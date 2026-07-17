---
name: test-runner
description: Detecting and running a repository's test suite reliably. Use when verifying changes or reproducing reported defects.
---

# Test Runner

- Detect the project's test command from its manifest (package.json scripts,
  Makefile, pyproject, go.mod conventions) before guessing.
- Run the narrowest relevant test scope first, then the full suite if it passes.
- Always report the exact command, exit code, and a verbatim excerpt of failures.
- Distinguish deterministic failures from flakes by re-running a failed test once;
  report both outcomes if they differ.
