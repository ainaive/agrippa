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

## 界面导航

导航集中在**左侧边栏**。顶部是**项目切换器**——可搜索项目、在项目间跳转或新建项目。下方的「项目」分组包含工作台、任务目录、任务，以及（项目管理员可见的）设置；「组织」分组包含审批收件箱，组织管理员还能看到管理入口。侧边栏可通过顶栏按钮收起为图标栏，小屏幕上会变为抽屉。顶栏显示当前位置的面包屑；右侧**头像菜单**用于切换语言（English / 中文）与主题（浅色 / 深色 / 跟随系统），以及退出登录。

## 初始配置清单

1. **创建项目** —— 首次登录会自动引导。项目是所有事物的边界：成员、资源、配额、代码仓库。新项目会**自动授权所有内置模型、技能与硅基人**，因此原本需要逐个开关的资源授权已默认就绪。
2. **关联代码仓库**（项目 → 设置 → 代码仓库）：选择托管平台（GitHub / GitLab / GitCode / 通用 Git），填写地址（HTTPS，不支持 SSH）、默认分支与访问令牌。令牌用于各托管平台的推送认证，并在 GitHub / GitLab / GitCode 上创建合并请求（通用 Git 仅推送）——发布类工作流即使面向公开仓库也需要它。令牌加密存储，之后不再显示。
3. **按需添加供应商密钥**（项目 → 设置 → 资源）：每个供应商的密钥与模型授权聚合在一处——例如使用通义千问模型需配置阿里百炼/DashScope 密钥。添加密钥时会**自动授权该供应商的内置模型**。
4. **需要自定义供应商？**（管理 → 模型与供应商）：组织管理员登记自定义供应商（DeepSeek、自建网关……）的 Anthropic 或 OpenAI 兼容端点与主机白名单，再在其下登记模型。项目随后在"资源"中像内置供应商一样为其配置密钥。
5. **按需微调资源授权**（项目 → 设置 → 资源）：内置资源已默认开启，仅在需要关闭某项时操作。提交表单的概要面板会显示**就绪检查清单**（模型、密钥、技能、仓库），每项不通过时可直接跳转到对应设置页修复。
6. **设置配额**（项目 → 设置 → 配额，可选）：每月 Token 上限；开启**强制停止**则配额耗尽后拒绝新提交并中止进行中的执行，关闭则仅作提示。
7. **邀请成员**（项目 → 设置 → 成员）：按邮箱添加——对方需先注册。角色：管理员 / 成员 / 访客。
8. **提交第一个任务**：在「任务目录」中试试针对已关联仓库的「状态报告」。
