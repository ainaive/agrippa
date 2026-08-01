import { homedir } from "node:os";
import path from "node:path";

export type DaemonConfig = {
  serverUrl: string;
  token: string;
  /** Where per-run workspaces live on this machine. */
  workspaceRoot: string;
};

/**
 * Config precedence: CLI flags → env → `~/.agrippa/daemon.json`. The token is
 * the machine's platform identity (issued once in Admin → Workers); the
 * workspace root defaults under the user's home so runs never collide with
 * system temp cleaners mid-execution.
 */
export async function loadConfig(
  argv: string[] = Bun.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<DaemonConfig> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    else if (argv[i + 1] && !(argv[i + 1] as string).startsWith("--")) {
      flags.set(arg.slice(2), argv[++i] as string);
    }
  }

  let fileConfig: Partial<DaemonConfig> = {};
  const configPath = path.join(homedir(), ".agrippa", "daemon.json");
  try {
    fileConfig = (await Bun.file(configPath).json()) as Partial<DaemonConfig>;
  } catch {
    // no config file — flags/env must carry it
  }

  const serverUrl = flags.get("server") ?? env.AGRIPPA_SERVER_URL ?? fileConfig.serverUrl;
  const token = flags.get("token") ?? env.AGRIPPA_DAEMON_TOKEN ?? fileConfig.token;
  const workspaceRoot =
    flags.get("workspace-root") ??
    env.AGRIPPA_DAEMON_WORKSPACE_ROOT ??
    fileConfig.workspaceRoot ??
    path.join(homedir(), ".agrippa", "workspaces");

  if (!serverUrl || !token) {
    throw new Error(
      "missing configuration: pass --server/--token, set AGRIPPA_SERVER_URL/AGRIPPA_DAEMON_TOKEN, or write ~/.agrippa/daemon.json",
    );
  }
  return { serverUrl: serverUrl.replace(/\/$/, ""), token, workspaceRoot };
}
