# Agrippa · 硅基工坊 Silicon Workshop

**English** | [中文](#中文)

Agrippa is a team-oriented agent work platform. Teams collaborate in **projects**, pick a **task type** from a catalog of work scenarios (project management, software development, test & verification), fill in a form, and submit — the platform executes the task in the background with a preset agent (a **Faber**, 硅基人) that orchestrates sub-agents, Skills, MCP servers, and models according to a versioned **orchestration template**, streaming live progress and producing reviewable artifacts.

## Three layers

1. **Scenario layer** — a task catalog organized by work scenario; forms are auto-generated from template parameter schemas.
2. **Orchestration layer** — Fabri execute runs by following orchestration templates: phases, steps, human-approval checkpoints, model-selection rules, budgets. Engines are pluggable; the first executor is the Claude Agent SDK.
3. **Resource layer** — governed registries for models, sub-agents, Skills, MCP servers, and templates, with registration, immutable versioning, and project-level permission grants.

Projects are the resource scope and billing boundary: enabled Skills/MCP/models, token budget & quota, connected repos and docs.

## Status

M1 implemented — all three layers work end to end. See the [M1 plan](docs/plan/m1-plan.md) for what shipped.

## Getting started

**Development** (Bun ≥ 1.3, Postgres running locally):

```sh
bun install
docker compose -f infra/docker-compose.dev.yml up -d   # postgres + redis (or use local installs)
export DATABASE_URL=postgres://localhost:5432/agrippa
export AGRIPPA_SECRET_KEY=$(openssl rand -base64 32)
export AGRIPPA_EXECUTOR=fake                            # token-free demo executor
bun apps/api/src/index.ts      # api :3000 (migrates + seeds on boot)
bun apps/worker/src/index.ts   # worker
cd apps/web && bun run dev     # SPA :5173 (proxies /api → :3000)
```

Sign up (the first user becomes org admin), create a project, grant models/skills under Settings → Resources, then submit a task from the catalog. Set `AGRIPPA_EXECUTOR=claude-agent-sdk` and `ANTHROPIC_API_KEY` for real runs.

**Self-hosted** (Docker):

```sh
cp infra/env/.env.example infra/env/.env    # fill in the secrets
docker compose -f infra/docker-compose.yml --env-file infra/env/.env up -d
```

**Quality gate**: `bun run check && bun test` (same commands CI runs).

## Documentation

- Design: [overview](docs/design/00-overview.md) · [domain model](docs/design/01-domain-model.md) · [orchestration templates](docs/design/02-orchestration-template.md) · [executor abstraction](docs/design/03-executor-abstraction.md) · [execution runtime](docs/design/04-execution-runtime.md) · [API & auth](docs/design/05-api-and-auth.md) · [frontend](docs/design/06-frontend.md) · [i18n](docs/design/07-i18n.md) · [deployment](docs/design/08-deployment.md) · [testing & CI](docs/design/09-testing-and-ci.md)
- Decisions: [ADRs](docs/adr/)

## Tech stack

TypeScript · Bun workspaces monorepo · Hono (REST + SSE) · Vite + React + TailwindCSS + shadcn/ui · Drizzle + Postgres · pg-boss · Redis (pubsub) · better-auth · i18next (en / zh-CN) · Claude Agent SDK (first executor) · Docker Compose (self-hosted)

---

## 中文

Agrippa（硅基工坊）是一个面向团队的智能体工作平台。团队在**项目**中协作：从工作场景目录（项目管理、软件研发、测试验证）中选择**任务类型**，填写表单并提交——平台在后台由预置智能体（**硅基人**，Faber）执行任务：依照带版本的**编排模板**调度子智能体、技能（Skills）、MCP 服务与模型，实时推送执行进度，并产出可审阅的成果物。

### 三层架构

1. **场景层** —— 按工作场景组织的任务目录；提交表单由模板参数 Schema 自动生成。
2. **编排层** —— 硅基人依照编排模板执行任务：阶段与步骤、人工审批节点、模型选择规则、预算限制。执行引擎可插拔，首个执行器为 Claude Agent SDK。
3. **资源层** —— 模型、子智能体、技能、MCP 服务与编排模板的受管注册表：注册、不可变版本、项目级授权。

项目是资源与计费边界：项目级启用技能/MCP/模型、Token 预算与配额、关联代码仓库与文档。

### 当前状态

设计阶段——请阅读上方设计文档；实现按 [M1 计划](docs/plan/m1-plan.md) 推进。
