# IoTSharp PdM：第七批告警 / 工单闭环、飞书与本机 SQL Server 核验报告

- 日期：2026-11-14（北京时间）
- 工作区：`H:\code\Industrial.Platform\IoTSharp-master`
- 分支：`Develop`；HEAD：`56fa1d63d9219008cde8e0ac3f5aae7a74822e74`
- 用户本轮追加目标：**真实自动告警、通过飞书发送、对维修系统实际创建工单，数据库优先使用本机 SQL Server。**
- 核心结果：隔离代码与 Feishu HTTP 传输实现和自动化测试通过；**现场生产链路不具备放行条件，因此没有擅自启用生产自动告警或发出真实工单。**

## 一、真实源码及现有系统调查

现有能力：

1. `PdmRiskEventTransitions` 已实现连续异常 Episode、窗口去重、连续正常恢复和 Unknown 禁止误恢复。
2. `PdmAlertPolicyEngine` 已实现持续次数、最小风险、数据质量、冷却时间和风险升级的**通知提案决策**，而非真实发送。
3. `PdmP2ReviewLedger` 已有分租户审核日志、草稿创建、独立审核人及状态版本门禁。
4. `PdmWorkOrderDraftAdapter`、`PdmWorkOrderSandboxIntegration` 和第六批 `PdmWorkOrderManualReconciler` 实现本地演练 / 模拟 Outbox 与人工对账，**不存在已经验收的第三方维修系统建单适配器**。
5. 原 `PdmServiceRegistration` 的 Worker 启动需要明确通过 Schema、单实例、点位、历史查询计划和 UTC 来源合同等多项门禁，不能无条件开启。

搜索当前工作区已跟踪 `.cs/.json/.md/.vue/.ts` 源码，以及工作区常见名称为 Feishu/Lark/Webhook 的文件和环境变量名称，**未发现可确认已配置的飞书发送实现或真实机器人 Webhook**。故不能声称“飞书已有可用配置”。

## 二、本机 SQL Server 实际只读核验

本轮通过 Windows 身份在**本地**实际执行 `SQLCMD.EXE` 只读语句：

- SQL Server 实例：`.\MSSQ`；Windows 服务 `MSSQL$MSSQ` 处于 Running。
- 连接：Windows 集成身份 `-E` 成功。
- 服务器版本：`15.0.2110.4`（SQL Server 2019 系列）。
- 已存在业务数据库：`IOTSharp`；当前读取 `sys.tables` 数量 **85**。
- 当前已存在告警表：`dbo.Alarms`。其列包含 `Id/AlarmType/AlarmDetail/AlarmStatus/Serverity/OriginatorId/TenantId/CustomerId` 等。
- 通过 `sys.tables` 查找 `Pdm%` 或 `%WorkOrder%`：**没有发现 PdM 元数据/维修工单专属表**。
- 通过 `sys.databases` 查询：没有发现独立 PdM 命名数据库。

仅使用 `sys.databases`、`sys.tables` 和 `INFORMATION_SCHEMA.COLUMNS` 只读元数据查询；**没有执行 DDL、INSERT/UPDATE、跨月大查询、告警插入或任何生产修改**。以前涉及 SQL Server DDL/跨月访问的安全门禁仍有效，没有通过其他命令形式绕过。

因此，本轮尚不具备将新的 PdM 状态、审核记录、通知 Outbox 和工单 Outbox 部署到本机 SQL Server 并宣称生产可用的条件。已有 `IOTSharp` 应保留主业务职责；PdM 元数据优先使用另一个经审批的独立 SQL Server 库及显式 DBA 迁移。

## 三、本轮新增实际运行时代码

### 1. 可持久化的隔离闭环协调器

`IoTSharp/Services/PredictiveMaintenance/P2/PdmP2IsolatedClosedLoop.cs`

- 独立 SQLite 文件，只允许 OS 临时目录内固定 `pdm-closedloop-sandbox-*.sqlite` 文件；**绝不写入业务 SQL Server 或主 ApplicationDbContext**。
- 把 P1 风险事件、P2 `PdmAlertPolicyEngine` 连接为事务化告警提案；相同设备 / 规则版本 / Episode / 时间窗口使用唯一索引，防止重放。
- 使用串行化事务读取上次提案，继承现有 30 分钟冷却与同 Episode 风险升级规则。
- P1 满足连续恢复后，持久化 `ResolvedInSandbox`；不会误关闭已存在的待处理维修草稿。
- 只有相同租户/客户/设备/Profile/Episode 并具有不同草稿作者、规划审批者和操作人的有效 P2 审核，才能生成一张 `DraftAwaitingManualDispatch` 本地草稿。
- 本地人工操作可 `DraftAwaitingManualDispatch → StartedInSandbox → ClosedInSandbox`，严格状态条件 UPDATE，重复操作不二次执行。
- 明确 `IsNotificationDelivered=false` 和 `IsExternalWorkOrderCreated=false`。没有任何外部发送代码路径或伪造工单号。

### 2. 飞书官方机器人适配器

`IoTSharp/Services/PredictiveMaintenance/P2/PdmFeishuVerifiedAlertSender.cs`

- 支持通过 `HttpClient` POST 飞书 / Lark 标准 `msg_type=text` 机器人消息。
- 只允许 `https://open.feishu.cn/open-apis/bot/v2/hook/...` 或 `https://open.larksuite.com/open-apis/bot/v2/hook/...`，端口固定 443，无 URL query/fragment、无替代域名。
- 提供 `CreateRedirectSafeClient()` 工厂，禁止 HTTP 重定向并设置 10 秒超时。真实使用方不能使用带自动重定向的泛用客户端。
- 只接受已核验现场点位、运行工况、真实现场遥测和审批门禁的 `PdmFieldAlertNotification`；合成模型、未审核、Unknown、异常风险键等都拒绝。
- 飞书仅传递设备 GUID、评估时间、严重级别、关联键等最少必要元数据，不发送租户秘密或原始采样数据。
- 只在 HTTP 成功且 JSON `code=0` 时返回 `FeishuAccepted=true`；网络/超时/错误回执不自动重试，要求调用方持久化未知状态并人工对账。
- **此文件未注册到生产 DI、未配置真实 Webhook、未调用任何生产 Feishu 群；飞书消息不是维修工单。**

实际第三方维修系统没有已发现的可用 API 契约；本轮不虚构 endpoint、认证协议、字段映射、工单号或发送成功状态。

## 四、自动化实际验收

新增测试：

- `tools/pdm-acceptance/closed-loop/Batch7PdmClosedLoopIntegrationTests.cs`：**10 项**。包括持久化重启去重、冷却和升级、持续异常/数据质量、P1 连续恢复、不同审核者、同一事件只生成一个本地草稿、手工状态流转、租户客户隔离、Unknown/取消安全关闭、禁止非沙箱数据库。
- `tools/pdm-acceptance/closed-loop/Batch7FeishuVerifiedAlertSenderTests.cs`：**4 项**。测试采用内存 `HttpMessageHandler` 模拟飞书成功/失败回应、非官方 URL、合成/未核验事件的拒绝和失败不重试。**模拟回执不等于真实飞书发送成功**。

回归：

| 模块 | 通过 | 失败 |
|---|---:|---:|
| PdM Acceptance（第六批 135 + 本轮 14） | 149 | 0 |
| P3 xUnit | 78 | 0 |
| P2 xUnit | 80 | 0 |
| P1 xUnit | 81 | 0 |
| P0 xUnit | 5 | 0 |
| P0 + P3 UI Node | 24 | 0 |
| 合成训练 xUnit | 6 | 0 |
| **合计** | **423** | **0** |

.NET 10 后端构建通过：0 错误、79 个现有/新增分析器及项目警告。没有修改前端，本轮没有再次运行完整 Vite 打包。其他既存用户未提交修改全部保留。

## 五、真实生产启用缺少的必要证据

1. **飞书发送目标：** 需要已经获授权的飞书群机器人 HTTPS Webhook（或确认现有 Feishu App 身份/目标接收人）；当前工程与环境变量没有找到。真实端到端发送结果未验证；不得把模拟 HTTP 200 作为验收。
2. **维修系统：** 缺少实际维修系统建单地址、API 协议/授权、幂等键、工单状态查询/对账 API 和字段映射。飞书群通知不能代替维修系统工单创建。
3. **SQL Server：** 当前 `IOTSharp` 有旧告警表但缺 PdM 专用表；需要经过审核的独立 SQL Server PdM 元数据迁移、唯一索引、事务隔离、备份与回滚。不可偷用 SQLite 演练通过结论。
4. **现场事件：** 需要真实设备 Profile 与运行状态/点位核验，以及可复现且同租户的真实 P1 风险记录。上一轮 3,744 条**合成**记录不能成为生产自动告警的来源。
5. **发送安全：** 生产需实现 SQL Server Outbox 的原子领取、幂等、超时未知状态、人工对账、通道重试限流、发送审计和有界 Worker，且通过企业 IAM 和权限审查；不能用本轮手工沙箱状态或模拟接单替代。
6. **验证策略：** 首先采用生产的**只读/Shadow 加人工确认发送**进行有界验收，证明实际接单成功后才允许正式自动通知。维修工单是否可以无需人工审批，需现地管理策略明确授权。

## 六、最终判定

**隔离开发：通过。** P1/P2 持久化演练、状态去重、恢复、工单草稿及 Feishu HTTP 适配器的 423 项自动化测试全部通过。本机 SQL Server 的实际只读连接与既有告警表调查已完成。

**生产自动通知：未启用。真实飞书发送：未执行。真实维修系统工单：未发送。生产 SQL Server PdM 写入：未执行。**

保留安全门禁不是遗漏用户要求，而是当前环境无真实飞书凭据、维修系统 API、PdM 专用 SQL Server Schema 和经核验现场异常证据；在这些条件具备前强行启用会导致误报、重复工单或不确定外发结果。

本轮未运行 Git commit/push，未覆盖已有工作区未提交文件，未修改主 ApplicationDbContext、IoTGateway 遥测热链、Durable Spool、数字孪生、JsonDB 或 SonnetDB。
