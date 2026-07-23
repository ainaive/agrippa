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
    const pushUrl = credentialedUrl(connection.url, token);
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
    throw new Error(
      `pr.open is not supported for provider '${connection.provider}' — push succeeded, open the PR manually`,
    );
  }

  private async openGithubPr(
    repoUrl: string,
    token: string,
    spec: PullRequestSpec,
  ): Promise<{ url: string }> {
    const url = new URL(repoUrl);
    const [owner, repo] = url.pathname
      .replace(/^\//, "")
      .replace(/\.git$/, "")
      .split("/");
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
          { headers },
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
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      // GitLab reports an existing MR for the branch pair as 409 — recover it
      if (response.status === 409) {
        const lookup = await fetch(
          `${apiBase}/merge_requests?source_branch=${encodeURIComponent(spec.head)}&target_branch=${encodeURIComponent(spec.base)}&state=opened`,
          { headers },
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
