# 模板编写

编排模板是 Agrippa 的核心：一份 YAML 文档，定义任务类型的输入、执行计划与交付物。本文是实践指南；正式规范见 [docs/design/02](../../design/02-orchestration-template.md)，`templates/` 下的六个内置模板是可运行的参考——其中 `swdev/bug-localize-fix.yaml` 覆盖了全部特性。

## 工作流程

管理 → 模板 →（新建或打开）→ 编辑 YAML → **校验** → **保存草稿** → **发布**。校验是完整的试编译，一次性报告*所有*问题，并预览提交表单。发布对该版本不可逆——新提交使用它，旧执行保持各自的版本。平台自带模板位于仓库 `templates/` 目录，源码变更后随部署自动重新发布（CI 中 `bun run templates:validate` 把关）。

## 最小模板（带注释）

```yaml
apiVersion: agrippa/v1
kind: OrchestrationTemplate
metadata:
  slug: swdev.my-task            # <场景前缀>.<名称>，须与模板头一致
  scenario: software-development # 须与模板头的场景一致
  name: { en: "My Task", zh-CN: "我的任务" }        # 两种语言，缺一不可
  description: { en: "...", zh-CN: "……" }
spec:
  faber: forge                   # 默认硅基人

  inputs:                        # ⇒ 自动生成提交表单
    - key: goal
      type: text                 # string|text|number|boolean|select|repoRef|docRef
      required: true
      label: { en: "Goal", zh-CN: "目标" }
      ui: { widget: textarea, rows: 6 }

  models:
    roles:                       # 角色 → 档位；提交时解析为已授权模型
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
            完成这个目标：${inputs.goal}
          produces: [result]     # 该步骤必须产出的产出物键

  outputs:
    artifacts:
      - { key: result, kind: markdown, required: true }   # 缺失则执行失败
    summary: { from: result }
```

## 输入 → 表单控件

| `type` | 呈现为 | 值形态 |
|---|---|---|
| `string` | 单行文本框 | 字符串 |
| `text` | 多行文本域（`ui.rows`） | 字符串 |
| `number` | 数字输入 | 数字 |
| `boolean` | 开关 | 布尔 |
| `select` | 下拉（`options` 带本地化标签） | 选项值 |
| `repoRef` | 项目已关联仓库的选择器 | `{ repoConnectionId }` |
| `docRef` | 预留（暂不可用） | — |

`required`、`default`、`label`、`help` 行为如你所料；API 端会按同一 Schema 复验，表单与服务端不可能不一致。

## 执行计划

- **阶段（phase）**把步骤分组，用于时间线展示，也是审批节点的挂载点。**步骤顺序执行。**
- 步骤类型：`agent`（一次智能体调用——指令、`model: {role}`，可选的 `subagents`/`skills`/`mcpServers` 取自 `spec.resources`）与 `system`（平台动作，当前为 `workspace.checkout`）。
- **工作区**：声明 `workspace: { repo: ${inputs.myRepo}, ref: ..., access: readOnly|readWrite }`，并在需要克隆的位置放一个 `kind: system, action: workspace.checkout` 步骤。
- **控制流**——刻意保持极小：`when: <表达式>`（为假则跳过）、`retry: { max: N }`（同步骤重试）、`onFailure: continue`（记录失败后继续）。没有循环——这是治理层面的决定（ADR-0006）。
- **可选集成**：在 `resources` 中给 MCP 服务标记 `optional: true`，再用 `requires: { mcpServers: [name] }` 约束步骤——服务不可用时该步骤*跳过*而非失败。

## 表达式

`${...}` 占位符可用于指令、工作区字段与 `when`。语言只有属性路径加 `==`、`!=`、`&&`、`||`、`!`、字面量与括号——再无其他。可用的根：`inputs.*`、`steps.<id>.outputs.result`（前序步骤的最终输出）、`run.id`/`run.number`、`project.slug`/`project.name`。编译器会拒绝引用不存在的输入或定义在后面的步骤。

## 审批、预算、产出物

```yaml
phases:
  - id: build
    approval:                          # 在该阶段执行【之前】设卡
      checkpoint: approve-plan
      title: { en: "Approve the plan", zh-CN: "确认方案" }
      present: [draft-plan]            # 呈现给审批人的产出物
      timeout: 48h                     # 到期后：cancel | reject | approve
      onTimeout: cancel

budgets:
  maxCostUsd: 6
  maxDurationMinutes: 40
  perPhase:
    build: { maxCostUsd: 3 }
```

产出物：智能体把文件写入工作区的 `.agrippa/artifacts/<key>`（平台会明确告知每个期望的键）；`patch` 类型的产出物由平台自动从工作区差异生成。每个 `produces:` 键都必须在 `outputs.artifacts` 中声明，每个 `required: true` 的产出物都必须有某个步骤产出——编译器检查连线，引擎保证交付。

## 校验清单

编译器会拒绝（不完全列举）：任何本地化字段缺少 `en` 或 `zh-CN`、未知的模型角色、引用未声明的子智能体/技能/MCP 服务、`produces` 键不在产出物契约内、必需产出物无人产出、未知的表达式根、以及对后续步骤的前向引用。把它列出的问题全部修完——能编译通过的模板就能运行。
