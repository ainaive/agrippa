# CLAUDE.md

@AGENTS.md

Claude-specific notes:

- Run `bun run check && bun test` before any commit — do not trust `bun test | tail`-style pipes for pass/fail (the pipe masks the exit code); check the fail count.
- Integration tests skip silently without local Postgres; treat "0 fail" with skipped suites as unverified.
