import { providerAuthPolicy, requiredExecutorIds } from "@agrippa/core";
import {
  type Db,
  loadProviderCatalog,
  mcpServers,
  projects,
  providerCredentials,
  runs,
  runtimes,
  workerHeartbeats,
} from "@agrippa/db";
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";

type RunRow = typeof runs.$inferSelect;
export type RuntimeRow = typeof runtimes.$inferSelect;

export type RouteDecision = { kind: "central" } | { kind: "remote"; runtime: RuntimeRow };

/** Liveness window for routing candidates — 4× the daemon heartbeat cadence. */
const RUNTIME_LIVE_WINDOW_MS = 60_000;

/** Every provider the run's (flat or slot-keyed) model resolution names. */
function resolvedProviders(run: RunRow): Set<string> {
  const providers = new Set<string>();
  for (const value of Object.values(run.modelResolution as Record<string, unknown>)) {
    if (value === null || typeof value !== "object") continue;
    if ("provider" in value) {
      providers.add((value as { provider: string }).provider);
    } else {
      for (const entry of Object.values(value as Record<string, { provider?: string }>)) {
        if (entry?.provider) providers.add(entry.provider);
      }
    }
  }
  return providers;
}

type ProviderCatalog = Awaited<ReturnType<typeof loadProviderCatalog>>;
type ExecutorAd = { id: string; envAuthProviders?: string[] };

/**
 * The env-policy providers each executor's OWN slots resolve. Auth is scored
 * per executor, not as a cross-product: a claude-implementer/codex-reviewer
 * run needs anthropic auth on the claude executor and openai auth on codex —
 * requiring every executor to authenticate every provider would wrongly
 * disqualify every mixed fleet. Flat (pre-slot) resolutions attribute all
 * providers to the run's primary executor. Every required executor gets an
 * entry, possibly empty.
 */
function envProvidersByExecutor(run: RunRow, catalog: ProviderCatalog): Map<string, Set<string>> {
  const perExecutor = new Map<string, Set<string>>();
  for (const id of requiredExecutorIds(run)) perExecutor.set(id, new Set());
  const add = (executorId: string, provider: string | undefined) => {
    if (!provider || providerAuthPolicy(provider, catalog) !== "env") return;
    perExecutor.get(executorId)?.add(provider);
  };

  const bindings = run.agentBindings ?? {};
  const raw = run.modelResolution as Record<string, unknown>;
  const values = Object.values(raw);
  const flat = values.every(
    (v) => v !== null && typeof v === "object" && "providerModelId" in (v as object),
  );
  if (flat) {
    for (const value of values) add(run.executorId, (value as { provider?: string }).provider);
    return perExecutor;
  }
  for (const [slot, resolution] of Object.entries(raw)) {
    if (resolution === null || typeof resolution !== "object") continue;
    const executorId = bindings[slot]?.executorId ?? run.executorId;
    for (const entry of Object.values(resolution as Record<string, { provider?: string }>)) {
      add(executorId, entry?.provider);
    }
  }
  return perExecutor;
}

/**
 * Whether one host's advertisement can serve the run: every required executor
 * is present AND can authenticate the env-policy providers ITS slots resolve
 * (an undefined advertisement means ungated — fake/demo/custom executors).
 * Used symmetrically for central workers and daemon runtimes, so a keyless
 * central worker can no longer mask an authenticated daemon.
 */
function adsCoverRun(
  ads: ReadonlyMap<string, ExecutorAd>,
  perExecutor: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  for (const [executorId, providers] of perExecutor) {
    const ad = ads.get(executorId);
    if (!ad) return false;
    if (ad.envAuthProviders === undefined) continue;
    for (const provider of providers) {
      if (!ad.envAuthProviders.includes(provider)) return false;
    }
  }
  return true;
}

const adsOf = (executors: ExecutorAd[] | null | undefined): Map<string, ExecutorAd> =>
  new Map((executors ?? []).map((e) => [e.id, e]));

/**
 * Where a run executes (ADR-0017 Decisions 3 + 7). Deterministic given the
 * run row and registry state, with the persisted pin absolute — a resume must
 * re-derive the identical decision or the workspace and the engine diverge.
 *
 * Order:
 * 1. Affinity: a pinned runtime wins unconditionally (dead pin → the remote
 *    workspace manager's isIntact fails the resume `workspace_lost`).
 * 2. Central-only STRICT (Decision 7): any resolved provider with a stored
 *    project credential (env- or project-policy), any project-policy provider
 *    at all, or any authorized MCP server with platform-held auth — platform
 *    secrets never ship to daemons, and ADR-0013's "project credential wins"
 *    precedence must not silently invert.
 * 3. Prefer central when a live central worker covers the executor set (least
 *    surprise; daemons serve what the platform can't).
 * 4. Else the org's live runtime candidates: executor set covered AND every
 *    env-policy provider covered by the executor's advertised env auth; most
 *    recently seen wins. The pin persists before the first dispatch.
 */
export async function routeRun(db: Db, run: RunRow): Promise<RouteDecision> {
  if (run.runtimeId) {
    const [pinned] = await db.select().from(runtimes).where(eq(runtimes.id, run.runtimeId));
    if (pinned) return { kind: "remote", runtime: pinned };
    return { kind: "central" }; // pin row deleted — engine will fail it honestly
  }

  const [project] = await db
    .select({ orgId: projects.orgId })
    .from(projects)
    .where(eq(projects.id, run.projectId));
  if (!project) return { kind: "central" };

  // ── central-only strict exclusions ─────────────────────────────────────────
  const catalog = await loadProviderCatalog(db, project.orgId);
  const providers = resolvedProviders(run);
  if ([...providers].some((p) => providerAuthPolicy(p, catalog) === "project")) {
    return { kind: "central" };
  }
  if (providers.size > 0) {
    const credentialed = await db
      .select({ provider: providerCredentials.provider })
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.projectId, run.projectId),
          inArray(providerCredentials.provider, [...providers]),
        ),
      );
    if (credentialed.length > 0) return { kind: "central" };
  }
  const manifestMcp = run.resourceManifest?.mcpServers ?? [];
  if (manifestMcp.length > 0) {
    const authed = await db
      .select({ id: mcpServers.id })
      .from(mcpServers)
      .where(and(inArray(mcpServers.slug, manifestMcp), isNotNull(mcpServers.authSecretRef)))
      .limit(1);
    if (authed.length > 0) return { kind: "central" };
  }
  // Publishing templates (git.push/git.branch) route like any other since the
  // ADR-0017 publication inversion: git.branch is a remote no-op (the daemon
  // materializes runs.work_branch from the dispatch payload) and git.push
  // applies the approved patch to a pristine server-side clone — the daemon
  // never touches platform git credentials either way.

  // ── prefer central when it can serve — executors AND auth ─────────────────
  // Coverage is the same predicate daemons are scored by: a keyless central
  // worker (executor present, no env auth for the resolved provider) must
  // NOT win the preference and starve an authenticated daemon — that is the
  // primary BYO-credentials scenario.
  const perExecutor = envProvidersByExecutor(run, catalog);
  const centralWorkers = await db
    .select({ executors: workerHeartbeats.executors })
    .from(workerHeartbeats)
    .where(gte(workerHeartbeats.heartbeatAt, sql`now() - interval '15 minutes'`));
  const centralCovers = centralWorkers.some((w) => adsCoverRun(adsOf(w.executors), perExecutor));
  if (centralCovers) return { kind: "central" };

  // ── remote candidates ──────────────────────────────────────────────────────
  const candidates = await db
    .select()
    .from(runtimes)
    .where(
      and(
        eq(runtimes.orgId, project.orgId),
        eq(runtimes.status, "active"),
        gte(
          runtimes.lastSeenAt,
          sql`now() - interval '${sql.raw(String(RUNTIME_LIVE_WINDOW_MS / 1000))} seconds'`,
        ),
      ),
    );
  const eligible = candidates.filter((runtime) =>
    adsCoverRun(adsOf(runtime.executors), perExecutor),
  );
  eligible.sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0));
  const chosen = eligible[0];
  if (!chosen) return { kind: "central" };

  // Persist the affinity pin before the first dispatch. The CAS ("still
  // unpinned") can lose to a concurrent delivery of the same job — routing
  // runs before the execution lease is taken — and the loser must ADOPT the
  // persisted winner rather than proceed with its local choice: the pin is
  // absolute, and executing against a different runtime than the one on the
  // run row would strand the workspace on resume.
  const pinned = await db
    .update(runs)
    .set({ runtimeId: chosen.id })
    .where(and(eq(runs.id, run.id), sql`${runs.runtimeId} is null`))
    .returning({ id: runs.id });
  if (pinned.length === 0) {
    const [current] = await db
      .select({ runtimeId: runs.runtimeId })
      .from(runs)
      .where(eq(runs.id, run.id));
    if (current?.runtimeId) {
      const [winner] = await db.select().from(runtimes).where(eq(runtimes.id, current.runtimeId));
      if (winner) return { kind: "remote", runtime: winner };
    }
    return { kind: "central" }; // winner's pin row vanished — dead-pin semantics
  }
  return { kind: "remote", runtime: chosen };
}
