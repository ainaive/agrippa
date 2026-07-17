# CLAUDE.md

All agent guidance for this repository lives in AGENTS.md (single source of truth — edit that file, not this one):

@AGENTS.md

Claude-specific notes:

- Run `bun run check && bun test` before any commit — do not trust `bun test | tail`-style pipes for pass/fail (the pipe masks the exit code); check the fail count.
- Integration tests skip silently without local Postgres; treat "0 fail" with skipped suites as unverified.
