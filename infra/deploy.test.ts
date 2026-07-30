/**
 * Behavioural tests for infra/deploy.sh.
 *
 * Every property asserted here is one a review has actually broken at least
 * once — an off-branch commit being deployable as root, `up -d` failing without
 * rollback, images tagged with a short SHA, dumps landing world-readable. They
 * were each verified by hand against the live host, which does not survive the
 * next refactor; this does.
 *
 * Deliberately no Docker. The script's dependencies (`docker`, `id`, `sleep`,
 * `timeout`) are replaced by stubs earlier on PATH, so these run in CI where no
 * daemon exists. `git` stays real — the commit-reachability check is the whole
 * privilege boundary and stubbing it would test nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(import.meta.dirname, "deploy.sh");

/** A `docker` stub: enough of the surface deploy.sh touches, scenario-driven by env. */
const DOCKER_STUB = `#!/usr/bin/env bash
# Records what it was asked to do so tests can assert on ordering, and answers
# the handful of queries deploy.sh makes. Scenarios come from STUB_* env vars.
# AGRIPPA_VERSION is logged because it arrives via the environment, not argv —
# it is the tag the build actually uses, so tests must be able to see it.
echo "$* [AGRIPPA_VERSION=\${AGRIPPA_VERSION:-}]" >> "$STUB_LOG"

# flags precede the subcommand (docker compose -f X --env-file Y <sub>), so
# scan for it rather than indexing positionally
for a in "$@"; do
  case "$a" in config|ps|build|up|exec|logs|stop|start) sub="$a"; break;; esac
done

case "$1" in
  compose)
    case "$sub" in
      config)
        # deploy.sh greps this for the tag it expects to have set
        [ "\${STUB_CONFIG_TAG:-1}" = "1" ] &&
          echo "    image: ghcr.io/ainaive/agrippa-api:\${AGRIPPA_VERSION}"
        exit 0 ;;
      ps)
        case "$*" in
          *"--services"*)  printf 'postgres\\napi\\nworker\\n' ;;
          *"{{.Health}}"*) echo "\${STUB_API_HEALTH:-healthy}" ;;
          *"{{.Service}}"*)
            for _ in $(seq 1 "\${STUB_WORKERS_RUNNING:-1}"); do echo worker; done ;;
        esac
        exit 0 ;;
      build) exit "\${STUB_BUILD_RC:-0}" ;;
      up)    exit "\${STUB_UP_RC:-0}" ;;
      logs)  exit 0 ;;
      exec)
        case "$*" in
          *pg_dump*) printf 'FAKEDUMP'; exit "\${STUB_DUMP_RC:-0}" ;;
          *psql*)
            # the worker readiness probe; STUB_PROBE_DELAY makes it slow
            [ -n "\${STUB_PROBE_DELAY:-}" ] && /bin/sleep "$STUB_PROBE_DELAY"
            echo "\${STUB_REGISTRATIONS:-1}"; exit 0 ;;
        esac
        exit 0 ;;
    esac
    exit 0 ;;
  inspect) echo "ghcr.io/ainaive/agrippa-api:\${STUB_RUNNING_TAG:-latest}"; exit 0 ;;
  images)  exit 0 ;;
  rmi)     exit 0 ;;
esac
exit 0
`;

type Scenario = Record<string, string>;

let dir: string;
let appDir: string;
let stateDir: string;
let binDir: string;
let stubLog: string;
let deploySha: string;

const run = async (scenario: Scenario = {}, args: string[] = []) => {
  const proc = Bun.spawn(["bash", SCRIPT, ...args], {
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      APP_DIR: appDir,
      STATE_DIR: stateDir,
      LOCK_FILE: path.join(dir, "lock"),
      DEPLOY_REMOTE: "selftest",
      DEPLOY_REF: "deploy",
      // small: sleeps are stubbed, so only probe time accrues, and failure
      // scenarios must finish inside bun's per-test timeout
      HEALTH_TIMEOUT: "2",
      STUB_LOG: stubLog,
      ...scenario,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode, log: readFileSync(stubLog, "utf8") };
};

const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd });

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "deploysh-"));
  appDir = path.join(dir, "app");
  stateDir = path.join(dir, "state");
  binDir = path.join(dir, "bin");
  stubLog = path.join(dir, "stub.log");
  writeFileSync(stubLog, "");

  await mkdir(binDir, { recursive: true });
  for (const [name, body] of [
    ["docker", DOCKER_STUB],
    // the script refuses to run unless euid 0; tests are not root
    ["id", "#!/usr/bin/env bash\necho 0\n"],
    // no-op so the probe loop costs nothing; the stub's own delay uses /bin/sleep
    ["sleep", "#!/usr/bin/env bash\nexit 0\n"],
    // macOS ships neither; both exist on the Linux hosts this runs on, so they
    // are stubbed rather than skipped. Consequence: the lock and the per-probe
    // kill are NOT exercised here — `timeout` passes the command straight
    // through, so what these cases prove is the deadline loop, not the kill.
    ["flock", "#!/usr/bin/env bash\nexit 0\n"],
    ["timeout", '#!/usr/bin/env bash\nshift\nexec "$@"\n'],
  ] as const) {
    const p = path.join(binDir, name);
    writeFileSync(p, body, { mode: 0o755 });
  }

  // a real repo: reachability is enforced with git, so it must be genuine
  await mkdir(path.join(appDir, "infra", "env"), { recursive: true });
  writeFileSync(path.join(appDir, "infra", "docker-compose.yml"), "services:\n  api:\n");
  writeFileSync(path.join(appDir, "infra", "env", ".env"), "AGRIPPA_PORT=127.0.0.1:3001\n");
  git(appDir, "init", "-q", "-b", "main");
  git(appDir, "add", "-A");
  git(appDir, "commit", "-qm", "base");
  git(appDir, "branch", "-f", "deploy", "HEAD");
  // fetched from itself, so `git fetch selftest` resolves without a network
  git(appDir, "remote", "add", "selftest", appDir);
  deploySha = new TextDecoder().decode(git(appDir, "rev-parse", "deploy").stdout).trim();
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("infra/deploy.sh", () => {
  it("refuses a commit that is not reachable from the deploy branch", async () => {
    // the privilege boundary: janus passes this argument, so it must be verified
    git(appDir, "checkout", "-q", "-b", "feature");
    writeFileSync(path.join(appDir, "infra", "docker-compose.yml"), "services:\n  evil:\n");
    git(appDir, "commit", "-aqm", "hostile");
    const offBranch = new TextDecoder().decode(git(appDir, "rev-parse", "HEAD").stdout).trim();
    git(appDir, "checkout", "-q", "main");

    const r = await run({}, [offBranch]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("not reachable from");
    // and it bailed before doing anything expensive or destructive
    expect(r.log).not.toContain("build");
    expect(r.log).not.toContain("up -d");
  });

  it("deploys the happy path, tagging with the full SHA", async () => {
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("healthy");
    // the build ran with the FULL 40-char SHA as its tag, not a 7-char prefix
    // that a collision could overwrite
    expect(r.log).toContain(`build [AGRIPPA_VERSION=${deploySha}]`);
    expect(readFileSync(path.join(stateDir, "last-good"), "utf8").trim()).toBe(deploySha);
  });

  it("keeps the dump private to root", async () => {
    await run();
    const dumps = [...new Bun.Glob("pgdump-*.dump").scanSync(stateDir)];
    expect(dumps.length).toBe(1);
    expect(statSync(path.join(stateDir, dumps[0] as string)).mode & 0o777).toBe(0o600);
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
  });

  it("retains only the newest KEEP_DUMPS dumps", async () => {
    // dumps are a full copy of production, so unbounded retention is both a
    // disk and an exposure problem. Seed more than the cap with distinct mtimes
    // so "newest" is well defined, then check the oldest are the ones dropped.
    mkdirSync(stateDir, { recursive: true });
    const seeded = ["0001", "0002", "0003", "0004", "0005", "0006"].map((n) => {
      const f = path.join(stateDir, `pgdump-2026010${n[3]}-000000-seed${n}.dump`);
      writeFileSync(f, "old");
      return f;
    });
    for (const [i, f] of seeded.entries()) {
      const t = new Date(1e9 + i * 1000);
      utimesSync(f, t, t);
    }

    const r = await run({ KEEP_DUMPS: "3" });
    expect(r.exitCode).toBe(0);

    const left = [...new Bun.Glob("pgdump-*.dump").scanSync(stateDir)].sort();
    expect(left.length).toBe(3);
    // the run's own dump survives, and so do the two newest seeds
    expect(left.some((f) => f.includes("seed0006"))).toBe(true);
    expect(left.some((f) => f.includes("seed0005"))).toBe(true);
    expect(left.some((f) => f.includes("seed0001"))).toBe(false);
  });

  it("rolls back when docker compose up -d fails", async () => {
    const r = await run({ STUB_UP_RC: "1" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("up -d failed");
    expect(r.stderr).toContain("rolling back");
  }, 20_000);

  it("rolls back when the api never becomes healthy", async () => {
    const r = await run({ STUB_API_HEALTH: "starting" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("api never became healthy");
    expect(r.stderr).toContain("rolling back");
  }, 20_000);

  it("fails when a worker replica is not running, even with a fresh registration", async () => {
    // the case that used to pass: api healthy, registration present, worker dead
    const r = await run({ STUB_WORKERS_RUNNING: "0", STUB_REGISTRATIONS: "1" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("worker never became ready");
  }, 20_000);

  it("aborts before building when the version does not reach compose", async () => {
    // guards the class of bug where the tag silently fails to propagate
    const r = await run({ STUB_CONFIG_TAG: "0" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("did not reach compose");
  });

  it("treats HEALTH_TIMEOUT as wall-clock even when probes are slow", async () => {
    // each probe sleeps 2s; with sleep stubbed out, only probe time accumulates.
    // Counting sleeps instead of elapsed time would loop far past the budget.
    const started = Date.now();
    const r = await run({
      HEALTH_TIMEOUT: "3",
      STUB_API_HEALTH: "starting",
      STUB_PROBE_DELAY: "1",
    });
    const elapsed = (Date.now() - started) / 1000;
    expect(r.exitCode).not.toBe(0);
    // budget + one in-flight probe + process startup. Counting sleeps instead
    // of elapsed time would run several multiples of this.
    expect(elapsed).toBeLessThan(12);
  }, 20_000);

  it("prints a recovery procedure that drops and recreates, not --clean", async () => {
    const r = await run({ STUB_UP_RC: "1" });
    expect(r.stderr).toContain("dropdb");
    expect(r.stderr).toContain("createdb");
    expect(r.stderr).toContain("--single-transaction");
    // the pg_restore invocation itself must not use --clean: it only drops what
    // the archive holds, so it cannot remove tables a failed migration added.
    // (The surrounding prose explains that, so match the command, not the word.)
    expect(r.stderr).not.toContain("-d agrippa --clean");
  }, 20_000);
});
