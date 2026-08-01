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

  const required = requiredExecutorIds(run);
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

  // ── prefer central when it can serve ───────────────────────────────────────
  const centralWorkers = await db
    .select({ executors: workerHeartbeats.executors })
    .from(workerHeartbeats)
    .where(gte(workerHeartbeats.heartbeatAt, sql`now() - interval '15 minutes'`));
  const centralCovers = centralWorkers.some((w) => {
    const ids = new Set((w.executors ?? []).map((e) => e.id));
    return required.every((id) => ids.has(id));
  });
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
  const envPolicyProviders = [...providers].filter((p) => providerAuthPolicy(p, catalog) === "env");
  const eligible = candidates.filter((runtime) => {
    const ads = new Map((runtime.executors ?? []).map((e) => [e.id, e]));
    if (!required.every((id) => ads.has(id))) return false;
    // every executor the run binds must be able to authenticate every
    // env-policy provider the run resolves, from the DAEMON's own logins
    return required.every((id) => {
      const envAuth = ads.get(id)?.envAuthProviders;
      if (envAuth === undefined) return true; // unadvertised = ungated (fake/custom)
      return envPolicyProviders.every((p) => envAuth.includes(p));
    });
  });
  eligible.sort((a, b) => (b.lastSeenAt?.getTime() ?? 0) - (a.lastSeenAt?.getTime() ?? 0));
  const chosen = eligible[0];
  if (!chosen) return { kind: "central" };

  // persist the affinity pin before the first dispatch; the lease serializes
  // execution, so no CAS is needed beyond "still unpinned"
  await db
    .update(runs)
    .set({ runtimeId: chosen.id })
    .where(and(eq(runs.id, run.id), sql`${runs.runtimeId} is null`));
  return { kind: "remote", runtime: chosen };
}
