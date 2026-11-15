# IoTSharp → VOL.MES 人工维修工单完工、关闭同步 V1

日期：2026-11-15。此方案延续已经完成的自动监测风险异常、升级、监测恢复通知，不创建第二套 MES 维修工单流程。

## 事件与权限

- 人工工单使用现有真实 `PdmInternalWorkOrderService.TransitionAsync` 和 `api/pdm/workorders/{id}/transition`，遵守租户、客户、维修人身份、Revision 乐观并发校验及审计。
- **WORKORDER_COMPLETED**：只有已指派维修人、工单为 InProgress，执行 Complete 且写入处理原因后触发。
- **WORKORDER_CLOSED**：工单已 Completed，由有授权的管理人员执行 Close 才触发。
- 监测风险 `ALARM_RECOVERED` 仅表示指标恢复，不产生人工维修完成事件，MES 监测状态始终独立。
- 工单的事件流：`sourceEventKey = workorder:<WorkOrderId:N>`，Complete=1、Close=2，EventId 独立稳定，关联原监测 Episode 的 `RiskSourceEventKey`、RiskEventId、租户/客户/设备/Profile。
- 任一工单只允许一个源风险事件关联，数据库原有唯一索引 `IX_PdmInternalWorkOrders_TenantId_CustomerId_RiskEventId` 禁止同一事件重复建单。测试复用历史风险片段时必须先查是否已有工单。

## 源端实现

| 位置 | 职责 |
|---|---|
| `IoTSharp/Services/PredictiveMaintenance/P2/PdmInternalWorkOrderService.cs` | Complete/Close 同一事务写工单状态、审计、工单 MES Outbox |
| `IoTSharp/Services/PredictiveMaintenance/P2/PdmInternalWorkOrderDbContext.cs` | 工单原风险 Episode 关联键与新 Outbox 模型 |
| `IoTSharp/Services/PredictiveMaintenance/P2/PdmWorkOrderMesOutbox.cs` | 保证工单状态真实、风险关联完整、序列固定，生成持久事件 |
| `IoTSharp/Services/PredictiveMaintenance/Integration/PdmWorkOrderMesOutboxWorker.cs` | 工单独立后台发送、失败退避、幂等重试、人工核对 |
| `IoTSharp/Services/PredictiveMaintenance/Integration/PdmMesOutboxWorker.cs` | 共用已验收的 HMAC HTTP 客户端、确认 EventId 后置为 Delivered |
| `docs/pdm/PdmWorkOrderMesSync_SqlServer_V1.sql` | 独立维修工单 SQL Server 库增量幂等迁移 |

生产端默认保持关闭，明确启用条件是原先 P1/MesIntegration 和 WorkOrders 所有批准门禁全部有效，再配置：

```json
{
  "PredictiveMaintenance": {
    "WorkOrders": {
      "Enabled": true,
      "SchemaReady": true,
      "MesSync": { "Enabled": true, "SchemaReady": true }
    }
  }
}
```

以上示例不是全量配置，仍需已有 `PredictiveMaintenance:Enabled` 与 `PredictiveMaintenance:MesIntegration:Enabled/SchemaReady`、独立 workorder SQL Server 连接、TLS、可信服务密钥以及真实设备批准。严禁仅凭示例开启生产。

## 开发环境实际测试

- SQL Server `DESKTOP-2ALRK02\MSSQ`：`IoTSharpPdmDev` 执行 `PdmWorkOrderMesSync_SqlServer_V1.sql` 两遍；`netcoreserver_dev` 执行 `IoTSharpIntegration_WorkOrder_BusinessDb_V2.sql` 两遍。
- `tests/IoTSharp.WorkOrderMes.LiveDev/` 隔离编译 **0 错误**，用**真实**工单服务、SQL Server 事务、HMAC 发送器、MES Inbox/通知 Worker 测试：
  - 管理员指派、维修人开始、非指派人员完工被拒绝、真实授权维修人完工、管理人员 Close。
  - 维修源 Outbox 2 Delivered，MES 工单最终 Closed，管理员每个工单 2 条独立通知；重复发送事件不重复入库，原监测状态仍 RECOVERED。
  - 两次工单：`fac901b5-d980-43a0-8abf-1eae6b9256c5` 和 `8194fcaa-d976-48fa-b954-229db4ad7b97`；第二次还验证临时 QA 接收人收到各自独立通知。
- `VOL.MES/tests/IoTSharpMes.E2E` 使用一次性 LocalDB 做包含原始报警链路的 **18 项 HTTP+SQL 断言**，全部通过（退出码0），覆盖工单 Close 乱序先于 Complete 的正确等待、两人通知及不影响监测状态；两套临时库成功清理。
- 发现并修复 SQL Server 不同客户端 `datetime2` 毫秒精度差导致的 Close 校验失败，现在工单身份/租户/设备/版本/序列仍严格校验，仅允许 CompletedAtUtc 毫秒表示差异不超过5ms。
- **2026-11-15 最新复核：IoTSharp 主工程完整 Debug 构建已通过，0 错误、195 警告、退出码 0（1 分 41 秒）。** 使用 Windows TEMP 下的独立 `OutDir`，没有关闭正在运行的开发服务。直接编译到默认 `bin/Debug/net10.0` 失败仅因本机 IoTSharp 开发服务（端口 5088、当时 PID 41208）锁定 DLL，报 `MSB3021/MSB3027`；未出现此前数字孪生源码编译错误。未修改用户的 3D 文件。

## 实际部署与未完成项

已通过的是**开发 SQL + IoTSharp 工单真实状态机 + MES 接收、幂等、消息落库**。新增 Vue 页面已经完成 SFC/消息 JS 编译，但人工维修通知的**登录浏览器/SignalR 两态弹窗**本轮因临时 QA 验证码登录未通过而未取得新一轮成功截图；不能算通过。原有自动报警的 Vue/SignalR 三态浏览器验收结果不等于维修工单两态验收。

正式使用前还需实际 PLC/设备维修场景、正式 HTTPS/证书、多实例发送/消费并发、工单角色权限审核。测试使用 `[DEV联调模拟]`，不发送真实 PLC/飞书通知，测试记录用于审计保留。

详细 MES 侧报告：`vol.api.sqlsugar/docs/IoTSharp_WorkOrderSync_Acceptance_20261115.md`。

## 2026-11-15 重复验收结果

- IoTSharp 集成单元测试 7/7 PASS；真实源状态机的维修工单专项工程编译 0 错误。
- MES 隔离 LocalDB HTTP/SQL 端到端测试 18/18 PASS，包含真实 HMAC、乱序、去重、异常/恢复、维修完成/关闭和双用户消息，临时数据库均已清理。
- 另外再次在 **IoTSharpPdmDev → 实际 9991 MES → netcoreserver_dev/netcore** 完成一张新的开发模拟维修工单：`35948ba3-ea83-47d8-9b17-02f4f7430712`，状态从 Assigned → InProgress → Completed → Closed，权限和 Revision 校验通过；2 个事件已送达、2 条管理员通知持久化，重复事件不会重复通知，原监测风险仍为 RECOVERED。
- 三张模拟维修工单的源 Outbox 合计 6 条 Delivered，MES Closed=3，相关通知/Inbox 无 Pending；全部测试结果另见 VOL 项目的最新报告。
- VOL Web `npm run build` 此次完整成功（3479 modules transformed，退出码 0），此前大项目构建超时的记录已更新。
- **补充浏览器验收（2026-11-15 12:12 北京时间）通过**：正常验证码/密码登录的临时 QA 用户在真实 Edge 页面中看到已关闭维修工单，SignalR 连接 `ws://localhost:9991/message`；IoTSharp 真实开发工单 `62384df0-3cc3-481d-97db-3c356280a673` 完成→关闭的两条事件在浏览器中分别产生绿色成功弹窗，测试退出码 0，无接口/JS 错误。再次打开其关联报警 `93c195ac-feef-4ae0-b1e7-9dbb46b1ad7b` 能看到 Closed 工单及 3 条监测事件。截图与详细日志在 VOL 项目的 `vol.api.sqlsugar/docs/IoTSharp_WorkOrderSync_Acceptance_20261115.md`。
- **开发环境 V1 核心功能流程验收已经全部通过**（含此前的 7/7 源端测试、18/18 MES LocalDB HTTP/SQL 回归、前后端构建、真实 SQL/HMAC 幂等、真实浏览器两态提醒）。现场真实 PLC、跨主机正式 HTTPS/证书、实际维修人员和多实例故障切换属于独立生产验收范围。
