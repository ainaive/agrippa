import { cp, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  type Db,
  decryptSecret,
  loadSecretKey,
  mcpServers,
  providerCredentials,
  secrets,
  skills,
  skillVersions,
} from "@agrippa/db";
import { type ResolvedMcpServer, type ResolvedSkill, realContained } from "@agrippa/executor-core";
import type { ResourceMaterializer } from "@agrippa/orchestration";
import { skillSlugOfRef } from "@agrippa/orchestration";
import { and, eq } from "drizzle-orm";
import { assertPublicHost } from "./net";

const TEMPLATES_DIR =
  process.env.AGRIPPA_TEMPLATES_DIR ?? path.resolve(import.meta.dirname, "../../../../templates");

/**
 * Remove project configuration created by a prior agent invocation. `rm` on a
 * symlink removes the link itself; it never traverses into the target.
 */
export async function resetAgentProjectConfig(workspaceDir: string): Promise<void> {
  for (const relative of [".claude", ".mcp.json"]) {
    const target = path.join(workspaceDir, relative);
    try {
      await lstat(target);
    } catch {
      continue;
    }
    await rm(target, { recursive: true, force: true });
  }
  await mkdir(path.join(workspaceDir, ".claude", "skills"), { recursive: true });
}

/** Registry-backed resolution: skills materialize onto disk, MCP configs decrypt secrets. */
export class DbResourceMaterializer implements ResourceMaterializer {
  constructor(private readonly db: Db) {}

  async prepareWorkspace(workspaceDir: string): Promise<void> {
    await resetAgentProjectConfig(workspaceDir);
  }

  async skills(
    refs: string[],
    workspaceDir: string,
  ): Promise<{ resolved: ResolvedSkill[]; missing: string[] }> {
    const resolved: ResolvedSkill[] = [];
    const missing: string[] = [];
    for (const ref of refs) {
      const slug = skillSlugOfRef(ref);
      const range = ref.includes("@") ? (ref.split("@")[1] as string) : "*";
      const [head] = await this.db.select().from(skills).where(eq(skills.slug, slug));
      if (!head) {
        // unregistered or no active matching version → unavailable, not an error;
        // the engine treats it symmetrically with a missing MCP server
        missing.push(ref);
        continue;
      }
      const versions = await this.db
        .select()
        .from(skillVersions)
        .where(eq(skillVersions.skillId, head.id));
      const version = versions
        .filter((v) => v.status === "active" && Bun.semver.satisfies(v.version, range))
        .sort((a, b) => Bun.semver.order(b.version, a.version))[0];
      if (!version) {
        missing.push(ref);
        continue;
      }

      const skillName = slug.split("/").pop() as string;
      const target = path.join(workspaceDir, ".claude", "skills", skillName);
      await mkdir(path.dirname(target), { recursive: true });
      if (!(await realContained(workspaceDir, target))) {
        throw new Error(`skill target escapes the run workspace: ${target}`);
      }
      if (version.contentRef.startsWith("builtin://")) {
        const source = path.join(
          TEMPLATES_DIR,
          "_shared/skills",
          version.contentRef.slice("builtin://".length),
        );
        await cp(source, target, { recursive: true });
      } else {
        await cp(version.contentRef, target, { recursive: true });
      }
      resolved.push({ slug, version: version.version, localPath: target });
    }
    return { resolved, missing };
  }

  async mcpServers(refs: string[]): Promise<{ resolved: ResolvedMcpServer[]; missing: string[] }> {
    const resolved: ResolvedMcpServer[] = [];
    const missing: string[] = [];
    for (const ref of refs) {
      const [server] = await this.db.select().from(mcpServers).where(eq(mcpServers.slug, ref));
      if (server?.status !== "active") {
        missing.push(ref);
        continue;
      }
      let authToken: string | null = null;
      if (server.authSecretRef) {
        const [secret] = await this.db
          .select()
          .from(secrets)
          .where(eq(secrets.id, server.authSecretRef));
        if (secret) authToken = decryptSecret(secret.ciphertext, loadSecretKey());
      }
      const config = server.config as Record<string, unknown>;
      if (server.transport === "stdio") {
        resolved.push({
          slug: server.slug,
          transport: "stdio",
          command: String(config.command ?? ""),
          args: (config.args as string[]) ?? [],
          env: {
            ...((config.env as Record<string, string>) ?? {}),
            ...(authToken ? { MCP_AUTH_TOKEN: authToken } : {}),
          },
        });
      } else {
        resolved.push({
          slug: server.slug,
          transport: server.transport,
          url: String(config.url ?? ""),
          headers: {
            ...((config.headers as Record<string, string>) ?? {}),
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
        });
      }
    }
    return { resolved, missing };
  }

  async providerCredential(
    projectId: string,
    provider: string,
  ): Promise<{ apiKey: string; baseUrl?: string } | null> {
    // scoped to the run's project — never looked up by raw credential id
    const [row] = await this.db
      .select()
      .from(providerCredentials)
      .where(
        and(
          eq(providerCredentials.projectId, projectId),
          eq(providerCredentials.provider, provider),
        ),
      );
    if (!row) return null;
    if (row.baseUrl) {
      // the key is about to be sent to this host — refuse names that resolve
      // into private space (the API only rejects IP literals syntactically)
      await assertPublicHost(new URL(row.baseUrl).hostname);
    }
    const [secret] = await this.db.select().from(secrets).where(eq(secrets.id, row.secretRef));
    if (!secret) return null;
    return {
      apiKey: decryptSecret(secret.ciphertext, loadSecretKey()),
      baseUrl: row.baseUrl ?? undefined,
    };
  }

  async hasProviderCredential(projectId: string, provider: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: providerCredentials.id })
      .from(providerCredentials)
      .innerJoin(secrets, eq(secrets.id, providerCredentials.secretRef))
      .where(
        and(
          eq(providerCredentials.projectId, projectId),
          eq(providerCredentials.provider, provider),
        ),
      )
      .limit(1);
    return row !== undefined;
  }
}
