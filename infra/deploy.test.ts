/**
 * Behavioural tests for infra/deploy.sh.
 *
 * Every property asserted here is one a review has actually broken at least
 * once — an off-branch commit being deployable as root, `up -d` failing without
 * rollback, images tagged with a short SHA, dumps landing world-readable. They
 * were each verified by hand against the live host, which does not survive the
 * next refactor; this does.
 *
 * Every case carries an explicit timeout. They spawn bash and do real git work,
 * which overruns bun's 5s default under full-suite load — seen once as a flake in
 * the reachability case, where the 5s cap fired on a run that took 93s of wall
 * clock. The ceilings are generous on purpose: none of them is an assertion,
 * except in the wall-clock case, where the bound IS the thing under test.
 *
 * Deliberately no Docker. The script's dependencies (`docker`, `id`, `sleep`,
 * `timeout`) are replaced by stubs earlier on PATH, so these run in CI where no
 * daemon exists. `git` stays real — the commit-reachability check is the whole
 * privilege boundary and stubbing it would test nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  copyFileSync,
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
          *"{{.Health}}"*)
            # STUB_HEALTH_DELAY paces the probe loop, so a case that measures
            # iterations does not busy-spin and starve its sibling tests
            [ -n "\${STUB_HEALTH_DELAY:-}" ] && /bin/sleep "$STUB_HEALTH_DELAY"
            echo "\${STUB_API_HEALTH:-healthy}" ;;
          *"{{.Service}}"*)
            for _ in $(seq 1 "\${STUB_WORKERS_RUNNING:-1}"); do echo worker; done ;;
          *"-q"*)
            for i in $(seq 1 "\${STUB_WORKERS_RUNNING:-1}"); do echo "workerctr$i"; done ;;
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
  inspect)
    case "$*" in
      *RestartCount*)
        # STUB_RESTART_GROWS simulates a crash-looping worker: the count must
        # CHANGE between probes, so a fixed value would not reproduce it.
        if [ "\${STUB_RESTART_GROWS:-0}" = "1" ]; then
          c=$(cat "$STUB_LOG.restarts" 2>/dev/null || echo 0)
          c=$((c + 1)); echo "$c" > "$STUB_LOG.restarts"; echo "$c"
        else
          echo "\${STUB_RESTART_COUNT:-0}"
        fi ;;
      *) echo "ghcr.io/ainaive/agrippa-api:\${STUB_RUNNING_TAG:-latest}" ;;
    esac
    exit 0 ;;
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

/** `script` defaults to the repo's copy; the self-rewrite case runs the fixture's. */
const run = async (scenario: Scenario = {}, args: string[] = [], script = SCRIPT) => {
  const proc = Bun.spawn(["bash", script, ...args], {
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

/**
 * Assert EVERY compose invocation names the project — not merely that one did.
 *
 * The first version of this asserted `expect(r.log).toContain("-p agrippa")`
 * over the whole log, which passes if a single call carries the flag. The
 * worker readiness probe had never carried it, and those tests were green
 * anyway. Asserting over an aggregate cannot see a missing element; the check
 * has to be per-invocation.
 *
 * The stub writes one line per `docker` call containing its full argv, so a
 * compose call is a line beginning with "compose ".
 */
const expectEveryComposeCallIsPinned = (log: string, project: string) => {
  const calls = log.split("\n").filter((l) => l.startsWith("compose "));
  // guard against the filter silently matching nothing and passing vacuously
  expect(calls.length).toBeGreaterThan(3);
  const unpinned = calls.filter((l) => !l.includes(`-p ${project} `));
  expect(unpinned).toEqual([]);
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
  writeFileSync(
    path.join(appDir, "infra", "docker-compose.yml"),
    "name: agrippa\nservices:\n  api:\n",
  );
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
  }, 20_000);

  it("deploys the happy path, tagging with the full SHA", async () => {
    const r = await run();
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("healthy");
    // the build ran with the FULL 40-char SHA as its tag, not a 7-char prefix
    // that a collision could overwrite
    expect(r.log).toContain(`build [AGRIPPA_VERSION=${deploySha}]`);
    expect(readFileSync(path.join(stateDir, "last-good"), "utf8").trim()).toBe(deploySha);
  }, 20_000);

  it("keeps the dump private to root", async () => {
    await run();
    const dumps = [...new Bun.Glob("pgdump-*.dump").scanSync(stateDir)];
    expect(dumps.length).toBe(1);
    expect(statSync(path.join(stateDir, dumps[0] as string)).mode & 0o777).toBe(0o600);
    expect(statSync(stateDir).mode & 0o777).toBe(0o700);
  }, 20_000);

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
  }, 20_000);

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
  }, 20_000);

  it("treats HEALTH_TIMEOUT as wall-clock even when probes are slow", async () => {
    // PROBE COUNT is the discriminator, not elapsed time. `sleep` is stubbed to a
    // no-op, so a loop that tracks a real deadline keeps probing for the whole
    // budget, while one that counts its own sleeps satisfies the budget after a
    // single iteration and gives up early.
    //
    // Elapsed seconds cannot separate the two, which two earlier versions of this
    // assertion got wrong: an upper bound passes for both, and a lower bound is
    // dominated by script startup because `api_ok && worker_ok` short-circuits
    // before the slow psql probe when the api is unhealthy. Both survived the
    // mutation. Each probe is paced by STUB_HEALTH_DELAY so counting iterations
    // does not busy-spin and starve the sibling tests.
    const budget = 3;
    const started = Date.now();
    const r = await run({
      HEALTH_TIMEOUT: String(budget),
      STUB_API_HEALTH: "starting",
      STUB_HEALTH_DELAY: "0.4",
    });
    const elapsed = (Date.now() - started) / 1000;
    expect(r.exitCode).not.toBe(0);

    // Measured: 13 with the deadline honoured, 4 without. The failing count is
    // deterministic — two probes per stack_ok call, and stack_ok runs twice
    // (deploy, then rollback) — while the passing count scales with budget/delay
    // and only shrinks under load. So the threshold sits just above the fixed
    // failing value rather than near the passing one.
    const probes = (r.log.match(/\{\{\.Health}}/g) ?? []).length;
    expect(probes).toBeGreaterThan(5);
    // loose ceiling against a runaway loop, sized not to flake under CI load
    expect(elapsed).toBeLessThan(budget + 22);
  }, 40_000);

  it("completes when the deployed commit rewrites deploy.sh", async () => {
    // deploy.sh lives inside the tree it deploys and resets that tree, so it
    // rewrites its own file whenever the deployed commit changes it. Bash reads
    // scripts lazily, so that looks like it should be able to truncate execution
    // mid-run.
    //
    // It does not, and this pins that down: a deploy whose target commit replaces
    // deploy.sh still runs to the end. git swaps in a new inode, so the running
    // shell keeps its descriptor on the old one — confirmed on macOS and on the
    // Linux deploy host (git 2.43) by watching the inode change mid-run.
    //
    // Scope, honestly: this guards that the reset happens and the run survives
    // it. It does NOT prove immunity to an in-place rewrite. I could not build a
    // mutation that truncates this script's execution — replacing the file in
    // place, at sizes from 4 KB to 192 KB, still ran to completion — so there is
    // no failing case to assert against. Asserting on reaching the end rather
    // than the exit code, because a truncated run would exit 0.
    const inRepo = path.join(appDir, "infra", "deploy.sh");
    copyFileSync(SCRIPT, inRepo);
    chmodSync(inRepo, 0o755);
    git(appDir, "add", "-A");
    git(appDir, "commit", "-qm", "add deploy.sh");
    const c1 = new TextDecoder().decode(git(appDir, "rev-parse", "HEAD").stdout).trim();

    // The deployed version is a tiny stub, replacing the whole file rather than
    // appending to it — an appended comment leaves every earlier byte intact, so
    // nothing about the on-disk file would have changed in a way any assertion
    // could notice. It need not be a runnable script: the running process reads
    // from its own descriptor, so on disk this is only bytes.
    const deployedStub = "#!/bin/sh\nexit 0\n";
    writeFileSync(inRepo, deployedStub);
    git(appDir, "commit", "-aqm", "replace deploy.sh with a stub");
    git(appDir, "branch", "-f", "deploy", "HEAD");
    const c2 = new TextDecoder().decode(git(appDir, "rev-parse", "deploy").stdout).trim();
    // …while the working tree still holds the full script, so the reset rewrites it
    git(appDir, "reset", "--hard", "-q", c1);
    expect(readFileSync(inRepo, "utf8")).not.toBe(deployedStub); // precondition

    const r = await run({}, [], inRepo);

    // The rewrite MUST have happened, or this proves nothing. Without these two
    // the case passed even with `git reset --hard` deleted from deploy.sh.
    expect(new TextDecoder().decode(git(appDir, "rev-parse", "HEAD").stdout).trim()).toBe(c2);
    expect(readFileSync(inRepo, "utf8")).toBe(deployedStub);

    // …and the run still reached the end. Not the exit code: the in-place
    // failure mode exits 0, so an exit-code check would not see it.
    expect(r.log).toContain("build");
    expect(r.stdout).toContain("healthy");
    expect(r.stdout).toContain("deployed");
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

  it("names the compose project in the printed restore commands", async () => {
    // The restore procedure is copy-pasted by an operator into a shell that does
    // not share the deploy's environment. Without -p, `docker compose -f <file>`
    // resolves the project from that file's `name:` — so the commands act on
    // whatever stack the tree names, not the one that just failed.
    //
    // Found by drilling the restore against a throwaway stack on the live host:
    // the deploy ran under COMPOSE_PROJECT_NAME, and the printed commands would
    // have dropped the PRODUCTION database instead of the drill's. Every step
    // reported success while targeting the wrong stack, which is the worst
    // possible shape for a recovery procedure.
    const r = await run({ STUB_UP_RC: "1" });
    expect(r.stderr).toContain("-p agrippa");

    const drill = await run({ COMPOSE_PROJECT_NAME: "agrippadrill", STUB_UP_RC: "1" });
    expect(drill.stderr).toContain("-p agrippadrill");
  }, 40_000);

  it("names the compose project in every command it runs", async () => {
    // Deliberately the SUCCESS path. The restore-hint case above forces `up -d`
    // to fail, which makes rollback's own `up -d` fail too, so the script dies
    // before stack_ok — and the worker readiness probe, the one invocation that
    // spells out `docker compose` instead of using compose(), never executes.
    // Asserting pinning there proved nothing about it: the probe was missing -p
    // for two commits while these tests were green.
    //
    // One run per test, because the stub log is a file that accumulates across
    // run() calls within a test — a second run's assertions would see the first
    // run's lines and flag them under the other project's name.
    const r = await run();
    expect(r.exitCode).toBe(0);
    expectEveryComposeCallIsPinned(r.log, "agrippa");
  }, 20_000);

  it("names the overridden project in every command, not just some", async () => {
    const r = await run({ COMPOSE_PROJECT_NAME: "agrippadrill" });
    expect(r.exitCode).toBe(0);
    expectEveryComposeCallIsPinned(r.log, "agrippadrill");
  }, 20_000);

  it("fails a deploy whose worker is crash-looping, not just one that is down", async () => {
    // Compose gained `restart: unless-stopped` so the stack returns after a
    // host reboot. That alone would have made this deploy report SUCCESS: a
    // crash-looping worker is "running" between restarts, and it registers its
    // executors before it can die during consumer setup — so both the replica
    // count and the fresh-registration check pass on the upswing of each loop.
    //
    // The stub's count increments per probe, which is what a restart policy
    // actually produces and what a fixed value could not reproduce.
    const r = await run({ STUB_RESTART_GROWS: "1" });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("worker never became ready");
    expect(r.stderr).toContain("rolling back");
  }, 20_000);

  it("fails with its own message when the compose file has no name:", async () => {
    // The project derivation used to sit above both die() and the -f guard, so
    // this path exited 127 with "die: command not found" and no explanation,
    // and a missing compose file died on awk's error rather than the guard's.
    // Reachable by re-deploying or rolling back to any commit predating
    // `name: agrippa` in the compose file.
    writeFileSync(path.join(appDir, "infra", "docker-compose.yml"), "services:\n  api:\n");
    git(appDir, "commit", "-aqm", "compose file without a name: key");
    git(appDir, "branch", "-f", "deploy", "HEAD");

    const r = await run();
    expect(r.exitCode).not.toBe(0);
    expect(r.exitCode).not.toBe(127); // 127 is the bug: die() not yet defined
    expect(r.stderr).toContain("no 'name:'");
    // and it bailed before touching anything
    expect(r.log).not.toContain("build");
    expect(r.log).not.toContain("up -d");
  }, 20_000);

  it("detaches HEAD instead of dragging the checked-out branch along", async () => {
    // The live host was checked out on a local branch named `main` that tracked
    // GitHub's origin/main — a ref deploy.sh never fetches, since it fetches the
    // deploy ref alone. Every deploy force-moved that branch to the deploy tip,
    // so `main` named one thing and pointed at another, reported "ahead 13" of a
    // ref nobody updates.
    //
    // The cost is not just the confusing name. On a branch, a stray `git pull`
    // on the host advances the tree past the running images; compose config,
    // .env defaults and Dockerfiles are read from that tree, so manual compose
    // commands — including the restore procedure this script prints on rollback
    // — would run against config that does not match what is running. Detached,
    // that pull fails outright.
    //
    // Deploy and main must differ for this to mean anything: if `deploy` were an
    // ancestor of the checked-out branch, resetting would leave the branch where
    // it was and the case would pass with or without the detach.
    const mainSha = new TextDecoder().decode(git(appDir, "rev-parse", "main").stdout).trim();
    git(appDir, "checkout", "-q", "deploy");
    writeFileSync(path.join(appDir, "infra", "docker-compose.yml"), "services:\n  api:\n  # v2\n");
    git(appDir, "commit", "-aqm", "a commit that is on deploy but not on main");
    const deployTip = new TextDecoder().decode(git(appDir, "rev-parse", "deploy").stdout).trim();
    git(appDir, "checkout", "-q", "main");
    expect(deployTip).not.toBe(mainSha); // precondition

    const r = await run();
    expect(r.exitCode).toBe(0);

    // HEAD is at the deployed commit and on no branch at all
    const head = new TextDecoder().decode(git(appDir, "rev-parse", "HEAD").stdout).trim();
    const branch = new TextDecoder()
      .decode(git(appDir, "rev-parse", "--abbrev-ref", "HEAD").stdout)
      .trim();
    expect(head).toBe(deployTip);
    expect(branch).toBe("HEAD"); // what git reports when detached

    // ...and the local branch was left exactly where the operator had it
    expect(new TextDecoder().decode(git(appDir, "rev-parse", "main").stdout).trim()).toBe(mainSha);
  }, 20_000);
});
