import type { Db } from "@agrippa/db";
import type { PullRequestSpec, ScmService } from "@agrippa/orchestration";
import { credentialedUrl, git, loadRepoConnection, workspaceDirFor } from "./workspace";

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
    // -B keeps this idempotent across step retries and crash-resume
    await git(["checkout", "-B", name], workspaceDirFor(runId));
  }

  async push(
    runId: string,
    spec: { projectId: string; repo: unknown; branch: string },
  ): Promise<void> {
    const { connection, token } = await loadRepoConnection(this.db, spec.projectId, spec.repo);
    const pushUrl = credentialedUrl(connection.url, token);
    await git(["push", pushUrl, `${spec.branch}:${spec.branch}`], workspaceDirFor(runId));
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
