import type { Db } from "@agrippa/db";
import type { PullRequestSpec, PushResult, PushSpec, ScmService } from "@agrippa/orchestration";
import {
  credentialedUrl,
  git,
  loadRepoConnection,
  platformBaseSha,
  platformGit,
  stagePlatformSnapshot,
  workspaceDirFor,
} from "./workspace";

/**
 * Every provider API call fails fast instead of hanging a run — pr.open and
 * push are template-retryable steps, so a bounded failure beats a stuck job.
 */
const SCM_HTTP_TIMEOUT_MS = 30_000;
const scmTimeout = () => AbortSignal.timeout(SCM_HTTP_TIMEOUT_MS);

/** `https://host/owner/repo(.git)` → `[owner, repo]` (github/gitcode URL shape). */
function ownerRepoFromUrl(url: URL): [string | undefined, string | undefined] {
  const [owner, repo] = url.pathname
    .replace(/^\//, "")
    .replace(/\.git$/, "")
    .split("/");
  return [owner, repo];
}

/** gitcode.com serves its API from api.gitcode.com; other hosts (tests, self-managed) are origin-relative. */
function gitcodeApiBase(url: URL): string {
  return url.hostname === "gitcode.com" ? "https://api.gitcode.com/api/v5" : `${url.origin}/api/v5`;
}

/**
 * GitCode HTTPS git auth wants the account's real username with the token as
 * password — the official GitCode CLI resolves it the same way — so ask the
 * v5 API who the token belongs to. Any failure falls back to the
 * x-access-token magic username the other providers use.
 */
export async function gitcodeCredentialedUrl(repoUrl: string, token: string): Promise<string> {
  try {
    const url = new URL(repoUrl);
    const response = await fetch(`${gitcodeApiBase(url)}/user`, {
      headers: { authorization: `Bearer ${token}`, "user-agent": "agrippa" },
      signal: scmTimeout(),
    });
    if (response.ok) {
      const { login } = (await response.json()) as { login?: string };
      if (login) {
        const withAuth = new URL(repoUrl);
        withAuth.username = login;
        withAuth.password = token;
        return withAuth.toString();
      }
    }
  } catch {
    // network/parse failure — fall through to the generic credential form
  }
  return credentialedUrl(repoUrl, token);
}

/**
 * Platform-side git write-path (ADR-0011): branch creation, credentialed push,
 * and PR creation via the provider REST API. The PR link is contract-required,
 * so none of this is delegated to an agent or an optional MCP server. The
 * credential is injected per call (push URL / API header) and never lands in
 * .git/config or the agent environment.
 */
export class GitScmService implements ScmService {
  constructor(private readonly db: Db) {}

  async createBranch(runId: string, name: string): Promise<void> {
    // This is the last platform operation against agent-visible .git and runs
    // before any agent step. The sidecar ref is the idempotency anchor used by
    // the verified publisher later.
    await git(["checkout", "-B", name], workspaceDirFor(runId));
    const baseSha = await platformBaseSha(runId);
    if (!baseSha) throw new Error("trusted platform git base is missing");
    await platformGit(runId, ["update-ref", `refs/heads/${name}`, baseSha]);
  }

  async push(runId: string, spec: PushSpec): Promise<PushResult> {
    const snapshot = await stagePlatformSnapshot(runId);
    if (spec.expectedPatch !== undefined && snapshot.patch !== spec.expectedPatch) {
      return { status: "evidence_mismatch" };
    }
    if (snapshot.patch.length === 0) {
      throw new Error("nothing to publish — the approved workspace snapshot is empty");
    }

    await platformGit(runId, ["check-ref-format", "--branch", spec.branch]);
    const branchRef = `refs/heads/${spec.branch}`;
    const existing = await platformGit(runId, ["rev-parse", "--verify", branchRef])
      .then((out) => out.trim())
      .catch(() => null);

    let commitSha: string;
    if (existing && existing !== snapshot.baseSha) {
      const [tree, parent] = await Promise.all([
        platformGit(runId, ["rev-parse", `${existing}^{tree}`]).then((out) => out.trim()),
        platformGit(runId, ["rev-parse", `${existing}^`]).then((out) => out.trim()),
      ]);
      if (tree !== snapshot.treeSha || parent !== snapshot.baseSha) {
        throw new Error("platform publish ref does not match the approved snapshot");
      }
      commitSha = existing;
    } else {
      // dates pinned to the base commit: with identity, tree, parent, and
      // message all fixed, the snapshot commit SHA is fully deterministic —
      // any retry or racer reproduces the identical commit, so the
      // expected-old update-ref below is a true CAS between equals
      const baseDate = (
        await platformGit(runId, ["show", "-s", "--format=%cI", snapshot.baseSha])
      ).trim();
      commitSha = (
        await platformGit(
          runId,
          [
            "commit-tree",
            snapshot.treeSha,
            "-p",
            snapshot.baseSha,
            "-m",
            "chore: publish approved Agrippa changes",
          ],
          {
            GIT_AUTHOR_NAME: "Agrippa",
            GIT_AUTHOR_EMAIL: "agrippa@agrippa.local",
            GIT_AUTHOR_DATE: baseDate,
            GIT_COMMITTER_NAME: "Agrippa",
            GIT_COMMITTER_EMAIL: "agrippa@agrippa.local",
            GIT_COMMITTER_DATE: baseDate,
          },
        )
      ).trim();
      await platformGit(runId, [
        "update-ref",
        branchRef,
        commitSha,
        existing ?? "0000000000000000000000000000000000000000",
      ]);
    }

    const { connection, token } = await loadRepoConnection(this.db, spec.projectId, spec.repo);
    const pushUrl =
      connection.provider === "gitcode" && token
        ? await gitcodeCredentialedUrl(connection.url, token)
        : credentialedUrl(connection.url, token);
    await platformGit(runId, ["push", pushUrl, `${branchRef}:${branchRef}`]);
    return { status: "pushed", commitSha };
  }

  async openPullRequest(_runId: string, spec: PullRequestSpec): Promise<{ url: string }> {
    const { connection, token } = await loadRepoConnection(this.db, spec.projectId, spec.repo);
    if (!token) {
      throw new Error("pr.open needs a stored repo credential (add a token to the connection)");
    }
    if (connection.provider === "github") {
      return await this.openGithubPr(connection.url, token, spec);
    }
    if (connection.provider === "gitlab") {
      return await this.openGitlabMr(connection.url, token, spec);
    }
    if (connection.provider === "gitcode") {
      return await this.openGitcodePr(connection.url, token, spec);
    }
    throw new Error(
      `pr.open is not supported for provider '${connection.provider}' — push succeeded, open the PR manually`,
    );
  }

  /**
   * GitCode (gitcode.com) exposes a Gitee-style v5 REST API with GitHub-shaped
   * pull-request endpoints (POST /repos/{owner}/{repo}/pulls, html_url in the
   * response) and Bearer token auth. Its duplicate status code is undocumented
   * (the platform is GitLab-derived; Gitee lineage suggests 400), so recovery
   * runs on any 4xx: list open PRs on the base branch and match the head
   * client-side — the v5 list endpoint documents no `head` filter.
   */
  private async openGitcodePr(
    repoUrl: string,
    token: string,
    spec: PullRequestSpec,
  ): Promise<{ url: string }> {
    const url = new URL(repoUrl);
    const [owner, repo] = ownerRepoFromUrl(url);
    const apiBase = gitcodeApiBase(url);
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "agrippa",
    };
    const response = await fetch(`${apiBase}/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: spec.title,
        head: spec.head,
        base: spec.base,
        body: spec.body,
      }),
      signal: scmTimeout(),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      if (response.status >= 400 && response.status < 500) {
        // the list endpoint has no head filter, so page through (bounded)
        // and match client-side — one page could hide the duplicate behind
        // 100 unrelated open PRs on the same base
        for (let page = 1; page <= 5; page++) {
          const lookup = await fetch(
            `${apiBase}/repos/${owner}/${repo}/pulls?state=open&base=${encodeURIComponent(spec.base)}&per_page=100&page=${page}`,
            { headers, signal: scmTimeout() },
          );
          if (!lookup.ok) break;
          const open = (await lookup.json()) as Array<{
            html_url?: string;
            web_url?: string;
            head?: { ref?: string; label?: string };
            source_branch?: string;
          }>;
          const existing = open.find((pr) => {
            const head = pr.head?.ref ?? pr.head?.label ?? pr.source_branch;
            return head === spec.head || head === `${owner}:${spec.head}`;
          });
          const existingUrl = existing?.html_url ?? existing?.web_url;
          if (existingUrl) return { url: existingUrl };
          if (open.length < 100) break;
        }
      }
      throw new Error(`GitCode PR creation failed (${response.status}): ${detail}`);
    }
    const json = (await response.json()) as { html_url?: string; web_url?: string };
    const prUrl = json.html_url ?? json.web_url;
    if (!prUrl) throw new Error("GitCode PR creation returned no html_url");
    return { url: prUrl };
  }

  private async openGithubPr(
    repoUrl: string,
    token: string,
    spec: PullRequestSpec,
  ): Promise<{ url: string }> {
    const url = new URL(repoUrl);
    const [owner, repo] = ownerRepoFromUrl(url);
    // github.com uses api.github.com; GHES exposes the API under /api/v3
    const apiBase =
      url.hostname === "github.com" ? "https://api.github.com" : `${url.origin}/api/v3`;
    const headers = {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "agrippa",
    };
    const response = await fetch(`${apiBase}/repos/${owner}/${repo}/pulls`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: spec.title,
        head: spec.head,
        base: spec.base,
        body: spec.body,
      }),
      signal: scmTimeout(),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      // A retry after a lost response (or a crash before the URL was stored)
      // re-POSTs and GitHub answers 422. Recover the existing open PR by
      // head/base instead of failing a run whose PR actually exists — work
      // branches are unique per run, so the lookup can't match another run's.
      if (response.status === 422) {
        const lookup = await fetch(
          `${apiBase}/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${spec.head}`)}&base=${encodeURIComponent(spec.base)}&state=open`,
          { headers, signal: scmTimeout() },
        );
        if (lookup.ok) {
          const open = (await lookup.json()) as Array<{ html_url?: string }>;
          const existing = open[0]?.html_url;
          if (existing) return { url: existing };
        }
      }
      throw new Error(`GitHub PR creation failed (${response.status}): ${detail}`);
    }
    const json = (await response.json()) as { html_url?: string };
    if (!json.html_url) throw new Error("GitHub PR creation returned no html_url");
    return { url: json.html_url };
  }

  private async openGitlabMr(
    repoUrl: string,
    token: string,
    spec: PullRequestSpec,
  ): Promise<{ url: string }> {
    const url = new URL(repoUrl);
    const projectPath = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
    const apiBase = `${url.origin}/api/v4/projects/${encodeURIComponent(projectPath)}`;
    const headers = { "private-token": token, "content-type": "application/json" };
    const response = await fetch(`${apiBase}/merge_requests`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        source_branch: spec.head,
        target_branch: spec.base,
        title: spec.title,
        description: spec.body,
      }),
      signal: scmTimeout(),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      // GitLab reports an existing MR for the branch pair as 409 — recover it
      if (response.status === 409) {
        const lookup = await fetch(
          `${apiBase}/merge_requests?source_branch=${encodeURIComponent(spec.head)}&target_branch=${encodeURIComponent(spec.base)}&state=opened`,
          { headers, signal: scmTimeout() },
        );
        if (lookup.ok) {
          const open = (await lookup.json()) as Array<{ web_url?: string }>;
          const existing = open[0]?.web_url;
          if (existing) return { url: existing };
        }
      }
      throw new Error(`GitLab MR creation failed (${response.status}): ${detail}`);
    }
    const json = (await response.json()) as { web_url?: string };
    if (!json.web_url) throw new Error("GitLab MR creation returned no web_url");
    return { url: json.web_url };
  }
}
