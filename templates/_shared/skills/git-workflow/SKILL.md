---
name: git-workflow
description: Branching, committing, and diff hygiene for platform-driven changes. Use whenever making commits or preparing a change for review.
---

# Git Workflow

- Work on a dedicated branch named `agrippa/<task-slug>-<run-number>` off the base
  branch you were given; never commit to the base branch directly.
- Make one commit per logical change with a Conventional Commit message
  (`fix: ...`, `feat: ...`). The body explains why the change is needed.
- Keep the diff minimal: no drive-by reformatting, no unrelated cleanups.
- Before finishing, run `git status` and `git diff` and confirm the working tree
  contains only intended changes.
