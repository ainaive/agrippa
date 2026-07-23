---
name: git-workflow
description: Branch and diff hygiene for platform-driven changes. Use whenever preparing a repository change for review.
---

# Git Workflow

- Stay on the current platform-created branch; never create or switch branches.
- Local commits are optional checkpoints only. The platform publishes the final
  approved filesystem state as one verified snapshot commit, so never rely on
  local commit history as the delivery contract.
- Keep the diff minimal: no drive-by reformatting, no unrelated cleanups.
- Before finishing, compare the complete workspace against the base branch and
  inspect `git status --short`, including every untracked file.
