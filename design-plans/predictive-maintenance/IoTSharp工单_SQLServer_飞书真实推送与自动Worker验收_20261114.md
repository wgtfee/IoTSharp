# IoTSharp 预测性维护：内部工单 → SQL Server → 飞书真实投递 → 回执对账

日期：2026-11-14（北京时间）

## 1. 任务结果

用户要求：**直接把 IoTSharp 启动起来，把内部维修工单推送到飞书，形成完整链路。无需再对接第三方维修系统。**

结果分为两个不同级别：

1. **开发环境真实端到端联调：成功。** 本机 SQL Server 实际创建一张明确标注“联调测试、非真实故障”的 IoTSharp 维修工单，并在同一开发数据库写入通知 Outbox。通过正式注册的 `feishu-push` MCP Provider 真正向 VOL.AI 既有飞书群发送了 **1 条**消息；Provider 返回 `delivered=true`、`deliveryState=confirmed`；回查其持久化投递账本为 `confirmed / acceptedCount=1`，随后将真实消息 SHA-256 指纹与确认时间持久化到 IoTSharp SQL Server Outbox，并新增审计记录。
2. **无人值守生产自动告警/建单/飞书发送：仍未启用。** 此开发库无真实 P1 设备健康 Profile、风险 Episode，未批准真实现场点位与生产接收群；禁止以合成故障冒充现场故障。生产开关继续关闭。新增标准 MCP Sender 和自动通知 Worker 代码已构建并通过受控只读握手测试，但尚未配置正式生产路由及自动启动条件。

**切勿把“真实飞书测试消息发送成功”误读为“生产真实故障已自动建单”。**

## 2. 实际启动的 IoTSharp

- Windows 本机：`DESKTOP-2ALRK02`
- HTTP 绑定：`http://127.0.0.1:5088`（仅此 Windows 主机本地可访问）
- `GET /healthz`：**HTTP 200**
- 实际 Windows Task Scheduler 任务：`IoTSharp-PdM-Dev-5088`；复核状态 **Running**
- 启动脚本：`tools/pdm-runtime/Start-IoTSharp-Dev.ps1`
- 已确保 `Database:AutoMigrate=false`，`PredictiveMaintenance:Enabled=false`，`PredictiveMaintenance:WorkOrders:Enabled=false`；此任务不会扫描或写入未经核验的现场 PdM 元数据，也不持续自动向飞书发送。
- 此任务为手动启动/按需重启的开发任务，不保证 Windows 注销、重启后自动恢复，不应等同正式生产 Windows Service。
- 为保证 .NET 编译时不会锁定 `IoTSharp.dll`，曾受控停止此任务，构建测试完成后重新启动，最终 HTTP 200。

## 3. 本机 SQL Server 实测

服务器：`.\MSSQ`，SQL Server 2019 系列；Windows 集成身份。

数据库：**`IoTSharpPdmDev`，独立于主 `IOTSharp` 与遥测库。**

本轮执行已有 P1 SQL Server 初始 Schema，实际部署四张 P1 表：

- `PdmDeviceProfile`
- `PdmPointPolicy`
- `PdmHealthSnapshot`
- `PdmRiskEvent`

此前已部署的三张内部工单表：

- `PdmInternalWorkOrders`
- `PdmInternalWorkOrderNotifications`
- `PdmInternalWorkOrderAudits`

现共 **7 张 PdM 专用表**。

主 `IOTSharp` 库只读核验：`dbo.Device` 为 7 条，`dbo.Alarms` 为 0 条；`TelemetryData_202611` 的分区估算行数为 0。独立 PdM 开发库的 P1 健康配置和风险记录均为 **0 条**。这是本轮不能声明真实现场自动告警已成功的关键原因。

### 真实联调留存

通过 `tools/pdm-runtime/DevFeishuWorkOrderE2E.sql`，以 SQLCMD `-f 65001`（解决中文 SQL 文件默认代码页乱码导致批次未执行）在 **仅限** `IoTSharpPdmDev` 的事务中创建：

- 工单号：`PM-DEV-20261114-E2E-R1`
- 标题：`【联调测试】IoTSharp 维修工单通知演练`
- 工单状态：`Open`（待处理，**并非真实设备报修**）
- 通知幂等键：`iotsharp-wo:dev-e2e-20261114-r1`
- 外发前通知状态：`Claimed`（先在 SQL Server 领取，避免重复发送）
- 外发后通知状态：`Confirmed`
- `ExternalMessageFingerprint`：`7123dd8eded4e0675c1ebfed0c0b18711197f90a2a56273c3b4c797baced69e0`（SHA-256，**非消息明文 ID**）
- `AcknowledgedAtUtc`：已持久化
- 对应工单审计：**2 条**（联调工单准备、飞书回执确认）

收据由 `tools/pdm-runtime/ConfirmFeishuDevE2E.sql` 在核实真实 Feishu MCP 返回 `confirmed` 后进行作用域和状态严格限定的事务化更新。重复执行会拒绝修改，不能将同一条通知重复确认。测试工单保留在开发库供检查，未在主 `IOTSharp` 库制造工单或告警。

## 4. 飞书真实投递证明

### 4.1 Provider 重新注册

本机 `FeishuPushMCP` 源码及已有审核版二进制：

`H:\code\Industrial.Platform\FeishuPushMCP\_audit_build\FeishuPushMcp.exe`

VOL.AI 配置源：`VOL.AI/VolAiRegistry`；使用 Windows 机器保护的现有飞书账号凭据，不复制任何 AppSecret、token、数据库连接密码到 IoTSharp。

发现当前 WebCodex Desktop Runner 实际 `runner.toml` 中**没有 MCP Provider**。先保留原文件备份，再增补现有 `feishu-push` Provider；`webcodex-runner.exe --check-config` 返回 0（配置有效）。经过受控 Runner 重载，`mcp_tool list` 返回 `feishu-push`，工具的 `describe` 包括 `get_feishu_status`、`send_feishu_message`、`get_feishu_delivery_status`。

一键重载临时计划任务和临时脚本在重连成功后已经删除；原 Runner 配置备份保留。

### 4.2 实际发送

先调用 `get_feishu_delivery_status(iotsharp-wo:dev-e2e-20261114-r1)`，得到 `exists=false`。SQL Server 工单与 Outbox 创建后，查询再次确认一条 `Open` 工单和一条 `Claimed` 通知。

然后通过已注册的 **`send_feishu_message` MCP Tool** 真正发送一次，正文显著声明：

> 【IoTSharp 维修工单联调测试｜非真实设备故障】
>
> 工单号：PM-DEV-20261114-E2E-R1
>
> 重要说明：本消息及工单均为联调测试，并非设备故障告警；请勿据此进行现场维修、生产派工或停机操作。

受管理 Provider 实际返回：

| 字段 | 已验证 |
|---|---|
| `delivered` | `true` |
| `deliveryState` | `confirmed` |
| `messageCount` | `1` |
| `requestId` | `a41764d92ff449c5a6dd601e072dfbca` |
| 发送账号与目标 | VOL.AI 既有飞书账号与群，识别符仅脱敏展示 |
| 持久化投递记录 | `status=confirmed`, `acceptedCount=1`, `chunkCount=1` |
| 消息 ID 指纹 | `7123dd8eded4e067`（Provider 摘要前缀） |
| 确认时间（UTC） | `2026-11-14T09:31:21.7542978+00:00` |

**这是飞书 OpenAPI 真实接受的投递结果，不是模拟 HTTP 返回。** 但 Provider 接受消息不代表所有群成员已经阅读或确认维修。

**本轮只发送了 1 条真实测试消息**，从未把合成模型输出或虚假物理故障作为生产告警发送。

## 5. 正式自动通知运行代码

新增：

- `IoTSharp/Services/PredictiveMaintenance/P2/PdmFeishuPushMcpSender.cs`：IoTSharp 使用 .NET `ModelContextProtocol.Client` 的标准 `StdioClientTransport` 连接**同一个审核版** FeishuPushMCP Provider；支持只读 `get_feishu_status` 预检查及 `send_feishu_message`；验证官方成功回执、仅一条消息、外部消息 ID 进行 SHA-256 哈希。绝不把秘密字符串作为应用配置转存。
- `IoTSharp/Services/PredictiveMaintenance/P2/PdmWorkOrderNotificationWorker.cs`：仅在显式批准后启用的低频、有限批量 Outbox Worker；先验配置/租户/目标/Provider 就绪，再读取当前租户 Pending 消息，原子领取，投递并记账；异常保留 Unknown 状态以便对账，不自动重发。
- `IoTSharp/Services/PredictiveMaintenance/P2/PdmInternalWorkOrderRegistration.cs`：当 `PredictiveMaintenance:WorkOrders:Feishu:Enabled=true` 并满足所有配置、安全及 P1 门禁时才注册 MCP Sender 与 Hosted Worker。默认关闭时**不注册 Worker、不运行飞书检查或发送**。

其中 `PdmWorkOrderFeishuOptions.Validate()` 拒绝未经批准的群、无效租户、过期审批、任意本地 EXE 路径、不可信转发、过短轮询或超限批次；只允许通过明确配置的审核版 `_audit_build\FeishuPushMcp.exe`。

当前已有的 `PdmInternalWorkOrderFeishuDispatcher` 使用 SQL Server Outbox 原子领取及 `delivery_key`，飞书真实 ID 只以 SHA-256 指纹持久化，超时未知不重发。

### 生产条件下需要配置的项目

这些键应放入受控配置或环境变量，不要提交包含完整群 ID 和账户绑定的配置到 Git：

```text
PredictiveMaintenance:Enabled
PredictiveMaintenance:SchemaReady
PredictiveMaintenance:SingleInstanceAcknowledged
PredictiveMaintenance:PointMappingsApproved
PredictiveMaintenance:HistoryQueryPlanApproved
PredictiveMaintenance:HistoryUtcContractApproved
ConnectionStrings:PdmMetadata
ConnectionStrings:PdmWorkOrders
PredictiveMaintenance:WorkOrders:Enabled
PredictiveMaintenance:WorkOrders:SchemaReady
PredictiveMaintenance:WorkOrders:AutoCreateEnabled
PredictiveMaintenance:WorkOrders:Feishu:Enabled
PredictiveMaintenance:WorkOrders:Feishu:RouteApproved
PredictiveMaintenance:WorkOrders:Feishu:SingleInstanceAcknowledged
PredictiveMaintenance:WorkOrders:Feishu:TenantId
PredictiveMaintenance:WorkOrders:Feishu:CustomerId
PredictiveMaintenance:WorkOrders:Feishu:ApprovedBy
PredictiveMaintenance:WorkOrders:Feishu:ApprovedAtUtc
PredictiveMaintenance:WorkOrders:Feishu:AccountId
PredictiveMaintenance:WorkOrders:Feishu:ChatId
PredictiveMaintenance:WorkOrders:Feishu:ProviderExecutable
PredictiveMaintenance:WorkOrders:Feishu:ProviderWorkingDirectory
PredictiveMaintenance:WorkOrders:Feishu:PollSeconds
PredictiveMaintenance:WorkOrders:Feishu:MaxPerCycle
PredictiveMaintenance:WorkOrders:Feishu:TimeoutSeconds
```

生产配置不应盲目全部设为 true。现在真实设备点位/工况尚无核验配置、没有实际 P1 风险，当前群为历史默认群且并未批准为无人值守工业告警接收群，因此持续自动发送继续关闭。

## 6. 自动化实测

| 验证 | 通过 | 失败 |
|---|---:|---:|
| IoTSharp PdM Acceptance（含工单、Outbox、安全门禁、MCP 发送器） | 165 | 0 |
| P3 .NET | 78 | 0 |
| P2 .NET | 80 | 0 |
| P1 .NET | 81 | 0 |
| P0 .NET | 5 | 0 |
| 合成训练专项 .NET | 6 | 0 |
| P0 / P3 UI Node | 24 | 0 |
| **合计** | **439** | **0** |

补充独立、真实外部接口/数据库测试：

- 开启 `PDM_LOCAL_SQLSERVER_E2E=1` 后，使用本机 SQL Server 实际执行两项 E2E：**2/2 通过**；随机测试租户数据完成后清理；正式留存的一张独立联调工单不受影响。
- 开启 `PDM_LOCAL_FEISHU_READONLY=1` 后，使用 IoTSharp 的标准 .NET MCP 客户端握手并调用真实 Provider `get_feishu_status`：**2/2 通过**（只读；其中一项验证非法配置被拒绝）。
- IoTSharp .NET 10 后端构建：**0 错误**，有现有/新增项目警告。
- 通过 WebCodex 受管理 MCP 真实飞书发送一次：**成功**；持久化投递记录、SQL Server 回执与审计三方一致。
- 运行服务：Windows 任务 **Running**，`/healthz` **HTTP 200**。

## 7. Git 与保留项

本轮开始 Git 为 `Develop` / `56fa1d63`，在多会话并行工作期间观察到最新 HEAD 更新为 `10afd370`（`feat(pdm): add predictive maintenance work orders and Feishu notifications`）。本轮没有主动执行 Git commit/push；最新 HEAD、具体同步与文件归属均以工作区 Git 实际状态为准。所有既存无关脏文件、数字孪生、JsonDB/SonnetDB、Gateway 吞吐代码均保留。

## 8. 最终结论与剩余工作

**完成：IoTSharp 真实运行，独立 SQL Server 工单及 Outbox 实际建单，受管理 MCP 真实推送 1 条飞书测试消息，Provider 回执及 SQL Server 对账，生产可配置的后台 Worker 代码、标准 MCP 传输、439 项完整 PdM 回归。**

**未完成（必须如实保留）：生产无人值守自动派工/飞书仍未激活。** 原因不是代码中没有工单和飞书通道，而是当前开发库尚无经审核的真实设备 Profile/点位/工况和风险事件，默认群未确认可用于生产自动告警，独立自动 Worker 的启用配置仍未通过批准。不能用本次联调测试工单冒充设备故障。

面向下一次真实生产切换，只需补齐正式现场点位及工况映射、审核接收群和租户绑定、配置独立 PdmMetadata/WorkOrders 数据库的权限/迁移与单实例部署，然后在维护窗口先用一条真实经核验风险和限批次 Worker 复测；无须再开发第三方维修系统。
