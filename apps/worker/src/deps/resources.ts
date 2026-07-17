import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  type Db,
  decryptSecret,
  loadSecretKey,
  mcpServers,
  secrets,
  skills,
  skillVersions,
} from "@agrippa/db";
import type { ResolvedMcpServer, ResolvedSkill } from "@agrippa/executor-core";
import type { ResourceMaterializer } from "@agrippa/orchestration";
import { skillSlugOfRef } from "@agrippa/orchestration";
import { eq } from "drizzle-orm";

const TEMPLATES_DIR =
  process.env.AGRIPPA_TEMPLATES_DIR ?? path.resolve(import.meta.dirname, "../../../../templates");

/** Registry-backed resolution: skills materialize onto disk, MCP configs decrypt secrets. */
export class DbResourceMaterializer implements ResourceMaterializer {
  constructor(private readonly db: Db) {}

  async skills(refs: string[], workspaceDir: string): Promise<ResolvedSkill[]> {
    const resolved: ResolvedSkill[] = [];
    for (const ref of refs) {
      const slug = skillSlugOfRef(ref);
      const range = ref.includes("@") ? (ref.split("@")[1] as string) : "*";
      const [head] = await this.db.select().from(skills).where(eq(skills.slug, slug));
      if (!head) throw new Error(`skill '${slug}' is not registered`);
      const versions = await this.db
        .select()
        .from(skillVersions)
        .where(eq(skillVersions.skillId, head.id));
      const version = versions
        .filter((v) => v.status === "active" && Bun.semver.satisfies(v.version, range))
        .sort((a, b) => Bun.semver.order(b.version, a.version))[0];
      if (!version) throw new Error(`skill '${slug}' has no version satisfying '${range}'`);

      const skillName = slug.split("/").pop() as string;
      const target = path.join(workspaceDir, ".claude", "skills", skillName);
      await mkdir(path.dirname(target), { recursive: true });
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
    return resolved;
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
}
