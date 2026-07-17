/**
 * Enforces the dependency direction between workspace packages
 * (docs/design/00-overview.md → Monorepo layout). Values are the ALLOWED
 * internal dependencies — a superset of what is currently used, so packages
 * grow into them; anything else fails CI.
 */
import { Glob } from "bun";

const ALLOWED: Record<string, string[]> = {
  "@agrippa/core": [],
  "@agrippa/i18n": [],
  "@agrippa/db": ["@agrippa/core"],
  "@agrippa/orchestration": ["@agrippa/core", "@agrippa/db", "@agrippa/executor-core"],
  "@agrippa/executor-core": ["@agrippa/core"],
  "@agrippa/executor-claude": ["@agrippa/core", "@agrippa/executor-core"],
  "@agrippa/api-client": ["@agrippa/core"],
  "@agrippa/api": ["@agrippa/core", "@agrippa/db", "@agrippa/orchestration", "@agrippa/i18n"],
  "@agrippa/worker": [
    "@agrippa/core",
    "@agrippa/db",
    "@agrippa/orchestration",
    "@agrippa/executor-core",
    "@agrippa/executor-claude",
    "@agrippa/i18n",
  ],
  "@agrippa/web": ["@agrippa/core", "@agrippa/api-client", "@agrippa/i18n"],
};

let failed = false;

for await (const path of new Glob("{apps,packages}/*/package.json").scan(".")) {
  const pkg = (await Bun.file(path).json()) as {
    name: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const allowed = ALLOWED[pkg.name];
  if (!allowed) {
    console.error(
      `✗ ${pkg.name} (${path}) is not in the dependency-direction map — add it consciously`,
    );
    failed = true;
    continue;
  }
  const internal = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) =>
    d.startsWith("@agrippa/"),
  );
  for (const dep of internal) {
    if (!allowed.includes(dep)) {
      console.error(`✗ ${pkg.name} → ${dep} violates the dependency direction`);
      failed = true;
    }
  }
}

if (failed) process.exit(1);
console.log("✓ dependency direction ok");
