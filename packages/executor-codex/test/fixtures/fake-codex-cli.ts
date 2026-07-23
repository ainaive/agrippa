/**
 * Stand-in for `codex --version` / `codex exec --help` in probe tests.
 * First argument selects the personality: "modern" advertises the
 * config-isolation flags, "legacy" predates them.
 */
const [scenario, ...rest] = process.argv.slice(2);

if (rest.includes("--version")) {
  console.log(scenario === "legacy" ? "codex-cli 0.99.0" : "codex-cli 0.145.0");
  process.exit(0);
}

if (rest[0] === "exec" && rest.includes("--help")) {
  if (scenario === "legacy") {
    console.log("Usage: codex exec [OPTIONS] [PROMPT]\n  --json\n  --sandbox <MODE>");
  } else {
    console.log(
      "Usage: codex exec [OPTIONS] [PROMPT]\n  --json\n  --ignore-user-config\n  --ignore-rules\n  --sandbox <MODE>",
    );
  }
  process.exit(0);
}

console.error(`fake-codex-cli: unexpected args ${rest.join(" ")}`);
process.exit(2);
