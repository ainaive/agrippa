import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "@agrippa/executor-core";

/**
 * How stale a workspace must be before the daemon deletes it without being
 * told to.
 *
 * The server names finished runs on every claim poll, so this only ever sees
 * what that signal missed — a daemon offline when its runs ended, one upgraded
 * from a build that never reaped, or a run finalized longer ago than the
 * server looks back. Thirty days because the cost of being wrong is asymmetric:
 * reaping early does not merely waste a re-clone, it drops the completed steps'
 * work of a run that is merely paused, and the run then continues from the
 * pinned base as though that work never happened.
 */
export const STALE_WORKSPACE_DAYS = 30;

/**
 * How often the local sweep repeats. It runs at boot too, but boot-only was a
 * backstop for the server's signal rather than a policy of its own: retention
 * belongs to the server, the filesystem belongs to this machine (ADR-0018
 * Decision 4), and a laptop that has not reached the server in weeks must
 * still bound its own disk use. Six hours is far below the 30-day floor, so
 * the repetition costs a directory listing and nothing else.
 */
export const STALE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Env override for the floor above, in days; anything unparseable keeps 30. */
export function staleWorkspaceDays(env: Record<string, string | undefined>): number {
  const raw = Number(env.AGRIPPA_DAEMON_WORKSPACE_TTL_DAYS ?? "");
  return Number.isFinite(raw) && raw > 0 ? raw : STALE_WORKSPACE_DAYS;
}

/**
 * Delete workspace directories untouched for `days`.
 *
 * Deliberately dumb: it does not ask the server which runs exist, because the
 * whole point is to collect what the conversation with the server missed. It
 * reads mtime rather than trusting names, skips anything it cannot stat, and
 * never throws — a boot must not fail because a directory was busy.
 */
export async function sweepStaleWorkspaces(
  root: string,
  days: number,
  logger: Logger,
): Promise<number> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0; // no root yet — nothing has ever run here
  }

  let removed = 0;
  for (const entry of entries) {
    const dir = path.join(root, entry);
    try {
      const info = await stat(dir);
      if (!info.isDirectory() || info.mtimeMs >= cutoff) continue;
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      logger.warn(`stale workspace sweep skipped ${entry}`, { err: String(err) });
    }
  }
  if (removed > 0) {
    logger.info(`swept ${removed} workspace(s) untouched for ${days}+ days`);
  }
  return removed;
}
