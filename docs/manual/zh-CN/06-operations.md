# 运维指南

## 服务栈

`infra/docker-compose.yml` 运行四个服务：

| 服务 | 职责 | 说明 |
|---|---|---|
| `api` | REST + SSE + Web 界面 | 启动时自动迁移数据库并植入内置内容（带咨询锁，多实例并发启动安全） |
| `worker` | 执行任务 | 用 `WORKER_REPLICAS` 横向扩容；单 worker 并发由 `WORKER_SLOTS` 控制 |
| `postgres` | 事实来源 | 同时承载任务队列（pg-boss）——无需额外消息中间件 |
| `redis` | 仅用于实时事件分发 | **可丢弃**：宕机时实时流降级为回放/轮询，正确性不受影响 |

## 配置项参考

以 `infra/env/.env.example` 为准；完整清单：

| 变量 | 使用方 | 含义 |
|---|---|---|
| `DATABASE_URL` | api、worker | Postgres 连接串 |
| `REDIS_URL` | api、worker | 事件分发用 Redis；不设则回退为数据库轮询 |
| `AGRIPPA_SECRET_KEY` | api、worker | **必填。**加密存储凭证的 32 字节 base64 密钥。丢失将使全部已存令牌不可恢复 |
| `BETTER_AUTH_SECRET` | api | **必填。**会话签名密钥 |
| `AGRIPPA_BASE_URL` | api | 实例的公开地址 |
| `ANTHROPIC_API_KEY` | worker | Claude 执行器凭证 |
| `AGRIPPA_EXECUTOR` | api | 新执行的默认执行器：`claude-agent-sdk` 或 `fake`（零 Token 演示） |
| `WORKER_SLOTS` | worker | 单 worker 并发执行数（默认 2） |
| `WORKSPACE_ROOT` | worker | 每次执行的检出目录（镜像内默认 `/work/runs`） |
| `ARTIFACT_STORAGE_ROOT` | worker | 大产出物存储（>64 KB；更小的存于 Postgres） |
| `AGRIPPA_TEMPLATES_DIR` | api、worker | 内置模板位置（镜像内已设置） |
| `AGRIPPA_WEB_DIST` | api | 要托管的 SPA 构建目录（api 镜像内已设置） |
| `AGRIPPA_MIGRATE_ON_BOOT` | api | 设为 `0` 关闭启动时迁移/植入 |
| `AGRIPPA_KEEP_WORKSPACES` | worker | 设为 `1` 保留已结束执行的工作区，便于排查 |
| `PORT` | api | 监听端口（默认 3000） |

## 备份——三样东西

1. **postgres 卷**（`pgdata`）——按你的策略定期 `pg_dump`。
2. **work 卷**（`workdata`）——存放大产出物；丢失后超过 64 KB 的下载不可恢复（元数据与小产出物在 Postgres 中仍在）。
3. **`AGRIPPA_SECRET_KEY`** ——没有它，所有已存的 git 令牌和 MCP 凭证都无法解密。Redis 无需备份。

## 升级与扩容

拉取新镜像后 `docker compose up -d` 即可。api 在启动时于咨询锁下迁移，多副本滚动升级安全。worker 排空同样安全：被终止的 worker 上进行中的执行保持 `running`，队列会重试，引擎**按步骤粒度续跑**——已完成的步骤不会重跑，费用也不会重复计入。吞吐量 = `WORKER_REPLICAS` × `WORKER_SLOTS`。

反向代理注意：对 `/api/v1/runs/*/events`（SSE）**关闭响应缓冲**——如 nginx 的 `proxy_buffering off;`——否则实时进度会成批到达。

## 故障排查

| 现象 | 可能原因 / 处理 |
|---|---|
| 执行卡在「排队中」 | 没有 worker 在运行，或入队丢失——worker 启动后其巡检器会自动补投超过 30 秒的排队执行。查看 worker 日志。 |
| 实时进度延迟约 1 秒、无推送 | `REDIS_URL` 未设置或不可达——SSE 退化为数据库轮询。无害；恢复 Redis 即恢复即时推送。 |
| 提交被拒 `skill_not_granted` / `mcp_not_granted` / `model_unresolvable` | 到 项目 → 设置 → 资源授权 打开对应资源（模型需覆盖模板请求的档位）。 |
| 提交被拒 `quota_exhausted` | 项目当月强制配额已用尽——上调、关闭强制停止或等待下一周期。 |
| 执行失败 `contract_violation` | 智能体未产出某个必需产出物——查看各步骤输出，通常是模板指令的问题。 |
| 私有仓库检出失败 | 仓库连接的令牌缺失或过期——到 设置 → 代码仓库 重新录入（令牌只写不读，重新填写即可）。 |
| 想看智能体在磁盘上到底做了什么 | 给 worker 设置 `AGRIPPA_KEEP_WORKSPACES=1` 后重跑；工作区保留在 `WORKSPACE_ROOT/<runId>`。 |
| `healthz` 返回 503 | api 连不上 Postgres——检查 `DATABASE_URL` 与 postgres 服务。 |
