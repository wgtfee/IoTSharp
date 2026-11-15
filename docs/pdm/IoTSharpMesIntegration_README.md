# IoTSharp → VOL.MES 告警与恢复通知 — IoTSharp 实施说明

## 源端已新增

- 独立 PdM SQL Server Outbox：IoTSharp.Data/PdmIntegrationOutbox.cs。
- 独立手工迁移脚本：docs/pdm/IoTSharpMesIntegration_Outbox_SqlServer_V1.sql；绝不通过主库的自动迁移执行。
- 事件投影：IoTSharp/Services/PredictiveMaintenance/Integration/PdmMesEventProjector.cs。采用已核验 P1 风险事件的事务，只有达到两次持续可信风险后生成 ALARM_OPENED；升级到 Critical 生成 ALARM_ESCALATED；风险 Cleared 生成 ALARM_RECOVERED。
- 可靠传送：IoTSharp/Services/PredictiveMaintenance/Integration/PdmMesOutboxWorker.cs。存储固定 EventId/SourceSequence/JSON，发送同一 payload，HMAC 后由 MES Inbox 进行最终去重。
- 未启用前不触发发送，默认配置全部 false。不能把历史数据模拟结果标记成真实工厂报警。

## 部署前置

1. 先在**隔离的 IoTSharp PdM 元数据库**执行并审核 Outbox SQL 脚本，不连接主 IOTSharp 或时序库。
2. VOL.MES 在独立 BusinessDb 和 SysDb 分别运行经过审查的迁移脚本；审核设备到人员的 Tenant/Customer/Device 映射，不按“所有人”广播。
3. 生产 HTTPS 服务端地址必须指向 /api/integration/iotsharp/events，正确配置 KeyId 与两端同一 HMAC SharedSecret（不少于 32 字节），从环境变量或安全配置源注入；不提交真实密钥。
4. 满足 IoTSharp PredictiveMaintenance P1 的 SchemaReady、SingleInstanceAcknowledged、PointMappingsApproved、HistoryQueryPlanApproved、HistoryUtcContractApproved 及独立 MetadataProvider=SqlServer 门禁后，显式启用 PredictiveMaintenance:MesIntegration:SchemaReady 和 Enabled。
5. MES 配置 IoTSharpIntegration:Enabled 之前务必验证其 SQL 表权限和接收服务。可先以仅读模拟输入和一次性隔离数据库验证，而不是发往真实收件人。

## 事件语义

同一风险事件使用 SourceEventKey 对齐 MES 报警，EventId 区分每次通知，SourceSequence 单调递增。恢复通知应与首次异常和升级各自独立，且不能标记为“维修工单已完工”。若源端与 MES 暂时断开，Outbox 重试同一 EventId，不生成新的事件身份。

## 测试及未完成

- 独立无网络单元测试：tests/IoTSharp.MesIntegration.Tests/IoTSharp.MesIntegration.Tests.csproj。验证 Warning、Critical、Normal/Cleared 顺序产生 OPENED、ESCALATED、RECOVERED，以及未审批/单窗口风险无外部事件。新增 PdmMesApiClientTests，直接调用真实 PdmMesApiClient + 模拟 HttpMessageHandler 验证实际 HMAC 签名、202/200 回执、错误 EventId 不可确认、401/503 分类。
- IoTSharp.Test/PdmMesEventProjectorTests.cs 作为常规测试集的一部分；如果现有 IoTSharp.Test 受其他代码编译错误阻塞，可运行上述隔离项目。
- **2026-11-15** 上述独立项目验证 **7/7 通过（退出码 0）**。本轮 VOL 对端 LocalDB 实际 HTTP+SQL Server 两库测试 **14/14 通过**，包含无绑定队列积压 55 条不阻塞后续正常设备、乱序恢复、Sys_Notice 每人独立消息。详见 VOL 端 OperatorGuide_V1.md 与 tests/IoTSharpMes.E2E/Program.cs。
- 本轮还在全新、随机命名的一次性 LocalDB 数据库上实际运行 IoTSharp 独立 PdM Outbox SQL 脚本 **两遍**，建表与唯一索引校验通过，临时库已删除；这仅验证迁移 SQL 结构和幂等性，不是 PdM 真实后台 Worker 的数据库联调。
- 源端可复现命令：`dotnet test tests/IoTSharp.MesIntegration.Tests/IoTSharp.MesIntegration.Tests.csproj --no-restore -c Debug --filter FullyQualifiedName~PdmMes --nologo -v quiet /p:MesIsolatedAssemblyReferences=true /clp:ErrorsOnly /m:1`。当运行中的 IoTSharp 主机锁定 DLL 时，隔离测试项目会引用本次编译的 IoTSharp obj 程序集；正式 CI 可使用通常的 ProjectReference。
- 这是 LocalDB 测试阶段的记录。此后已在本机实际开发 SQL Server 数据库完成真实 HTTP 跨进程 E2E 与断线重试（见下文），**仍未运行生产数据库迁移、跨主机生产 HTTPS、真实 PLC、飞书或维修工单完成回传**。内部工单的人工完工不等同于本次监测恢复。

完整 MES 对端表结构、配置、协议及验收步骤参见 VOL 工程的 vol.api.sqlsugar/docs/IoTSharpIntegration_OperatorGuide_V1.md。

## 真实开发库跨工程联调（2026-11-15）

**已实际完成** IoTSharp 的 PdM 风险状态机 → SQL Server 实体事务 → PdmIntegrationOutbox → 真实 PdmMesOutboxWorker → HMAC HTTP → `VOL.WebApi` 实例 `127.0.0.1:9991` → 真实 MES BusinessDb Inbox/Alarm/NotificationOutbox → 真实 SysDb.Sys_Notice。

- 本机三套开发库 `IoTSharpPdmDev`、`netcoreserver_dev`、`netcore` 迁移脚本均已重复执行两次通过。未改动 IoTSharp 主/遥测数据库。
- 新增 `tests/IoTSharp.MesIntegration.LiveDev/` 控制台测试与 `Run-RealDevSource.ps1`，只允许开发机 SQL Server `DESKTOP-2ALRK02\\MSSQ`、开发数据库和本机 9991，且需要显式开发测试授权标志；自动读取受保护的 Windows DPAPI 本机 HMAC 开发密钥，禁止打印或提交。
- 使用五个可信的**模拟** 15 分钟窗口验证 `Warning → Warning → Critical → Normal → Normal`，经过实际的 `PdmRiskEventTransitions.Apply` 与 `PdmMesEventProjector.TryAppendAsync`，投影出 `ALARM_OPENED`、`ALARM_ESCALATED`、`ALARM_RECOVERED` 三条不同 EventId、SourceSequence=1/2/3 的事件。
- 为避免伪装成实际设备故障，投影器新增末尾可选 `isSynthetic=false` 参数：默认正式路径仍为 false，只有显式测试调用传 true，事件摘要标记 `[DEV联调模拟]`；MES 仅 Development + 显式 AllowSyntheticInDevelopment 能接收。
- **实测成功** 源端 Outbox 3 Delivered，MES Inbox 3 Processed，单个报警 `RECOVERED`，SysDb 管理员异常/升级/恢复 3 条独立未读消息；同一 EventId 重发未复制消息。
- 真实 MES 后端曾因测试运行时间上限退出，源端 Pending 真实积压且计数增加（重试次数 2），重启 MES 后自动投递并全部 Delivered，验证断线重试/幂等恢复。
- 联调事件 SourceEventKey：`9a710438aef95e0edc22aa368a0beb1231d7b1042e6caa9f882e73eff0fa5d24`，MES AlarmId：`a69106f2-def8-4a75-bcf9-ddfcf7096b85`。测试 PdM Profile 已禁用，不参与后续真实设备轮询；历史及 MES 消息保留用于审计与浏览器复核。
- 独立开发联调控制台项目使用本机已编译 IoTSharp `obj/Debug/net10.0` 程序集；因为当前主程序集按 .NET EF Core 10.0.10 编译，控制台单独引用对应 EF Core 10.0.10；不改主工程的全局 NuGet 依赖基线。

**尚未完成**：生产 HTTPS 双机证书与多实例压力验收；管理员真实浏览器登录后查询详情及在线 SignalR Push 截图（环境自动化登录凭证操作受限）；真实 PLC 遥测推断、飞书和人工维修工单完工信号。此次并不代表它们通过。

VOL 后端开发验收记录、数据库对照及手工启动步骤位于 `vol.api.sqlsugar/docs/IoTSharpIntegration_OperatorGuide_V1.md`。

**V1 本机真实开发环境完整功能验收已通过。** 最新 16 项实际验证与浏览器截图参见 VOL 项目 `vol.api.sqlsugar/docs/IoTSharpIntegration_FullAcceptance_20261115.md`。除先前完成的真正 HTTP+SQL 风险生命周期外，又通过正常验证码密码登录、普通用户隔离、SignalR 实时异常/升级/绿色恢复、断线后的浏览器未读恢复。IoTSharp 实测 Outbox 15 Delivered，5 个合成 PdM 设备 Profile 均已禁用；MES Inbox/通知 Outbox Pending 均为 0，临时 QA 收件人已禁用并清理 Token。**真实 PLC、人工维修工单已完工、生产 HTTPS/多实例和飞书仍属于独立待验收范围。**
