import { beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, migrateDb, orgs, projects, repoConnections, users } from "@agrippa/db";
import { sql } from "drizzle-orm";

// WORKSPACE_ROOT is read at module load — point it at a scratch dir BEFORE
// importing the workspace module
process.env.WORKSPACE_ROOT = mkdtempSync(path.join(tmpdir(), "agrippa-ws-test-"));
const { GitWorkspaceManager, git, workspaceDirFor } = await import("./workspace");
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

  it("creates the work branch and pushes it back to the origin", async () => {
    const branch = "agrippa/run-1-abcd1234";
    await scm.createBranch(runId, branch);
    // -B is idempotent for retries
    await scm.createBranch(runId, branch);
    await scm.push(runId, { projectId, repo: { repoConnectionId }, branch });

    const res = Bun.spawnSync(["git", "rev-parse", "--verify", branch], {
      cwd: sourceDir,
      stdout: "pipe",
      stderr: "ignore",
    });
    expect(res.exitCode).toBe(0);
    // the diff still reports against the clone base after branching
    expect(await workspace.diff(runId)).toContain("committed line");
  });

  it("falls back to a worktree diff when the base ref is missing", async () => {
    const dir = workspaceDirFor(runId);
    await git(["update-ref", "-d", "refs/agrippa/base"], dir);
    await Bun.write(path.join(dir, "uncommitted.txt"), "worktree only\n");

    const diff = await workspace.diff(runId);
    expect(diff).toContain("uncommitted.txt"); // worktree changes still visible
    expect(diff).not.toContain("committed line"); // pre-base-ref behavior
  });
});
