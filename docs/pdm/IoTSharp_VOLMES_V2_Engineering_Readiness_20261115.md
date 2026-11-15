# IoTSharp → VOL.MES V1 之后的工程化加固

日期：2026-11-15。基于 `IoTSharp_WorkOrder_VOLMES_V1_Acceptance.md`，保留报警/恢复/维修完工/关闭的原有业务协议、发送回执与 MES EventId 幂等，不重复开发 V1。

## V2 针对多实例的增量

- `PdmMesOutboxWorker` 与 `PdmWorkOrderMesOutboxWorker` 各自在原有独立 SQL Server PdM 库使用会话级 `sp_getapplock`。会话锁按队列隔离，`LockTimeout=0` 时抢占失败直接跳过本轮，无并发双发同一 Pending 批次。
- 持锁连接跨 HTTP 投递保持打开，但不跨请求持有长事务；正常结束释放会话锁，物理连接中断由 SQL Server 释放。释放锁失败必须清除 ADO.NET 连接池对应的物理连接，不能只依靠逻辑 `Close`。
- 未知 HTTP 结果仍重试同一个稳定 `EventId`，MES 持久化 Inbox 负责幂等；不能将此次改进宣传为精确一次发送。
- 监测风险恢复与人工维修完成/关闭仍是独立状态机，所有原有正式启用门禁保持不变。
- **未解除 IoTSharp P1 的 `SingleInstanceAcknowledged` 门禁**：这个锁只覆盖 MES 发送侧，未实现完整多实例预测性维护计算。生产双实例 P1 切换前仍需独立设计。

## 只读巡检

在已核验的 `IoTSharpPdmDev` 或经授权的 PdM 独立数据库连接上执行 `IoTSharp_VOLMES_QueueHealth_ReadOnly.sql`，查看两个 Outbox 的 Pending / Delivered / ManualReview、最老事件、重试次数及索引。旧版 `sqlcmd` 使用 `-f 65001` 以正确读取中文 UTF-8 注释，例如 `sqlcmd -f 65001 -S DESKTOP-2ALRK02\MSSQ -d IoTSharpPdmDev -E -b -i docs/pdm/IoTSharp_VOLMES_QueueHealth_ReadOnly.sql`。不要直接更改失败状态来强迫重投，不自动清理历史审计。

建议初始监控阈值：任一 `ManualReview > 0`、最老 Pending 超过 15 分钟、ReadyCount 连续 10 分钟增长、连续 HTTP / SQL 错误。阈值只是待压测的初始建议，不能代替实际负载基线。

接收侧 `VOL.MES` 的收件人绑定撤销拦截、Inbox/通知消费锁及 DBA 生产门禁，详见 `vol.api.sqlsugar/docs/IoTSharpIntegration_ProductionReadiness_20261115.md`。正式配置必须 HTTPS 且使用安全密钥源，不随代码提交真实密钥。

## 上线前未完成的现场验证

需要生产维护窗口、数据库备份、正式证书及 HMAC 轮换、SQL Server 故障切换、多主机 SignalR 路由、重启后消息恢复和断网补偿长稳、真实维修角色及 PLC 现场验收。现有 `NU1903` 安全依赖告警（含 `Microsoft.OpenApi` 等）需独立 SBOM/许可证及版本评审，不在本轮擅自更换基础组件。开发 LocalDB 与开发 SQL Server 的通过结果，不能直接视为生产上线批准。

本轮 IoTSharp 完整 Debug 独立输出编译 0 错误、195 警告；MES 集成单元测试 7/7 通过。源端两条队列只读巡检已在开发 SQL Server 实际运行成功。

## 对标渐近线科技 Vision X（研究建议，不修改 3D）

公开介绍中的 Vision X 着重**三维工厂设计 → 仿真验证 → 软件生成/虚拟调试 → 生产运行与瓶颈分析**。与当前 IoTSharp + VOL.MES + WCS 项目比较，最值得分阶段借鉴的是：

1. 为 WCS 已有组件、动作编排增加**可重复的离线验收用例与预期事件轨迹**，不改变当前 3D 引擎及 ActionFlow。
2. 将模型中的生产节拍、拥堵、故障注入、恢复耗时与 IoTSharp/MES 事件关联，先做只读的回放及瓶颈分析。
3. 只在明确隔离的虚拟设备适配层验证 PLC/IO 逻辑，不自动下发真实 PLC，也不让仿真任务绕过既有审批和业务门禁。

以上只是可借鉴方向，未证明 Vision X 产品具有公开 SDK、MCP 接口、PLC 兼容清单或代码生成的具体可移植能力；这些需取得厂商技术资料或可操作的试用版本后另行核实。本轮不对 WCS/3D 做变更。
