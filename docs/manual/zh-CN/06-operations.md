# 运维指南

## 服务栈

`infra/docker-compose.yml` 运行四个服务：

| 服务 | 职责 | 说明 |
|---|---|---|
| `api` | REST + SSE + Web 界面 | 启动时自动迁移数据库并植入内置内容（带咨询锁，多实例并发启动安全） |
| `worker` | 执行任务 | 用 `WORKER_REPLICAS` 横向扩容；单 worker 并发由 `WORKER_SLOTS` 控制 |
| `postgres` | 事实来源 | 同时承载任务队列（pg-boss）——无需额外消息中间件 |
| `redis` | 仅用于实时事件分发 | **可丢弃**：宕机时实时流降级为回放/轮询，正确性不受影响 |

本手册中的每条命令都会显式指定 Compose 项目名（`-p agrippa`）。项目名同样固定写在 Compose 文件里，因此只要 shell 中没有设置 `COMPOSE_PROJECT_NAME`，这个参数就是冗余的；一旦设置了，未指定项目名的命令就会悄悄作用到另一套栈上——对 `down -v` 而言，这意味着删除错误的数据卷。如果你是有意在运行第二套栈（恢复演练、预发布副本等），请把它替换成那套栈的项目名，而不是把该参数去掉。

## 首次运行：创建管理员

自助注册已**关闭**——实例采用邀请制，因此第一位用户无法自行注册。需要离线创建一次组织管理员，然后登录：

```sh
# Docker —— 把两个值直接传给容器。compose 的 --env-file 只用于对 compose 文件
# 本身做变量插值，写在那里进程读不到；而写进 api 服务的 environment: 又会把管理员
# 密码长期留在容器环境里。
read -r -s -p 'admin password: ' PW; echo
docker compose -p agrippa -f infra/docker-compose.yml --env-file infra/env/.env exec \
  -e AGRIPPA_BOOTSTRAP_EMAIL=you@example.com \
  -e AGRIPPA_BOOTSTRAP_PASSWORD="$PW" \
  api bun apps/api/src/cli/bootstrap-admin.ts
unset PW

# VM（在 /opt/agrippa 下，读取 /etc/agrippa/agrippa.env 获取 DATABASE_URL）：
sudo -u agrippa env AGRIPPA_BOOTSTRAP_EMAIL=you@example.com \
  AGRIPPA_BOOTSTRAP_PASSWORD='设置一个强密码' \
  bun --env-file=/etc/agrippa/agrippa.env apps/api/src/cli/bootstrap-admin.ts
```

若 api 容器尚未启动，把 `exec` 换成 `run`——注意 `-e` 选项必须写在服务名**之前**：

```sh
docker compose -p agrippa -f infra/docker-compose.yml --env-file infra/env/.env run --rm --no-deps \
  -e AGRIPPA_BOOTSTRAP_EMAIL=you@example.com \
  -e AGRIPPA_BOOTSTRAP_PASSWORD="$PW" \
  api bun apps/api/src/cli/bootstrap-admin.ts
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
| `ANTHROPIC_API_KEY` | worker | Claude 执行器凭证——部署级回退；项目自己的服务商凭证（设置 → 模型服务商）会覆盖对应服务商的该密钥 |
| `OPENAI_API_KEY`、`CODEX_API_KEY` | worker | 同上，用于 Codex 执行器的 `openai` 服务商。二者均可留空：没有密钥的 worker 仍会注册 `codex-cli`，且项目凭证始终优先 |
| `AGRIPPA_EXECUTOR` | api | 未声明执行器的代理位所使用的默认值：`claude-agent-sdk`、`codex-cli` 或 `fake`（零 Token 演示） |
| `CODEX_VERSION` | 构建期 | 打进 worker 镜像的 Codex CLI 版本（默认 0.145.0，下限 0.122） |
| `NPM_REGISTRY` | 构建期 | 从何处下载 Codex CLI——中国大陆主机用 `https://registry.npmmirror.com` |
| `APT_MIRROR` | 构建期 | 构建 worker 镜像时使用的就近 Debian 镜像源 |
| `WORKER_SLOTS` | worker | 单 worker 并发执行数（默认 2） |
| `WORKSPACE_ROOT` | worker | 每次执行的检出目录（镜像内默认 `/work/runs`） |
| `ARTIFACT_STORAGE_ROOT` | worker | 大产出物存储（>64 KB；更小的存于 Postgres） |
| `AGRIPPA_TEMPLATES_DIR` | api、worker | 内置模板位置（镜像内已设置） |
| `AGRIPPA_WEB_DIST` | api | 要托管的 SPA 构建目录（api 镜像内已设置） |
| `AGRIPPA_MIGRATE_ON_BOOT` | api | 设为 `0` 关闭启动时迁移/植入 |
| `AGRIPPA_KEEP_WORKSPACES` | worker | 设为 `1` 保留已结束执行的工作区，便于排查 |
| `AGRIPPA_MAX_ARTIFACT_BYTES` | worker | 单个产出物大小上限（默认 25 MiB）。非正数或无法解析的值会回退到默认值，而不是取消上限 |
| `AGRIPPA_SCM` | worker | 设为 `fake` 时用伪造的分支/推送/PR 代替真实远端操作——用于演示 |
| `AGRIPPA_SSE_KEEPALIVE_MS` | api | 执行事件流发送保活注释帧的间隔（默认 15000 毫秒）。仅当中间层回收空闲连接更快时才需要调小 |
| `PORT` | api | 监听端口（默认 3000） |
| `AGRIPPA_PORT` | compose | 对外发布的端口映射，可带网卡地址。反向代理之后请用 `127.0.0.1:3000`，否则明文 HTTP 的 API 会监听 `0.0.0.0` |

## 执行器

worker 会在启动时以及每 60 秒的心跳中，把自己真正能跑的执行器写入 `executor_registrations`；没有任何 worker 注册过的执行器，API 会直接拒绝提交。`claude-agent-sdk` 与 `fake` 总会注册。`codex-cli` 只有在 worker 的 `PATH` 上存在足够新、支持 `codex exec --ignore-user-config` / `--ignore-rules` 的 Codex CLI 时才会注册——worker 镜像会把它装在 `/opt/codex`，该检查不通过时镜像构建会直接失败。

这一点很关键，因为**需求交付**把评审代理位绑定在了 `codex-cli` 上。每次部署后都应确认：

```sh
docker compose -p agrippa logs worker | grep -i codex
docker compose -p agrippa exec worker codex --version
docker compose -p agrippa exec -T postgres psql -U agrippa -d agrippa \
  -c "select executor_id, registered_at from executor_registrations order by 1;"
```

即使执行器已注册，步骤解析到的服务商仍需要凭证。`openai` 与 `anthropic` 可用 worker 环境变量（如 `OPENAI_API_KEY`）；`dashscope` 以及组织自行注册的自定义服务商**只能用项目凭证**。注意 `dashscope` 根本无法支撑 `codex-cli` 代理位——它在目录中只提供 `anthropic` 线路协议，因为 Codex ≥ 0.122 移除了百炼 OpenAI 兼容模式所用的 chat 线路 API。这类代理位请改指向提供 `openai` 协议的服务商，或改用 `claude-agent-sdk`。

## 轮换数据库密码

`POSTGRES_PASSWORD` 只在数据卷**首次初始化**时被 Postgres 读取，之后每次启动都会忽略它；而 Compose 仍然一直用它来拼接 `DATABASE_URL`。因此只改环境文件不会轮换任何东西，只会让 URL 与角色对不上：api 与 worker 会报 `password authentication failed for user "agrippa"`，`/healthz` 返回 503，部署随即回滚——而且回滚也救不回来，因为 `infra/env/.env` 未纳入版本控制，`git reset --hard` 不会还原它。

正确顺序是先改角色，再改文件：

```sh
C="docker compose -p agrippa -f infra/docker-compose.yml --env-file infra/env/.env"
NEW=$(openssl rand -hex 24)          # 用十六进制：该值会进入 URL，而 base64 可能产生 /

$C exec -T postgres psql -U agrippa -d agrippa \
    -c "ALTER ROLE agrippa WITH PASSWORD '$NEW'"
# 上一步成功之后，再把同样的值写入 infra/env/.env
$C up -d api worker                  # 使其读取新的 DATABASE_URL
```

**从依赖旧默认值的部署升级？** 早期版本在该变量未设置时会默认使用字面量 `agrippa`。现在它是必填项，因此请把它设置为 `agrippa`——也就是角色实际持有的密码——或者先用上面的方法轮换。设置成其他任何值都无法通过认证。

## 备份——三样东西

1. **数据库** —— Compose：`pgdata` 卷；虚拟机：`pg_dump agrippa` ——按你的策略定期执行。
2. **产出物存储** —— Compose：`artifacts` 卷；虚拟机：`/var/lib/agrippa/artifacts`。丢失后超过 64 KB 的下载不可恢复（元数据与小产出物在 Postgres 中仍在）。
3. **`AGRIPPA_SECRET_KEY`** ——没有它，所有已存的 git 令牌和 MCP 凭证都无法解密。Redis 无需备份。

## 升级与扩容

Compose 部署请使用 **`sudo infra/deploy.sh [<commit>]`**：它从 GitCode 拉取代码、构建以所部署提交号打标签的镜像、启动、等待 `/healthz`，若新版本起不来则**回滚到上一个标签**。可随时手动执行；向 `deploy` 分支推送时，Janus 会通过 `.janus/deploy.yml` 自动运行同一个脚本。

对 `deploy.sh` 自身的修改会**推迟一次部署才生效**：正在运行的脚本读自*上一次*部署时的工作树，重置工作树后它仍继续从原文件执行。因此，携带脚本改动的那次部署跑的仍是旧脚本。请在下一次部署时验证脚本改动，或手动执行新脚本。

服务器上的工作副本处于**游离 HEAD**（detached HEAD）状态，指向已部署的那个提交，因此在该目录执行 `git pull` 会直接失败，而不会悄悄把工作树推进到运行中镜像之后——Compose 配置、`.env` 默认值与 Dockerfile 都取自这棵工作树。查看当前部署的提交用 `git -C /opt/agrippa log -1`；要变更则移动 `deploy` 分支并推送。

api 的健康检查设置了 180 秒的 `start_period`：迁移与种子数据都在监听端口打开之前执行，若不设置，一次较慢但成功的迁移会在部署过程中显示为 `unhealthy`。

四个服务都设置了 `restart: unless-stopped`，因此主机重启后整套栈会自行恢复——没有别的东西在托管它。注意这与部署校验是绑定的：崩溃重启循环中的 worker 在两次重启之间看起来是 "running"，因此校验期间若 worker 的重启计数发生变化，本次部署同样判定失败。二者不可只去其一。

它每次都会重新构建，这是刻意为之：SPA 与 API 都在构建镜像时打包进 api 镜像，因此单纯的 `git pull && docker compose up -d` 会重启**旧**代码，且看起来像是成功了。构建缓存让纯文档变更的部署依然很快。脚本用 `flock` 串行化并发部署，并且只保留当前与上一个镜像标签（每组约 4 GB）。

有两点它不会做。它**只部署能从 `deploy` 分支追溯到的提交**——任意 SHA 会被拒绝，这正是那条 root 级授权得以成立的前提。以及**回滚不会还原数据库**：API 在启动、尚未健康之前就会执行迁移，其中部分不可逆。

Janus 并非通过 `sudo` 获得 root。它的服务启用了 `NoNewPrivileges`，该标志会被每个流水线步骤继承且子进程无法解除，因此 setuid 在其中永久失效——无论 sudoers 规则怎么写，`sudo` 都无法工作。流水线改为启动一个 oneshot systemd 单元 `agrippa-deploy@<sha>.service`，由一条 polkit 规则授权，且该规则仅限这一个单元与 `start` 这一个动作；部署日志写入 `/var/log/agrippa-deploy/<sha>.log`，再由流水线回读打印。参见 [`infra/janus/README.md`](https://github.com/ainaive/agrippa/blob/main/infra/janus/README.md)。

打印出来的命令会显式指定 Compose 项目名（`-p`）。它们本就是要粘贴到一个全新 shell 中执行的，若不指定，就会根据工作树里的 Compose 文件解析项目名——如果这次部署是在 `COMPOSE_PROJECT_NAME` 下运行的，那解析出的将是另一套栈，而非刚刚失败的这一套。

因此脚本会在每次部署前做一次 `pg_dump`，存放于 `/var/lib/agrippa-deploy`（目录 `0700`、转储文件 `0600`，保留最近 5 份——它们是生产数据的完整副本，而本机上还运行着非特权的 CI 用户）。任何失败都会打印还原步骤，而不是让人误以为数据库也一并还原了：

```sh
# 部署失败时会打印所用的转储文件路径；请把它赋给变量，而不是照抄占位符
DUMP=/var/lib/agrippa-deploy/pgdump-20260730-064413-070e868.dump
C="docker compose -p agrippa -f infra/docker-compose.yml --env-file infra/env/.env"

$C stop api worker                       # dropdb 要求没有任何连接
$C exec -T postgres dropdb -U agrippa --if-exists agrippa
$C exec -T postgres createdb -U agrippa agrippa
$C exec -T postgres pg_restore -U agrippa -d agrippa \
    --exit-on-error --single-transaction < "$DUMP"
$C start api worker                      # 仅在还原成功之后
```

要先删库重建，而不是用 `pg_restore --clean`：`--clean` 只会删除归档中存在的对象，因此失败迁移**新增**的表会残留下来，并可能因依赖关系导致还原失败。`--single-transaction` 配合 `--exit-on-error` 可保证部分还原会整体回滚，而不是留下一个半成品数据库。先停掉应用不是可选项——api 与 worker 仍持有连接时 `dropdb` 会拒绝执行。

只有当 api 报告健康、**且**每个预期的 worker 副本都在运行、**且**已有 worker 注册了执行器时，部署才算成功。副本数之所以重要，是因为 worker 在开始消费队列之前就会先注册，仅凭一条新注册记录会放过一个启动途中就挂掉的 worker。已知残留缺口：worker 起来了但注册后卡死，这种情况检测不到。

拉取新镜像后 `docker compose -p agrippa up -d` 即可（虚拟机：`sudo /opt/agrippa/infra/vm/deploy.sh`，会先重启 api——见上文虚拟机一节）。api 在启动时于咨询锁下迁移，多副本滚动升级安全。worker 排空同样安全：被终止的 worker 上进行中的执行保持 `running`，队列会重试，引擎**按步骤粒度续跑**——已完成的步骤不会重跑，Token 用量也不会重复计入。吞吐量 = `WORKER_REPLICAS` × `WORKER_SLOTS`。

### 从「compose 项目未命名」时期的部署升级

`v0.2.0` 及更早版本的 `infra/docker-compose.yml` 没有 `name:` 键，Compose 会用文件所在目录名作为项目名，即 `infra`；现在项目名固定为 `agrippa`。若你的卷叫 `infra_pgdata` / `infra_artifacts` / `infra_workspaces`（`docker volume ls` 可查），直接执行 `docker compose up -d` 会在旧栈旁边再起一套**空的**新栈，并与其争抢对外端口。请先迁移一次：

```sh
# 0. 仅当你已经在新代码上执行过 `docker compose up -d`、因而生成了一套空的
#    agrippa 栈时才需要这一步。执行前先用 `docker volume ls` 确认数据仍在
#    infra_* 下——这一步会删除那些新建的空卷。
docker compose -p agrippa -f infra/docker-compose.yml --env-file infra/env/.env down -v

# 1. 停掉旧栈——不要加 -v，那会删掉数据
docker compose -p infra -f infra/docker-compose.yml --env-file infra/env/.env down

# 2. 先检查「源」卷。Docker 会自动创建不存在的具名卷，因此一旦名字写错，就会挂上
#    一个空卷、什么也没复制，最后得到一个能通过 /healthz 的空数据库——看起来迁移
#    成功了，实际数据还留在别处。
for v in pgdata artifacts workspaces; do
  docker volume inspect "infra_$v" >/dev/null 2>&1 || {
    echo "infra_$v 不存在——请用 'docker volume ls' 核对真实卷名" >&2
    exit 1
  }
done
docker run --rm -v infra_pgdata:/from postgres:17 test -f /from/PG_VERSION || {
  echo "infra_pgdata 中没有 PG_VERSION——它不是 Postgres 数据目录" >&2
  exit 1
}

# 3. 把每个卷从 infra_X 复制到 agrippa_X。任何带 cp 的镜像都行，postgres:17
#    本地已有。执行工作区可丢弃，真正重要的是 pgdata 与 artifacts。
#
#    下面的检查不可省略：对已存在的卷执行 `docker volume create` 会静默成功，
#    而 `cp -a` 也不会删除目标里已有的文件。若把旧集群复制到一个「启动过又弃用」
#    的新栈上，就会把两个 system identifier 不同的 Postgres 集群混在一起——
#    WAL 与系统目录文件交错，且没有干净的回退办法。
for v in pgdata artifacts workspaces; do
  if docker volume inspect "agrippa_$v" >/dev/null 2>&1 &&
     [ -n "$(docker run --rm -v "agrippa_$v:/to" postgres:17 sh -c 'ls -A /to')" ]; then
    echo "agrippa_$v 已存在且非空——请先执行第 0 步" >&2
    exit 1
  fi
  docker volume create "agrippa_$v" >/dev/null
  docker run --rm -v "infra_$v:/from" -v "agrippa_$v:/to" postgres:17 \
    sh -c 'cd /from && cp -a . /to'
done

# 4. 以新项目名启动，确认无误后再清理
docker compose -p agrippa -f infra/docker-compose.yml --env-file infra/env/.env up -d
curl -fsS http://127.0.0.1:3000/healthz

# 5. 确认没问题后再执行这一步——不可逆
docker volume rm infra_pgdata infra_artifacts infra_workspaces
```

其余一切不变：镜像相同、env 文件相同、数据相同，变的只是资源的命名空间。

升级到首次引入平台自有 Git 快照（ADR-0012）的版本前，请先排空仍在进行的**仓库型**执行。旧工作区没有可信的平台 gitdir，新 worker 恢复时会按设计以 `workspace_lost` 失败关闭；非仓库型执行不受影响。后续升级仍保持正常的步骤粒度续跑行为。

反向代理注意：对 `/api/v1/runs/*/events`（SSE）**关闭响应缓冲**——如 nginx 的 `proxy_buffering off;`——否则实时进度会成批到达。该流每 15 秒发送一个注释帧，使空闲的执行不会被中间层当成断连回收；若某个中间层的超时更激进，可用 `AGRIPPA_SSE_KEEPALIVE_MS` 调整。

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
| `git.push` 失败 / `pr.open needs a stored repo credential` | 发布即使面向公开仓库也需要令牌（匿名 HTTPS 只读）——请添加带令牌的仓库连接，令牌需具备内容与合并请求的写权限。 |
| `pr.open is not supported for provider 'generic-git'` | 分支已推送，但只有 GitHub/GitLab/GitCode 连接能自动创建合并请求——请用正确的托管平台重建连接，或手动开 PR。 |
| 想看智能体在磁盘上到底做了什么 | 给 worker 设置 `AGRIPPA_KEEP_WORKSPACES=1` 后重跑；工作区保留在 `WORKSPACE_ROOT/<runId>`。 |
| 提交被拒 `executor_unavailable` | 没有任何在线 worker 注册过该执行器。若是 `codex-cli`，执行 `docker compose -p agrippa logs worker \| grep -i codex`——原因字符串直接来自 CLI 探测。 |
| 执行停在 `queued`，且事件里提到服务商鉴权被延后 | worker 没有该步骤所解析服务商的可用凭证——把密钥加进 worker 环境变量，或在设置 → 模型服务商中添加项目凭证。 |
| `healthz` 返回 503 | api 连不上 Postgres——检查 `DATABASE_URL` 与 postgres 服务。 |
| （Docker）怀疑沙箱未生效 | 属预期：在 Docker 默认配置下 bubblewrap **无法**创建命名空间，沙箱会静默降级。要恢复它需要同时放开 `seccomp=unconfined` 与 `CAP_SYS_ADMIN`，这比接受"容器即边界"更不划算（见 [design/08](../../design/08-deployment.md)）。需要操作系统级沙箱请改用 VM 部署方式。探测命令：`docker compose -p agrippa exec worker bwrap --unshare-all --ro-bind / / /bin/true`。 |
| （虚拟机）worker 卡在「activating」 | 其 `ExecStartPre` 正在等待 api 的 `/healthz`（最长 120 秒）——用 `journalctl -u agrippa-api` 排查 api 为何不健康。 |
| （虚拟机）Ubuntu 24.04 上智能体命令失败，或怀疑沙箱失效 | AppArmor 的 `apparmor_restrict_unprivileged_userns` 可能拦截 bubblewrap——而没有 bwrap 时沙箱会**静默**降级。用 `sudo -u agrippa bwrap --unshare-all --ro-bind / / /bin/true` 探测；若失败，放行非特权用户命名空间（或为 bwrap 安装 AppArmor 配置文件）后重启 worker。 |
