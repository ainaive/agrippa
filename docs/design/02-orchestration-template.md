# 02 — Orchestration Template Format (`agrippa/v1` & `agrippa/v2`)

> Status: living · Last updated: 2026-07-23

Templates are the contract between the scenario layer (auto-generated forms), the orchestration engine (phases, checkpoints, budgets), and executors (single-step agent invocations). They are authored in **YAML**, compiled to **zod-validated JSON**, and published as **immutable versions** ([ADR-0006](../adr/0006-yaml-template-format.md)).

Two authoring versions exist: `agrippa/v1` (linear phases, phase-level approvals) and `agrippa/v2` (agent slots, checkpoint steps, bounded loops, SCM actions — [ADR-0010](../adr/0010-agrippa-v2-slots-checkpoints-loops.md)). Both compile to one v2-shaped IR (`CompiledTemplate`); a pure `upgradeV1ToV2` runs at compile time and when loading stored compiled rows, so v1 templates keep working unchanged and no data migration ever happens.

## Lifecycle

```
author YAML → validate (compile + zod) → save draft version → publish (immutable)
                                              │
builtin templates in templates/**  ──seed──►  published version (checksum-guarded upsert)
```

- The compiler lives in `@agrippa/orchestration`: parse YAML → resolve/normalize → validate against zod schemas → emit `compiled` JSON. The API exposes `POST /templates/validate` for dry-runs (used by the template editor).
- `template_versions.source_yaml` keeps the human-authored form for diffing/review; `compiled` is what the engine executes. Both stored; checksum ties them.
- Runs pin a `template_version_id` at submit. Deprecating a version stops new runs; existing runs finish on it.

## Format Specification

Top level:

```yaml
apiVersion: agrippa/v1          # format version gate; future formats bump this
kind: OrchestrationTemplate
metadata:
  slug: <scenario-slug>.<template-slug>
  scenario: <scenario slug>
  name: { en: ..., zh-CN: ... }
  description: { en: ..., zh-CN: ... }
spec:
  faber: <faber slug>            # default preset agent; task type may override
  inputs: [...]                  # §Inputs
  workspace: {...}               # optional; §Workspace
  resources: {...}               # §Resources
  models: {...}                  # §Model selection
  phases: [...]                  # §Phases & steps
  budgets: {...}                 # §Budgets
  outputs: {...}                 # §Output contract
```

### Inputs

`inputs[]` is a self-describing parameter schema. It drives **both** the auto-generated submission form in the SPA and server-side validation (the compiler derives a zod schema from it) — one definition, two enforcement points.

```yaml
inputs:
  - key: bugReport               # identifier used in ${inputs.bugReport}
    type: text                   # string | text | number | boolean | select | repoRef | docRef
    required: true
    default: ...                 # optional
    label: { en: "Bug report", zh-CN: "缺陷描述" }
    help:  { en: "...", zh-CN: "..." }        # optional
    ui: { widget: textarea, rows: 8 }         # optional rendering hints
    options: [...]               # for select: [{value, label: {en, zh-CN}}]
```

Special types render project-scoped pickers: `repoRef` → the project's `repo_connections`; `docRef` → connected documents. Their resolved values are structured references, not raw strings.

### Workspace

```yaml
workspace:
  repo: ${inputs.repo}           # a repoRef input
  ref: ${inputs.branch}
  access: readOnly | readWrite
```

If present, the engine provisions an isolated per-run checkout before the first step (see [04-execution-runtime](04-execution-runtime.md)). Omitted → the run gets an empty scratch workspace.

An agent step may override the workspace access with its own `access:` — the canonical case is a **reviewer step declaring `access: readOnly` inside a readWrite workspace**: whatever a reviewer wrote would be published without ever being re-reviewed, and the engine refuses to push a workspace that drifted from the reviewed patch evidence, so a writable reviewer would only be able to fail runs.

### Resources

Declared requirements, resolved against **project grants** at submit time. Submission fails fast with an actionable error if a required resource isn't granted to the project.

```yaml
resources:
  skills:
    - ref: builtin/git-workflow@^1       # slug@semver-range against skill_versions
  mcpServers:
    - ref: github
      optional: true                     # run proceeds without it; steps gate via `requires`
  subagents:                             # inline sub-agent definitions (template-owned)
    - id: code-locator
      description: "Searches the codebase to localize the root cause"
      promptFile: _shared/prompts/code-locator.md   # relative to templates/; inlined at compile
      tools: [Read, Grep, Glob]
      model: { role: analysis }
```

Sub-agents are defined inline in the template (compiled to full prompt text). A shared sub-agent registry can come later; inline keeps v1 simple and versioned with the template.

### Model selection

Templates never name concrete models. They declare **roles** mapped to **tiers**; the resolver maps tiers to concrete models from the project's granted model registry at run start (frozen into `runs.model_resolution`).

```yaml
models:
  roles:
    planning: { tier: strong, fallback: [balanced] }
    analysis: { tier: balanced }
    coding:   { tier: strong }
    fast:     { tier: fast }
  allowProjectOverride: true     # project grants may pin roles to specific models
```

Resolution order per role: project override (if allowed) → cheapest enabled granted model of the tier → fallback tiers in order → submit-time error.

### Phases & steps

Phases group steps for progress display and approval gating. Steps run **sequentially** within a run (v1 has no intra-run parallelism — see Expressiveness).

```yaml
phases:
  - id: localize
    name: { en: "Localize", zh-CN: "定位" }
    approval:                    # optional human checkpoint BEFORE the phase runs
      checkpoint: approve-fix-plan
      title: { en: ..., zh-CN: ... }
      present: [localization-report]      # artifact keys shown to the approver
      timeout: 24h
      onTimeout: cancel | reject | approve
    steps:
      - id: find-root-cause
        kind: agent | system
        # kind: system → platform action, no LLM. Actions: workspace.checkout (v1)
        model: { role: planning }         # agent steps only
        subagents: [code-locator]         # refs into resources.subagents
        skills: [builtin/git-workflow]    # subset of resources.skills for this step
        mcpServers: [github]              # subset for this step
        requires: { mcpServers: [github] }  # skip step if optional resource unavailable
        when: ${inputs.autoOpenPr}        # conditional execution (expression → boolean)
        instructions: |                   # the step prompt; supports interpolation
          ...
        produces: [localization-report]   # artifact keys this step must emit
        retry: { max: 2 }                 # same-step retry on failure
        onFailure: fail | continue        # continue → mark failed, proceed to next step
```

### Expression language

Interpolation contexts: `${inputs.<key>}`, `${steps.<stepId>.outputs.<key>}`, `${run.id}`, `${project.slug}`. The grammar is deliberately tiny and **non-Turing-complete**: property paths, `==`, `!=`, `&&`, `||`, `!`, literals. No loops, no user-defined functions, no arithmetic. `when:` takes one expression; `instructions:` allows embedded `${...}` substitution. This is a governance decision, not a technical limitation — templates must stay auditable ([ADR-0006](../adr/0006-yaml-template-format.md)).

### Budgets

```yaml
budgets:
  maxCostUsd: 8
  maxDurationMinutes: 45
  perPhase:
    fix: { maxCostUsd: 4 }
```

Enforced by the engine's `BudgetMeter` from executor `usage` events, in addition to (never instead of) the project quota. See [04-execution-runtime](04-execution-runtime.md).

### Output contract

```yaml
outputs:
  artifacts:
    - { key: localization-report, kind: markdown, required: true }
    - { key: patch,               kind: patch,    required: true }
  summary: { from: fix-report }  # artifact rendered as the run's summary
```

The engine fails a run that completes its steps without producing all `required` artifacts — an explicit quality gate, so "succeeded" always means "produced the contracted outputs".

## `agrippa/v2` additions ([ADR-0010](../adr/0010-agrippa-v2-slots-checkpoints-loops.md))

v2 keeps everything above (inputs, workspace, resources, models, budgets, outputs) and changes the execution vocabulary. `templates/swdev/requirement-delivery.yaml` is the reference example.

### Agent slots (replaces `spec.faber`)

```yaml
spec:
  agents:
    implementer:
      label: { en: "Implementer", zh-CN: "实现者" }
      faber: forge                  # default persona (registry slug)
      executor: claude-agent-sdk    # default engine (core EXECUTOR_CATALOG id)
      # overridable: true           # default — submitter may swap faber/executor
    reviewer:
      label: { en: "Reviewer", zh-CN: "评审者" }
      faber: arbiter
      executor: codex-cli
```

Agent steps bind to a slot via `agent: <slot>` (default: the first declared slot). At submit, `resolveAgentBindings` freezes each slot to a concrete faber + executor onto `runs.agent_bindings` (user overrides on overridable slots; capability checks against the catalog — e.g. a codex-bound step may not declare subagents/skills/MCP; per-slot model resolution filtered by the executor's provider list). When the deployment default executor is `fake` (the token-free demo switch), every slot binds to it. v1 upgrades to one non-overridable `main` slot on the deployment default.

### Checkpoint steps (replaces phase-level `approval:`)

Checkpoints are steps (`kind: checkpoint`), so they can sit anywhere in a phase and reuse the step idempotency/resume machinery:

```yaml
- id: confirm-plan
  kind: checkpoint
  checkpoint:
    kind: approval                 # approval | input | review-gate
    present: [implementation-plan] # artifact keys shown to the responder
    title: { en: ..., zh-CN: ... }
    timeout: 48h
    onTimeout: cancel              # approval also allows reject | approve
```

- `approval` — approve / reject; inside a loop also **request_changes** (comment required — it re-enters the run as `checkpoints.<id>.comment`).
- `input` — `source:` names a **json questions artifact** the preceding agent step produced (`{"questions":[{id,text,kind,options,required,recommended}]}`). The responder answers via an auto-generated form; **auto-passes** when the list is absent or empty.
- `review-gate` — `source:` names a **json review-report artifact** (`{"summary","findings":[{id,severity,file,line,title,detail,suggestion}]}`). The responder picks findings to fix (`outcome: fix`, the rest are explicitly accepted) or accepts them all (`outcome: pass`); auto-passes on zero findings.

Decisions store a structured `response` on the checkpoint row, exposed as the `checkpoints.<id>` expression root (e.g. `${checkpoints.review-gate.selectedFindings}` interpolates the full finding objects into the fix step's prompt). The schemas live in `@agrippa/core` (`interaction-schemas.ts`) and are shared by the engine, API, and SPA.

### Bounded loops

```yaml
- kind: loop
  id: review-fix
  name: { en: "Review & fix", zh-CN: "评审与修复" }
  maxIterations: 3                 # static, 1–10 — compiler totality preserved
  until: checkpoints.review-gate.outcome == 'pass'
  onMaxIterations: continue        # or fail
  phases: [...]                    # plain phases; no nested loops
```

`until` is evaluated after each iteration. `run_steps`/`checkpoints`/`artifacts` carry an `iteration` column; expression reads (`steps.*`, `artifacts.*`, `checkpoints.*`) resolve to the **latest** iteration, and a forward reference to a same-loop checkpoint resolves to the *previous* iteration's response (empty on iteration 1) — how a clarify round reads the answers to the previous round's questions. `budgets.perPhase` caps a phase's cumulative spend across iterations.

### System actions & new expression roots

`kind: system` actions in v2: `workspace.checkout`, `git.branch`, `git.push`, `pr.open` (the latter three require a `readWrite` workspace and run through the platform SCM service — [ADR-0011](../adr/0011-codex-executor-and-platform-scm.md)). Each takes an interpolable `with:` map; `pr.open` must produce exactly one `link` artifact and appends the accepted-findings waiver section to the PR body. New context roots: `checkpoints.<id>`, `artifacts.<key>` (latest inline content), plus `run.workBranch` and `run.taskTitle`.

## Full Example — `templates/swdev/bug-localize-fix.yaml`

```yaml
apiVersion: agrippa/v1
kind: OrchestrationTemplate
metadata:
  slug: swdev.bug-localize-fix
  scenario: software-development
  name: { en: "Bug Localization & Fix", zh-CN: "缺陷定位与修复" }
  description:
    en: "Reproduce a reported bug, localize the root cause, implement and verify a fix."
    zh-CN: "复现缺陷、定位根因、实现修复并验证。"
spec:
  faber: forge

  inputs:
    - key: bugReport
      type: text
      required: true
      label: { en: "Bug report", zh-CN: "缺陷描述" }
      ui: { widget: textarea, rows: 8 }
    - key: repo
      type: repoRef
      required: true
      label: { en: "Repository", zh-CN: "代码仓库" }
    - key: branch
      type: string
      default: main
      label: { en: "Base branch", zh-CN: "基准分支" }
    - key: reproduceCommand
      type: string
      required: false
      label: { en: "Reproduce command (optional)", zh-CN: "复现命令（可选）" }
    - key: autoOpenPr
      type: boolean
      default: false
      label: { en: "Open a pull request when done", zh-CN: "完成后自动创建 PR" }

  workspace:
    repo: ${inputs.repo}
    ref: ${inputs.branch}
    access: readWrite

  resources:
    skills:
      - ref: builtin/git-workflow@^1
      - ref: builtin/test-runner@^1
    mcpServers:
      - ref: github
        optional: true
    subagents:
      - id: code-locator
        description: "Searches the codebase to localize the root cause"
        promptFile: _shared/prompts/code-locator.md
        tools: [Read, Grep, Glob]
        model: { role: analysis }
      - id: verifier
        description: "Runs tests and validates the fix"
        tools: [Bash, Read]
        model: { role: fast }

  models:
    roles:
      planning: { tier: strong, fallback: [balanced] }
      analysis: { tier: balanced }
      coding:   { tier: strong }
      fast:     { tier: fast }
    allowProjectOverride: true

  phases:
    - id: reproduce
      name: { en: "Reproduce", zh-CN: "复现" }
      steps:
        - id: setup
          kind: system
          action: workspace.checkout
        - id: reproduce-bug
          kind: agent
          model: { role: analysis }
          instructions: |
            Attempt to reproduce the bug described below.
            ${inputs.reproduceCommand} may help. Record exact commands and observed
            vs expected behavior.
            --- BUG REPORT ---
            ${inputs.bugReport}
          produces: [reproduction-report]
          onFailure: continue

    - id: localize
      name: { en: "Localize", zh-CN: "定位" }
      steps:
        - id: find-root-cause
          kind: agent
          model: { role: planning }
          subagents: [code-locator]
          instructions: |
            Using the reproduction report and the codebase, identify the root cause.
            Produce a localization report: suspect files/lines, causal chain,
            and a proposed fix plan with risk assessment.
          produces: [localization-report]

    - id: fix
      name: { en: "Fix", zh-CN: "修复" }
      approval:
        checkpoint: approve-fix-plan
        title: { en: "Approve proposed fix plan", zh-CN: "确认修复方案" }
        present: [localization-report]
        timeout: 24h
        onTimeout: cancel
      steps:
        - id: implement-fix
          kind: agent
          model: { role: coding }
          skills: [builtin/git-workflow]
          instructions: |
            Implement the approved fix plan on a new branch. Keep the change minimal.
            Commit with a conventional commit message.
          produces: [patch]

    - id: verify
      name: { en: "Verify", zh-CN: "验证" }
      steps:
        - id: run-tests
          kind: agent
          model: { role: fast }
          subagents: [verifier]
          skills: [builtin/test-runner]
          instructions: |
            Run the reproduction steps and the test suite against the fixed branch.
            Fail this step if the bug still reproduces or tests regress.
          retry: { max: 2 }

    - id: report
      name: { en: "Report", zh-CN: "报告" }
      steps:
        - id: summarize
          kind: agent
          model: { role: fast }
          instructions: "Write a fix report: root cause, change summary, verification evidence."
          produces: [fix-report]
        - id: open-pr
          kind: agent
          when: ${inputs.autoOpenPr}
          requires: { mcpServers: [github] }
          mcpServers: [github]
          model: { role: fast }
          instructions: "Push the branch and open a PR; include the fix report as the body."
          produces: [pr-link]

  budgets:
    maxCostUsd: 8
    maxDurationMinutes: 45
    perPhase:
      fix: { maxCostUsd: 4 }

  outputs:
    artifacts:
      - { key: reproduction-report, kind: markdown, required: false }
      - { key: localization-report, kind: markdown, required: true }
      - { key: patch,               kind: patch,    required: true }
      - { key: fix-report,          kind: markdown, required: true }
      - { key: pr-link,             kind: link,     required: false }
    summary: { from: fix-report }
```

## M1 Builtin Template Set

| Scenario | Template | Sketch |
|---|---|---|
| Project management | `pm.status-report` | Gather repo/tracker activity → synthesize a bilingual status report |
| Project management | `pm.plan-breakdown` | PRD/goal input → milestone & task breakdown with estimates (approval gate before publishing) |
| Software development | `swdev.requirements-dev` | Requirement text → clarifying analysis → design proposal → approval → implementation plan or scaffold |
| Software development | `swdev.bug-localize-fix` | The full example above |
| Software development | `swdev.requirement-delivery` | **agrippa/v2 flagship**: clarify Q&A loop → plan loop with request-changes → implement on a platform branch → cross-agent review-fix loop (implementer=Claude Code, reviewer=Codex) → platform push + PR |
| Test & verification | `test.test-plan` | Feature/change description → risk-based test plan + case matrix |
| Test & verification | `test.regression-verify` | Repo + change ref → run suites, compare, verdict report |

## Engine/Executor Split (the portability rule)

The **engine** (`@agrippa/orchestration`) interprets everything structural: phases, step ordering, `when` conditions, approvals, retries, budgets, the output contract. The **executor** only ever executes **one step** — one agent invocation, possibly with sub-agents. No template concept may require executor-specific behavior; if a step can't be expressed as "prompt + resources + model + tool policy", the format (not the executor contract) must grow. This is what keeps templates portable across future engines ([ADR-0005](../adr/0005-executor-step-granularity.md)).
