# IoTSharp 预测性维护：内部维修工单 + 飞书通知（开发及本机 SQL Server 真实验收）

日期：2026-11-14（北京时间）

工作区：`H:\code\Industrial.Platform\IoTSharp-master`

Git：`Develop`，HEAD `56fa1d63d9219008cde8e0ac3f5aae7a74822e74`；原有未提交改动保留，未进行 commit/push。

## 一、纠正产品设计

用户明确：**工单由 IoTSharp 自己创建和管理，飞书只负责将工单信息通知维修人员。完全不需要第三方维修系统创建工单。**

实查原始功能：

- IoTSharp 原有 `dbo.Alarms`、`AlarmController` 支持普通设备告警。
- PdM P1 已有风险事件、规则健康快照、恢复状态。
- PdM P2 已有 `PdmWorkOrderDraft`、人工审核草稿、模拟 Outbox，但**没有正式的业务维修工单实体、独立生产持久化表和维修全生命周期 API**。
- VOL.AI 已有真实飞书 App 通道和 FeishuPushMCP；自检 `Ready=true`，只读 Feishu OpenAPI 查询成功。飞书作为通知器即可，无需为工单写外部业务表。

新实现业务流：

```text
IoTSharp 真实设备遥测/工况
        ↓
P1: 核验规则风险（连续 >= 2 次 + Good 数据质量）
        ↓
IoTSharp 独立 SQL Server：内部维修工单（同一风险事件唯一）
        ├── 工单状态 Open → Assigned → InProgress → Completed → Closed
        ├── 责任维修人员与处理结果
        ├── 审计日志、版本并发控制
        └── 同事务生成一条 Feishu Notification Outbox
                        ↓
           受管理 FeishuPushMCP（需批准账号/群）
                        ↓
           只在飞书通知，不向“维修系统”建立外部工单
```

## 二、新增的实际代码

### 后端

- `IoTSharp/Services/PredictiveMaintenance/P2/PdmInternalWorkOrderDbContext.cs`：独立三实体、唯一索引、SQL Server EF，UTC 转换；没有改 ApplicationDbContext 或用户业务库。
- `IoTSharp/Services/PredictiveMaintenance/P2/PdmInternalWorkOrderService.cs`：
  - 从**由服务器查询的**可信 `PdmDeviceProfile + PdmRiskEvent + PdmHealthSnapshot` 创建 IoTSharp 内部维修工单。
  - 强制经核验的设备/点位/运行状态、单设备同版本、真实源、连续 `OccurrenceCount>=2`、Good 质量、Warning/Critical；不能使用合成分类器直接建单。
  - 同一 `Tenant + Customer + RiskEventId` 唯一；数据库事务一次性提交工单、初始审计与飞书通知请求。
  - 状态：待处理 / 已分配 / 处理中 / 已完成 / 已关闭，分配人、执行人、处理结果和版本并发控制；重新开同一事件返回已有工单。
  - 一工单一 `iotsharp-wo:<sha256>` 飞书去重键；通知发送失败不回滚工单。
- `IoTSharp/Services/PredictiveMaintenance/P2/PdmInternalWorkOrderRegistration.cs`：新工单独立 SQL Server 连接、SchemaReady/真实 P1 门禁、显式配置启用；绝不写主 IOTSharp 库或 telemetry 库。
- `IoTSharp/Services/PredictiveMaintenance/P2/PdmInternalWorkOrderFeishuDispatcher.cs`：
  - SQL Server Outbox 原子领取，调用注入的受管理 MCP Sender，保存成功消息 SHA256 / 未知结果。
  - 超时后不盲重试，不虚报 FeishuDelivered，也不创建任何外部维修单。
  - **目前仅完成并测试调度器接口及逻辑，没有注册真实外发 Sender/Worker。**
- `IoTSharp/Services/PredictiveMaintenance/PdmEvaluationWorker.cs`：仅在 P1 窗口确实提交、质量为 Good 且告警等级达到 Warning/Critical，且**独立的自动建单组件明确启用**时执行内部自动建单；保持原 P1 单实例/Schema/点位/历史时间等门禁，不触碰采集热路径。
- `IoTSharp/Startup.cs`：注册独立工单模块，默认未启用则不创建 DB Context/Worker。
- `IoTSharp/Controllers/PdmInternalWorkOrdersController.cs`：`/api/pdm/workorders` 列表、详情、`POST /from-risk/{id}`、`POST /{id}/transition`；当前租户客户由受信任 JWT/IAM 获取，禁止前端指定租户。SystemAdmin/TenantAdmin/CustomerAdmin 和专用工单管理角色可以执行管理；被分配的维修人员按授权角色处理，所有写操作有版本检查。

### 前端

- `ClientApp/src/api/pdm/workorders.ts`：前端类型和接口调用。
- `ClientApp/src/views/iot/pdm/InternalWorkOrders.vue`：工单列表、状态筛选、工单处理、维修结果和角色失败提示；不展示虚拟数据。
- `ClientApp/src/views/iot/pdm/workbench.vue`：在设备健康监测工作台展示内部维修工单。
- `ClientApp/src/views/iot/pdm/risk-events.vue`：在真实 Open 风险事件行提供“建维修工单”按钮（需管理员权限及显式门禁）。

### 独立 SQL Server DDL

`design-plans/predictive-maintenance/migrations/PdmInternalWorkOrders_V001_sqlserver.sql`：

| 表 | 用途 |
|---|---|
| `PdmInternalWorkOrders` | IoTSharp 内部正式维修工单 |
| `PdmInternalWorkOrderNotifications` | 飞书通知 Outbox，原子唯一键、投递状态 |
| `PdmInternalWorkOrderAudits` | 创建、指派、处理、关闭审计 |

迁移具有独立数据库检查，明确拒绝 system DB 与主 `IOTSharp` 库，不执行主数据库自动迁移。约束包括唯一事件工单、唯一通知 Key、FK、状态 CHECK、租户查询索引。

## 三、本机 SQL Server 真实执行

在 Windows Runner 本机连接 `DESKTOP-2ALRK02\MSSQ`（Windows 集成身份），只在**新建的独立开发数据库**操作：

`Database=IoTSharpPdmDev`

过程：

1. 检查同名开发数据库原本不存在，才创建专用开发库；保留原 `IOTSharp` 数据库不动。
2. 执行 `PdmInternalWorkOrders_V001_sqlserver.sql`，实际建表成功，查 `sys.tables` 确认三个表齐全。
3. 使用 `Microsoft.EntityFrameworkCore.SqlServer`，针对真实本机 SQL Server 跑隔离 E2E：创建工单、重复同一 Episode 去重、查询工单、验证通知 Outbox、分配维修人、开始、完成、关闭，检查 5 条审计。
4. E2E **1/1 通过**。最后只按本次随机测试租户/客户删除相关测试数据并复查：
   - `PdmInternalWorkOrders`：**0 行**
   - `PdmInternalWorkOrderNotifications`：**0 行**
   - `PdmInternalWorkOrderAudits`：**0 行**
5. 开发专用数据库及三张空表保留，后续可以继续本机验收；没有在主 IOTSharp DB 插入工单、警报或修改遥测。

## 四、自动化回归

| 测试 | 结果 |
|---|---:|
| PdM Acceptance（含前述 153 + 9 项内部工单/飞书协调测试） | **162/162** |
| PdM P3 .NET | **78/78** |
| PdM P2 .NET | **80/80** |
| PdM P1 .NET | **81/81** |
| PdM P0 .NET | **5/5** |
| PdM P0 / P3 UI Node | **24/24** |
| 合成训练专项 .NET | **6/6** |
| **合计** | **436/436** |

此外，启用 `PDM_LOCAL_SQLSERVER_E2E=1` 的本机 SQL Server 测试单独实际执行成功；非本机环境默认跳过 SQL Server 真实连接步骤（普通 xUnit 会将条件内 return 视作 Pass，不能混淆为已连接 SQL Server）。

- `.NET 10` IoTSharp 构建：成功，**0 错误**（存在项目警告）。
- Vue `npm run typecheck`：成功。
- Vue `npm run build`：成功。
- 还未用真实认证浏览器及投递过飞书消息进行完整人工业务验收。

## 五、为什么目前没有直接让飞书发出真实通知？

VOL.AI 的真实 Feishu 应用凭据和群会话已由上轮确认，现成 `FeishuPushMCP` 具备带稳定 `delivery_key` 的 `send_feishu_message`。**但本次没有修改 VOL.AI，也未找到当前可调用的受管理 FeishuPushMCP Tool Provider**；不能通过绕过受管理 MCP 的 EXE 命令私自发送生产告警。

此外，当前 VOL.AI 默认群是 2026-08-21 最近活跃的会话，尚未经过 PdM 生产接收群审批；当前 PdmMetadata 真实设备和规则证据也没有完成上线，不能将合成记录或空库伪装成现场故障。

本轮**工单主体确实已经实现**，并在 SQL Server 实际创建与流转验证通过。飞书是其后续通知通道，**尚未真实外发**。当前 `PdmInternalWorkOrderNotifications.State='Pending'` 表示请求已持久化，而不是外部消息已送达。

## 六、上线配置门禁与后续最短路径

当前保持默认关闭：

```text
PredictiveMaintenance:Enabled                          = false (unchanged unless reviewed)
PredictiveMaintenance:SchemaReady                      = false (unless schema separately verified)
PredictiveMaintenance:WorkOrders:Enabled               = false
PredictiveMaintenance:WorkOrders:SchemaReady           = false
PredictiveMaintenance:WorkOrders:AutoCreateEnabled     = false
PredictiveMaintenance:WorkOrders:ManualCreateEnabled   = false
```

独立连接配置示例（仅本机开发环境）：

```text
ConnectionStrings:PdmWorkOrders =
  Server=.\MSSQ;Database=IoTSharpPdmDev;Integrated Security=True;TrustServerCertificate=True
```

不可单独把上述标志直接设为 true：P1 的 `PdmMetadata` 独立库/规则/现场设备核验、单实例 Worker、历史 UTC 和查询资源门禁必须先实际通过。当前开发库已经包含内部工单三表，但**不能据此证明整个 P1 元数据 Schema 和硬件数据都已经准备就绪**。

最短后续：

1. 在独立 PdmMetadata 中部署并核验 P1 真实设备/点位/工况规则数据，具备可信连续异常后启用内部自动建单。
2. 授权确认 PdM 飞书接收群与账号（Tenant/Customer/Account/Chat），并为 IoTSharp 工单通知配置受管理 FeishuPushMCP Sender。
3. 有真实的低风险、经审核现场事件后先发送**一条**显式标注的受控通知，验证真实回执、重复通知幂等、重启未知状态；通过后再打开按工单自动发送开关。
4. 用真实 IAM 身份完成网页创建、分配、维修、关闭与审计验收；保留回滚开关。

**结论：内部工单及其 SQL Server 持久化/前端/API/审计/飞书通知 Outbox 已开发和测试通过。飞书实际外发与生产自动建单仍未激活，不应宣称完整生产流程已经验收。**
