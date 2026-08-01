import { type Db, dispatches, runs } from "@agrippa/db";
import type { PullRequestSpec, PushResult, PushSpec, ScmService } from "@agrippa/orchestration";
import { applyApprovedPatch, platformGitDirFor, workspaceIntact } from "@agrippa/workspace";
import { and, desc, eq } from "drizzle-orm";
import {
  credentialedUrl,
  git,
  loadRepoConnection,
  platformBaseSha,
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
    // Daemon-routed runs have no local checkout: the engine still records
    // runs.work_branch, and the daemon materializes it (`checkout -B`) from
    // the dispatch payload. Publication no longer needs a sidecar ref anchor
    // (ADR-0017 Decision 5), so remotely there is nothing to do here.
    if (!(await workspaceIntact(runId))) return;
    // Central runs: the last platform operation against agent-visible .git,
    // before any agent step — the agent is told to commit to this branch.
    await git(["checkout", "-B", name], workspaceDirFor(runId));
  }

  async push(runId: string, spec: PushSpec): Promise<PushResult> {
    // Publication inversion (ADR-0017 Decision 5, amending ADR-0011/0012):
    // apply the APPROVED patch to a pristine clone of the pinned base and
    // push the deterministic commit. The engine verified the evidence bytes
    // (store-time sha256) and passes them as expectedPatch — no workspace
    // state participates, so post-approval drift is structurally irrelevant
    // and evidence_mismatch cannot occur at this layer anymore.
    const patch = spec.expectedPatch ?? (await stagePlatformSnapshot(runId)).patch;
    if (patch.length === 0) {
      throw new Error("nothing to publish — the approved patch is empty");
    }

    const { connection, token } = await loadRepoConnection(this.db, spec.projectId, spec.repo);
    const pushUrl =
      connection.provider === "gitcode" && token
        ? await gitcodeCredentialedUrl(connection.url, token)
        : credentialedUrl(connection.url, token);

    // Base + object source: central runs read the platform sidecar (pristine
    // by ADR-0012; refs/agrippa/base always resolves there); daemon runs use
    // the SERVER-pinned base recorded at checkout (ls-remote, before any
    // daemon involvement) — never the dispatch report. A daemon-chosen base
    // could be any other reachable commit, and a benign patch applying
    // cleanly on top would smuggle that commit's contents past the approval.
    const sidecarBase = await platformBaseSha(runId);
    let fetchSource: string;
    let fetchRef: string;
    let baseSha: string;
    if (sidecarBase) {
      fetchSource = platformGitDirFor(runId);
      fetchRef = "refs/agrippa/base";
      baseSha = sidecarBase;
    } else {
      const pinnedBase = await this.pinnedBaseSha(runId);
      if (!pinnedBase) {
        throw new Error("no trusted base for publication (no sidecar, no server-pinned base)");
      }
      // cross-check only: the daemon reported what it actually checked out;
      // a mismatch means it never materialized the pinned base — fail loudly
      // now instead of publishing a patch applied against something else
      const reported = await this.dispatchBaseSha(runId);
      if (reported && reported !== pinnedBase) {
        throw new Error(
          `daemon-reported base ${reported} does not match the server-pinned base ${pinnedBase}`,
        );
      }
      fetchSource = pushUrl;
      fetchRef = pinnedBase;
      baseSha = pinnedBase;
    }

    const { commitSha } = await applyApprovedPatch({
      fetchSource,
      fetchRef,
      baseSha,
      branch: spec.branch,
      patch,
      pushUrl,
    });
    return { status: "pushed", commitSha };
  }

  /** The base the SERVER pinned at checkout (runs.workspace_ref, remote runs). */
  private async pinnedBaseSha(runId: string): Promise<string | null> {
    const [run] = await this.db
      .select({ workspaceRef: runs.workspaceRef })
      .from(runs)
      .where(eq(runs.id, runId));
    if (!run?.workspaceRef) return null;
    try {
      const spec = JSON.parse(run.workspaceRef) as { baseSha?: string };
      return spec.baseSha ?? null;
    } catch {
      return null; // central-format workspaceRef
    }
  }

  /** The clone base the daemon reported when it completed a dispatch. */
  private async dispatchBaseSha(runId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ result: dispatches.result })
      .from(dispatches)
      .where(and(eq(dispatches.runId, runId), eq(dispatches.status, "completed")))
      .orderBy(desc(dispatches.finishedAt))
      .limit(1);
    const result = row?.result as { baseSha?: string } | null | undefined;
    return result?.baseSha ?? null;
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
