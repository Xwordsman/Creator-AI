# 10 当前实施状态

> 更新：2026-11-09。版本：0.1.0 服务器安装交付。记录代码与实际测试，不把目标规格当成已经验收。

## 1. 本轮交付

按用户要求转向服务器安装版交付：版本统一为 0.1.0，新增独立生产 Compose、配置初始化/检查、安装/状态、数据库备份、升级与源码包生成工具；页面显示实际包版本，登录页使用生产安装入口。生产配置开放真实模型能力，但不会初始化连接或发出收费调用。升级在备份成功后才迁移，失败保持停写；私有配置、主密钥、Redis 和证书的备份/恢复边界见 [21 服务器安装](./21-production-release.md)。本轮没有重建本地预览、操作历史业务数据或切换已有模型配置。Docker 与完整恢复未在本机执行。

本轮接入账号写作资料：多文件导入已有 Markdown 人物卡、写作卡和范文，编辑分类与启停后显式保存，新创作冻结全文；已有文章协作默认沿用原稿，也可明确选择账号当前修订，资料变化时拒绝过期选择。上一轮已补齐显式模型连接检查，此前已完成当前稿讨论、多处修改/保留批注、建议对比、选择采用/撤销和显式保存。D-011 的完整对齐仍未完成，M0–M3 也未整体验收。契约见 [14 模型与 Agent](./14-agent-runtime.md)、[15 草稿继续创作](./15-draft-continuation.md)、[16 动态团队协作](./16-dynamic-team-collaboration.md)、[17 内容闭环](./17-content-workflow.md)、[18 文章协作编辑](./18-article-collaboration.md)、[19 连接检查](./19-model-connection-checks.md)、[20 账号写作资料](./20-account-writing-cards.md)，剩余目标见 [13 能力对齐](./13-workbuddy-capability-plan.md)。

| 范围   | 已实现子集                                                                                    | 尚未完成 / 验证边界                                                     |
| ------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 工程   | pnpm workspace、共享 Zod、严格 TS、格式/静态检查、CI 配置                                     | 云端 CI 运行、Linux 镜像与安全维护审查                                  |
| 认证   | 唯一管理员 CLI、scrypt、数据库会话、Origin/CSRF、注销、限流                                   | 密码修改/重置、多人权限、代理真实 IP 精确限流                           |
| 账号   | 创建/列表、读者与人设、默认专家、人物卡/写作卡/范文导入与修订、owner 校验                     | 基础档案编辑/删除、平台授权、图片素材库                                 |
| 专家   | 零到多项 Skills、身份/方法、问法/引导、预加载/轮次、复制/启停/版本与历史恢复                  | 头像、引导制作、资料转专家、默认模型与独立试运行                        |
| 技能   | 内置只读 + 自建/导入、版本引用/历史恢复、资源/导出、按需加载与资料读取                        | 带资源复制、目录导入、沙箱、外部工具                                    |
| 能力包 | ZIP 预览确认、原子安装、资源存档/导出、命名空间与路径/容量校验                                | 升级冲突处理、分享发现、总容量/频率配额、实际 WorkBuddy 互操作          |
| 模型   | 加密连接、启停、HTTPS 白名单/DNS/socket 检查、非流式 Chat Completions、显式基础连接检查与核对 | 收费服务商与内容质量实测、完整能力探测、轮换、Token 流、价格表          |
| 单专家 | 独立上下文、工具循环、运行预算、真实协议结果、成功草稿分支修改                                | 完整多轮聊天/交互确认、素材授权、产物人工评价                           |
| 专家团 | 阶段依赖/并行、可选动态规划/批准派工、同伴与用户追问、确认/重规划、独立汇总                   | 成员不同模型、无限自治/任意未来 DAG、真实服务商协作质量与成本评价       |
| 可靠性 | Run/Outbox 同事务、幂等、BullMQ、租约 fencing、调用账本先落库、取消/核对                      | 生产故障演练、供应商结果查询、跨任务额度与计划调度                      |
| 内容   | 当前稿对话、多处批注、局部建议/选择采用/撤销、账号资料选版；版本/恢复、审核/导出              | 实际写作质量、图片/素材、平台排版、长期偏好、多人审核、归档、发布与视频 |
| 部署   | API/Worker、迁移/健康检查、生产 Compose/Caddy、安装/检查/备份/升级工具、源码交付包            | Docker 启动/卷重建、备份恢复、TLS、负载与公网安全验收                   |

没有静默添加正式业务数据；本地明确标注“示例”的四人编辑部和两项技能用于预览配置。无模型凭证的本地预览继续 mock，不能把 UI 中的配置、fixture 响应或模板当作真实 AI 成稿。

## 2. 不变量与实际语义

- 账号表达要求优先于专家默认口吻。模型上下文包含此规则，但真实创作质量仍需人工评价。
- 账号可保存最多 8 份人物卡/写作卡/范文，单份正文 8,000 字符、合计 24,000 字符。停用资料也计入存储限制，配置快照保留全文，模型上下文只传启用资料。范文仅参考表达，不作为作者事实。保存使用共享账号修订；异常后先读回核对，不自动覆盖。详见 20。
- 专家/自定义技能更新使用 `baseVersion`，写新版本；启停不增加定义版本。停用不能作为新任务输入，不自动取消已保存快照；模型连接每次发送前重新检查启用状态。
- 创建任务按专家配置解析指定技能版本，未指定时取当前版本，保存账号、专家/成员、完整技能/资源、模型非敏感配置及预算快照。未来修改不改写历史；专家和自建技能可将历史定义恢复为新版本。
- `snapshot.skillSelection` 是配置与创建时事实；实际加载在 `execution.agents[].loadedSkillKeys`，版本来自快照。mock 无实际加载。工具、调用、成员结果、派工回报与人工核对分开记录。
- 单专家可无 Skill；专家团需要显式选择模型，未选仍返回 `422 TEAM_RUNTIME_UNAVAILABLE`，不退回一次 mock 或一次模型扮演多人。
- 默认 `team-v1` 按结构化阶段调度；可显式选 `team-dynamic-v1`，负责人独立规划，每次派工先等待用户批准。动态模式逐任务串行，成员可真实追问同伴或用户，负责人可确认、重规划和独立汇总；SOP 不自动授权新成员或工具。旧任务模式不改变。
- 幂等键必填，16–128 位受限字符；同 owner 同键同输入返回旧任务，输入不同 409。新建和修改共用键空间；修改摘要另含操作、来源和规范化要求。新建表单键仍限本次生命周期；修改要求与键按 owner/来源保存在当前标签页 sessionStorage，刷新后同输入可复用，不跨设备/标签页共享。
- 成功草稿可按修改要求生成新分支，原稿与账本不变；冻结账号/专家/技能/模型/限额，创建前再检查可用性。每轮独立预算和新调用，不是使用旧余额；unknown/失败/取消任务不能从此入口续跑。只带直接来源的原始候选正文，不是完整历史聊天，不读取内容库人工稿。
- 内容库从成功任务显式加入，来源唯一；人工稿独立保存，写入/审核带 baseRevision 与幂等键，先回放准确收据再检测冲突。保存/恢复追加不可变版本并回到 draft，审核绑定准确版本；模拟不可通过。导出只含指定已保存版本，历史/未审/模拟需确认。本地草稿不是备份，未知结果冻结输入与键、只人工原样重试，详见 17。
- 文章协作发送当前编辑稿，默认复用来源账号/专家/技能快照，可每轮显式选择模型和账号当前资料修订；专家/技能不随资料选版改变，团队只取负责人。账号资料过期则拒绝创建任务，原样幂等回放先于修订检测。讨论无修改，建议严格校验段落/保留/范围，选择采用只改本地稿。应用前核对本地基线及服务器修订，仍需保存新版本。历史最多 6 轮/12,000 字符，单轮最多 4 次调用/64,000 tokens/180 秒；模拟不产出改写，未知不自动重发。详见 18、20。
- 连接检查由 API 直接执行，独立持久化且需显式确认；最多一次固定短文本请求、输出上限 256 Token，无文章/专家/技能/工具。按 owner/键回放，每个连接的在途或未核对未知记录阻止新检查；不阻止创作任务。结果未知不自动重发，人工说明不可覆盖；基础通过不代表写作或工具质量。详见 19。
- 状态：`queued -> running -> succeeded / failed / cancelled / needs_review`；动态任务另可 `running -> waiting_user -> queued`，等待不是终态，释放 Worker，排队/等待可直接取消。成功表示结构合格的待审核候选，不表示人工审核或发布。
- 先持久化 invocation ID、请求摘要和预算，再标记在途/发请求；未知不自动重发、不释放可能已花费的预留。确认结果可从账本恢复，过期 Worker 不得覆盖新状态。
- Worker 并发 2；租约 30 秒、每秒心跳。旧模式最多领取 3 次；动态模式累计 attempts 不清零，每个人工交互段最多领取 3 次，仅有效新答复重置段恢复次数。Dispatcher 约每 2 秒扫描，至少 30 秒再次投递；等待任务不投递，不能据此无限重试外部调用。
- 动态动作、答复与派生任务同事务落库；同一动作同内容重复答复返回当前任务，不再派工，改答复返回 409。等待用户不占累计活跃时长，不重置调用/Token 预算。最多 6 次规划、24 次成员任务、4 次同伴请求、8 次用户交互，仍受共享预算限制；协议错误直接停，不自动付费纠错。
- 取消尽力中断 HTTP，不承诺免收费。核对说明追加后关闭任务，保留 unknown 与预算证据，不自动导回、退款或继续。
- SSE 为最新快照通知：`run.snapshot/heartbeat/session.expired/stream.unavailable`，每 2 秒检查；无 Token 流/历史事件回放，每用户每 API 进程最多 6 连接，终态主动断开。
- 模型与保存正文只允许有界 doc/paragraph/heading/text，不接受任意 HTML、图片、链接、事件属性或外部嵌入。通用导出从白名单构造并转义，HTML 无外部资源；目标平台的图片/样式仍需独立适配和兼容验证。

当前 22 张业务表：`users`、`sessions`、`accounts`、`experts`、`expert_versions`、`skills`、`skill_versions`、`creation_runs`、`task_outbox`、`model_connections`、`agent_runs`、`model_invocations`、`tool_executions`、`team_messages`、`invocation_reconciliations`、`team_actions`、`content_items`、`content_versions`、`content_reviews`、`content_operations`、`content_turns`、`model_checks`；另有 `migrations`。没有 assets/schedules 表。团队定义仍嵌入专家版本，动作、派生任务和答复独立持久化。

增量迁移均由 CLI 显式执行，不使用 synchronize，拒绝破坏性 down。内容闭环后另有 `1794009600000-capability-reuse.ts`（默认专家、修订与历史恢复来源）、`1794096000000-content-assistance.ts`（新增对话关联及历史索引）和 `1794182400000-model-checks.ts`（仅新增检查表与索引）。服务启动/就绪检查迁移，历史输入/正文不重写。API、对话、版本/审核历史、下载、模型引用和后台账本限定 owner；这不是素材隔离验收。

登录为带随机盐的 scrypt；会话只保存 Token 摘要，固定 7 天、可注销，Cookie HttpOnly/SameSite=Strict，HTTPS 下 Secure。写请求精确 Origin+CSRF。登录用户名/IP 每 5 分钟 15 次；当前不信任转发头，代理后的 socket IP 桶共享，不声称精确边缘多用户限流。

## 3. 实际 HTTP 接口

统一 `/api/v1`；健康/登录外需会话，写接口另需 Origin 与 `X-CSRF-Token`。JSON 成功 `{data,requestId}`，错误 `{error:{code,message,retryable},requestId}`；ZIP/SSE 不套 JSON。

| 方法与路径                                                      | 实际能力                                        |
| --------------------------------------------------------------- | ----------------------------------------------- |
| GET `/health/live`、`/health/ready`                             | 存活、迁移/Redis 就绪及 modelMode               |
| POST `/auth/login`、GET `/auth/session`、POST `/auth/logout`    | 登录/会话/注销                                  |
| GET / POST `/accounts`                                          | 列表/创建（201）                                |
| GET `/accounts/:id`                                             | 当前账号资料，owner 隔离                        |
| POST `/accounts/:id/writing-cards`                              | `baseRevision,writingCards`，显式保存资料，200  |
| GET / POST `/experts`                                           | 单专家/专家团列表/创建（201）                   |
| GET / POST `/experts/:id/versions`                              | 历史/保存新版本；POST 查询 `baseVersion`        |
| POST `/experts/:id/availability`                                | `{enabled,baseVersion}`                         |
| GET / POST `/skills`                                            | 列表/创建，内置不可改                           |
| GET / POST `/skills/:key/versions`                              | 历史/新版本，POST 需 `baseVersion`              |
| POST `/skills/:key/availability`                                | 用户技能启停                                    |
| POST `/packages/preview`、`/packages/import`                    | 原始 ZIP 预览/原子安装，不是 multipart          |
| GET `/skills/:key/export`、`/experts/:id/export`                | ZIP 下载，专家 `original=true` 需存档           |
| GET `/models/capabilities`                                      | 模式、是否可配置、允许主机与只读工具            |
| GET / POST `/models`                                            | 连接列表/创建（201），不返回 Key、不自动测试    |
| POST `/models/:id/availability`                                 | `{enabled}`，执行前重新检查                     |
| GET / POST `/models/:id/checks`                                 | 最近 10 条 / 显式 `{confirm:true}`，幂等键、200 |
| POST `/models/:id/checks/:checkId/reconcile`                    | 未知调用核对说明，保留原状态、200               |
| GET / POST `/creation-runs`                                     | 分页/创建（202），Idempotency-Key 必填          |
| GET `/creation-runs/:id`                                        | 一致性读取快照、输出及 execution                |
| GET `/creation-runs/:id/events`                                 | 会话/归属限制的快照 SSE                         |
| POST `/creation-runs/:id/continue`                              | `{instruction}`，成功稿生成新分支，202、幂等    |
| GET `/creation-runs/:id/history`                                | 同 owner/root 分页分支元数据，不批量读取正文    |
| POST `/creation-runs/:id/actions/:actionId/respond`             | 动态计划批准/拒绝、确认/补问答复；动作内幂等    |
| POST `/creation-runs/:id/cancel`                                | 排队/等待取消或运行中请求中断                   |
| POST `/creation-runs/:id/reconcile`                             | `{note}`，只允许 needs_review，保留证据         |
| GET / POST `/contents`                                          | 分页列表 / 从 sourceRunId 加入（201），来源唯一 |
| GET `/contents/:id`                                             | 当前内容与准确版本的一致快照                    |
| GET `/contents/:id/versions`、`/contents/:id/versions/:version` | 分页版本元数据 / 单版本正文                     |
| POST `/contents/:id/versions`、`/contents/:id/restore`          | 保存/恢复新版本，baseRevision + 幂等键          |
| GET / POST `/contents/:id/reviews`                              | 分页审核 / submit、approve、request_changes     |
| POST `/contents/:id/export`                                     | 指定 version/format 的原始 JSON/MD/HTML 附件    |
| POST `/accounts/:id/default-expert`                             | `baseRevision,expertId`，绑定或清除默认专家     |
| POST `/experts/:id/restore`、`/skills/:key/restore`             | `baseVersion,version`，恢复为新定义版本         |
| GET / POST `/contents/:id/assistant-turns`                      | 对话分页 / 提交当前稿协作（202），幂等键必填    |
| GET `/contents/:id/assistant-turns/writing-profile`             | 原稿冻结账号与当前账号资料                      |
| GET `/contents/:id/assistant-turns/:turnId`                     | 回复、建议与准确原文快照                        |

列表 `page` 默认 1、`pageSize` 默认 30/最大 100；文章协作历史最终限制每页最多 20 条，模型列表返回当前连接数组（上限 20）。普通 JSON 64 KiB，账号/专家/技能配置及内容路由 2 MiB；ZIP 2 MiB/128 条目/单文件 512 KiB/解压 4 MiB。资源只存数据库，不在服务器解包、不执行安装。包预览 `runtimeReady=false` 仍表示没有验证其全部工具/环境兼容，不能因只读 Agent 已可运行而改为全包可执行。

已有动态团队动作答复、内容闭环、文章协作和独立基础模型检查接口，但没有通用步骤 confirm/失败 retry、独立专家 test-run 或计划接口；continue 仅用于成功候选稿的新一轮修改，不用于不确定结果重试。共享契约另含 `assistance.ts`、`model-check.ts` 与 `writing-cards.ts`，未生成 OpenAPI。更多约束见 06、13–20。

## 4. 验证与环境边界

本轮最终验证环境：Windows、Node 24.22.2、pnpm 11.25.0。Node 使用官方归档并核验 SHA-256；未替换原预览运行时。完整修复与安全说明见 [22 项目检查报告](./22-project-audit.md)。

| 检查                  | 结果与范围                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------- |
| 单元/验收工具         | 本轮 161 项全部通过：工具 41、contracts 38、后端 60、Web 22                                  |
| PostgreSQL/Redis 集成 | 本轮完整重跑，7 个套件、117 项全部通过；隔离 `_test` 库、独立 Redis DB 15、本地 HTTP fixture |
| Playwright            | 本轮完整重跑，桌面/手机 176 项全部通过；包含新增异常收据、读取恢复、存储失效与防重复调用测试 |
| 格式/静态/类型/构建   | format:check、lint、typecheck、build 均已通过；构建有第三方 Zod 注释警告，无构建错误         |
| Docker/CI/备份恢复    | 本机无 Docker；隔离命令和 CI 已配置，但无真实容器与云端执行结论；没有恢复演练                |
| 模型/第三方/平台      | 未调用付费 API；真实服务商互通、质量、WorkBuddy 运行兼容、自动发布和视频均未验证             |
| 依赖与网关配置        | 官方 npm 生产依赖无已知漏洞；全量仅 1 项 Jest 低危；Caddy 2.11.9 通过实际配置验证            |

集成测试覆盖零 Skill、按需/预加载与资源、越权工具/路径、密钥隔离、实际独立并行及阶段依赖、调用/Token 预算、禁用预检、排队/在途取消、断线 unknown 与说明持久化、成功账本恢复、过期租约 fencing、截断和重定向。它证明执行协议/持久化，不证明模型自主选技能、事实真实性或文章质量。

本轮在原基线基础上新增 23 项单元/工具测试和 32 项桌面/手机浏览器测试，重点覆盖：无效 API envelope/收据不能清除待确认键，非 JSON 401 仍触发登录处理，读取失败保留本地稿与后续恢复，保存收据先应用再读取最新稿，损坏记录阻止写入，创作/续写配置冻结与显式同键重试，存储失效不发新请求且不解锁旧请求，以及模型检查历史读取门禁。工具另覆盖补丁版本一致、升级前备份后基础服务更新、更新失败不迁移/不恢复写入及发布包遗漏配置。Docker 调用通过注入的命令执行器验证顺序和失败分支，不能代替实际容器运行。本轮没有请求收费模型、操作历史业务库或重建原本地预览；新增端到端手工验收使用全新隔离数据库与虚构账号。

写作资料阶段新增 4 项写作资料契约测试、3 项 HTTP/PostgreSQL 集成测试和 10 项桌面/手机浏览器测试，验证中文合法容量、控制字符/重复标识、UTF-8 与占位符/换行保留、批量导入失败不部分添加、显式保存、并发/归属/CSRF、异常保存先读回、原任务及分支冻结、早期无修订号快照兼容、停用资料不发模型、协作明确选版/过期拒绝、账号更新后未知请求仍同键回放。普通路由 64 KiB 和账号路由 2 MiB 解析上限均有覆盖。真实家庭卡片和收费模型未用于测试。

上一轮新增 2 项连接检查契约测试、10 项真实 HTTP/PostgreSQL 集成测试和 14 项桌面/手机浏览器测试。验证费用确认与 CSRF、跨实例同键回放、并发只发送一次、禁用/跨模型键冲突、服务商错误脱敏、无效 JSON 不付费纠错、断线未知/不可覆盖核对说明、过期前后发送门控和迟到响应保护；前端验证保存/查看零调用、刷新后显式同键核对、关闭停止轮询及旧查询不能覆盖新结果。服务商由本地 fixture 提供，不表示真实模型互通已验收。

上一轮新增 32 项动态运行集成测试和 1 项认证 HTTP 答复测试：提案批准/拒绝、重规划、真实同伴调用、多轮用户答复、跨 Worker 恢复、等待不耗活跃时间、并发幂等、账本恢复/未知不重发、取消、越权依赖/动作和全部硬上限。保留原修改分支、配置冻结与归属测试。本轮新增 12 项内容 HTTP/数据库集成测试，包含并发加入/保存/审核、收据回放、旧审核失效/恢复、模拟来源不可洗白、越权/CSRF、正文白名单/2 MiB 和三种安全导出；非 mock 审核 fixture 只在隔离测试库构造，不冒充真实服务商。新增 20 项桌面/手机内容测试，模拟 JSONB 字段重排，确保切换编辑权限不触发幽灵编辑。浏览器在隔离的 5187 端口运行，默认最多 4 个本地 Worker，避免过量并发。

集成测试会清空指定测试库，必须使用独立数据库；正式 CI 推荐独立 Redis 实例。浏览器 fixture 不证明数据库成功。本地真实预览另外验证升级/持久化与无模型操作，报告/截图放在被忽略的 `data/local-preview/checks/`。

### 历史本地预览记录

以下为此前各阶段的预览验收与数据保全记录，不是本轮服务器部署结果。本轮保留现有环境，交付入口转为第 21 篇的生产安装流程。

使用便携 PostgreSQL 17.6、Redis 7.4.11；Web `127.0.0.1:5173`、API `3310`、Worker `3001`，不依赖 Docker、不公开访问。启动/停止脚本只管理自己记录且身份匹配的进程。

前一轮能力目录迁移已有冷备份 `data/local-preview/backups/before-capability-catalog-20261102-110715`，核验原 1 账号、1 专家/2 版本/3 任务不变后才增加示例。

前一轮运行时升级已完成：先确认无排队、运行中或待核对任务，停止预览 API/Worker/数据库/Redis，再冷备份到 `data/local-preview/backups/before-agent-runtime-20261102-143923`。启动时仅应用 AgentRuntime 新迁移。比较显式原有业务列，1 用户、1 账号、2 专家/3 版本、2 技能/2 版本、3 任务及其 Outbox 的数量和 SHA-256 一致；新增预算列不计入历史内容哈希。报告为 `data/local-preview/checks/runtime-preservation.json`。冷备份不是恢复验收。

核验后通过真实预览 API/Worker/SSE 与浏览器新增 1 条“验收示例 · 运行时升级后的模拟创作”，没有修改账号、专家或技能，截至该轮共 4 条任务。旧 3 条候选正文可读，新任务完成且刷新后仍在；mock 没有伪造 Agent 调用证据，模型列表为空、添加连接按钮锁定。桌面与手机四个路由无页面异常、HTTP 错误或横向溢出。报告和截图为 `data/local-preview/checks/runtime-preview-report.json`、`runtime-*.png`。Tabbit 注册不可用，该次使用项目 Playwright Chromium，不是用户当前浏览器会话；未拦截 API，未请求收费模型。

前一轮草稿继续创作升级：停止自有预览进程并冷备份至 `data/local-preview/backups/before-draft-continuation-20261102-152006`，启动时仅应用 DraftContinuation 迁移。登录或新增示例前核验 15 张业务表原有列的数量与 SHA-256 全部一致，包含原有 4 条任务、Outbox、会话与空运行账本；仅排除当次新增的三个 lineage 列。报告为 `checks/continuation-preservation.json`。

随后在真实页面基于第 4 条稿件创建 1 条明确标注“验收示例”的模拟修改分支，当前共 5 条任务。API/Worker/SSE、冻结配置、原有 4 条任务不变、分支历史、来源跳转、刷新持久化与相同要求重提交仍返回同一任务均已通过。桌面和手机四路由无溢出、页面异常或 HTTP 错误；没有拦截 API、外部浏览器请求或收费模型。只读数据库核验模型连接/调用/Agent 记录仍为 0，没有未完成任务。报告/截图为 `checks/continuation-preview-report.json`、`checks/continuation-ledger.json`、`continuation-*.png`（均在 `data/local-preview/`）。Tabbit 在任务派发前即因注册缺失失败，使用项目 Playwright Chromium，不修改其注册或用户浏览器会话。冷备份仍未做恢复演练。

上一轮动态团队升级：确认没有排队、在途、等待或待核对任务，停止自有进程并冷备份至 `data/local-preview/backups/before-dynamic-teams-20261102-160237`；仅应用 DynamicTeams 迁移。登录或页面检查前核对原有 15 张业务表的数量与 SHA-256 全部不变，包括 5 条任务、配置、Outbox、会话及空运行账本；只排除三个新增运行计时/恢复列，保留 lineage 列参加校验。报告为 `checks/dynamic-preservation.json`。预览仍为 mock，未提供真实模型凭证，不能演示真实动态团队成稿；不为演示伪造收费调用证据。冷备份未做恢复演练。

升级后另外通过未拦截 API 的真实预览检查：桌面/手机共 8 次路由访问，原有 5 条任务完整可读，修改分支与刷新持久化正常；无模型时团队选项禁用，不显示动态模式入口。没有新增业务记录，没有页面异常、HTTP 错误、外部浏览器请求或横向溢出。只读数据库确认仍有 5 条任务、0 个模型连接/调用/Agent/动态动作、0 条未完成任务。使用项目 Playwright Chromium 的独立会话，检查结束仅注销该会话。报告/截图为 `checks/dynamic-preview-report.json`、`dynamic-upgrade-*.png`，不能代替真实动态模型验收。

此前内容闭环升级：确认无未完成运行，停止自有预览进程，冷备份至 `data/local-preview/backups/before-content-workflow-20261102-214545`，仅应用 ContentWorkflow 迁移。登录或新增内容前核验原 16 张业务表全部列的数量与 SHA-256 完全一致，不排除任何历史列；包括原 5 条运行、配置、Outbox、会话和空运行账本。报告为 `checks/content-preservation.json`，冷备份未做恢复演练。

随后用未拦截 API 的独立 Playwright Chromium 会话，显式将现有模拟修改分支加入 1 篇“验收示例”内容；人工编辑、刷新持久化、送审/要求修改、历史恢复为新版本、JSON/Markdown/HTML 实际下载及文本注入转义均通过。最终 4 个内容版本、3 条审核、6 条幂等收据，模拟来源仍在且通过按钮禁用。首次验收发现 JSONB 字段重排与 Tiptap 权限切换误触发更新，已修复并补桌面/手机回归后继续，不重复创建示例。最终桌面/手机 6 次路由检查无异常、HTTP 错误、外部请求或溢出；原 5 条运行与账号/专家/技能完整响应不变。模型连接/调用/Agent/动态动作仍为 0，无未完成运行；未调用付费模型。报告和截图为 `checks/content-preview-report.json`、`checks/content-desktop.png`、`checks/content-mobile.png`，独立会话已注销，不操作用户浏览器会话。Tabbit 注册不可用，未尝试修改注册。

上一轮文章协作升级：确认无未完成任务，停库后冷备份至 `data/local-preview/backups/before-article-collaboration-20261109-100016`，启动时应用 CapabilityReuse 与 ContentAssistance 两项增量迁移。登录或新增协作示例前，核对原 20 张业务表原有列的数量与 SHA-256 全部一致，包括 5 条任务、1 篇内容、4 个版本、3 条审核、配置与会话。报告为 `checks/assistance-preservation.json`，备份仍未恢复演练。

随后通过未拦截 API 的独立 Playwright Chromium 会话，在现有文章发送 1 轮明确标注“验收示例”的模拟协作，验证未保存标题和段落批注进入任务快照、API/队列/Worker 完成、桌面/手机刷新历史、调用记录跳转和协作结果下载入口。检查后丢弃该轮本地标题改动，服务器文章、4 个版本与原 5 条任务完整响应均不变；当前共 6 条任务、1 条文章对话，模型连接/调用/Agent 仍为 0，无未完成任务。无页面异常、HTTP 错误、外部浏览器请求或横向溢出；没有收费调用，也未验证真实模型改稿质量。报告/截图为 `checks/assistance-preview-report.json`、`checks/assistance-desktop.png`、`checks/assistance-mobile.png`；仅注销本次独立会话，保留用户预览运行。

本轮模型连接检查升级：确认无未完成任务，停止自有预览服务后冷备份至 `data/local-preview/backups/before-model-checks-20261109-103805`，只应用 ModelChecks 迁移。登录检查前核对原 21 张业务表全部历史列的数量与 SHA-256 均不变，包括 6 条任务、1 篇内容、4 个版本、3 条审核、1 轮协作与原会话；新增检查表为空。报告为 `checks/model-check-preservation.json`；备份没有恢复演练。

通过未拦截 API 的独立 Playwright Chromium 会话，在桌面/手机检查模型设置、内容库、当前文章和修改分支，共 8 次路由访问。文章协作刷新后可读，原有 6 条运行及文章/版本/审核/协作完整 API 响应保持一致；没有新增业务记录、页面异常、HTTP 错误、外部浏览器请求或横向溢出。模型连接/检查/调用/Agent 仍为 0，无未完成任务，预览继续 mock；模型检查交互只在隔离 fixture 中验收，真实服务商没有调用。报告/截图为 `checks/model-check-preview-report.json`、`checks/model-check-*.png`；本次独立会话已注销，自有预览服务保持运行。

Compose 本轮重新通过静态 YAML/锚点/`!override` 与网络约束检查，记录为 `data/local-preview/checks/model-check-compose.json`：API/Worker 可出站，冒烟对二者都覆盖为仅 private/mock，只有 gateway 发布端口。本机仍无 Docker，未执行 `docker compose config` 或容器启动，不能将静态检查算作 Docker 部署验收。

本轮写作资料升级：停服务后冷备份至 `data/local-preview/backups/before-writing-cards-20261109-111302`，逐文件核验 8,662 份文件的大小和 SHA-256，记录为 `checks/writing-cards-backup.json`。没有新增迁移；重启后登录检查前，对原 22 张业务表全部列逐表比较数量和 SHA-256，全部一致，包括 6 条任务、1 篇内容、4 个版本、3 条审核、1 轮协作及原会话。报告为 `checks/writing-cards-preservation.json`。冷备份没有做恢复演练。

通过独立 Playwright Chromium 会话，在桌面/手机检查工作台、账号、模型、内容库、文章与修改分支，共 12 次路由访问。打开账号资料导入窗口且不保存，展开旧文章的原稿资料，确认无修订号的早期快照可读、默认沿用原稿、刷新后对话仍在。原有运行及文章/版本/审核/协作完整 API 响应不变，没有新增业务记录；无页面异常、HTTP 错误、外部请求或横向溢出。模型连接/检查/调用/Agent 仍为 0，预览继续 mock。报告/截图为 `checks/writing-cards-preview-report.json`、`checks/writing-cards-*.png`；本次独立会话已注销，本地预览保持运行。导入后保存与模型上下文的验证使用隔离 fixture，不代替真实家庭资料和写作质量评价。

页面检查期间，登录机制正常清理 1 条过期会话；注销独立验收会话后，会话总数由升级前 2 条变为 1 条。因此页面检查后的全表比较单列会话变化，不声称所有会话不变；其余 21 张表全部列的数量及 SHA-256 与原始基线一致，记录为 `checks/writing-cards-post-preview.json`。升级后、登录前的 22 表完整一致结论仍保留在前述报告中，原始基线未覆盖。隔离测试 PostgreSQL/Redis 已关闭，预览服务保持健康。

## 5. 发布与下一步

现有 Node/pnpm、Vue/Vite、NestJS/TypeORM、BullMQ、Zod 与镜像版本以锁文件和 Compose 为准。本轮依赖安全门禁通过，生产依赖无已知 npm 告警；基础标签已与供应商/官方镜像列表核对。固定标签与 npm 检查不等于完整容器漏洞或许可审计。Windows 构建仍可能有 Zod Rollup 注释警告；生产 Linux 镜像另验。Node 官方预告 2026-11-11 发布安全更新，正式部署前应再次检查 24.x 最新补丁。

项目目标开源但许可证尚未选择，package 仍为 UNLICENSED/private，不代表已经授权公开使用。首次发布需补齐 LICENSE/NOTICE 与依赖/镜像许可和补丁核验。

后续直接使用服务器安装版测试真实人物卡/写作卡、文章和人工修改，收到问题后修复；功能继续接图片/素材模型与目标平台排版。账号默认绑定、技能版本引用和历史恢复已实现；C1/C4 的引导制作、通用聊天及分享发现等仍需补齐。内容审核当前为个人自审，通用 HTML 不是平台适配完成。动态团队协议仍需真实质量/成本评价，不等于完整 WorkBuddy 对齐。另需验证 Docker、故障及备份恢复。自动发布、视频、计划不能抢在可靠内容闭环之前。
