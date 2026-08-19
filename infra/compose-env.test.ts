/**
 * Every operator knob the server code reads must survive the trip into a
 * container.
 *
 * Compose services declare an explicit `environment:` map, so a value in
 * infra/env/.env reaches a process ONLY where its service names it — unlike the
 * systemd topology, whose `EnvironmentFile=` passes the whole file. That
 * asymmetry is invisible at every point where it matters: the code reads the
 * variable and falls back, the docs describe the knob, the operator sets it,
 * and nothing anywhere reports that the value was dropped on the way in.
 *
 * It had gone wrong eight times by the M3 closeout — five worker knobs
 * (workspace retention, both inactivity watchdogs, the platform-retry backoff,
 * the queued-run deadline) and three more (the follow-up token bound, the
 * follow-up coalesce window, and the HSTS lifetime, whose *documented rollback*
 * is to serve `max-age=0` and so could not be performed at all). Each was
 * documented in design 08 or manual 06 as a working control.
 *
 * The scan is deliberately over source rather than over a hand-kept list: a
 * knob added in a future milestone is caught by existing without being wired,
 * which is exactly how the eight arrived. Exceptions are enumerated with a
 * reason apiece — the point is that dropping a variable is a decision someone
 * writes down, not a silent default.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const composePath = path.join(repoRoot, "infra", "docker-compose.yml");

/**
 * Knobs deliberately not passed through compose. A name here is a claim that
 * the container gets its value some other way — verified by the reason.
 */
const NOT_PASSED: Record<string, string> = {
  // The bootstrap runbook passes these with `compose exec -e` for a single
  // command precisely so an admin password never persists in the env file.
  AGRIPPA_BOOTSTRAP_EMAIL: "one-time `compose exec -e`, never persisted to .env",
  AGRIPPA_BOOTSTRAP_PASSWORD: "one-time `compose exec -e`, never persisted to .env",
  // Baked into the images (Dockerfile.api / Dockerfile.worker `ENV`), because
  // the paths describe that image's own layout, not an operator's choice.
  AGRIPPA_TEMPLATES_DIR: "set by ENV in both Dockerfiles — image layout, not operator config",
  AGRIPPA_WEB_DIST: "set by ENV in Dockerfile.api — image layout, not operator config",
  // A fixture name, used only to exercise envNumber's parsing.
  AGRIPPA_TEST_KNOB: "test fixture (packages/orchestration/src/engine/watchdog.test.ts)",
};

/** Source trees whose env reads run inside a compose container. */
const SERVER_SOURCE = [
  "apps/api/src",
  "apps/worker/src",
  "packages/orchestration/src",
  "packages/executor-core/src",
  "packages/executor-claude/src",
  "packages/executor-codex/src",
  "packages/workspace/src",
];

/** apps/daemon runs on an operator's own machine, not under this compose file. */
const walk = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
};

/** `process.env.X`, `process.env["X"]`, and the `envNumber("X", …)` helper. */
const readEnvNames = (source: string): string[] => {
  const names: string[] = [];
  const patterns = [
    /process\.env\.(AGRIPPA_[A-Z0-9_]+)/g,
    /process\.env\[["'](AGRIPPA_[A-Z0-9_]+)["']\]/g,
    /envNumber\(\s*["'](AGRIPPA_[A-Z0-9_]+)["']/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) names.push(m[1] as string);
  }
  return names;
};

const knobsReadInSource = (): Set<string> => {
  const found = new Set<string>();
  for (const rel of SERVER_SOURCE) {
    for (const file of walk(path.join(repoRoot, rel))) {
      for (const name of readEnvNames(readFileSync(file, "utf8"))) found.add(name);
    }
  }
  return found;
};

/**
 * Collect the keys of every `environment:` block in the compose file.
 *
 * Hand-parsed rather than via the `yaml` package, which is a dependency of
 * apps/api and packages/orchestration but not of the root, so it does not
 * resolve from infra/. The block shape is the narrow part of YAML — an
 * `environment:` line, then `KEY: value` at deeper indentation until the first
 * dedent — and the sanity assertion below is what stops a parser that quietly
 * matches nothing from turning the whole file green.
 */
const composeEnvKeys = (): Set<string> => {
  const keys = new Set<string>();
  const lines = readFileSync(composePath, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const opener = /^(\s*)environment:\s*$/.exec(lines[i] as string);
    if (!opener) continue;
    const blockIndent = (opener[1] as string).length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] as string;
      if (line.trim() === "" || /^\s*#/.test(line)) continue;
      const indent = line.length - line.trimStart().length;
      if (indent <= blockIndent) break; // dedent ends the block
      // Compose accepts a `KEY=value` list as well as a map; take both.
      const entry = /^\s*-?\s*([A-Z_][A-Z0-9_]*)\s*[:=]/.exec(line);
      if (entry) keys.add(entry[1] as string);
    }
  }
  return keys;
};

describe("compose passes every operator knob the server reads", () => {
  it("both scans find something — otherwise every assertion below is vacuously true", () => {
    // The failure mode this guards is the one that makes config tests useless:
    // a parser that matches nothing, or a source scan pointed at a moved
    // directory, reports perfect compliance. Floors, not exact counts, so
    // ordinary additions do not churn the test.
    expect(composeEnvKeys().size).toBeGreaterThan(10);
    expect(knobsReadInSource().size).toBeGreaterThan(10);
    expect(composeEnvKeys()).toContain("AGRIPPA_SECRET_KEY");
  });

  it("no AGRIPPA_* knob read by server code is dropped on the way into a container", () => {
    const passed = composeEnvKeys();
    const missing = [...knobsReadInSource()]
      .filter((name) => !passed.has(name) && !(name in NOT_PASSED))
      .sort();
    expect(missing).toEqual([]);
  });

  it("every documented exception is genuinely absent, so the list cannot rot into a lie", () => {
    const passed = composeEnvKeys();
    // A name that IS passed but still sits in NOT_PASSED means the exception's
    // reason no longer describes reality — the next reader would trust it.
    const contradicted = Object.keys(NOT_PASSED)
      .filter((name) => passed.has(name))
      .sort();
    expect(contradicted).toEqual([]);
  });

  it("the knobs whose absence actually broke a documented control are wired", () => {
    const passed = composeEnvKeys();
    // Named individually rather than left to the scan: these are the eight the
    // closeout found, and each one's absence made a specific published sentence
    // false. A regression here should say which control stopped working.
    for (const name of [
      "AGRIPPA_WORKSPACE_RETENTION_MINUTES",
      "AGRIPPA_FOLLOWUP_MAX_TOKENS",
      "AGRIPPA_FOLLOWUP_COALESCE_SECONDS",
      "AGRIPPA_STEP_IDLE_MINUTES",
      "AGRIPPA_STEP_NO_PROGRESS_MINUTES",
      "AGRIPPA_PLATFORM_RETRY_BACKOFF_SECONDS",
      "AGRIPPA_RUN_QUEUED_DEADLINE_HOURS",
      "AGRIPPA_HSTS_MAX_AGE",
      // The ninth, found by the scan above rather than by reading docs: compose
      // already had this value as the image tag, so it was defined everywhere
      // and reached nothing. Every worker heartbeat carried a null version and
      // Admin → Workers rendered the column blank.
      "AGRIPPA_VERSION",
    ]) {
      expect(passed).toContain(name);
    }
  });
});
