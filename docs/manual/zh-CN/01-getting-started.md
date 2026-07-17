# 快速开始

## 使用 Docker Compose 部署（推荐）

要求：安装了 Compose 的 Docker，约 2 GB 内存。

```sh
git clone https://github.com/ainaive/agrippa && cd agrippa
cp infra/env/.env.example infra/env/.env
# 编辑 infra/env/.env：
#   AGRIPPA_SECRET_KEY   ← openssl rand -base64 32   （务必备份！）
#   BETTER_AUTH_SECRET   ← openssl rand -base64 32
#   ANTHROPIC_API_KEY    ← 你的密钥；或留空并设置 AGRIPPA_EXECUTOR=fake
docker compose -f infra/docker-compose.yml --env-file infra/env/.env up -d
```

打开 `http://localhost:3000`。整个栈由四个服务组成：**api**（同时提供 Web 界面）、**worker**（执行任务）、**postgres**、**redis**。数据库迁移与内置内容（场景、任务类型、模板、模型、技能）在启动时自动就位。

**演示模式**：设置 `AGRIPPA_EXECUTOR=fake` 并将 `ANTHROPIC_API_KEY` 留空——所有任务类型都会由零 Token 消耗的演示执行器端到端跑通，产出占位产出物。适合在花费 Token 之前评估平台。

## 部署到虚拟机（systemd，无需 Docker）

要求：Ubuntu 22.04/24.04 LTS，约 2 GB 内存，root 权限。

```sh
sudo git clone https://github.com/ainaive/agrippa /opt/agrippa
sudo /opt/agrippa/infra/vm/install.sh        # 加 --skip-redis 可不装 Redis
```

安装脚本幂等（可重复执行），在同一台机器上完成全部准备：

- Bun，以及 worker 的系统依赖（`git`、`ripgrep`、用于智能体沙箱的 `bubblewrap`）
- PostgreSQL 17（PGDG）与 Redis 7（可选——没有它实时流会降级为轮询）
- `agrippa` 系统用户，数据目录位于 `/var/lib/agrippa`
- `/etc/agrippa/agrippa.env`，密钥自动生成——**务必备份 `AGRIPPA_SECRET_KEY`**
- `agrippa-api` + `agrippa-worker` systemd 服务，随后完成首次构建并启动

打开 `http://<主机>:3000`。上文的演示模式同样适用（在 `/etc/agrippa/agrippa.env` 中设置 `AGRIPPA_EXECUTOR=fake`）。后续更新：

```sh
sudo /opt/agrippa/infra/vm/deploy.sh         # 拉取 → 构建 → 重启（先 api 后 worker）
```

虚拟机上的日志、备份与故障排查见[运维指南](06-operations.md)。

## 源码运行（开发模式）

参见 [README 快速开始](../../../README.md#getting-started)：Bun ≥ 1.3 + 本地 Postgres，启动三个进程（`api`、`worker`、`web`）。

## 首次登录

在登录页注册账号——**第一个注册的账号自动成为组织管理员**（其后注册的均为普通成员）。全新部署正是通过这一机制引导出管理员，请在分享地址给团队之前先创建好管理员账号。

## 初始配置清单

1. **创建项目** —— 首次登录会自动引导。项目是所有事物的边界：成员、资源、预算、代码仓库。
2. **关联代码仓库**（项目 → 设置 → 代码仓库）：填写地址、默认分支，私有仓库需提供访问令牌。令牌加密存储，之后不再显示。
3. **授权资源**（项目 → 设置 → 资源授权）：打开项目可用的**模型**（每个所需档位至少一个），以及任务类型需要的**技能**/**MCP 服务**。缺少必需资源时，提交会给出明确的报错。
4. **设置配额**（项目 → 设置 → 配额，可选）：每月费用/Token 上限，可开启强制停止。
5. **邀请成员**（项目 → 设置 → 成员）：按邮箱添加——对方需先注册。角色：管理员 / 成员 / 访客。
6. **提交第一个任务**：在「任务目录」中试试针对已关联仓库的「状态报告」。
