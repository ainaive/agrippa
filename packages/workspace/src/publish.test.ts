import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyApprovedPatch,
  buildPlatformGitEnv,
  checkoutFromUrl,
  platformBaseSha,
  TipConflictError,
  workspaceDirFor,
} from "./index";

const sh = (args: string[], cwd?: string): string => {
  const res = Bun.spawnSync(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: buildPlatformGitEnv(process.env, {
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "f@example.com",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "f@example.com",
    }),
  });
  if (res.exitCode !== 0) throw new Error(`git ${args[0]}: ${res.stderr.toString()}`);
  return res.stdout.toString();
};

let origin: string;
let baseSha: string;
let textPatch: string;
let binaryPatch: string;

describe("applyApprovedPatch (publication inversion)", () => {
  beforeAll(() => {
    // a bare origin with one base commit, plus a scratch clone that produces
    // the approved patches the same way the platform snapshot does
    origin = `${mkdtempSync(path.join(tmpdir(), "agrippa-origin-"))}/repo.git`;
    sh(["init", "--bare", "-b", "main", origin]);
    const work = mkdtempSync(path.join(tmpdir(), "agrippa-work-"));
    sh(["clone", origin, work]);
    Bun.write(path.join(work, "README.md"), "# base\n");
    sh(["add", "-A"], work);
    sh(["commit", "-m", "init"], work);
    sh(["push", "origin", "main"], work);
    baseSha = sh(["rev-parse", "HEAD"], work).trim();

    Bun.write(path.join(work, "feature.ts"), "export const ok = true;\n");
    sh(["add", "-A"], work);
    textPatch = sh(["diff", "--cached", "--binary", baseSha], work);
    sh(["reset", "--hard", baseSha], work);

    Bun.write(path.join(work, "blob.bin"), new Uint8Array([0, 1, 2, 255, 254, 253, 0, 7]));
    sh(["add", "-A"], work);
    binaryPatch = sh(["diff", "--cached", "--binary", baseSha], work);
  });

  it("applies the approved patch to a pristine base and pushes deterministically", async () => {
    const first = await applyApprovedPatch({
      fetchSource: origin,
      fetchRef: baseSha,
      baseSha,
      branch: "agrippa/run-1-aaaaaaaaaaaa",
      patch: textPatch,
      pushUrl: origin,
    });
    expect(sh(["show", "agrippa/run-1-aaaaaaaaaaaa:feature.ts"], origin).toString()).toBe(
      "export const ok = true;\n",
    );

    // retry: byte-identical commit found at the remote tip — no second push
    const retry = await applyApprovedPatch({
      fetchSource: origin,
      fetchRef: baseSha,
      baseSha,
      branch: "agrippa/run-1-aaaaaaaaaaaa",
      patch: textPatch,
      pushUrl: origin,
    });
    expect(retry).toEqual(first);
    expect(sh(["rev-list", "--count", `main..agrippa/run-1-aaaaaaaaaaaa`], origin).trim()).toBe(
      "1",
    );
  });

  it("refuses to overwrite a branch tip that is not the approved snapshot commit", async () => {
    // someone (or something) advanced the publish branch — never clobber it
    sh(["update-ref", "refs/heads/agrippa/run-1-aaaaaaaaaaaa", baseSha], origin);
    await expect(
      applyApprovedPatch({
        fetchSource: origin,
        fetchRef: baseSha,
        baseSha,
        branch: "agrippa/run-1-aaaaaaaaaaaa",
        patch: textPatch,
        pushUrl: origin,
      }),
    ).rejects.toThrow(/does not match the approved snapshot commit/);
  });

  it("carries binary patches", async () => {
    await applyApprovedPatch({
      fetchSource: origin,
      fetchRef: baseSha,
      baseSha,
      branch: "agrippa/run-2-bbbbbbbbbbbb",
      patch: binaryPatch,
      pushUrl: origin,
    });
    const cat = Bun.spawnSync(["git", "cat-file", "blob", "agrippa/run-2-bbbbbbbbbbbb:blob.bin"], {
      cwd: origin,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(cat.exitCode).toBe(0);
    expect(new Uint8Array(cat.stdout)).toEqual(new Uint8Array([0, 1, 2, 255, 254, 253, 0, 7]));
  });

  it("rejects an empty approved patch", async () => {
    await expect(
      applyApprovedPatch({
        fetchSource: origin,
        fetchRef: baseSha,
        baseSha,
        branch: "agrippa/run-3-cccccccccccc",
        patch: "",
        pushUrl: origin,
      }),
    ).rejects.toThrow(/nothing to publish/);
  });
});

describe("applyApprovedPatch expected-tip CAS (ADR-0019)", () => {
  let chainOrigin: string;
  let chainBase: string;
  let patch1: string; // base → one.ts
  let patch2: string; // base → one.ts + two.ts — CUMULATIVE, the chain's shape
  let patch3: string; // base → one.ts + three.ts — a competing cumulative steer

  const spec = (branch: string, patch: string, expectedTip?: string) => ({
    fetchSource: chainOrigin,
    fetchRef: chainBase,
    baseSha: chainBase,
    branch,
    patch,
    pushUrl: chainOrigin,
    expectedTip,
  });

  beforeAll(() => {
    chainOrigin = `${mkdtempSync(path.join(tmpdir(), "agrippa-chain-origin-"))}/repo.git`;
    sh(["init", "--bare", "-b", "main", chainOrigin]);
    const work = mkdtempSync(path.join(tmpdir(), "agrippa-chain-work-"));
    sh(["clone", chainOrigin, work]);
    writeFileSync(path.join(work, "README.md"), "# chain\n");
    sh(["add", "-A"], work);
    sh(["commit", "-m", "init"], work);
    sh(["push", "origin", "main"], work);
    chainBase = sh(["rev-parse", "HEAD"], work).trim();

    writeFileSync(path.join(work, "one.ts"), "one\n");
    sh(["add", "-A"], work);
    patch1 = sh(["diff", "--cached", "--binary", chainBase], work);
    writeFileSync(path.join(work, "two.ts"), "two\n");
    sh(["add", "-A"], work);
    patch2 = sh(["diff", "--cached", "--binary", chainBase], work);
    sh(["reset", "--hard", chainBase], work);
    writeFileSync(path.join(work, "one.ts"), "one\n");
    writeFileSync(path.join(work, "three.ts"), "three\n");
    sh(["add", "-A"], work);
    patch3 = sh(["diff", "--cached", "--binary", chainBase], work);
  });

  it("advances the tip by exactly one commit parented on the last published snapshot", async () => {
    const branch = "agrippa/chain-advance";
    const first = await applyApprovedPatch(spec(branch, patch1));

    const advance = await applyApprovedPatch(spec(branch, patch2, first.commitSha));
    expect(advance.pushed).toBe(true);
    expect(sh(["rev-parse", `${branch}^`], chainOrigin).trim()).toBe(first.commitSha);
    expect(sh(["show", `${branch}:two.ts`], chainOrigin)).toBe("two\n");

    // determinism holds with the extra input: a retry reproduces the commit
    const retry = await applyApprovedPatch(spec(branch, patch2, first.commitSha));
    expect(retry).toEqual(advance);
    expect(sh(["rev-list", "--count", `main..${branch}`], chainOrigin).trim()).toBe("2");
  });

  it("an unchanged steer returns the expected tip and pushes nothing", async () => {
    const branch = "agrippa/chain-noop";
    const first = await applyApprovedPatch(spec(branch, patch1));

    const noop = await applyApprovedPatch(spec(branch, patch1, first.commitSha));
    expect(noop).toEqual({ commitSha: first.commitSha, treeSha: first.treeSha, pushed: false });
    expect(sh(["rev-parse", branch], chainOrigin).trim()).toBe(first.commitSha);
  });

  it("a diverged tip refuses typed and leaves the branch untouched", async () => {
    const branch = "agrippa/chain-conflict";
    const first = await applyApprovedPatch(spec(branch, patch1));
    // someone moved the branch: the platform's record no longer matches
    sh(["update-ref", `refs/heads/${branch}`, chainBase], chainOrigin);

    const err = await applyApprovedPatch(spec(branch, patch2, first.commitSha)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TipConflictError);
    expect((err as TipConflictError).observedTip).toBe(chainBase);
    expect(sh(["rev-parse", branch], chainOrigin).trim()).toBe(chainBase);
  });

  it("an unchanged steer on a branch a human has advanced refuses typed", async () => {
    // "nothing new to publish" is a claim about a remote the chain still
    // describes — never a stale success over one it no longer does. The human
    // commit DESCENDS from E, so the expected parent is fetchable and the
    // refusal comes from the no-op guard itself, not the missing-parent path.
    const branch = "agrippa/chain-noop-moved";
    const first = await applyApprovedPatch(spec(branch, patch1));
    const human = sh(
      ["commit-tree", `${first.commitSha}^{tree}`, "-p", first.commitSha, "-m", "human touch-up"],
      chainOrigin,
    ).trim();
    sh(["update-ref", `refs/heads/${branch}`, human], chainOrigin);

    const err = await applyApprovedPatch(spec(branch, patch1, first.commitSha)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TipConflictError);
    expect((err as TipConflictError).observedTip).toBe(human);
    expect(sh(["rev-parse", branch], chainOrigin).trim()).toBe(human);
  });

  it("two racing advances from one tip: exactly one lands, the loser conflicts typed", async () => {
    // whichever window the loser hits — before its ls-remote or inside the
    // push lease — the surfaced error must be the same typed conflict
    const branch = "agrippa/chain-race";
    const first = await applyApprovedPatch(spec(branch, patch1));

    const results = await Promise.allSettled([
      applyApprovedPatch(spec(branch, patch2, first.commitSha)),
      applyApprovedPatch(spec(branch, patch3, first.commitSha)),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won.length).toBe(1);
    expect(lost.length).toBe(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(TipConflictError);
    // exactly one advance landed, parented on the shared tip
    expect(sh(["rev-parse", `${branch}^`], chainOrigin).trim()).toBe(first.commitSha);
    expect(sh(["rev-list", "--count", `main..${branch}`], chainOrigin).trim()).toBe("2");
  });

  it("a push that fails with the tip unmoved stays a plain error, not a conflict", async () => {
    const branch = "agrippa/chain-broken-remote";
    const first = await applyApprovedPatch(spec(branch, patch1));
    Bun.spawnSync(["chmod", "-R", "a-w", chainOrigin]);
    try {
      const err = await applyApprovedPatch(spec(branch, patch2, first.commitSha)).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TipConflictError);
      expect((err as Error).message).toMatch(/git push failed/);
    } finally {
      Bun.spawnSync(["chmod", "-R", "u+w", chainOrigin]);
    }
  });

  it("a chain whose branch was deleted after publishing refuses typed", async () => {
    const branch = "agrippa/chain-deleted";
    const first = await applyApprovedPatch(spec(branch, patch1));
    sh(["update-ref", "-d", `refs/heads/${branch}`], chainOrigin);

    // the expected parent is unreachable AND the tip is gone — never recreated
    const err = await applyApprovedPatch(spec(branch, patch2, first.commitSha)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(TipConflictError);
    expect((err as TipConflictError).observedTip).toBeNull();
  });
});

describe("checkoutFromUrl (server-pinned base, ADR-0017)", () => {
  let pinOrigin: string;
  let pinSha: string;
  let movedSha: string;
  let savedRoot: string | undefined;

  beforeAll(async () => {
    savedRoot = process.env.WORKSPACE_ROOT;
    process.env.WORKSPACE_ROOT = mkdtempSync(path.join(tmpdir(), "agrippa-pin-ws-"));

    pinOrigin = `${mkdtempSync(path.join(tmpdir(), "agrippa-pin-origin-"))}/repo.git`;
    sh(["init", "--bare", "-b", "main", pinOrigin]);
    const work = mkdtempSync(path.join(tmpdir(), "agrippa-pin-work-"));
    sh(["clone", pinOrigin, work]);
    await Bun.write(path.join(work, "README.md"), "# pinned\n");
    sh(["add", "-A"], work);
    sh(["commit", "-m", "pinned base"], work);
    pinSha = sh(["rev-parse", "HEAD"], work).trim();
    await Bun.write(path.join(work, "later.txt"), "moved past the pin\n");
    sh(["add", "-A"], work);
    sh(["commit", "-m", "branch moved"], work);
    movedSha = sh(["rev-parse", "HEAD"], work).trim();
    sh(["push", "origin", "main"], work);
  });

  afterAll(() => {
    if (savedRoot === undefined) delete process.env.WORKSPACE_ROOT;
    else process.env.WORKSPACE_ROOT = savedRoot;
  });

  it("forces HEAD and the trusted base ref to the pin when the branch moved past it", async () => {
    const runId = crypto.randomUUID();
    await checkoutFromUrl(runId, {
      cloneUrl: pinOrigin,
      displayUrl: pinOrigin,
      ref: "main",
      pinSha,
    });
    expect(movedSha).not.toBe(pinSha); // the fixture really did move
    expect(sh(["rev-parse", "HEAD"], workspaceDirFor(runId)).trim()).toBe(pinSha);
    expect(await platformBaseSha(runId)).toBe(pinSha);
  });

  it("fails typed when the pinned commit does not exist at origin", async () => {
    await expect(
      checkoutFromUrl(crypto.randomUUID(), {
        cloneUrl: pinOrigin,
        displayUrl: pinOrigin,
        ref: "main",
        pinSha: "0123456789012345678901234567890123456789",
      }),
    ).rejects.toThrow(/not fetchable from origin/);
  });
});
