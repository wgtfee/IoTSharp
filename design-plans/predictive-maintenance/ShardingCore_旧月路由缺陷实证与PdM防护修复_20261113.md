# IoTSharp PdM — ShardingCore 跨月真实隔离运行与旧月份防护修复

日期：2026-11-13（北京时间）
项目：H:\code\Industrial.Platform\IoTSharp-master
Git：Develop / 56fa1d63，未 commit / push
阶段判断：**旧月路由缺陷已在真实 ShardingCore 隔离 SQLite 运行时复现，PdM 读操作已采用最小修复 fail-closed；并未恢复 SQL Server 所有历史月份的真实路由。**

## 一、本轮核心发现

### 1. 配置覆盖 2026 年 8 月时，真实 ShardingCore 跨月查询正常

独立工具 tools/pdm-sharding-sqlite-probe/ 使用实际工程的：
- ShardingDbContext
- TelemetryDataMonthRoute
- ShardingCore 7.10.2.1
- BoundedTelemetryHistoryQuery.Build
- SQLite 私有临时数据库（非 SQL Server、非生产 DB）

执行实际 ShardingCore 初始化，并在同一个私有 SQLite 中创建 TelemetryData_202608 与 TelemetryData_202609；插入 20 条跨月时序数据。查询从 2026-08-31 23:59:35 UTC 开始，跨越 9 月月初，数据结构与 IoTSharp 的 TelemetryData 一致。

实测：
- global Take(maxRows+1=17) 返回 17 行，耗时约 421～443 毫秒；
- 前 13 行属于 8 月，随后 4 行属于 9 月，排序和值序列一致；
- 业务行上限 16，调用 CompleteOrThrow 正确产生 TelemetryHistoryLimitExceededException；
- endExclusive 恰好为 2026-09-01 00:00 UTC 时只有 8 月 13 行；
- 查询从 2026-09-01 00:00 UTC 开始时只返回 9 月 7 行；
- 此隔离运行工具为真实 ShardingCore 执行，但仅使用 SQLite Provider；**不证明 SQL Server 的实际 SQL 执行计划、扇出或 UTC 契约已通过。**

### 2. 旧月份物理表存在，但起始路由晚于目标月份时无法自动查询

在相同私有 SQLite 文件中保持 202608、202609 物理表不变，以 ShardingBeginTime=2026-10-01 重建真实 ShardingCore 服务容器并重新执行 8/9 月的历史查询。

**实际抛出 ShardingCoreQueryRouteNotMatchException**，而不是发现既有旧表。

这证明仅凭 sys.tables / sqlite_master 能看到旧表，不等于运行时路由已经覆盖；也说明先前假设“配置只影响自动创建、不影响已有历史查询”是不安全的。

生产 ShardingCore DI 使用 ThrowIfQueryRouteNotMatch=false，可能会使某些未匹配情况返回空结果，因此 PdM 不能把该空结果解释成“设备历史正常且无故障”。

## 二、本轮最小源码修复

新增：IoTSharp.Data.TimeSeries/PdmMonthlyShardRouteGuard.cs
修改：IoTSharp.Data.TimeSeries/ShardingStorage.PdmBoundedHistory.cs（仅 PdM 有界历史读取入口）。

LoadTelemetryBoundedAsync 的新顺序：
1. 检查取消令牌；
2. 使用现有 BoundedTelemetryHistoryQuery.Validate 校验设备、点位、行数及 UTC 半开窗口；
3. 使用 PdmMonthlyShardRouteGuard.EnsureCovers 比较目标月份和配置路由起点；
4. **仅通过前述检查之后**才解析 ShardingDbContext 并发送实际有界查询；
5. 保留原来的 limit+1、数值列投影和超限拒绝机制。

当请求月份早于 ShardingBeginTime 所在月份时抛出 PdmHistoryRouteNotCoveredException，包含 requestedMonth、routeBeginMonth 和“不可信旧月份无法被当作无历史数据”的诊断信息。未修改：
- IoTSharp.Data/Shardings/Routes/TelemetryDataMonthRoute.cs 原有路由；
- AppSettings 默认起始月份；
- 原有采集和分表写入热链、Durable Spool；
- 主 ApplicationDbContext；
- 数字孪生、JsonDB、SonnetDB；
- 数据库结构、业务行和任何 PLC/MES 指令。

此修复优先防止**路由失败被误读为设备没有数据**。它没有自动向 ShardingCore 注册所有旧月份，也没有偷偷把 ShardingBeginTime 改回 2025 年（这样可能使 AutoCreateTableByTime 自动创建大量历史月表）。

## 三、本轮验证

新增测试：tools/pdm-acceptance/provider/PdmMonthlyShardRouteGuardTests.cs，6/6 通过：
- 月份早于路由起点，给出明确 fail-closed 异常；
- **真实 ShardingStorage.LoadTelemetryBoundedAsync** 在无任何 DbContext 注册的容器中，仍能先返回正确路由异常，证明不会先访问数据库；
- 显式路由覆盖 8 月及跨月查询可继续；
- 月初包含/不包含边界；
- 不可信非 UTC 输入拒绝；
- 非月分表模式不使用月路由特有检查。

隔离 ShardingCore 执行程序（单独运行，不计入 xUnit 数量）成功：
- ShardingCore 跨月 SQL 查询、全局行数排序、limit+1、超限异常；
- 已存在旧物理表但路由起点较晚时真实抛出路由不匹配；
- 新守卫在此状态下于开库前拒绝。

测试汇总：

| 验证 | 结果 |
|---|---|
| PdM Acceptance | **39/39 通过**（此前 33 + 本轮 6） |
| P3 | **67/67 通过** |
| P2 | **80/80 通过** |
| P1 | **81/81 通过** |
| P0 .NET | **5/5 通过** |
| P0 Node | **20/20 通过** |
| **累计自动化回归** | **292/292 通过** |
| 独立 SQLite/ShardingCore 真实路由测试 | **通过** |
| IoTSharp.Data.TimeSeries 项目单独编译 | **0 错误，15 警告** |
| IoTSharp 整站重新编译 | **被其他并行 3D 模块阻塞** |

完整 IoTSharp 后端 build 的错误仍为：
IoTSharp/Services/DigitalTwin/ActionFlow/TwinActionFlowServerCompiler.cs 第 151 行 CS0103，ValidPlanningRequest 不存在。与本次 PdM 更改无关，不属于本轮有权修改的数字孪生源码；未回滚、未修改它。

## 四、复现命令

从 Windows 工程根目录运行：

    dotnet build IoTSharp.Data.TimeSeries/IoTSharp.Data.TimeSeries.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false
    dotnet run --project tools/pdm-sharding-sqlite-probe/PdmShardingSqliteProbe.csproj -c Debug --no-restore -p:BuildProjectReferences=false -- isolated-sqlite
    dotnet test tools/pdm-acceptance/IoTSharp.PdM.Acceptance.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false
    dotnet test tools/pdm-p1/IoTSharp.PdM.P1.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false
    dotnet test tools/pdm-p2/IoTSharp.PdM.P2.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false
    dotnet test tools/pdm-p3/IoTSharp.PdM.P3.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false
    dotnet test tools/pdm-p0/IoTSharp.PdM.P0.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false
    node --test tools/pdm-p0/replay.test.mjs tools/pdm-p0/security-time-contract.test.mjs

隔离运行工具显式要求参数 isolated-sqlite，使用新建的随机临时 SQLite 文件，结束时清理。该运行会在私有 SQLite 文件里自动建表和插入合成数据，不允许把它改成开发/生产 SQL Server 连接字符串运行。

## 五、仍需解决的发布门禁

1. SQL Server **真实 ShardingCore 跨月**：此前运行时跨月 SQL 测试被安全检查拦截，不能通过改造请求绕过。需要获准的隔离只读部署或正式 DBA 验收路径，抓实际 Physical Table 路由和执行计划。
2. 历史路由恢复：如果确实要查询 2026 年 8 月等旧月数据，必须在受控环境验证 ShardingBeginTime 的显式历史覆盖范围、旧表发现、物理表存在性和 AutoCreateTableByTime 对缺月表的影响，防止擅自生成额外表。
3. 跨表 SQL 性能、单表/全局 TOP 下推、真实 Provider 取消时延和 UTC 时间契约，仍需 SQL Server/PostgreSQL/InfluxDB 分别验证。
4. 整站构建需并行负责数字孪生的任务修复 ValidPlanningRequest 编译错误，本轮没有修改该文件。
5. P2/P3 独立 SQL Server schema 真实迁移/回滚此前被平台安全检查拦截，仍未获批。
6. PdM Worker 仍为默认关闭，无生产模型、自动工单或 PLC 控制启用。

**阶段结论：旧月份路由不可见的根因在 ShardingCore 隔离运行时得到实证，本轮完成了 PdM fail-closed 防护和 292 项回归；老表实际可用化与生产级 SQL Server 跨月性能尚未验收。**

