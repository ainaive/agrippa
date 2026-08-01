import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyApprovedPatch,
  buildPlatformGitEnv,
  checkoutFromUrl,
  platformBaseSha,
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
