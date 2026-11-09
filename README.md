# Creator-AI

把背景留下，把时间留给创作。

Creator-AI 是面向个人创作者的自部署 Web 工作台：保存账号定位和作者人设，配置长期协作的专家与 Skills，不必每次创作重新交代背景。目标形态为 Docker Compose 部署，而不是桌面客户端。

> 当前交付版本：`0.1.0`。通过生产 Compose 安装到自己的服务器，后续在同一产品上迭代测试反馈。已实现文字创作与文章协作主流程；配图、定时创作、视频和自动发布尚未实现。容器部署及真实模型质量仍需在实际环境验证。

## 当前功能

- 通过本地 CLI 初始化唯一管理员，登录、注销和使用可撤销会话。
- 创建公众号、头条或通用平台的账号档案，保存目标读者和作者人设。这不是平台授权登录。
- 在账号的**写作资料**导入 Markdown / TXT 人物卡、写作卡与范文，预览、编辑、启停后显式保存。新创作冻结资料；已有文章可明确选择本轮使用账号当前资料，见 [账号写作资料](docs/20-account-writing-cards.md)。
- 在**专家中心**创建单专家或专家团，配置身份/方法、推荐问法、可用与预加载 Skills；支持复制、启停、版本历史。
- 在独立**技能库**创建和编辑 SKILL.md，查看导入资源、管理版本、启停和导出；不再限于三个固定技能。
- 预览并确认导入受限的专家/团队/Skill ZIP，保存原包文件，导出当前配置；冲突不覆盖已有能力。
- 在**模型设置**中保存加密连接、启停、选择输入/输出限制；可确认费用后显式检查基础文本/JSON 连接，记录结果与用量。仅允许管理员白名单中的 HTTPS 服务，保存和查看不会自动调用，详见 [连接检查](docs/19-model-connection-checks.md)。
- 选择账号、单专家或专家团与主题，提交后台任务；保存当时的专家/技能/资源/模型配置和预算快照。未选择模型时仅单专家 mock。
- 真实协议路径包含独立 Agent 工具循环、按需技能/包内文本读取、成员阶段依赖与并行、主理人独立汇总，保留原始交付和调用账本。
- 专家团可显式选择动态模式：负责人提案、用户批准后派工、成员同伴追问/用户补问、反馈重规划和独立汇总；等待时释放 Worker，同一账本持久化恢复，详见 [动态协作契约](docs/16-dynamic-team-collaboration.md)。
- 查看创作记录、实时状态、只读候选正文与技能/工具证据，取消任务或核对未知结果，并下载草稿 JSON。
- 对成功草稿追加修改要求，复用原账号/专家/技能快照生成新分支，保留原稿和执行记录，查看来源与同主题历史。真实模型每轮独立预算并提示新费用；mock 仍仅验证流程，详见 [继续创作契约](docs/15-draft-continuation.md)。
- 将成功候选稿加入独立**内容库**，人工编辑标题与正文，保存不可变版本、恢复历史为新版本、送审/要求修改，并导出指定版本的 JSON、Markdown 或安全 HTML。模拟来源永久保留、不能审核通过；断线重试和并发冲突不覆盖本地编辑，详见 [内容闭环](docs/17-content-workflow.md)。
- 在内容编辑台**和 AI 一起打磨**：围绕含未保存修改的当前稿讨论，累积段落修改/保留批注，查看原文与建议对比，勾选采用、撤销后再保存。可每轮选择模型，默认沿用原稿资料，也可明确选择账号当前资料；专家与技能沿用原快照。空选模型为不改写的免费模拟，详见 [文章协作编辑](docs/18-article-collaboration.md)。

当前还支持账号默认专家、技能版本引用及专家/自建技能历史恢复为新版本。当前不包含：通用单专家聊天、脚本/MCP/浏览器/外部检索、账号素材上传与档案编辑/删除、独立专家试运行、图片与平台专属排版、跨文章长期偏好、定时计划、视频制作或自动发布。通用 HTML 导出不保证公众号/头条样式兼容。动态团队为受限协议，不是无限自治网络。三项内置 Skills 仍只读。只读工具不授予脚本、网络或桌面权限；真实模型内容质量与第三方兼容性仍需验证。

完整范围见 [产品文档](docs/README.md)，实际进度与测试边界见 [实施状态](docs/10-implementation-status.md)，本次问题修复与安全结论见 [项目检查报告](docs/22-project-audit.md)。

已按用户要求，将 WorkBuddy 专家、Skills、专家团的完整功能语义纳入必做目标，采用独立实现而非复制私有代码与内容。当前完成配置与受限执行子集；不能把结构化阶段等同于完整自主团队。范围见 [能力对齐计划](docs/13-workbuddy-capability-plan.md)，配置/预算/恢复见 [Agent 运行契约](docs/14-agent-runtime.md)。

## 技术结构

```text
apps/web          Vue 3 + Vite + Element Plus + Tiptap
apps/server       NestJS API / Worker / 初始化 CLI
packages/contracts  共享类型与 Zod 输入、输出校验
infra/docker      应用镜像与 Caddy 配置
docs              产品、架构、安全与实施记录
```

PostgreSQL 保存业务事实；Redis / BullMQ 负责执行调度。任务和 Outbox 同事务写入，Worker 对账、领取任务并保存结果。API 和 Worker 分进程、共用代码与服务端镜像。SSE 只是快照通知，最终状态以数据库为准。

## 服务器安装

使用发布包中的生产配置，浏览器通过 HTTPS 域名访问。服务器需要 Docker Engine、Compose 2.24.4 以上；以下自动安装命令另需 Node.js 24.22.2 以上（24.x），不需 pnpm 或主机安装项目依赖。只安装 Docker 的步骤、备份、升级和恢复见 [服务器安装手册](docs/21-production-release.md)。

进入解压后的安装目录，使用自己的域名与模型服务主机：

```sh
node scripts/production.mjs init --origin https://creator.example.com --model-hosts api.example.com
node scripts/production.mjs check
node scripts/production.mjs install
```

初始化生成独立的随机数据库口令和固定模型加密主密钥，保存到私有 `.env.production`，已有文件拒绝覆盖。安装会构建镜像、执行迁移、交互创建管理员并等待服务健康；不带本地预览数据或样例账号，不创建模型连接，不自动发起收费请求。首次安装需要联网拉取镜像与锁定依赖，发布包不是离线镜像。

管理员初始化需在交互终端执行：用户名为 3-80 位字母、数字、`.`、`-` 或 `_`；口令为 12-256 个字符，输入不回显。已有用户时拒绝再次初始化，不提供公开注册接口。自动部署可通过进程环境注入 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`，不要把真实值写在命令行参数、CI 输出或 Compose 源文件中。

环境变量注入仅适用于直接调用管理员初始化 CLI；上述 `production.mjs install/admin` 入口固定使用交互输入，并清除继承的管理员变量。

生产配置开放真实模型能力。登录后在「模型设置」填写 API 根路径、模型与 Key；可显式确认费用进行连接检查，然后建立账号、导入人物卡/写作卡、选择专家和模型开始创作。模型使用兼容 Chat Completions 的文本/function tools 协议，具体限制见 [运行契约](docs/14-agent-runtime.md)。保存配置本身不调用模型；未选模型时保留明确标注的免费模拟。

已有文章可进入内容库，与 AI 讨论当前稿、累积段落修改/保留批注、对比并选择采用，再保存新版本、审核和导出。操作不会覆盖历史版本。

日常运维使用同一安装目录和环境文件：

```sh
node scripts/production.mjs status
node scripts/production.mjs backup
node scripts/production.mjs upgrade
```

升级先构建镜像、停写、核验备份，再更新 PostgreSQL/Redis 基础容器并迁移，失败时应用保持停止，不删除数据卷；原本停止的 Worker 不会自动启动。数据库备份不包含 `.env.production`、Redis 或证书，主密钥必须单独保管；恢复先在新项目核对业务和调用账本，再决定是否恢复 Worker，详见安装手册。

本机没有 Docker，当前不能提供实际容器启动和恢复演练结果。生产命令已接入 CI 检查，已有自动化测试不等于真实服务商质量或服务器验收完成。

## 本地开发

本轮工具基线：Node.js `24.22.2`、pnpm `11.25.0`（见 `.node-version` 与 `packageManager`）。业务依赖使用精确版本和 `pnpm-lock.yaml`。容器中的 Linux 兼容性另行验证。

安装 pnpm 后，在仓库根目录执行：

```sh
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm --filter @creator-ai/contracts build
```

复制 `.env.example` 为 `.env`，设置随机数据库口令及匹配的 `DATABASE_URL`，把 `APP_ORIGIN` 改为 `http://localhost:5173`，然后启动仅供开发的数据库与 Redis：

```sh
docker compose -f compose.yaml -f compose.dev.yaml up -d database redis
pnpm db:migrate
pnpm admin:create
```

开发覆盖文件只将数据库和 Redis 端口绑定到 `127.0.0.1`。也可使用自己的独立开发实例，正确配置 `DATABASE_URL` 和 `REDIS_URL`。不要连接生产库。

分别打开三个终端：

```sh
pnpm dev:api
pnpm dev:worker
pnpm dev:web
```

访问 `http://localhost:5173`。Vite 把 `/api` 代理到 `127.0.0.1:3000`，无需跨域 Token。修改共享契约后重新执行 contracts 构建，使后端使用最新产物。开发监听地址不要用于公网部署。

## 测试与验证

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm audit:security
pnpm test
pnpm build
pnpm --filter @creator-ai/web exec playwright install chromium
pnpm test:e2e
```

浏览器测试使用 API fixtures，覆盖配置/包/版本、模型设置与显式连接检查、专家团选择与成员交付、动态计划批准/拒绝和答复、取消/核对、修改分支与来源、人工编辑/审核/恢复/导出、文章协作、本地草稿和未知结果原样重试、会话和桌面/手机布局；不证明后端持久化。最新测试数量和结果见 [实施状态](docs/10-implementation-status.md)。模型集成使用本地 HTTP 协议 fixture，不调用付费模型、不证明真实创作质量。本地真实预览另外验证旧数据不变与实际 API/页面持久化。

`pnpm test:integration` 需要单独准备 PostgreSQL 和 Redis。通过进程环境设置 `TEST_DATABASE_URL` 和 `TEST_REDIS_URL`：数据库名必须以 `_test` 结尾，Redis URL 的库号必须是 `/15`。**测试会清空指定测试数据库的用户和关联业务表**，不得使用真实数据；推荐 Redis 同样使用独立测试实例，不指向业务队列。先构建 contracts，再运行测试。测试覆盖真实事务、幂等、版本/归属、BullMQ、SSE、能力包原子安装/并发冲突、独立成员与依赖、工具加载与拒绝、预算、取消、未知核对和账本恢复。

CI 配置在 `.github/workflows/ci.yaml`，包含服务容器集成测试、镜像构建和官方 npm 中危及以上漏洞门禁。配置存在不等于已经执行成功；当前验证结果详见实施状态文档。2026-11-09 的生产依赖检查无已知漏洞，全量依赖仍有 1 项仅用于 Jest 的低危、上游未修复告警，见检查报告；这不是永久安全保证。

### Docker 隔离冒烟验收

准备好本机 Docker Linux 容器引擎和 Compose 2.24.4 以上版本后执行：

```sh
pnpm test:docker
```

它会构建应用镜像，创建独立测试项目，验证迁移、管理员引导、真实 HTTP 创作、经 Caddy 的 SSE，以及保留数据卷重建容器后的数据与排队任务。网关只监听随机本地端口，不读取仓库 `.env`；结束时清理本次测试容器、卷和应用镜像，不操作正式项目。也可直接运行 `node scripts/docker-smoke.mjs`，无需主机 npm 依赖。

**当前本机没有 Docker，只验证了预检会正确报错退出，以及 19 项验收工具单元测试；完整容器流程仍待实际执行。** CI 已接入这条命令，但尚无远程执行结果。完整覆盖与清理边界见 [Docker 隔离验收](docs/11-docker-smoke-acceptance.md)。

## 数据与安全边界

- 持久化卷：`database_data`、`redis_data`、`caddy_data`、`caddy_config`。能力包上传后的文件/资源存于 PostgreSQL JSONB，没有账号素材库或素材卷。
- ZIP 只在内存解析和存档，不执行脚本、不安装依赖、不获取桌面权限。上限 2 MiB、128 条目、单文件 512 KiB、解压总计 4 MiB；原始包导出是文件重打包，不保证字节级还原或第三方运行兼容。
- 不要用删除数据卷解决启动问题；需要独立的一致性数据库备份，并在隔离环境验证恢复。
- API/Worker 在只读、非 root 容器中运行，数据库/Redis 默认不发布主机端口；只有网关可对外访问。
- 同源 HttpOnly 会话 Cookie；HTTPS 下启用 Secure，写请求校验 Origin 与会话 CSRF Token；登录有 Redis 限流。
- API 与 Worker 另接 `model_egress`，分别用于显式连接检查与创作；应用强制 URL 白名单、DNS 地址检查与 socket 绑定。该网络不是防火墙白名单；隔离 Docker 冒烟对两者都强制 mock/内部网络。
- 模型凭证经认证加密存库，API/快照不回传；主密钥单独保管。真实调用先记账，恢复只复用明确成功结果，未知不自动重发。不能将此作为未来平台发布的完整防重保证。

备份、升级和生产验收要求见 [部署与安全](docs/07-deployment-and-security.md)。

## 许可证

项目目标是开源，但项目许可证仍待选择。目前 package 元信息为 `UNLICENSED` / private，**不代表已授予开源使用许可**。首次公开发布前需选择许可证、补齐 NOTICE/归属声明，并核验依赖与容器镜像许可和安全状态。Tiptap 目前仅使用开源核心，不依赖付费扩展。
