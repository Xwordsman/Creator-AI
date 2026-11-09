# 21 服务器安装与版本交付

> 版本：0.1.0，2026-11-09。按服务器安装版交付，后续在同一产品上修复测试反馈。当前机器没有 Docker，因此下述容器流程已编码并接入 CI，尚无实际服务器启动或恢复演练结果。

## 1. 交付内容

发布包为 `creator-ai-0.1.0.tar.gz`，附 `.sha256` 和包内 `release-manifest.json`。这是**源码安装包**，服务器首次安装会构建镜像，需要访问镜像仓库和 npm registry；不是离线镜像包。发布文件包含代码、锁文件、生产 Compose 与文档，不带本机数据库、文章、模型连接、`.env`、私有密钥或 `node_modules`。

本次交付范围是账号/写作卡、专家/Skills/受限专家团、文字创作、文章对话和批注改稿、版本/审核/导出、模型配置及显式连接检查。配图生成、平台专属排版、定时创作、视频与自动发布尚未实现。完整范围见 [实施状态](./10-implementation-status.md)。

生产服务通过 Caddy 提供构建后的静态页面，API/Worker 使用编译产物，不运行 Vite 或 tsx watch。只开放网关 80/443，持久化 PostgreSQL、Redis 和证书；应用日志每容器最多保留 3 份 10 MiB 文件。

## 2. 安装前准备

- Linux 服务器，Docker Engine 和 Compose **2.24.4 以上**，能够拉取基础镜像和安装锁定依赖。
- 一个已解析到服务器的域名，80/443 入站可用。此标准入口直接由 Caddy 终结 HTTPS，使用标准端口；其他反向代理拓扑需另行配置。
- 选定文字模型服务的精确 API 主机名，例如 `api.example.com`。填写主机名，不带 `https://` 或 `/v1`；非标准端口写 `host:port`。运行时仍会检查全部 DNS 地址，拒绝内网和保留地址。
- 使用自动运维命令时，宿主机需有 **Node.js 24**，不需要 pnpm 或安装项目依赖。只装 Docker 的服务器可使用第 4 节手动步骤。

不要将旧预览目录的 `pg-data` 直接覆盖到 Docker 卷。现有数据如需迁移，使用 PostgreSQL 逻辑备份，并保留原部署的加密主密钥；本安装流程不会自动搬移本机历史数据。

## 3. 推荐安装方式

校验下载包，然后解压并进入目录。以下为 Linux shell 命令：

```sh
sha256sum -c creator-ai-0.1.0.tar.gz.sha256
tar -xzf creator-ai-0.1.0.tar.gz
cd creator-ai-0.1.0
```

使用自己的域名和模型主机替换命令中的对应值：

```sh
node scripts/production.mjs init --origin https://creator.example.com --model-hosts api.example.com
node scripts/production.mjs check
node scripts/production.mjs install
```

`init` 在本机生成独立随机数据库口令与 64 hex 模型加密主密钥，创建权限为 600 的 `.env.production`，不在输出中显示秘密。文件已存在时拒绝覆盖。请立即将它单独安全备份；**已有模型连接后不能重新生成主密钥**。Windows 上需要通过文件 ACL 管理访问权限。

`check` 验证 HTTPS 域名、模型白名单、固定项目名、Docker Linux 引擎及 Compose 实际渲染结果，不启动容器或请求模型。运维命令固定使用所选 env 文件，忽略 shell 中残留的 `COMPOSE_*`、模型/管理员变量及旧部署插值值，避免误接开发配置。Docker 引擎仍由当前 Docker context 决定，应先确认 context 指向目标服务器。

`install` 只接受没有对应容器或数据卷的新项目，依次构建镜像、等待数据库/Redis、执行迁移、在终端交互创建首个管理员，然后启动并等待健康检查。口令不回显；没有默认管理员。不会创建示例账号、文章或模型连接，也不会进行收费调用。

如果首次安装在管理员初始化处中断，保留现有数据，确认迁移成功后执行 `node scripts/production.mjs admin`；如果已创建管理员，则直接 `node scripts/production.mjs start`。不要反复运行 `install` 或删除卷。

登录域名后，在「模型设置」填写实际 API 根路径、模型名和 Key，然后创建账号、导入家人的人物卡/写作卡，选择专家和模型开始写作。生产配置开放真实模型能力；每次检查或创作仍由用户显式触发，不在保存配置时调用。未选模型的免费模拟仍保留并标注来源。

## 4. 服务器只安装 Docker

可以在有 Node.js 的电脑上运行 `init`，将 `.env.production` 通过安全通道单独传入服务器，不将它混入发布包或公开附件。然后在服务器进入源码目录：

```sh
chmod 600 .env.production
docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml config --quiet
docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml build
docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml up -d --wait database redis
docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml run --rm --no-deps api node dist/cli.js migrate
docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml run --rm --no-deps api node dist/cli.js admin:create
docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml up -d --wait
```

逐条执行，失败时停止。手动 Compose 命令会遵循 Docker 自身的环境变量优先级，不具备自动入口的防残留环境检查；不要在当前 shell 另设 `COMPOSE_FILE`、`COMPOSE_PROJECT_NAME` 或同名配置变量。

## 5. 状态与排错

```sh
node scripts/production.mjs status
docker compose --env-file .env.production -f compose.yaml -f compose.production.yaml logs --tail=100 api worker gateway
```

只有 `gateway` 发布主机端口。`status` 展示容器状态；应用健康检查覆盖数据库、Redis 和迁移就绪，不能证明 DNS、证书签发和真实服务商兼容性。首次安装还需从浏览器确认 HTTPS 登录、保存卡片、完成一次实际创作及导出。真实模型调用可能计费。

长命令开始/结束时会输出进度，构建期间没有逐行转发 Docker 输出。终端意外关闭后，先检查容器状态和 `data/production-operation.lock` 的进程/时间；确认原命令已退出才能移除锁并重试。锁不支持跨服务器或不同源码目录的并发协调，同一个部署只使用一个运维目录。

## 6. 数据库备份

```sh
node scripts/production.mjs backup
node scripts/production.mjs verify-backup data/production-backups/对应备份目录
```

备份会短暂停止网关和 API，再停止 Worker，确认写入进程退出后运行 PostgreSQL `pg_dump --format=custom`。归档另在数据库容器临时目录进行 `pg_restore --list` 可读性检查，记录 SHA-256 和元信息；成功后仅启动备份前运行的应用容器。备份失败时应用保持停止，排查后再显式 `start`。

备份保存在 `data/production-backups/` 的独立目录，目录权限 700、文件 600。没有有效 `backup.json` 的目录视为未完成备份。`verify-backup` 只校验归档哈希；哈希和列表可读都不代表完成恢复演练。

数据库包含文章、写作卡、专家/技能包、会话、加密模型连接与调用账本。**这个命令不备份 `.env.production`、Redis 或 Caddy 证书**。单独保管相应配置和主密钥；备份目录本身包含私有正文和认证数据，也须受控保存。Redis 队列可由业务账本/Outbox 重建，但恢复时必须先核对未完成与未知调用，不能直接启动 Worker。证书卷应根据自己的证书续签和灾备方案保管。

当前不自动删除旧备份。定期复制到另一块磁盘或另一台机器，按实际容量设置保留周期，不把同机备份作为唯一副本。

## 7. 升级

保留同一部署目录和 `.env.production`，用新的发布包更新源码；如有未提交自定义修改，先单独保存。不要覆盖 `data/` 或环境文件，也不要变更 `COMPOSE_PROJECT_NAME`，以免连接到另一组卷。

```sh
node scripts/production.mjs check
node scripts/production.mjs upgrade
node scripts/production.mjs status
```

升级先构建镜像，再进入维护窗口、备份数据库、执行事务迁移，最后重新创建维护前运行的应用服务并等待健康。原本停止的 Worker 等应用服务继续停止，避免意外恢复任务。备份或迁移失败不启动应用；启动健康检查失败会尝试再次停止应用，保留诊断与已成功的备份。不会自动回退数据库，也不会删除数据卷。

备份元信息的 `operatorVersion` 是执行备份工具的源码版本，不代表旧容器或数据库版本；迁移记录保存在数据库归档内。升级前同时保存上一版安装包及 `.env.production`。不能假设旧镜像兼容新迁移；需要回退时恢复到独立项目验证。

## 8. 在独立项目演练恢复

以下步骤针对**空的新项目**，使用当前版本匹配的发布包。先验证备份 SHA-256，保持原服务数据卷不变。命令中的 `creator-ai-restore` 为演练项目名：

```sh
docker compose --project-name creator-ai-restore --env-file .env.production -f compose.yaml -f compose.production.yaml up -d --wait database redis
docker compose --project-name creator-ai-restore --env-file .env.production -f compose.yaml -f compose.production.yaml exec -T database pg_restore --exit-on-error --no-owner --no-privileges -U creator -d creator < /安全备份路径/database.dump
docker compose --project-name creator-ai-restore --env-file .env.production -f compose.yaml -f compose.production.yaml exec -T database psql -U creator -d creator -c 'SELECT count(*) FROM content_items; SELECT status,count(*) FROM creation_runs GROUP BY status; SELECT status,count(*) FROM model_invocations GROUP BY status;'
```

如项目名已用过，先选择另一个新项目名；不要在原库中测试覆盖恢复。上述步骤不启动 API、网关或 Worker，也不会占用 80/443。核对文章、版本、卡片、迁移记录、模型凭证可解密性和未知/排队任务；数据库结构匹配后才允许启动 API，确认是否需要执行新迁移。原主密钥必须保留，不能使用重新生成的值替换。

Worker 启动后会对账并处理排队/过期租约任务，可能发出收费请求。先核对服务商已有记录和未知调用，再显式恢复 Worker；不要以“恢复后自动续跑”代替人工核对。数据演练不等于切换生产，还需单独处理域名、端口、证书与旧服务停写。

## 9. 构建自己的交付包

维护者在源码工作区运行：

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm release:package
```

产物在 `dist/releases/` 的新目录中，不覆盖已有发布包。源码文件逐一记录字节数和 SHA-256；包内不包含私有 `.env`、运行数据和依赖。当前仍需在有 Docker 的环境运行 `pnpm test:docker`，并在实际部署时验证生产配置及恢复流程。项目许可证尚未确定，本包用于用户自己的部署测试，尚未作为已授予开源许可的公开发行。
