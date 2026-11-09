# 05 领域模型与状态

> 本文为逻辑模型与建议实现基线，不是完整 DDL。2026-11-02 已实现能力目录、模型连接、Agent/阶段及动态团队与独立内容版本/审核子集；实际表以 10、14、17 和迁移为准。

## 1. 建模约定

- PostgreSQL 表和列采用 `snake_case`，TypeScript 与 API 字段采用 `camelCase`。
- 主键建议 UUID，API 中均为字符串，避免大整数精度问题。
- 时间点使用 `timestamptz`，API 使用带 UTC 偏移的 ISO 8601；计划单独保存 IANA 时区。
- 关联、状态、唯一约束和频繁查询字段使用普通列；灵活参数使用 JSONB。
- 历史配置、已保存内容版本、调用记录不原地覆盖；错误记录可追加修正说明。
- 默认明确 `owner_id` 与 `account_id` 作用域，不因第一版只有一个管理员而省略数据边界。

## 2. 核心实体

| 实体                   | 主要字段或职责                                                                           |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| User                   | 管理员身份、密码哈希、启停状态                                                           |
| PlatformAccount        | 平台标识、名称、定位、受众、作者人设、默认专家与流程、配置修订号                         |
| Expert / ExpertVersion | 单专家/专家团身份与状态；不可变的指令、成员配置、技能绑定及原包存档；模型/权限扩展待实现 |
| Skill / SkillVersion   | 技能身份、SKILL.md、元数据、指令与资源；工具要求不等于获得授权，输入输出约束由适配层提供 |
| Material               | 类型、标题、标签、所属账号或公共范围、来源和当前修订                                     |
| Asset                  | 物理文件引用、内容哈希、类型、大小、归属和生命周期                                       |
| ModelConnection        | 供应商配置、密钥引用、模型清单、能力和启停状态                                           |
| Credential             | 密文、加密版本、用途、归属；不包含在普通 API 响应                                        |
| Topic                  | 选题、来源、账号、确认状态、关联运行                                                     |
| WorkflowTemplate       | 工作流键和代码版本；第一版不是用户可任意编辑的执行图                                     |
| TaskRun                | 类型、账号、配置快照、状态、输入引用、预算、取消标记、关联内容                           |
| TaskStep               | 顺序、执行类型、状态、输入输出、检查点、租约和尝试次数                                   |
| TaskEvent              | 重要业务事件、递增游标和受控的事件详情                                                   |
| ModelInvocation        | 供应商请求 ID、尝试次数、状态、耗时、用量、费用估算与费率版本                            |
| TeamRun                | 团队快照、主理人、全局预算、取消状态和汇总产物；当前由 creation_runs 承载                |
| AgentRun               | 所属团队/单专家、成员快照、独立上下文、轮次、加载/调用记录与结果，已有持久化             |
| TeamTask / Dependency  | agent_runs 保存固定阶段/动态成员任务与依赖，team_actions 保存动态提案/答复/派生关系      |
| TeamMessage            | 已保存派工/回报、计划、追问、答复和确认，关联发送/接收成员与实际任务                     |
| ContentItem            | 内容身份、账号、当前版本、审核状态、来源任务和归档时间                                   |
| ContentVersion         | 标题、正文 JSON、封面、附件、发布/导出参数及创建原因                                     |
| ContentReview          | 审核的版本 ID、审核人、结论、时间与备注                                                  |
| Schedule               | 账号、默认配置、时间表达式、时区、数量、预算、启停、漏跑策略                             |
| ScheduleOccurrence     | 计划时点、结果、关联运行；唯一约束防重复触发                                             |
| OutboxEvent            | 已提交但待投递的任务事件及投递状态                                                       |

后续发布增加 `PlatformConnection`（凭证与能力）、`Publication`（单次发布意图）和平台结果记录。账号档案不依赖这些连接实体。

## 3. 关系要点

```text
PlatformAccount -> default Expert
Expert -> ExpertVersion -> Skill bindings
ExpertVersion (team) -> embedded member snapshots + phases
PlatformAccount -> Material[] / Topic[] / ContentItem[] / Schedule[]
Schedule -> ScheduleOccurrence -> TaskRun
TaskRun -> TaskStep[] / ModelInvocation[] / TaskEvent[]
TaskRun -> configuration snapshot + input material references
TaskRun -> TeamRun -> AgentRun[] / TeamTask[] / TeamMessage[] (target)
AgentRun -> ModelInvocation[] + actual Skill loads (implemented subset)
ContentItem -> ContentVersion[] -> ContentReview[]
Publication (later) -> exact reviewed ContentVersion
```

专家的默认模型和流程可以被账号或本次任务明确覆盖，但最终组合必须通过兼容性与权限检查。快照保存非敏感配置和版本引用，凭证只保存受控引用。

### 当前实现与目标的区别

- 专家引用 Skill key，不是已固定的 SkillVersion。创建任务时解析该 owner 下当前版本，把完整技能定义和资源复制入快照；固定版本引用是后续必做项。
- 团队保存于 `experts.definition` / `expert_versions.definition` JSONB，包含唯一主理人、2–12 个成员定义与最多 20 个阶段。复制现有专家为成员是快照，没有独立成员表或自动跟随更新。
- 团队成员技能是团队可用技能的子集，预加载是成员技能的子集。模型路径按配置调度并行/依赖；自然语言 SOP 不自动转成动态调度图。
- `skills` / `skill_versions` 存放用户定义及资源。专家原始包存在 `package_files`，文本为 UTF-8、二进制为 base64。启停状态不增加定义版本。
- `creation_runs.snapshot.skillSelection` 保存创建时配置/事实，不改写 loaded；实际加载在 `agent_runs.loaded_skill_keys`，工具记录、成员和快照版本共同构成证据，mock 仍为空。
- 运行时新增 `model_connections/agent_runs/model_invocations/tool_executions/team_messages/invocation_reconciliations/team_actions`；creation_runs 增加预算、开始时间、取消标记、分支来源及活跃计时/恢复段计数。团队运行/依赖复用 creation_runs 与 agent_runs，不是上述逻辑实体全部逐表实现；成功稿继续是不可变运行分支。动态 waiting_user 非终态、释放租约，答复幂等唤醒 Outbox，见 15、16。
- 内容闭环新增 `content_items/content_versions/content_reviews/content_operations`：显式从成功稿加入，来源唯一，人工稿与运行结果分离；保存/恢复生成不可变新版本，审核递增 revision 且绑定准确版本，幂等收据支持断线后回放。当前仅标题、白名单文本正文与账号名称/平台快照，没有封面、附件、归档或发布参数，见 17。

## 4. 内容状态

`ContentItem` 的审核状态与生成任务、发布状态分开存储，不用一个字段承担全部流程。

```text
draft -> pending_review -> approved
             |
             +----------> changes_requested -> pending_review

approved -- 保存新版本 --> draft
任一非归档状态 -- 归档 --> archived
```

- 当前显式加入内容库后初始为 `draft`，用户再提交到 `pending_review`；保存/恢复新版本回到 `draft`。运行输出的 `reviewStatus` 不等于已提交内容审核。人工新建内容和归档仍是目标能力，尚未实现。
- 审核通过必须绑定准确版本；旧审核保留作审计，但不覆盖新版本。
- 恢复旧稿创建新版本，不把版本号或历史指针回滚成旧状态。
- 局部改写先产生候选结果，只有用户接受才更新当前版本。
- 第一版导出不强制审核通过，但未审核版本应有明显提示；后续自动发布必须审核通过并另有授权。
- 内容归档不会自动撤回外部已发布内容；归档与发布均为后续目标。模拟来源永久保留，不能审核通过。

## 5. 创作任务状态

| 状态             | 含义                             | 允许的后续动作                             |
| ---------------- | -------------------------------- | ------------------------------------------ |
| queued           | 任务已持久化，等待投递或领取     | 执行、取消                                 |
| running          | Worker 正在推进步骤              | 完成、等待确认、退避、失败、取消中、待核对 |
| awaiting_input   | 等待大纲确认或其他人工输入       | 校验后继续入队、取消                       |
| retry_wait       | 可重试错误，等待有限退避         | 再执行、取消、耗尽后失败                   |
| cancel_requested | 不再开始新步骤，尝试停止当前调用 | 已取消、待核对；已完成结果需按事务状态核对 |
| succeeded        | 所有必需步骤完成并保存结果       | 查看结果、显式创建新运行                   |
| failed           | 明确失败且不再自动重试           | 修正问题后创建新的重试运行                 |
| unknown          | 外部操作可能完成，结果无法确认   | 查询或人工核对后决定恢复、完成或失败       |
| cancelled        | 已停止后续执行                   | 查看已有结果、显式创建新运行               |

自动重试属于同一运行的有限尝试。终态后的手动重试创建关联原运行的新运行，保留原错误与费用记录，不能擦除历史再执行。

进程退出不能直接把所有 `running` 标记为失败或重新发送外部请求。恢复逻辑需要检查租约、步骤检查点、供应商请求 ID 与实际结果。

## 6. 选题与计划

选题状态建议为 `proposed`、`approved`、`reserved`、`consumed`、`rejected`。只有 `approved` 选题可以被定时成稿领取。

- 领取选题与创建业务任务在同一事务完成，记录预留运行，避免并发重复消费。
- 生成完成后标记已消费；明确失败或取消后按规则释放预留，保留历史关联。
- 外部调用结果未知时不自动释放选题并生成第二篇，先核对已有运行。
- 相同计划时点只有一条 `ScheduleOccurrence`；触发重试不能多次预留选题。
- 每个时点的运行数量与选题数量受上限控制，余额不足时记录原因并提醒。
- 暂停计划只阻止未来时点，是否取消已有运行需要单独操作。
- 默认时区 `Asia/Shanghai`，用户可修改；存储标准时区而不是固定写死偏移。
- 默认 `skip_missed`：停机后跳过过去时点，计算下一次执行；不隐式补跑。

若未来支持存在夏令时的时区，必须测试缺失和重复的本地时刻，并在界面显示下一次实际 UTC 时间。

## 7. 后续发布状态

```text
queued -> publishing -> published
                |----> failed
                +----> unknown -> 查询 / 人工核对

queued -> cancelled
```

发布意图固定账号、审核版本、最终发布包、用户授权和幂等标识。修改已排程内容时，暂停尚未提交的发布，要求重新确认；已经提交的平台操作先核对，不声称能直接撤回。

API 请求成功受理不等于平台发布完成。最终状态应由平台结果或人工核验确定。

## 8. 必须维护的不变量

1. 没有授权不能访问素材、SSE、附件或执行工具；配置快照不能绕过当前撤权。
2. 新版本未审核时不能沿用旧版本审核进行自动发布。
3. 同一业务运行、步骤和计划时点需要数据库级去重，不能只靠前端防连点。
4. 内容、任务输入和费用记录不能只存在 Redis 或浏览器内存里。
5. 同一内容的并发编辑必须检测冲突，不能静默覆盖。
6. 用量未知不等于免费；调用结果未知不等于没有执行。
7. 费用额度检查与并发任务预留应原子化，但费用估算不能承诺替代供应商硬限额。
8. 删除素材、账号、模型连接前检查历史引用；停用优先于无条件级联删除。
9. 团队成员必须有独立上下文、调用与原始产物；主理人汇总不覆盖或伪造成员记录。
10. 派发任务校验成员身份、依赖无环、数量与预算；主理人不能无限派生任务或越过前置结果。
11. 团队取消与恢复遵循每个调用的已知/未知状态；不得把“团队还没完成”等同于所有成员都需要重跑。
12. 包导入在单个事务内完成，标识冲突不覆盖现有能力；导入资源不产生执行权限。

当前启停语义：专家/技能停用阻止新运行，不追溯取消已有不可变快照；模型连接在每次发送请求前重新检查。素材尚未实现，未来素材撤权必须另做执行时校验，不能把当前快照机制当作已满足第 1 项的全部授权要求。
