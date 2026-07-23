# ADR-0012: Platform-Owned Git Metadata and Snapshot Publishing

- Status: accepted · Date: 2026-07-23
- Supersedes ADR-0011's review-round-3 platform-git restoration model.

## Context

ADR-0011 moved branch publication into the platform and later hardened it by saving a trusted `.git/config` beside the workspace, restoring that file before evidence and push operations, and anchoring the clone-base SHA in the same sidecar. The remaining Git metadata stayed agent-writable. That boundary was not sound:

- restoring `.git/config` could follow an agent-created symlink or block on a special file;
- the agent could change `.git/index` and `.git/info/exclude`, defeating the protected-path rules used by the finalizing commit;
- platform Git still received provider credentials because it reused the executor environment allow-list;
- evidence errors could collapse to an empty patch, and empty stored evidence could bypass a truthiness-based comparison;
- an agent could leave `.claude` settings or hooks for the next agent invocation.

Evidence and publication need one canonical view that does not consume any metadata an agent can change.

## Decision

1. **Two independent Git metadata domains.** Checkout creates a normal repository, records the clone base, then moves its pristine `.git` directory to `<runId>.platform/git` outside the agent-writable workspace. A byte-copy becomes the workspace's agent-owned `.git`. The platform sidecar has its own config, refs, objects, and index; no inode or mutable Git file is shared. Agent-side `skip-worktree` and `info/exclude` entries remain usability aids only, never security controls.
2. **Canonical platform snapshot.** For evidence and publication, platform Git points its trusted gitdir at the agent workspace as a worktree, resets its private index to the clone base, and stages the filesystem with explicit exclusions for `.claude`, `.mcp.json`, and `.agrippa`. The resulting cached binary diff is the patch evidence, and `write-tree` is the publishable tree. Protected paths therefore retain their base-tree state regardless of deletion, replacement, index changes, or exclude-file changes in the agent repository.
3. **One verified publish commit.** `git.push` repeats the canonical snapshot atomically against the expected patch. Any difference, including empty-versus-nonempty evidence, returns a typed mismatch and fails the run with `contract_violation`. A matching nonempty tree is published as exactly one Agrippa-authored `commit-tree` child of the clone base. Retries reuse the sidecar branch ref when its tree and parent match, so a lost response cannot create another commit. Local commits made by agents remain useful checkpoints and review context, but their history is intentionally not preserved in the delivered branch.
4. **A narrower platform environment.** Platform Git receives only system, locale, temporary-directory, and TLS variables plus explicit Git hardening. It never receives Anthropic, OpenAI, or Codex credentials. Global and system config are disabled; hooks, fsmonitor, external diff, and text conversion are disabled or bypassed.
5. **Fresh project configuration per agent attempt.** Before resource checks that materialize skills and before every agent attempt or resumed attempt, the worker removes `.claude` and `.mcp.json` without following symlinks, recreates `.claude/skills`, and then materializes only the run-authorized skills. `CLAUDE.md` remains intentional repository context; project settings, hooks, and MCP configuration do not cross invocation boundaries.
6. **Fail closed.** Missing sidecar metadata makes a resumed repository workspace non-intact. Diff failures are step tool errors, not empty evidence. Publication refuses an empty snapshot and refuses any evidence mismatch before a credentialed push.

## Alternatives considered

- **Keep restoring selected files in agent `.git`.** This leaves an open-ended list of security-sensitive metadata and requires every restore to defend against symlinks, special files, races, and future Git features.
- **Trust agent commits after validating the final tree.** This could preserve history, but parsing and reproducing an arbitrary agent-controlled commit graph safely adds complexity with no workflow requirement. The approved artifact is a patch, not a history contract.
- **Copy the workspace into another checkout at publish time.** This provides separation but duplicates large worktrees and introduces a second filesystem-copy interpretation between evidence and publication. A private index over the same worktree gives both operations the same canonical snapshot.

## Consequences

- The delivered PR branch contains one deterministic platform snapshot commit on the selected base, even if agents made several local commits.
- Resuming a repository run created by a pre-ADR-0012 worker is deliberately unsupported because it has no trusted gitdir. Deployments must drain active repository-backed runs before upgrading workers.
- The sidecar remains host-local. Cross-host resume and protection from a shell that escapes the OS sandbox are still container/affinity concerns described by ADR-0009.
- Real-Git adapter tests pin symlink resistance, hostile config isolation, agent index/exclude tampering, protected-path preservation, stale and empty evidence rejection, idempotent retry, and provider-secret exclusion.
