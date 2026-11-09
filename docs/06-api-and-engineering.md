# 06 API 与工程约定

> 以下以目标开发契约为主。0.0.1 已实现子集的接口、事件和限制见 [实施状态](./10-implementation-status.md)。当前使用共享 Zod contracts，OpenAPI 生成尚未接入。

## 1. API 规则

- REST 前缀：`/api/v1`；JSON 字段使用 `camelCase`。
- 正确使用 HTTP 状态码，不把鉴权失败或服务器错误一律包装成 HTTP 200。
- 列表使用 `items` 与分页元信息；限制每页最大数量并允许必要的筛选排序。
- 对所有输入执行运行时校验，拒绝未知敏感字段和越权引用。
- 请求 ID 贯穿网关、API、Worker 和供应商调用日志，但不传递真实凭证。
- OpenAPI 作为 HTTP 契约，生成或检查前端类型；数据库实体不得直接返回。

建议成功响应：

```json
{
  "data": { "runId": "example-id", "status": "queued" },
  "requestId": "example-request-id"
}
```

建议错误响应：

```json
{
  "error": {
    "code": "CONTENT_REVISION_CONFLICT",
    "message": "Content changed. Reload before saving.",
    "retryable": false
  },
  "requestId": "example-request-id"
}
```

典型状态码：201 创建成功、202 异步任务已持久化、400 参数错误、401 未登录、403 无权限、404 不存在或不可见、409 版本或幂等冲突、413 请求过大、422 配置存在但当前不可执行、429 频率/额度限制、503 暂时不可用。错误响应不泄露堆栈、密钥或供应商完整请求。

## 2. 关键接口草案

| 方法与路径                         | 用途                     | 关键约束                          |
| ---------------------------------- | ------------------------ | --------------------------------- |
| POST `/auth/login`                 | 管理员登录               | 限流、安全会话                    |
| POST `/accounts`                   | 创建账号档案             | 与平台凭证解耦                    |
| POST `/experts`                    | 创建专家                 | 保存初始版本                      |
| POST `/experts/:id/versions`       | 更新专家定义             | 创建新版本而非覆盖历史            |
| POST `/experts/:id/test-runs`      | 试运行专家               | 独立结果、相同权限与计费约束      |
| GET `/skills`                      | 查询技能及可用版本       | 返回能力与输入输出约束            |
| POST `/creation-runs`              | 提交创作任务             | 幂等键、输入验证、202 + runId     |
| GET `/creation-runs/:id`           | 查询当前状态             | 数据库快照，不依赖 SSE            |
| GET `/creation-runs/:id/events`    | SSE 订阅                 | 会话与归属校验、事件游标          |
| POST `/creation-runs/:id/confirm`  | 确认大纲等步骤           | 绑定 stepId、输入版本、一次性推进 |
| POST `/creation-runs/:id/cancel`   | 请求取消                 | 非立即撤销外部副作用的承诺        |
| POST `/creation-runs/:id/retry`    | 明确终态失败后的手动重试 | 创建新运行，保留 retryOf 关联     |
| POST `/contents/:id/versions`      | 保存内容新版本           | baseRevision + Idempotency-Key    |
| POST `/contents/:id/reviews`       | 审核当前准确版本         | baseRevision，追加审核与幂等收据  |
| POST `/contents/:id/export`        | 导出指定版本             | version，未审/历史/模拟需确认     |
| POST `/schedules`                  | 创建计划                 | 时间规则、时区、预算、选题策略    |
| POST `/model-connections/:id/test` | 模型连接测试             | 小额度、有限超时、显示可能费用    |

路径省略的统一前缀为 `/api/v1`。列表、详情、编辑和停用接口在具体模块实施时补齐，不一次性猜测全部路由。

当前创建任务响应为 `202 + CreationRun`（包含 `id`）；专家更新的基线为查询 `baseVersion`。已实现 cancel、reconcile、成功稿 continue、动态团队动作响应与内容编辑/版本/审核/导出；通用 step confirm、失败 retry、定时计划与独立模型测试尚未实现。

### 已实现的内容接口（2026-11-02）

`POST /contents {sourceRunId}` 显式加入成功候选，按来源唯一幂等；GET 列表/详情、版本列表/单版本、审核历史均限定 owner。保存 `POST /contents/:id/versions`、恢复 `POST /contents/:id/restore`、审核 `POST /contents/:id/reviews` 必须携带 `baseRevision` 与 `Idempotency-Key`。先回放相同输入收据，再检查修订冲突；冲突为 `409 CONTENT_CONFLICT`。审核绑定当前已保存版本，保存/恢复撤销当前通过状态，不删除旧记录。模拟内容禁止通过。

`POST /contents/:id/export` 以准确版本导出 JSON/Markdown/安全 HTML，未审、历史和模拟稿必须明确确认；成功为原始附件，失败为错误 envelope。内容路由 JSON 2 MiB，普通请求仍为 64 KiB。节点、容量、状态和浏览器恢复详见 [17 内容闭环](./17-content-workflow.md)，不提供平台发布或任意 HTML。

### 2.1 已实现的能力目录接口（2026-11-02）

以下是实际接口，不是目标草案；均位于 `/api/v1`，要求有效会话，写请求额外校验 Origin 与 CSRF。

| 方法与路径                                 | 用途                          | 约束                                                    |
| ------------------------------------------ | ----------------------------- | ------------------------------------------------------- |
| GET / POST `/experts`                      | 查询/创建单专家或专家团       | 零到多项技能；团队成员/主理人/阶段校验                  |
| POST `/experts/:id/versions?baseVersion=N` | 保存新定义版本                | 冲突 409，不改写旧版本                                  |
| GET `/experts/:id/versions`                | 查询历史                      | owner 限定，分页                                        |
| POST `/experts/:id/availability`           | 启停                          | `{enabled,baseVersion}`，不增加定义版本                 |
| GET / POST `/skills`                       | 内置/用户技能列表与自定义创建 | 新建为 `{key,document}`，内置只读                       |
| POST `/skills/:key/versions?baseVersion=N` | 更新技能指令                  | key 不可改，保留现有资源                                |
| GET `/skills/:key/versions`                | 用户技能历史                  | owner 限定，分页                                        |
| POST `/skills/:key/availability`           | 用户技能启停                  | `{enabled,baseVersion}`，内置不可更改                   |
| POST `/packages/preview`                   | 解析能力包                    | 无数据库写入，返回文件、定义、警告与 runtimeReady=false |
| POST `/packages/import`                    | 原子安装能力包                | 同 key 冲突 409，全部回滚，不覆盖旧定义                 |
| GET `/skills/:key/export`                  | 技能 ZIP 下载                 | 包含指令与资源                                          |
| GET `/experts/:id/export?original=true`    | 专家/团队 ZIP 下载            | 默认 false 再生成；true 需要原包存档                    |

ZIP 请求为 `application/zip` 原始二进制，不使用 multipart 或 JSON base64 请求体；下载是 ZIP 原始响应，不套 JSON envelope。ZIP 最大 2 MiB，条目/解压与路径限制见 13。普通 JSON 最大 64 KiB，专家/技能配置路由为 2 MiB，避免合法多成员中文配置被全局小限额拒绝；字段级上限仍生效。

Skill key 支持一层命名空间（如 `my-package:outline`），客户端路径需编码。版本与启停分开，不自动终止已有任务。新任务拒绝停用配置；专家团未选择模型时返回 `422 TEAM_RUNTIME_UNAVAILABLE`，不能回退单专家 mock。

预览并不是服务器保留的安装许可：确认时重新上传并校验完整包，事务内重新检查冲突。用户点击预览不会产生专家、技能或文件系统副作用。完整接口与实际返回类型见 10 和共享 contracts。

### 2.2 已实现的模型与运行接口

`GET /models/capabilities` 返回模式、配置开关、主机白名单与工具；`GET/POST /models` 列表/创建连接，`POST /models/:id/availability` 接收 `{enabled}`。不返回 API Key、不自动测试。当前不采用目标草案中的 model-connections 路由。上限 20 个连接，列表直接为数组。

创建运行可带 `modelConnectionId` 与 `limits`；未带仅单专家沿用 mock，团队始终要求模型。快照工作流为 agent-v1/team-v1；团队显式提交 `teamMode: "dynamic"` 时为 team-dynamic-v1。预算、模型参数和权限见 14、16。`GET /creation-runs/:id` 包含 execution 的成员、工具、调用、消息、用量与核对历史，动态模式另有 collaboration 动作记录。

`POST /creation-runs/:id/cancel` 排队直接取消/运行中请求中断；`POST /creation-runs/:id/reconcile` 接收 10–2000 字 `{note}`，只允许 needs_review。核对后关闭 cancelled，保留 unknown 调用与预算，不重发/退款/继续。所有接口限定 owner 并沿用 Origin/CSRF。

## 3. 幂等与并发

已实现的草稿分支接口：`POST /creation-runs/:id/continue` 接收严格 `{instruction}`、需 Idempotency-Key，返回 202；`GET /creation-runs/:id/history` 分页返回同 owner/root 的分支元数据。仅成功且有合法正文的来源可修改，冻结原配置、独立预算、不覆盖原稿，不是失败/未知任务重试或完整对话。详细约束见 [15 草稿继续创作](./15-draft-continuation.md)。

已实现动态动作响应：`POST /creation-runs/:id/actions/:actionId/respond` 接收 `{answer,approved?}`，派工/确认需布尔批准，问题不能带批准字段；动作 UUID 作为一次性标识，相同答复幂等、不同答复 409。等待为非终态 waiting_user；有效答复与 Outbox 唤醒同事务。不是上表中的通用 step confirm，详细恢复与上限见 [16 动态团队协作](./16-dynamic-team-collaboration.md)。

异步任务创建、确认继续、导出请求和未来发布操作应支持业务幂等：

- 使用 `Idempotency-Key`，按用户、路由、业务范围与请求体摘要建立约束。
- 同一键和同一输入返回原资源；同一键但不同输入返回 409。
- 幂等记录保留策略需明确，覆盖客户端重试和任务生命周期的合理窗口。
- 数据库唯一约束与事务负责最终防重；Redis 去重只作为辅助。
- 内容保存使用基线版本，冲突时由用户比较合并，不自动覆盖。
- 内部幂等不能自动保证外部供应商不会重复扣费或重复发布。

## 4. SSE 与流式内容

建议事件类型：`run.status`、`step.status`、`content.delta`、`content.ready`、`run.error`、`heartbeat`。

当前实际事件为 `run.snapshot`、`heartbeat`、`session.expired`、`stream.unavailable`，每次连接先返回最新数据库快照；不支持按游标重放历史事件或 Token 流。

- 重要状态事件包含事件 ID、运行 ID、时间和最小必要数据。
- 临时 Token 增量不要求永久回放；最终内容与步骤状态以持久化结果为准。
- 重连发送最后事件游标；事件已过期时返回需要重新获取快照的信号。
- 未登录、无归属、会话过期均需拒绝或结束连接。
- 心跳、连接数上限、代理超时和断连清理必须测试。
- 首版不引入 WebSocket，除非出现必须的双向实时协作需求。

## 5. 登录与安全基线

建议同源 Web 使用服务端可撤销会话，通过 `HttpOnly`、`Secure`、适当 `SameSite` 的 Cookie 传输；变更请求结合 CSRF 防护和 Origin 校验。会话具体库与存储方式在 M0 核验，必须有注销和失效机制。

0.0.1 使用 PostgreSQL 会话表，固定 7 天有效期，HttpOnly + SameSite=Strict，HTTPS 下 Secure；写请求校验精确 Origin 与会话 CSRF Token。口令使用 Node scrypt，管理员仅可通过本地 CLI 首次创建，没有公开引导或注册端点。

不要因为 SSE 连接方便就在 URL 中放长期 Token，也不要把模型 API 密钥交给浏览器。若后续引入外部 API 客户端认证，应另行设计权限、有效期和撤销机制。

## 6. 代码与数据工程

- TypeScript 严格模式，边界输入做运行时校验；避免滥用 `any`。
- 采用模块化服务层，Controller 不承担复杂任务编排或直接持有供应商凭证。
- 前端以组合式函数和业务组件复用逻辑；按钮隐藏不能替代后端鉴权。
- 使用 TypeORM migration 管理模式变更，生产环境关闭 `synchronize`。
- 数据库迁移由明确的一次性部署步骤运行，不能让每个 API/Worker 实例同时自动迁移。
- 锁定依赖、运行时和镜像版本；示例环境文件只含占位值。
- 公共类型不包含密钥和内部实体；错误、费用和日期格式保持一致。
- 日志采用结构化字段，包含 requestId、runId、stepId；正文和供应商载荷默认脱敏或不记录。

## 7. 测试层次

| 层次     | 重点                                                            |
| -------- | --------------------------------------------------------------- |
| 前端单测 | 专家配置、内容冲突、状态渲染、表单与权限表现                    |
| 后端单测 | 上下文优先级、权限求交、预算、状态迁移、时区与选题规则          |
| 集成测试 | PostgreSQL 事务/约束、Redis 队列、Outbox 恢复、持久化与迁移     |
| 端到端   | 初始化 -> 账号 -> 专家 -> 创作 -> 编辑 -> 审核 -> 导出          |
| 故障测试 | API 提交后崩溃、Worker 中断、供应商超时、SSE 断连、计划重复触发 |
| 安全测试 | 账号素材隔离、CSRF、SSRF、HTML 清理、上传路径、密钥日志泄露     |

能力目录新增测试包括 ZIP 路径/链接/重名/容量与 YAML 校验、导入事务/并发冲突、owner 隔离、版本快照、停用拒绝、团队配置约束及执行拦截。未来 C2/C3 必须额外覆盖真实加载与工具授权、独立成员调用、依赖/并行、预算与未知结果恢复；配置测试不代替这些执行测试。

普通 CI 使用模型适配器桩和固定样本，不调用付费模型或真实平台发布。真实供应商冒烟测试显式启用，限制额度；平台发布测试必须选择专用测试账号和明确授权。

## 8. 完成标准

一个功能完成需要同时满足：验收场景通过、错误路径可见、权限和数据归属正确、必要测试通过、迁移可执行、文档同步。只有页面能点击或正常路径成功，不算完成。
