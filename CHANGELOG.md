# Changelog

All notable changes to Agrippa are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] — 2026-07-17

The M1 milestone: all three layers of the platform, working end to end.

### Added

- **Scenario layer** — three scenarios (project management, software development, test & verification) with six builtin task types; submission forms auto-generated from compiled template input schemas; bilingual (en / zh-CN) SPA with live run detail, approvals inbox, project settings, admin registries, and a template editor with dry-run validation.
- **Orchestration layer** — the `agrippa/v1` template format (YAML → zod-validated compiled JSON, immutable published versions, non-Turing-complete expression language); an engine with phases/steps, human-approval checkpoints that free worker slots, per-step retries, budget/quota enforcement, output contracts, and step-granular crash resume; pg-boss queueing with singleton-keyed sends and a reconciliation sweeper; SSE progress with gap-free `Last-Event-ID` replay (Redis optional).
- **Resource layer** — registries for models (tiered, priced), Fabri, skills, and MCP servers; head + immutable-version pattern; project-level resource grants gating submission; monthly quotas with hard-stop enforcement at submit time and mid-run.
- **Executors** — the pluggable `Executor` contract (ADR-0005) with a FakeExecutor compliance suite; the Claude Agent SDK executor (subagents, skills, MCP, resume, workspace-scoped tool policy, artifact convention); a token-free demo executor.
- **Platform** — better-auth with org/project RBAC and audit on every mutation, AES-256-GCM secrets store with write-only credentials, localized API errors, usage reporting, git workspaces with credential scrubbing, production Docker images + compose stack + GHCR release workflow.

[Unreleased]: https://github.com/ainaive/agrippa/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ainaive/agrippa/releases/tag/v0.1.0
