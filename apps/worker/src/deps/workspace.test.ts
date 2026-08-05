import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { appendFile, chmod, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createDb,
  encryptSecret,
  loadSecretKey,
  migrateDb,
  newRunIdentity,
  orchestrationTemplates,
  projects,
  repoConnections,
  runs,
  secrets,
  seed,
  tasks,
  taskTypes,
  users,
} from "@agrippa/db";
import { seedBuiltinTemplates } from "@agrippa/orchestration";
import { eq, sql } from "drizzle-orm";

// WORKSPACE_ROOT is read at module load — point it at a scratch dir BEFORE
// importing the workspace module
process.env.WORKSPACE_ROOT = mkdtempSync(path.join(tmpdir(), "agrippa-ws-test-"));
const {
  GitWorkspaceManager,
  buildPlatformGitEnv,
  git,
  platformBaseSha,
  platformDirFor,
  workspaceDirFor,
} = await import("./workspace");
const { GitScmService, gitcodeCredentialedUrl } = await import("./scm");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/agrippa_test";
const TEMPLATES_DIR = path.resolve(import.meta.dirname, "../../../../templates");
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
  // A REAL run row, because both services now resolve a run to its workspace
  // key before touching the filesystem (ADR-0018 Decision 3) — a bare uuid
  // would exercise a path that cannot happen in production.
  let runId: string;
  /** The directory identity behind that run — its own id, since it is not a follow-up. */
  let workspaceKey: string;
  const publishBranch = "agrippa/run-1-abcd1234";
  let orgId: string;
  let projectId: string;
  let repoConnectionId: string;
  let sourceDir: string;
  let workspace: InstanceType<typeof GitWorkspaceManager>;
  let scm: InstanceType<typeof GitScmService>;
  // enough of a run's ancestry to insert more of them: several tests want a
  // second, independent workspace, and every one now needs a real row behind it
  let taskId: string;
  let templateVersionId: string;
  let faberId: string;
  let userId: string;
  let runNumber = 1;

  /** Another run of the same task — a fresh workspace key, like any new run. */
  const newRunRow = async (): Promise<string> => {
    runNumber += 1;
    const [row] = await db
      .insert(runs)
      .values({
        ...newRunIdentity(),
        taskId,
        projectId,
        number: runNumber,
        templateVersionId,
        faberId,
        executorId: "fake",
        paramsSnapshot: {},
        modelResolution: {},
        createdBy: userId,
      })
      .returning();
    return row?.id as string;
  };

  beforeAll(async () => {
    await db.execute(sql`drop schema if exists public cascade`);
    await db.execute(sql`create schema public`);
    await db.execute(sql`drop schema if exists drizzle cascade`);
    await migrateDb(db);
    // seeded org/fabri/templates: a run row needs a task, a task type and a
    // published template version behind it
    await seed(db);
    await seedBuiltinTemplates(db, TEMPLATES_DIR);

    const orgRows = (await db.execute(sql`select id from orgs limit 1`)) as Array<{ id: string }>;
    orgId = orgRows[0]?.id as string;
    const [user] = await db
      .insert(users)
      .values({
        id: Bun.randomUUIDv7(),
        name: "WS Tester",
        email: "ws@example.com",
        orgId,
      })
      .returning();
    const [project] = await db
      .insert(projects)
      .values({
        orgId,
        slug: "ws",
        name: "WS",
        createdBy: user?.id as string,
      })
      .returning();
    projectId = project?.id as string;

    const [template] = await db
      .select()
      .from(orchestrationTemplates)
      .where(eq(orchestrationTemplates.slug, "swdev.bug-localize-fix"));
    const [taskType] = await db
      .select()
      .from(taskTypes)
      .where(eq(taskTypes.templateId, template?.id as string));
    const [task] = await db
      .insert(tasks)
      .values({
        orgId,
        projectId,
        taskTypeId: taskType?.id as string,
        title: "workspace fixture",
        params: {},
        createdBy: user?.id as string,
      })
      .returning();
    taskId = task?.id as string;
    templateVersionId = template?.latestPublishedVersionId as string;
    faberId = taskType?.defaultFaberId as string;
    userId = user?.id as string;
    const [run] = await db
      .insert(runs)
      .values({
        ...newRunIdentity(),
        taskId,
        projectId,
        number: 1,
        templateVersionId: template?.latestPublishedVersionId as string,
        faberId: taskType?.defaultFaberId as string,
        executorId: "fake",
        paramsSnapshot: {},
        modelResolution: {},
        createdBy: user?.id as string,
      })
      .returning();
    runId = run?.id as string;
    workspaceKey = run?.workspaceKey as string;

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
    await scm.createBranch(runId, publishBranch);
  });

  it("records the clone base and keeps sanitization out of the diff", async () => {
    const dir = workspaceDirFor(workspaceKey);
    const base = await platformBaseSha(workspaceKey);
    expect(base).toMatch(/^[0-9a-f]{40}$/);
    // .claude was stripped by sanitizeWorkspace, but the diff must not report
    // its deletion in every patch
    expect(await Bun.file(path.join(dir, ".claude", "settings.json")).exists()).toBe(false);
    expect(await workspace.diff(runId)).toBe("");
  });

  it("includes committed, staged, and untracked changes in the diff", async () => {
    const dir = workspaceDirFor(workspaceKey);
    await Bun.write(path.join(dir, "README.md"), "# Source\n\ncommitted line\n");
    await gitIn(dir, ["add", "-A"]);
    await gitIn(dir, ["commit", "-m", "feat: committed change"]);
    await Bun.write(path.join(dir, "new-file.ts"), "export const fresh = true;\n");

    const diff = await workspace.diff(runId);
    expect(diff).toContain("committed line"); // the finding: this used to vanish
    expect(diff).toContain("new-file.ts");
  });

  it("keeps sanitized paths out of diffs and agent commits", async () => {
    const dir = workspaceDirFor(workspaceKey);
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

  it("publishes one idempotent snapshot commit with all legitimate changes", async () => {
    const branch = publishBranch;
    const dir = workspaceDirFor(workspaceKey);
    await Bun.write(path.join(dir, "left-uncommitted.txt"), "the agent forgot me\n");
    const approved = await workspace.diff(runId);
    const first = await scm.push(runId, {
      projectId,
      repo: { repoConnectionId },
      branch,
      expectedPatch: approved,
    });
    const retried = await scm.push(runId, {
      projectId,
      repo: { repoConnectionId },
      branch,
      expectedPatch: approved,
    });
    expect(first).toEqual(retried);
    // the snapshot commit is fully deterministic (identity, dates, tree,
    // parent, message all pinned) and publication holds NO local state at
    // all since the ADR-0017 inversion — every retry rebuilds the identical
    // commit in a pristine temp repo and finds the remote tip already there
    const recreated = await scm.push(runId, {
      projectId,
      repo: { repoConnectionId },
      branch,
      expectedPatch: approved,
    });
    expect(recreated).toEqual(first);

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
    expect((await git(["rev-list", "--count", `main..${branch}`], sourceDir)).trim()).toBe("1");
    expect((await git(["show", "-s", "--format=%an <%ae>|%s", branch], sourceDir)).trim()).toBe(
      "Agrippa <agrippa@agrippa.local>|chore: publish approved Agrippa changes",
    );
    // the diff still reports against the clone base after branching
    expect(await workspace.diff(runId)).toContain("committed line");
  });

  it("refuses to publish a run with no commits and no changes", async () => {
    const emptyRunId = await newRunRow();
    await workspace.checkout(emptyRunId, {
      repo: { repoConnectionId },
      access: "readWrite",
      projectId,
    });
    const branch = "agrippa/run-2-00000000dead";
    await scm.createBranch(emptyRunId, branch);
    await scm.createBranch(emptyRunId, branch);
    await expect(
      scm.push(emptyRunId, { projectId, repo: { repoConnectionId }, branch }),
    ).rejects.toThrow(/nothing to publish/);
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
      await expect(scm.openPullRequest(runId, spec)).rejects.toThrow(/422/);
    } finally {
      server.stop(true);
    }
  });

  it("creates and duplicate-recovers a GitCode PR (v5 API, undocumented status)", async () => {
    // a fake GitCode forge: v5 paths, Bearer auth, 400 on duplicate (the
    // real status is undocumented — recovery must work for any 4xx), and a
    // list endpoint with no `head` filter, so matching happens client-side
    const state = { created: 0, recoverable: true, userResolvable: true };
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (req.headers.get("authorization") !== "Bearer gitcode-token") {
          return new Response("unauthorized", { status: 401 });
        }
        if (req.method === "GET" && url.pathname === "/api/v5/user") {
          if (!state.userResolvable) return new Response("server error", { status: 500 });
          return Response.json({ login: "acme-bot" });
        }
        if (req.method === "POST" && url.pathname === "/api/v5/repos/acme/widget/pulls") {
          state.created += 1;
          if (state.created === 1) {
            return Response.json({ html_url: "https://gitcode.local/acme/widget/pulls/3" });
          }
          return Response.json({ message: "已存在相同源分支的合并请求" }, { status: 400 });
        }
        if (req.method === "GET" && url.pathname === "/api/v5/repos/acme/widget/pulls") {
          if (!state.recoverable) return Response.json([]);
          if (url.searchParams.get("state") !== "open") return Response.json([]);
          // the matching PR sits on page 2, behind a full page of unrelated
          // open PRs — recovery must paginate, not stop at the first page
          if (url.searchParams.get("page") === "2") {
            return Response.json([
              { html_url: "https://gitcode.local/acme/widget/pulls/9", head: { ref: "other" } },
              {
                html_url: "https://gitcode.local/acme/widget/pulls/3",
                head: { ref: "agrippa/run-2-feedc0de1234" },
              },
            ]);
          }
          return Response.json(
            Array.from({ length: 100 }, (_, i) => ({
              html_url: `https://gitcode.local/acme/widget/pulls/f${i}`,
              head: { ref: `filler-${i}` },
            })),
          );
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
          ciphertext: encryptSecret("gitcode-token", loadSecretKey()),
        })
        .returning();
      const [conn] = await db
        .insert(repoConnections)
        .values({
          projectId,
          provider: "gitcode",
          url: `http://127.0.0.1:${server.port}/acme/widget.git`,
          defaultBranch: "main",
          credentialSecretRef: secret?.id,
        })
        .returning();
      const spec = {
        projectId,
        repo: { repoConnectionId: conn?.id as string },
        head: "agrippa/run-2-feedc0de1234",
        base: "main",
        title: "T",
        body: "B",
      };

      const first = await scm.openPullRequest(runId, spec);
      expect(first.url).toBe("https://gitcode.local/acme/widget/pulls/3");
      // the retry's 400 recovers via the list + client-side head match
      const retried = await scm.openPullRequest(runId, spec);
      expect(retried.url).toBe("https://gitcode.local/acme/widget/pulls/3");
      expect(state.created).toBe(2);
      // nothing to recover → the original error surfaces
      state.recoverable = false;
      await expect(scm.openPullRequest(runId, spec)).rejects.toThrow(/400/);

      // push auth resolves the token's real username via /user (the official
      // GitCode CLI does the same); a failed lookup falls back to the
      // x-access-token magic username
      const repoUrl = `http://127.0.0.1:${server.port}/acme/widget.git`;
      const resolved = new URL(await gitcodeCredentialedUrl(repoUrl, "gitcode-token"));
      expect(resolved.username).toBe("acme-bot");
      expect(resolved.password).toBe("gitcode-token");
      state.userResolvable = false;
      const fallback = new URL(await gitcodeCredentialedUrl(repoUrl, "gitcode-token"));
      expect(fallback.username).toBe("x-access-token");
      expect(fallback.password).toBe("gitcode-token");
    } finally {
      server.stop(true);
    }
  });

  it("never runs agent-installed hooks or honors agent git config in platform git", async () => {
    const hostileRunId = await newRunRow();
    await workspace.checkout(hostileRunId, {
      repo: { repoConnectionId },
      access: "readWrite",
      projectId,
    });
    expect(await workspace.isIntact(hostileRunId)).toBe(true);
    const dir = workspaceDirFor(hostileRunId);
    const branch = "agrippa/run-3-cafe0123beef";
    await scm.createBranch(hostileRunId, branch);

    // legitimate agent work, left uncommitted for the snapshot publisher
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

    // the whole post-agent platform write-path: evidence, snapshot commit, push
    const diff = await workspace.diff(hostileRunId);
    expect(diff).toContain("feature.ts");
    await scm.push(hostileRunId, {
      projectId,
      repo: { repoConnectionId },
      branch,
      expectedPatch: diff,
    });

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
    // Platform Git never repairs or reads the agent copy — it is simply ignored.
    const config = await Bun.file(path.join(dir, ".git", "config")).text();
    expect(config).toContain("nonexistent-evil");
    expect(config).toContain("hooksPath");
  });

  it("never follows an agent-controlled .git/config symlink", async () => {
    const symlinkRunId = await newRunRow();
    await workspace.checkout(symlinkRunId, {
      repo: { repoConnectionId },
      access: "readWrite",
      projectId,
    });
    const branch = "agrippa/run-4-deadbeefcafe";
    await scm.createBranch(symlinkRunId, branch);
    const dir = workspaceDirFor(symlinkRunId);
    const victim = path.join(tmpdir(), `agrippa-config-victim-${crypto.randomUUID()}`);
    await Bun.write(victim, "do not overwrite\n");
    await rm(path.join(dir, ".git", "config"), { force: true });
    await symlink(victim, path.join(dir, ".git", "config"));
    await Bun.write(path.join(dir, "safe-change.ts"), "export const safe = true;\n");

    const approved = await workspace.diff(symlinkRunId);
    await scm.push(symlinkRunId, {
      projectId,
      repo: { repoConnectionId },
      branch,
      expectedPatch: approved,
    });
    expect(await Bun.file(victim).text()).toBe("do not overwrite\n");
    expect(
      Bun.spawnSync(["git", "show", `${branch}:safe-change.ts`], {
        cwd: sourceDir,
        stdout: "ignore",
        stderr: "pipe",
      }).exitCode,
    ).toBe(0);
    await rm(victim, { force: true });
  });

  it("never opens an agent-controlled .git/config FIFO", async () => {
    const fifoRunId = await newRunRow();
    await workspace.checkout(fifoRunId, {
      repo: { repoConnectionId },
      access: "readWrite",
      projectId,
    });
    const branch = "agrippa/run-5-f1f0f1f0f1f0";
    await scm.createBranch(fifoRunId, branch);
    const dir = workspaceDirFor(fifoRunId);
    const config = path.join(dir, ".git", "config");
    await rm(config, { force: true });
    const made = Bun.spawnSync(["mkfifo", config], { stdout: "ignore", stderr: "pipe" });
    if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
    await Bun.write(path.join(dir, "fifo-safe.ts"), "export const safe = true;\n");

    const approved = await workspace.diff(fifoRunId);
    await scm.push(fifoRunId, {
      projectId,
      repo: { repoConnectionId },
      branch,
      expectedPatch: approved,
    });
    expect(
      Bun.spawnSync(["git", "show", `${branch}:fifo-safe.ts`], {
        cwd: sourceDir,
        stdout: "ignore",
        stderr: "pipe",
      }).exitCode,
    ).toBe(0);
  });

  it("ignores an agent-corrupted index and exclude file when publishing", async () => {
    const protectedRunId = await newRunRow();
    await workspace.checkout(protectedRunId, {
      repo: { repoConnectionId },
      access: "readWrite",
      projectId,
    });
    const branch = "agrippa/run-6-feedfacecafe";
    await scm.createBranch(protectedRunId, branch);
    const dir = workspaceDirFor(protectedRunId);

    await rm(path.join(dir, ".git", "info", "exclude"), { force: true });
    await gitIn(dir, ["update-index", "--no-skip-worktree", ".claude/settings.json"]);
    await Bun.write(path.join(dir, ".claude", "agent-note.md"), "must not ship\n");
    await Bun.write(path.join(dir, ".agrippa", "artifacts", "report.json"), "{}\n");
    await Bun.write(path.join(dir, "legitimate.ts"), "export const legitimate = true;\n");
    await gitIn(dir, ["add", "-A"]);
    await gitIn(dir, ["commit", "-m", "feat: hostile agent commit"]);

    const approved = await workspace.diff(protectedRunId);
    expect(approved).toContain("legitimate.ts");
    expect(approved).not.toContain(".claude");
    expect(approved).not.toContain(".agrippa");
    await scm.push(protectedRunId, {
      projectId,
      repo: { repoConnectionId },
      branch,
      expectedPatch: approved,
    });

    const show = (spec: string) =>
      Bun.spawnSync(["git", "show", spec], { cwd: sourceDir, stdout: "pipe", stderr: "pipe" });
    expect(show(`${branch}:.claude/settings.json`).stdout.toString()).toBe("{}\n");
    expect(show(`${branch}:.claude/agent-note.md`).exitCode).not.toBe(0);
    expect(show(`${branch}:.agrippa/artifacts/report.json`).exitCode).not.toBe(0);
    expect(show(`${branch}:legitimate.ts`).exitCode).toBe(0);
  });

  it("publishes exactly the approved patch — post-approval workspace drift is irrelevant", async () => {
    // ADR-0017 Decision 5 (amending ADR-0011): the approved patch IS the
    // contract. It is applied to a pristine clone of the pinned base, so
    // whatever happens in the workspace after approval cannot reach the
    // published tree — the old refresh-and-compare drift guard is retired
    // because there is nothing to compare anymore.
    const staleRunId = await newRunRow();
    await workspace.checkout(staleRunId, {
      repo: { repoConnectionId },
      access: "readWrite",
      projectId,
    });
    const branch = "agrippa/run-7-badc0ffeeeee";
    await scm.createBranch(staleRunId, branch);
    const dir = workspaceDirFor(staleRunId);
    await Bun.write(path.join(dir, "approved.ts"), "export const approved = true;\n");
    const approved = await workspace.diff(staleRunId);

    // the workspace drifts AFTER approval — none of this may publish
    await Bun.write(path.join(dir, "drift.ts"), "sneaked in after review\n");
    await Bun.write(path.join(dir, "approved.ts"), "export const approved = 'tampered';\n");

    const result = await scm.push(staleRunId, {
      projectId,
      repo: { repoConnectionId },
      branch,
      expectedPatch: approved,
    });
    expect(result.status).toBe("pushed");
    const show = (spec: string) =>
      Bun.spawnSync(["git", "show", spec], { cwd: sourceDir, stdout: "pipe", stderr: "pipe" });
    expect(show(`${branch}:approved.ts`).stdout.toString()).toBe("export const approved = true;\n");
    expect(show(`${branch}:drift.ts`).exitCode).not.toBe(0);

    // and an empty approved patch is a refusal, not an empty publish
    await expect(
      scm.push(staleRunId, {
        projectId,
        repo: { repoConnectionId },
        branch: "agrippa/run-8-000000000000",
        expectedPatch: "",
      }),
    ).rejects.toThrow(/nothing to publish/);
  });

  it("reports a never-checked-out workspace as not intact", async () => {
    expect(await workspace.isIntact(await newRunRow())).toBe(false);
  });

  it("ignores agent tampering with the base ref — the sidecar SHA anchors evidence", async () => {
    const dir = workspaceDirFor(workspaceKey);
    await git(["update-ref", "-d", "refs/agrippa/base"], dir);
    await Bun.write(path.join(dir, "uncommitted.txt"), "worktree only\n");

    const diff = await workspace.diff(runId);
    expect(diff).toContain("uncommitted.txt");
    expect(diff).toContain("committed line"); // committed work stays in evidence
  });

  it("fails closed when trusted platform metadata is missing", async () => {
    await rm(platformDirFor(workspaceKey), { recursive: true, force: true });
    expect(await workspace.isIntact(runId)).toBe(false);
    await expect(workspace.diff(runId)).rejects.toThrow(/trusted platform git base is missing/);
  });
});

describe("platform Git environment", () => {
  it("contains system variables but no platform or provider credentials", () => {
    const env = buildPlatformGitEnv({
      PATH: "/bin",
      HOME: "/tmp/home",
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENAI_API_KEY: "openai-secret",
      CODEX_API_KEY: "codex-secret",
      DATABASE_URL: "postgres://secret",
      AGRIPPA_SECRET_KEY: "master-secret",
    });
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/tmp/home");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.AGRIPPA_SECRET_KEY).toBeUndefined();
  });
});
