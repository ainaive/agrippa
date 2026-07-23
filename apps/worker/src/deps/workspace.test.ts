import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { appendFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDb,
  encryptSecret,
  loadSecretKey,
  migrateDb,
  orgs,
  projects,
  repoConnections,
  secrets,
  users,
} from "@agrippa/db";
import { sql } from "drizzle-orm";

// WORKSPACE_ROOT is read at module load — point it at a scratch dir BEFORE
// importing the workspace module
process.env.WORKSPACE_ROOT = mkdtempSync(path.join(tmpdir(), "agrippa-ws-test-"));
const { GitWorkspaceManager, git, platformDirFor, workspaceDirFor } = await import("./workspace");
const { GitScmService } = await import("./scm");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/agrippa_test";
const db = createDb(TEST_DATABASE_URL);
let dbUp = true;
try {
  await db.execute(sql`select 1`);
} catch {
  dbUp = false;
  console.warn("[test] postgres unreachable — skipping workspace git suite");
}

/**
 * Real-git coverage for the diff/branch/push mechanics — the compliance suite
 * runs against FakeWorkspaceManager's canned diff, which is exactly how "a
 * committed change produces an empty patch" shipped unnoticed.
 */

async function gitIn(dir: string, args: string[]): Promise<string> {
  return await git(["-c", "user.email=test@example.com", "-c", "user.name=Test", ...args], dir);
}

function makeSourceRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agrippa-src-"));
  const run = (args: string[]) => {
    const res = Bun.spawnSync(
      ["git", "-c", "user.email=src@example.com", "-c", "user.name=Src", ...args],
      { cwd: dir, stdout: "ignore", stderr: "pipe" },
    );
    if (res.exitCode !== 0) throw new Error(`git ${args[0]}: ${res.stderr.toString()}`);
  };
  run(["init", "-b", "main"]);
  Bun.spawnSync(["mkdir", "-p", path.join(dir, ".claude")]);
  Bun.write(path.join(dir, "README.md"), "# Source\n");
  Bun.write(path.join(dir, ".claude", "settings.json"), "{}\n");
  Bun.spawnSync(["sh", "-c", "sync"], { cwd: dir });
  run(["add", "-A"]);
  run(["commit", "-m", "init"]);
  return dir;
}

describe.skipIf(!dbUp)("GitWorkspaceManager + GitScmService (real git)", () => {
  const runId = crypto.randomUUID();
  let orgId: string;
  let projectId: string;
  let repoConnectionId: string;
  let sourceDir: string;
  let workspace: InstanceType<typeof GitWorkspaceManager>;
  let scm: InstanceType<typeof GitScmService>;

  beforeAll(async () => {
    await db.execute(sql`drop schema public cascade`);
    await db.execute(sql`create schema public`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await migrateDb(db);

    const [org] = await db.insert(orgs).values({ slug: "ws", name: "WS" }).returning();
    orgId = org?.id as string;
    const [user] = await db
      .insert(users)
      .values({
        id: Bun.randomUUIDv7(),
        name: "WS Tester",
        email: "ws@example.com",
        orgId: org?.id as string,
      })
      .returning();
    const [project] = await db
      .insert(projects)
      .values({
        orgId: org?.id as string,
        slug: "ws",
        name: "WS",
        createdBy: user?.id as string,
      })
      .returning();
    projectId = project?.id as string;

    sourceDir = makeSourceRepo();
    const [conn] = await db
      .insert(repoConnections)
      .values({
        projectId,
        provider: "generic-git",
        url: `file://${sourceDir}`,
        defaultBranch: "main",
      })
      .returning();
    repoConnectionId = conn?.id as string;

    workspace = new GitWorkspaceManager(db);
    scm = new GitScmService(db);
    await workspace.checkout(runId, {
      repo: { repoConnectionId },
      access: "readWrite",
      projectId,
    });
  });

  it("records the clone base and keeps sanitization out of the diff", async () => {
    const dir = workspaceDirFor(runId);
    // the base ref exists and points at the clone-time HEAD
    const base = (await git(["rev-parse", "refs/agrippa/base"], dir)).trim();
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    // .claude was stripped by sanitizeWorkspace, but the diff must not report
    // its deletion in every patch
    expect(await Bun.file(path.join(dir, ".claude", "settings.json")).exists()).toBe(false);
    expect(await workspace.diff(runId)).toBe("");
  });

  it("includes committed, staged, and untracked changes in the diff", async () => {
    const dir = workspaceDirFor(runId);
    await Bun.write(path.join(dir, "README.md"), "# Source\n\ncommitted line\n");
    await gitIn(dir, ["add", "-A"]);
    await gitIn(dir, ["commit", "-m", "feat: committed change"]);
    await Bun.write(path.join(dir, "new-file.ts"), "export const fresh = true;\n");

    const diff = await workspace.diff(runId);
    expect(diff).toContain("committed line"); // the finding: this used to vanish
    expect(diff).toContain("new-file.ts");
  });

  it("keeps sanitized paths out of diffs and agent commits", async () => {
    const dir = workspaceDirFor(runId);
    // platform-materialized + agent-created files under the sanitized paths —
    // none of this may appear in evidence or ship in a commit
    await Bun.write(path.join(dir, ".claude", "skills", "demo", "SKILL.md"), "# skill\n");
    await Bun.write(path.join(dir, ".agrippa", "artifacts", "questions.json"), "{}\n");
    await Bun.write(path.join(dir, ".claude", "agent-note.md"), "agent wrote this\n");

    const diff = await workspace.diff(runId);
    expect(diff).not.toContain("SKILL.md");
    expect(diff).not.toContain("questions.json");
    expect(diff).not.toContain("agent-note.md");
    expect(diff).not.toContain(".claude/settings.json"); // no deletion hunk either

    // an agent-style commit-everything must include neither the sanitized
    // deletion nor the platform/agent files under those paths
    await gitIn(dir, ["add", "-A"]);
    await gitIn(dir, ["commit", "-m", "chore: agent commits everything"]);
    const committed = await git(["show", "--stat", "--name-only", "HEAD"], dir);
    expect(committed).not.toContain(".claude");
    expect(committed).not.toContain(".agrippa");
    expect(committed).toContain("new-file.ts"); // the legitimate change went in
  });

  it("creates the work branch, finalize-commits leftovers, and pushes", async () => {
    const branch = "agrippa/run-1-abcd1234";
    const dir = workspaceDirFor(runId);
    await Bun.write(path.join(dir, "left-uncommitted.txt"), "the agent forgot me\n");
    await scm.createBranch(runId, branch);
    // -B is idempotent for retries
    await scm.createBranch(runId, branch);
    await scm.push(runId, { projectId, repo: { repoConnectionId }, branch });

    const show = (spec: string) =>
      Bun.spawnSync(["git", "show", spec], { cwd: sourceDir, stdout: "pipe", stderr: "pipe" });
    // branch exists at the origin
    expect(show(branch).exitCode).toBe(0);
    // evidence == PR: the uncommitted file was finalize-committed and shipped
    expect(show(`${branch}:left-uncommitted.txt`).exitCode).toBe(0);
    expect(show(`${branch}:new-file.ts`).exitCode).toBe(0);
    // the PR does NOT delete the sanitized-but-tracked repo files
    expect(show(`${branch}:.claude/settings.json`).exitCode).toBe(0);
    // nothing under the sanitized paths shipped either
    expect(show(`${branch}:.claude/agent-note.md`).exitCode).not.toBe(0);
    // the diff still reports against the clone base after branching
    expect(await workspace.diff(runId)).toContain("committed line");
  });

  it("refuses to publish a run with no commits and no changes", async () => {
    const emptyRunId = crypto.randomUUID();
    await workspace.checkout(emptyRunId, {
      repo: { repoConnectionId },
      access: "readWrite",
      projectId,
    });
    const branch = "agrippa/run-2-00000000dead";
    await scm.createBranch(emptyRunId, branch);
    expect(scm.push(emptyRunId, { projectId, repo: { repoConnectionId }, branch })).rejects.toThrow(
      /nothing to publish/,
    );
  });

  it("recovers an existing PR when the provider rejects the duplicate", async () => {
    // a fake GHES forge: first POST creates, later POSTs 422; the lookup
    // endpoint returns the open PR — the recovery path a lost response or a
    // crash-before-store forces the retry through
    const state = { created: 0, recoverable: true };
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.method === "POST" && url.pathname === "/api/v3/repos/acme/widget/pulls") {
          state.created += 1;
          if (state.created === 1) {
            return Response.json({ html_url: "https://forge.local/acme/widget/pull/7" });
          }
          return Response.json({ message: "Validation Failed" }, { status: 422 });
        }
        if (req.method === "GET" && url.pathname === "/api/v3/repos/acme/widget/pulls") {
          if (!state.recoverable) return Response.json([]);
          if (url.searchParams.get("head") !== "acme:agrippa/run-1-abcd1234") {
            return Response.json([]);
          }
          return Response.json([{ html_url: "https://forge.local/acme/widget/pull/7" }]);
        }
        return new Response("not found", { status: 404 });
      },
    });
    try {
      process.env.AGRIPPA_SECRET_KEY ??= btoa(
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
      );
      const [secret] = await db
        .insert(secrets)
        .values({
          orgId,
          kind: "git_credential",
          ciphertext: encryptSecret("forge-token", loadSecretKey()),
        })
        .returning();
      const [forgeConn] = await db
        .insert(repoConnections)
        .values({
          projectId,
          provider: "github",
          url: `http://127.0.0.1:${server.port}/acme/widget.git`,
          defaultBranch: "main",
          credentialSecretRef: secret?.id,
        })
        .returning();
      const spec = {
        projectId,
        repo: { repoConnectionId: forgeConn?.id as string },
        head: "agrippa/run-1-abcd1234",
        base: "main",
        title: "T",
        body: "B",
      };

      const first = await scm.openPullRequest(runId, spec);
      expect(first.url).toBe("https://forge.local/acme/widget/pull/7");
      // the retry's 422 recovers the same PR instead of failing the run
      const retried = await scm.openPullRequest(runId, spec);
      expect(retried.url).toBe("https://forge.local/acme/widget/pull/7");
      expect(state.created).toBe(2);
      // a 422 with nothing to recover still surfaces the original error
      state.recoverable = false;
      expect(scm.openPullRequest(runId, spec)).rejects.toThrow(/422/);
    } finally {
      server.stop(true);
    }
  });

  it("never runs agent-installed hooks or honors agent git config in platform git", async () => {
    const hostileRunId = crypto.randomUUID();
    await workspace.checkout(hostileRunId, {
      repo: { repoConnectionId },
      access: "readWrite",
      projectId,
    });
    expect(await workspace.isIntact(hostileRunId)).toBe(true);
    const dir = workspaceDirFor(hostileRunId);

    // legitimate agent work, left uncommitted so push's finalizing commit runs
    await Bun.write(path.join(dir, "feature.ts"), "export const ok = true;\n");

    // a prompt-injected agent weaponizes its workspace: hooks that exfiltrate
    // the worker env, config that redirects the push URL, and a clean filter
    const hook = `#!/bin/sh\nprintf '%s' "$DATABASE_URL$AGRIPPA_SECRET_KEY" > "${dir}/hook-leak.txt"\ntouch "${dir}/hook-ran.txt"\n`;
    for (const name of ["pre-commit", "post-commit", "pre-push", "post-checkout"]) {
      const hookPath = path.join(dir, ".git", "hooks", name);
      await Bun.write(hookPath, hook);
      await chmod(hookPath, 0o755);
    }
    await appendFile(
      path.join(dir, ".git", "config"),
      `[core]\n\thooksPath = ${path.join(dir, ".git", "hooks")}\n` +
        `[url "file:///nonexistent-evil"]\n\tinsteadOf = file://\n` +
        `[filter "steal"]\n\tclean = touch '${dir}/filter-ran.txt' && cat\n`,
    );
    await Bun.write(path.join(dir, ".gitattributes"), "*.ts filter=steal\n");

    // the whole platform write-path: evidence, branch, finalize commit, push
    const diff = await workspace.diff(hostileRunId);
    expect(diff).toContain("feature.ts");
    const branch = "agrippa/run-3-cafe0123beef";
    await scm.createBranch(hostileRunId, branch);
    await scm.push(hostileRunId, { projectId, repo: { repoConnectionId }, branch });

    // the push landed at the REAL origin — insteadOf did not redirect it
    const shown = Bun.spawnSync(["git", "show", `${branch}:feature.ts`], {
      cwd: sourceDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(shown.exitCode).toBe(0);
    // no hook and no filter ever executed, so nothing leaked
    expect(await Bun.file(path.join(dir, "hook-ran.txt")).exists()).toBe(false);
    expect(await Bun.file(path.join(dir, "hook-leak.txt")).exists()).toBe(false);
    expect(await Bun.file(path.join(dir, "filter-ran.txt")).exists()).toBe(false);
    // and the agent's config rewrite was replaced by the provision snapshot
    const config = await Bun.file(path.join(dir, ".git", "config")).text();
    expect(config).not.toContain("nonexistent-evil");
    expect(config).not.toContain("hooksPath");
  });

  it("reports a never-checked-out workspace as not intact", async () => {
    expect(await workspace.isIntact(crypto.randomUUID())).toBe(false);
  });

  it("ignores agent tampering with the base ref — the sidecar SHA anchors evidence", async () => {
    const dir = workspaceDirFor(runId);
    await git(["update-ref", "-d", "refs/agrippa/base"], dir);
    await Bun.write(path.join(dir, "uncommitted.txt"), "worktree only\n");

    const diff = await workspace.diff(runId);
    expect(diff).toContain("uncommitted.txt");
    expect(diff).toContain("committed line"); // committed work stays in evidence
  });

  it("falls back to a worktree diff for pre-sidecar workspaces", async () => {
    await rm(platformDirFor(runId), { recursive: true, force: true });

    const diff = await workspace.diff(runId);
    expect(diff).toContain("uncommitted.txt"); // worktree changes still visible
    expect(diff).not.toContain("committed line"); // pre-base-ref behavior
  });
});
