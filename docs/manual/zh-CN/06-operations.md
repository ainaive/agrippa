# 运维指南

## 服务栈

`infra/docker-compose.yml` 运行四个服务：

| 服务 | 职责 | 说明 |
|---|---|---|
| `api` | REST + SSE + Web 界面 | 启动时自动迁移数据库并植入内置内容（带咨询锁，多实例并发启动安全） |
| `worker` | 执行任务 | 用 `WORKER_REPLICAS` 横向扩容；单 worker 并发由 `WORKER_SLOTS` 控制 |
| `postgres` | 事实来源 | 同时承载任务队列（pg-boss）——无需额外消息中间件 |
| `redis` | 仅用于实时事件分发 | **可丢弃**：宕机时实时流降级为回放/轮询，正确性不受影响 |

## 首次运行：创建管理员

自助注册已**关闭**——实例采用邀请制，因此第一位用户无法自行注册。需要离线创建一次组织管理员，然后登录：

```sh
# Docker：env 文件为 infra/env/.env
# VM：/etc/agrippa/agrippa.env
AGRIPPA_BOOTSTRAP_EMAIL=you@example.com
AGRIPPA_BOOTSTRAP_PASSWORD='设置一个强密码'
```

```sh
# Docker —— 在 api 镜像中运行脚本，连到当前 compose 栈：
docker compose -f infra/docker-compose.yml --env-file infra/env/.env run --rm \
  api bun apps/api/src/cli/bootstrap-admin.ts

# VM（在 /opt/agrippa 下，读取 /etc/agrippa/agrippa.env）：
sudo -u agrippa bun --env-file=/etc/agrippa/agrippa.env apps/api/src/cli/bootstrap-admin.ts
```

脚本对邮箱幂等（同地址重复运行不会重复创建），用与登录流程一致的哈希算法存储密码，并写一条审计记录。看到 `org_admin created` 后即可在实例地址登录。之后其他成员只能通过邀请加入（管理 → 成员），参见[管理](04-administration.md#账号与接入)。

## 虚拟机（systemd）部署

由 `infra/vm/install.sh` 在单台 Ubuntu 主机上安装的同一套服务栈（无需 Docker；参见[快速开始](01-getting-started.md#部署到虚拟机systemd无需-docker)）：

| 内容 | 位置 |
|---|---|
| 服务 | `agrippa-api.service`、`agrippa-worker.service`（Postgres 与 Redis 为常规系统服务） |
| 日志 | `journalctl -u agrippa-api -f` · `journalctl -u agrippa-worker -f` |
| 代码 + SPA 构建 | `/opt/agrippa`（root 所有） |
| 配置 | `/etc/agrippa/agrippa.env` ——两个服务共用一个文件 |
| 执行工作区 / 产出物 | `/var/lib/agrippa/runs` · `/var/lib/agrippa/artifacts` |

更新：`sudo /opt/agrippa/infra/vm/deploy.sh` ——拉取（`--ff-only`）、按锁定文件安装依赖、重建 SPA、重启 api、等待 `/healthz`（迁移在 api 启动时应用）、再重启 worker。修改配置后执行 `sudo systemctl restart agrippa-api agrippa-worker` 生效。

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

1. **数据库** —— Compose：`pgdata` 卷；虚拟机：`pg_dump agrippa` ——按你的策略定期执行。
2. **产出物存储** —— Compose：`artifacts` 卷；虚拟机：`/var/lib/agrippa/artifacts`。丢失后超过 64 KB 的下载不可恢复（元数据与小产出物在 Postgres 中仍在）。
3. **`AGRIPPA_SECRET_KEY`** ——没有它，所有已存的 git 令牌和 MCP 凭证都无法解密。Redis 无需备份。

## 升级与扩容

拉取新镜像后 `docker compose up -d` 即可（虚拟机：`sudo /opt/agrippa/infra/vm/deploy.sh`，会先重启 api——见上文虚拟机一节）。api 在启动时于咨询锁下迁移，多副本滚动升级安全。worker 排空同样安全：被终止的 worker 上进行中的执行保持 `running`，队列会重试，引擎**按步骤粒度续跑**——已完成的步骤不会重跑，费用也不会重复计入。吞吐量 = `WORKER_REPLICAS` × `WORKER_SLOTS`。

反向代理注意：对 `/api/v1/runs/*/events`（SSE）**关闭响应缓冲**——如 nginx 的 `proxy_buffering off;`——否则实时进度会成批到达。

## 故障排查

| 现象 | 可能原因 / 处理 |
|---|---|
| 执行卡在「排队中」 | 没有 worker 在运行，或入队丢失——worker 启动后其巡检器会自动补投超过 30 秒的排队执行。查看 worker 日志。 |
| 实时进度延迟约 1 秒、无推送 | `REDIS_URL` 未设置或不可达——SSE 退化为数据库轮询。无害；恢复 Redis 即恢复即时推送。 |
| 提交被拒 `skill_not_granted` / `mcp_not_granted` / `model_unresolvable` | 到 项目 → 设置 → 资源授权 打开对应资源（模型需覆盖模板请求的档位）。 |
| 提交被拒 `quota_exhausted` | 项目当月强制配额已用尽——上调、关闭强制停止或等待下一周期。 |
| 提交被拒 `repo_not_in_project` | 该 `repoConnectionId` 不属于本项目——请选择本项目「设置 → 代码仓库」中已注册的仓库。 |
| 某个可选步骤（如「提交 PR」）被跳过 | 其可选资源未授权——在「设置 → 资源授权」中授权对应 MCP 服务；未授权的可选资源会被跳过，而不会用共享凭证运行。 |
| 执行失败 `contract_violation` | 智能体未产出某个必需产出物——查看各步骤输出，通常是模板指令的问题。 |
| 私有仓库检出失败 | 仓库连接的令牌缺失或过期——到 设置 → 代码仓库 重新录入（令牌只写不读，重新填写即可）。 |
| 想看智能体在磁盘上到底做了什么 | 给 worker 设置 `AGRIPPA_KEEP_WORKSPACES=1` 后重跑；工作区保留在 `WORKSPACE_ROOT/<runId>`。 |
| `healthz` 返回 503 | api 连不上 Postgres——检查 `DATABASE_URL` 与 postgres 服务。 |
| （虚拟机）worker 卡在「activating」 | 其 `ExecStartPre` 正在等待 api 的 `/healthz`（最长 120 秒）——用 `journalctl -u agrippa-api` 排查 api 为何不健康。 |
| （虚拟机）Ubuntu 24.04 上智能体命令失败，或怀疑沙箱失效 | AppArmor 的 `apparmor_restrict_unprivileged_userns` 可能拦截 bubblewrap——而没有 bwrap 时沙箱会**静默**降级。用 `sudo -u agrippa bwrap --unshare-all --ro-bind / / /bin/true` 探测；若失败，放行非特权用户命名空间（或为 bwrap 安装 AppArmor 配置文件）后重启 worker。 |
