/**
 * Visual smoke + screenshot harness (dev tool, not CI).
 *
 * Boots api + worker on a throwaway database with the fake executor, seeds a
 * project with one run driven to an approval checkpoint and one to success,
 * then captures every page in light and dark via headless Chromium. Fails if
 * any page logs a console error — the browser-level smoke that static checks
 * can't provide.
 *
 * Usage: bun scripts/screenshot.ts [--out <dir>] [--theme light|dark|both]
 * Requires: local Postgres, free ports 3000 (api) and 5173 (vite; the dev
 * proxy hard-targets :3000), `bunx playwright install chromium` once.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { type Browser, chromium } from "playwright";

// per-run name: never drops a database this run didn't create, and two
// harness runs can't stomp each other's data
const DB_NAME = `agrippa_shot_${process.pid}`;
const PG = process.env.SHOT_PG_URL ?? "postgres://localhost:5432";
const API = "http://localhost:3000";
const WEB = "http://localhost:5173";

const args = process.argv.slice(2);
const argValue = (flag: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const outDir = path.resolve(argValue("--out") ?? "screenshots");
const themeArg = argValue("--theme") ?? "both";
const themes = themeArg === "both" ? ["light", "dark"] : [themeArg];

const children: Bun.Subprocess[] = [];
const cleanup = async () => {
  // SIGKILL: a lingering child would hold DB connections (blocking the drop)
  // and, via inherited stderr, keep this script's output pipe open forever.
  for (const child of children) child.kill("SIGKILL");
  await Bun.sleep(500);
  psql(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
};

function psql(statement: string) {
  const res = Bun.spawnSync(["psql", `${PG}/postgres`, "-c", statement], { stdout: "ignore" });
  if (res.exitCode !== 0) throw new Error(`psql failed: ${statement}`);
}

function spawn(cmd: string[], env: Record<string, string>, cwd?: string) {
  const child = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "ignore",
    stderr: "ignore",
  });
  children.push(child);
  return child;
}

async function waitFor(url: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await Bun.sleep(500);
  }
  throw new Error(`timed out waiting for ${url}`);
}

async function portFree(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return false;
  } catch {
    return true;
  }
}

// ── API-side fixture seeding ─────────────────────────────────────────────────

let cookie = "";

async function api<T = unknown>(pathname: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${pathname}`, {
    ...init,
    // better-auth's CSRF check requires a matching Origin (the vite dev proxy
    // does the same rewrite for the SPA)
    headers: { "content-type": "application/json", cookie, origin: API, ...init?.headers },
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0] ?? "";
  if (!res.ok) throw new Error(`${pathname} → ${res.status}: ${await res.text()}`);
  return (await res.json()) as T;
}

async function waitForRunStatus(runId: string, want: string[], timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await api<{ status: string }>(`/api/v1/runs/${runId}`);
    if (want.includes(run.status)) return run.status;
    await Bun.sleep(1000);
  }
  throw new Error(`run ${runId} did not reach ${want.join("/")}`);
}

type Fixtures = {
  projectId: string;
  taskTypeId: string;
  deliveryTaskTypeId: string;
  templateId: string;
  waitingRunId: string;
  doneRunId: string;
  deliveryRunId: string;
};

async function seedFixtures(dbUrl: string): Promise<Fixtures> {
  // self-registration is closed — bootstrap the first admin, then sign in
  const bootstrap = Bun.spawnSync(["bun", "apps/api/src/cli/bootstrap-admin.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
      AGRIPPA_BOOTSTRAP_EMAIL: "ada@example.com",
      AGRIPPA_BOOTSTRAP_PASSWORD: "password123",
    },
  });
  if (bootstrap.exitCode !== 0) {
    throw new Error(`bootstrap-admin failed: ${bootstrap.stderr.toString().slice(0, 500)}`);
  }
  await api("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: "ada@example.com", password: "password123" }),
  });
  const project = await api<{ id: string }>("/api/v1/projects", {
    method: "POST",
    body: JSON.stringify({ slug: "atlas", name: "Atlas" }),
  });
  const models = await api<Array<{ id: string }>>("/api/v1/models");
  const skills = await api<Array<{ id: string }>>("/api/v1/skills");
  await api(`/api/v1/projects/${project.id}/grants`, {
    method: "PUT",
    body: JSON.stringify([
      ...models.map((m) => ({ resourceType: "model", resourceId: m.id })),
      ...skills.map((s) => ({ resourceType: "skill", resourceId: s.id })),
    ]),
  });
  await api(`/api/v1/projects/${project.id}/quota`, {
    method: "PUT",
    body: JSON.stringify({ costLimitUsd: 50, tokenLimit: null, hardStop: true }),
  });

  const taskTypes = await api<Array<{ id: string; slug: string }>>(
    "/api/v1/scenarios/project-management/task-types",
  );
  const planBreakdown = taskTypes.find((t) => t.slug === "plan-breakdown");
  if (!planBreakdown) throw new Error("plan-breakdown task type missing from seed");

  const submit = (title: string, goal: string) =>
    api<{ runId: string }>(`/api/v1/projects/${project.id}/tasks`, {
      method: "POST",
      body: JSON.stringify({ taskTypeId: planBreakdown.id, title, params: { goal } }),
    });

  // Responding re-enqueues the run, so its status stays waiting_approval until
  // the worker resumes — poll for the NEXT pending checkpoint, not the status.
  const pendingCheckpoint = async (runId: string, afterId?: string, timeoutMs = 60_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const rows = await api<Array<{ id: string; status: string; kind: string }>>(
        `/api/v1/runs/${runId}/checkpoints`,
      );
      const pending = rows.find((row) => row.status === "pending" && row.id !== afterId);
      if (pending) return pending;
      const run = await api<{ status: string; error: unknown }>(`/api/v1/runs/${runId}`);
      if (["failed", "cancelled", "timed_out", "succeeded"].includes(run.status)) {
        throw new Error(
          `run ${runId} reached ${run.status} while waiting for a checkpoint: ${JSON.stringify(run.error)}`,
        );
      }
      await Bun.sleep(500);
    }
    throw new Error(`timed out waiting for a pending checkpoint on run ${runId}`);
  };

  // run 1: drive to success so run detail / usage / audit have real data
  const done = await submit("Quarterly roadmap breakdown", "Break the Q3 roadmap into workstreams");
  await waitForRunStatus(done.runId, ["waiting_approval"]);
  const approval = await pendingCheckpoint(done.runId);
  await api(`/api/v1/runs/${done.runId}/checkpoints/${approval.id}/respond`, {
    method: "POST",
    body: JSON.stringify({
      kind: "approval",
      decision: "approved",
      comment: "Looks solid — proceed.",
    }),
  });
  await waitForRunStatus(done.runId, ["succeeded"]);

  // run 2: left paused at the checkpoint so CheckpointPanel + inbox render
  const waiting = await submit("Launch-readiness plan", "Plan the beta launch checklist");
  await waitForRunStatus(waiting.runId, ["waiting_approval"]);

  // run 3: the requirement-delivery workflow (agrippa/v2) — a repo connection
  // pointing at this working tree keeps checkout real while AGRIPPA_SCM=fake
  // fabricates push/PR; driven through the Q&A and plan gates, then left at
  // the round-1 review gate so the findings table and timeline cards render
  const repo = await api<{ id: string }>(`/api/v1/projects/${project.id}/repos`, {
    method: "POST",
    body: JSON.stringify({
      provider: "generic-git",
      url: `file://${process.cwd()}`,
      defaultBranch: "main",
    }),
  });
  const swdevTypes = await api<Array<{ id: string; slug: string }>>(
    "/api/v1/scenarios/software-development/task-types",
  );
  const delivery = swdevTypes.find((t) => t.slug === "requirement-delivery");
  if (!delivery) throw new Error("requirement-delivery task type missing from seed");
  const deliveryRun = await api<{ runId: string }>(`/api/v1/projects/${project.id}/tasks`, {
    method: "POST",
    body: JSON.stringify({
      taskTypeId: delivery.id,
      title: "Add dark-mode toggle",
      params: {
        requirement: "Add a dark-mode toggle to the settings page",
        repo: { repoConnectionId: repo.id },
      },
    }),
  });
  const questions = await pendingCheckpoint(deliveryRun.runId);
  if (questions.kind !== "input")
    throw new Error(`expected input checkpoint, got ${questions.kind}`);
  await api(`/api/v1/runs/${deliveryRun.runId}/checkpoints/${questions.id}/respond`, {
    method: "POST",
    body: JSON.stringify({ kind: "input", answers: { q1: "Keep the current API", q2: true } }),
  });
  const plan = await pendingCheckpoint(deliveryRun.runId, questions.id);
  await api(`/api/v1/runs/${deliveryRun.runId}/checkpoints/${plan.id}/respond`, {
    method: "POST",
    body: JSON.stringify({ kind: "approval", decision: "approved" }),
  });
  const gate = await pendingCheckpoint(deliveryRun.runId, plan.id);
  if (gate.kind !== "review-gate") throw new Error(`expected review-gate, got ${gate.kind}`);
  await api(`/api/v1/runs/${deliveryRun.runId}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: "Reviewer flagged two issues — I'd fix the major one." }),
  });

  const templates = await api<Array<{ id: string }>>("/api/v1/templates");
  const templateId = templates[0]?.id;
  if (!templateId) throw new Error("no templates seeded");

  return {
    projectId: project.id,
    taskTypeId: planBreakdown.id,
    deliveryTaskTypeId: delivery.id,
    templateId,
    waitingRunId: waiting.runId,
    doneRunId: done.runId,
    deliveryRunId: deliveryRun.runId,
  };
}

// ── Capture ──────────────────────────────────────────────────────────────────

function pages(f: Fixtures): Array<{ name: string; path: string }> {
  return [
    { name: "dashboard", path: `/projects/${f.projectId}` },
    { name: "catalog", path: `/projects/${f.projectId}/catalog` },
    { name: "submit", path: `/projects/${f.projectId}/submit/${f.taskTypeId}` },
    { name: "submit-delivery", path: `/projects/${f.projectId}/submit/${f.deliveryTaskTypeId}` },
    { name: "tasks", path: `/projects/${f.projectId}/tasks` },
    { name: "run-succeeded", path: `/projects/${f.projectId}/runs/${f.doneRunId}` },
    { name: "run-waiting", path: `/projects/${f.projectId}/runs/${f.waitingRunId}` },
    { name: "run-delivery", path: `/projects/${f.projectId}/runs/${f.deliveryRunId}` },
    { name: "approvals", path: "/approvals" },
    { name: "usage", path: `/projects/${f.projectId}/usage` },
    { name: "settings", path: `/projects/${f.projectId}/settings` },
    { name: "admin-templates", path: "/admin/templates" },
    { name: "template-editor", path: `/admin/templates/${f.templateId}` },
    { name: "admin-fabri", path: "/admin/fabri" },
    { name: "admin-models", path: "/admin/models" },
    { name: "admin-skills", path: "/admin/skills" },
    { name: "admin-mcp", path: "/admin/mcp-servers" },
    { name: "admin-audit", path: "/admin/audit" },
  ];
}

const IGNORED_CONSOLE = [/favicon/i, /\[vite\]/, /Download the React DevTools/];

async function capture(browser: Browser, f: Fixtures) {
  const errors: string[] = [];
  const sessionCookie = cookie.split("=");

  for (const theme of themes) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: theme === "dark" ? "dark" : "light",
    });
    await context.addCookies([
      {
        name: sessionCookie[0] ?? "",
        value: sessionCookie[1] ?? "",
        domain: "localhost",
        path: "/",
      },
    ]);
    await context.addInitScript(`localStorage.setItem("agrippa.theme", "${theme}")`);
    const page = await context.newPage();
    await page.emulateMedia({ reducedMotion: "reduce" });
    page.on("console", (msg) => {
      if (msg.type() === "error" && !IGNORED_CONSOLE.some((re) => re.test(msg.text()))) {
        errors.push(`[${theme}] console: ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => errors.push(`[${theme}] pageerror: ${err.message}`));

    // login page without a session, in a separate context
    const anon = await context.browser()?.newContext({
      viewport: { width: 1440, height: 900 },
      colorScheme: theme === "dark" ? "dark" : "light",
    });
    if (anon) {
      await anon.addInitScript(`localStorage.setItem("agrippa.theme", "${theme}")`);
      const loginPage = await anon.newPage();
      loginPage.on("console", (msg) => {
        if (msg.type() === "error" && !IGNORED_CONSOLE.some((re) => re.test(msg.text()))) {
          errors.push(`[${theme}] login console: ${msg.text()}`);
        }
      });
      loginPage.on("pageerror", (err) => errors.push(`[${theme}] login pageerror: ${err.message}`));
      await loginPage.goto(`${WEB}/login`, { waitUntil: "domcontentloaded" });
      await loginPage.waitForTimeout(800);
      await loginPage.screenshot({ path: path.join(outDir, `${theme}-login.png`), fullPage: true });
      await anon.close();
    }

    for (const target of pages(f)) {
      await page.goto(`${WEB}${target.path}`, { waitUntil: "domcontentloaded" });
      // let queries settle; networkidle never fires with SSE open
      await page.waitForTimeout(1500);
      await page.screenshot({
        path: path.join(outDir, `${theme}-${target.name}.png`),
        fullPage: true,
      });
      console.log(`  ${theme}/${target.name}`);
    }
    await context.close();
  }
  return errors;
}

// ── Main ─────────────────────────────────────────────────────────────────────

try {
  if (!(await portFree(`${API}/healthz`)) || !(await portFree(WEB))) {
    console.error("ports 3000/5173 are busy — stop your dev stack before running the harness");
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  console.log("→ fresh database");
  psql(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  psql(`CREATE DATABASE ${DB_NAME}`);

  console.log("→ booting api + worker + vite");
  const env = {
    DATABASE_URL: `${PG}/${DB_NAME}`,
    AGRIPPA_SECRET_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    AGRIPPA_EXECUTOR: "fake",
    AGRIPPA_SCM: "fake",
  };
  spawn(["bun", "apps/api/src/index.ts"], env);
  spawn(["bun", "apps/worker/src/index.ts"], env);
  spawn(["bunx", "vite", "--port", "5173", "--strictPort"], {}, "apps/web");
  await waitFor(`${API}/healthz`);
  await waitFor(WEB);

  console.log("→ seeding fixtures");
  const fixtures = await seedFixtures(env.DATABASE_URL);

  console.log(`→ capturing to ${outDir}`);
  const browser = await chromium.launch();
  const errors = await capture(browser, fixtures);
  await browser.close();

  if (errors.length > 0) {
    console.error(`\n✗ ${errors.length} browser error(s):`);
    for (const error of errors) console.error(`  ${error}`);
    // exitCode, not process.exit(): exit() would skip the finally cleanup and
    // leave the app processes and scratch database behind
    process.exitCode = 1;
  } else {
    console.log("✓ all pages captured with no browser errors");
  }
} finally {
  await cleanup();
}
