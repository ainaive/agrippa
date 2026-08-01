/**
 * Compile the daemon into a single self-contained binary (ADR-0017): the
 * executor packages, workspace core, and protocol client embed via Bun's
 * bundler, so a team machine needs only this file plus its own CLI logins.
 */
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const entry = path.join(root, "apps/daemon/src/index.ts");
const outfile = path.join(root, "dist/agrippa-daemon");

const proc = Bun.spawn(["bun", "build", "--compile", entry, "--outfile", outfile], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(await proc.exited);
