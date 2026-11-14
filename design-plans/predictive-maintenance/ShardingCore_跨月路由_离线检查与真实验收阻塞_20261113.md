# IoTSharp PdM：ShardingCore 月分表路由与跨月边界验证（下一轮）

日期：2026-11-13（开发机北京时间）
项目：H:\code\Industrial.Platform\IoTSharp-master
Git：Develop / 56fa1d63，未提交和推送

## 结论

**本轮已完成 ShardingCore 真实月路由对象的离线配置检查、跨月 UTC 边界验证和六项新增自动化测试。开发库中实际的 ShardingCore 跨表 SQL 尚未验证通过，因此 P1-07 全量真实 Provider 放行门禁仍然关闭。**

已在上一轮实测成功的内容继续有效：SQL Server 开发库 IOTSharp 中 202609 分表约 26,925,431 行，定向统计信息维护后，同一物理月表直连 EF Core 的 limit+1 查询返回 17 行，对 limit 16 正确超限，耗时约 44～162 毫秒。不能把这些结果推导成 ShardingCore 运行时跨月路由已经通过。

## 1. 核实的实际路由配置

- 工程配置 DataBase=SQLServer、TelemetryStorage=Sharding。
- 路由使用 IoTSharp.Data/Shardings/Routes/TelemetryDataMonthRoute.cs，继承 ShardingCore 按月 DateTime 虚拟路由，ShardingProperty 为 TelemetryData.DateTime。
- AppSettings.ShardingByDateMode 默认 PerMonth。
- AppSettings.ShardingBeginTime 在未设置时默认取当前 UTC 时间减 1 个月；从 2026 年 11 月运行来看为 2026 年 10 月的日期。
- 2026 年 9 月实际物理表 TelemetryData_202609 存在且含约 2692 万行，因此**较早月份是否能在 ShardingCore 运行时被自动发现**需要真实路由测试，不能仅凭物理表可读推断。
- TelemetryDataMonthRoute.AutoCreateTableByTime() 返回 true，ShardingCore 配置中的 ThrowIfQueryRouteNotMatch=false；因此不能为了测试而在开发业务库中随意启动独立 ShardingCore 上下文，避免不受控地自动建表或把未路由结果当作“没有遥测”。
- P1-07 的 ShardingStorage.PdmBoundedHistory.cs 使用 DeviceId、KeyName、>= beginUtc、< endUtc、OrderBy DateTime/KeyName、Take(maxRows+1)，最后检查超限。实际跨分表是否按月下推、是否发生多分表聚合并未获得生产级证据。

## 2. 本轮代码和测试

- 新增 tools/pdm-acceptance/provider/MonthlyShardingRouteAuditTests.cs：只读/纯函数的月份覆盖预检，验证最多 60 分钟的 UTC 半开窗口、跨月份生成两张物理表、endExclusive 恰好在月初时不多查一张表、缺表拒绝、历史月份早于路由配置起点时返回 RouteStartCoverageUnverified。
- 新增 tools/pdm-acceptance/provider/RealShardingRouteConfigurationTests.cs：通过测试服务提供器构造**工程真实 TelemetryDataMonthRoute 类**，验证显式 ShardingBeginTime 和默认起始时间；没有启动真实 ShardingCore 宿主或执行 SQL。
- 新增 tools/pdm-acceptance/provider/SqlServerCrossMonthReadOnly_20261113.sql：两张指定的 202608/202609 开发物理表、DeviceId+KeyName+UTC 范围约束；单表限量和联合后全局限量。仅作为受控只读审查脚本。
- 实际跨月 SQL 最初错误地只按日期过滤，因缺少 DeviceId/KeyName 聚集索引前导列发生超时；这是**测试 SQL 自身的缺陷**，不能归因于 ShardingCore。已修复索引前导过滤和联合全局上限，但是**修复后的数据库执行被平台安全检查拦截，尚无新的真实跨月查询耗时和结果**。
- 没有修改 ShardingStorage、BoundedTelemetryHistoryQuery、TelemetryDataMonthRoute、ApplicationDbContext 或遥测写入热链。

## 3. 实际回归

| 验证范围 | 实际结果 |
|---|---|
| 新增路由边界、真实月路由对象配置 | 6/6 通过 |
| 六线验收工程累计 | 33/33 通过 |
| P3 xUnit | 67/67 通过 |
| P2 xUnit | 80/80 通过 |
| P1 xUnit | 81/81 通过 |
| P0 .NET | 5/5 通过 |
| P0 Node | 20/20 通过 |
| 总计 | **286/286 通过** |

这些测试通过是在使用之前已构建的项目引用、BuildProjectReferences=false 的隔离验证条件下获得；不得将其视为当前共享工作树所有项目均能从零编译。

本轮完整 IoTSharp 后端 build **失败**：IoTSharp/Services/DigitalTwin/ActionFlow/TwinActionFlowServerCompiler.cs 约 151 行调用了不存在的 ValidPlanningRequest，CS0103。此错误位于并行修改的 3D/动作编排模块，和 PdM 查询无关。按照用户约束，本轮没有修改、回滚数字孪生相关源码。需对应任务修复后再进行整站 build 及 E2E 验收。

## 4. 准备下一阶段真实路由验收

1. 取得能禁止 DDL 的**真正 SQL Server 只读账号**或隔离镜像后，再启动 ShardingCore 真实路由进行 202608->202609 的跨月 UTC 窗口查询。必须同时抓真实 SQL 命令、物理表名单、每表/总行数、SQL 逻辑读/耗时和取消测试；明确是否实际发生 fanout。
2. 在运行上下文明确配置 ShardingBeginTime 的历史覆盖下界，验证较早 TelemetryData_202609 是否可被路由发现。不要直接把月路由配置起点调回 2025 年就运行自动建表，可能创建不需要的历史空表。
3. 检查两级 TOP(maxRows+1) 严格全局上限。如果跨表路由不能保证限量，P1-07 的 PdM Worker 继续 fail-closed。
4. 继续保留 DateTimeKind.Utc/UTC 合同与工况/点位人工审核门禁。
5. P2/P3 SQL Server 独立表 DDL 的真实执行在前一轮被平台安全检查拦截，本轮未执行任何建表或修改 SQL。

**验收结论：月路由配置和 UTC 跨月边界自动化检查通过；真实 SQL Server ShardingCore 跨月路由未通过验收，不能开启生产 Worker。**

