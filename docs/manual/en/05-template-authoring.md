# Template Authoring

Orchestration templates are the heart of Agrippa: a YAML document that defines a task type's inputs, execution plan, and deliverables. This is the practical guide; the formal specification is [docs/design/02](../../design/02-orchestration-template.md), and the six builtins under `templates/` are working references — `swdev/bug-localize-fix.yaml` exercises every feature.

## Workflow

Admin → Templates → *(create a head or open one)* → edit YAML → **Validate** → **Save draft** → **Publish**. Validation is a full dry-run compile that reports *every* problem at once and previews the submission form. Publishing is irreversible for that version — new submissions use it; old runs keep theirs. Builtin templates live in the repo under `templates/` and republish automatically on deploy when their source changes (`bun run templates:validate` checks them in CI).

The editor's version list lets you **open any historical version** (editing an old source and saving simply creates the next draft — versions themselves never change), **Compare versions** shows a colorized diff between any two, and older published versions can be **deprecated** — they stay available to the historical runs that pin them, but are marked retired. The latest published version can't be deprecated (new submissions pin it); publish a newer version first.

## A minimal template, annotated

```yaml
apiVersion: agrippa/v1
kind: OrchestrationTemplate
metadata:
  slug: swdev.my-task            # <scenario-prefix>.<name>, must match the template head
  scenario: software-development # must match the head's scenario
  name: { en: "My Task", zh-CN: "我的任务" }        # BOTH locales, always
  description: { en: "...", zh-CN: "……" }
spec:
  faber: forge                   # default preset agent

  inputs:                        # ⇒ auto-generates the submission form
    - key: goal
      type: text                 # string|text|number|boolean|select|repoRef|docRef
      required: true
      label: { en: "Goal", zh-CN: "目标" }
      ui: { widget: textarea, rows: 6 }

  models:
    roles:                       # roles → tiers; resolved to granted models at submit
      planning: { tier: strong, fallback: [balanced] }
      fast: { tier: fast }

  phases:
    - id: work
      name: { en: "Work", zh-CN: "执行" }
      steps:
        - id: do-it
          kind: agent
          model: { role: planning }
          instructions: |
            Accomplish this goal: ${inputs.goal}
          produces: [result]     # artifact keys this step must create

  outputs:
    artifacts:
      - { key: result, kind: markdown, required: true }   # run fails without it
    summary: { from: result }
```

## Inputs → form widgets

| `type` | Renders as | Value shape |
|---|---|---|
| `string` | text input | string |
| `text` | textarea (`ui.rows`) | string |
| `number` | number input | number |
| `boolean` | switch | boolean |
| `select` | dropdown (`options` with localized labels) | option value |
| `repoRef` | picker over the project's connected repositories | `{ repoConnectionId }` |
| `docRef` | reserved (not yet available) | — |

`required`, `default`, `label`, and `help` behave as you'd expect; the API re-validates against the same schema, so the form and the server can't disagree.

## Execution plan

- **Phases** group steps for the timeline and are the attachment point for approvals. **Steps run sequentially.**
- Step kinds: `agent` (one agent invocation — instructions, `model: {role}`, optional `subagents`/`skills`/`mcpServers` drawn from `spec.resources`) and `system` (platform action; currently `workspace.checkout`).
- **Workspace**: declare `workspace: { repo: ${inputs.myRepo}, ref: ..., access: readOnly|readWrite }` and add a `kind: system, action: workspace.checkout` step where the clone should happen.
- **Control flow** — deliberately small: `when: <expression>` (skip the step when falsy), `retry: { max: N }` (same-step retries), `onFailure: continue` (record the failure, move on). There are no loops — that's a governance decision (ADR-0006).
- **Optional integrations**: mark an MCP server `optional: true` in `resources`, then gate steps with `requires: { mcpServers: [name] }` — the step is skipped, not failed, when it's unavailable.

## Expressions

`${...}` placeholders work in instructions, workspace fields, and `when`. The language is property paths plus `==`, `!=`, `&&`, `||`, `!`, literals, and parentheses — nothing else. Available roots: `inputs.*`, `steps.<id>.outputs.result` (an earlier step's final output), `run.id`/`run.number`, `project.slug`/`project.name`. The compiler rejects references to unknown inputs or to steps defined later.

## Approvals, budgets, artifacts

```yaml
phases:
  - id: build
    approval:                          # gate BEFORE this phase runs
      checkpoint: approve-plan
      title: { en: "Approve the plan", zh-CN: "确认方案" }
      present: [draft-plan]            # artifacts shown to the approver
      timeout: 48h                     # then: cancel | reject | approve
      onTimeout: cancel

budgets:
  maxCostUsd: 6
  maxDurationMinutes: 40
  perPhase:
    build: { maxCostUsd: 3 }
```

Artifacts: agents write files to `.agrippa/artifacts/<key>` in the workspace (the platform tells them to, listing each expected key); `patch`-kind artifacts are generated automatically from the workspace diff. Every `produces:` key must be declared in `outputs.artifacts`, and every `required: true` artifact must be produced by some step — the compiler checks the wiring, the engine enforces delivery.

## Validation checklist

The compiler rejects, among other things: a missing `en` or `zh-CN` on any localized field, unknown model roles, references to undeclared subagents/skills/MCP servers, `produces` keys outside the artifact contract, required artifacts nothing produces, unknown expression roots, and forward references to later steps. Fix everything it lists — a template that compiles will run.
