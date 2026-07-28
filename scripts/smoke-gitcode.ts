/**
 * Manual GitCode smoke — run by hand, never in CI (precedent: the Claude
 * executor's env-gated live smoke, docs/design/09). Verifies the live auth
 * paths the loopback tests cannot: token → username resolution, authenticated
 * read, and an end-to-end push of a throwaway ref (the remote default-branch
 * head under refs/heads/agrippa-smoke-<epoch>, deleted afterwards — no
 * content changes, nothing left behind).
 *
 *   GITCODE_SMOKE_URL=https://gitcode.com/you/repo.git \
 *   GITCODE_SMOKE_TOKEN=... bun scripts/smoke-gitcode.ts
 */
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gitcodeCredentialedUrl } from "../apps/worker/src/deps/scm";

const url = process.env.GITCODE_SMOKE_URL;
const token = process.env.GITCODE_SMOKE_TOKEN;
if (!url || !token) {
  console.error("usage: GITCODE_SMOKE_URL=… GITCODE_SMOKE_TOKEN=… bun scripts/smoke-gitcode.ts");
  process.exit(1);
}

const scrub = (text: string): string => text.replaceAll(token, "***");

async function run(cmd: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(scrub(`${cmd[0]} ${cmd[1]} failed (${code}): ${err.trim()}`));
  return out;
}

let failed = false;
const step = async (name: string, fn: () => Promise<string>): Promise<void> => {
  try {
    const detail = await fn();
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failed = true;
    console.error(`FAIL  ${name} — ${scrub(String(error))}`);
  }
};

const pushUrl = await gitcodeCredentialedUrl(url, token);
const username = new URL(pushUrl).username;

await step("resolve username via /user", async () =>
  username === "x-access-token"
    ? Promise.reject(new Error("fell back to x-access-token — token rejected by the v5 API?"))
    : `login=${username}`,
);

await step("authenticated ls-remote", async () => {
  const out = await run(["git", "ls-remote", pushUrl, "HEAD"]);
  return `HEAD=${out.split("\t")[0]?.slice(0, 12)}`;
});

await step("push + delete throwaway ref", async () => {
  const ref = `refs/heads/agrippa-smoke-${Math.floor(performance.timeOrigin + performance.now())}`;
  const dir = mkdtempSync(path.join(tmpdir(), "gitcode-smoke-"));
  try {
    await run(["git", "clone", "--depth", "1", pushUrl, dir]);
    await run(["git", "push", pushUrl, `HEAD:${ref}`], dir);
    await run(["git", "push", pushUrl, `:${ref}`], dir);
    return ref.split("/").pop() ?? ref;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

process.exit(failed ? 1 : 0);
