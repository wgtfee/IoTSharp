# IoTSharp PdM 历史旧月份只读恢复 —— 隔离 ShardingCore 验收报告

日期：2026-11-14（北京时间）
Windows 工作区：H:\code\Industrial.Platform\IoTSharp-master
Git 分支：Develop；HEAD：56fa1d63；未执行 Git commit / push

## 阶段结论

**安全、独立的 ShardingCore 旧月分表只读恢复路径已实现，并在真实 ShardingCore + 私有 SQLite 测试库中执行成功。** 未修改全局写入路由或打开 PdM Worker。SQL Server 物理跨月路由尚未实际验收；SQL Server 的只读表清单/独立运行时已经写成组件，但没有连接开发或生产数据库执行本轮跨月测试。

## 已实现的代码

1. IoTSharp.Data.TimeSeries/PdmReadOnlyTelemetryMonthRoute.cs：继承现有 TelemetryDataMonthRoute，专用于 PdM 私有读容器，强制 AutoCreateTableByTime() = false。全局路由不变。
2. IoTSharp.Data.TimeSeries/PdmHistoricalMonthlyReadPlanner.cs：由显式审批时间段、UTC 半开查询窗口、真实存在的目标物理月表清单以及元数据采集时刻生成不可写的独立路由计划。仅允许 <=60 分钟、最多两个月、最近 24 个月、5 分钟内新鲜表清单；缺表、时区/授权边界异常、来源过期均拒绝。
3. IoTSharp.Data.TimeSeries/PdmHistoricalReadOnlyShardingRuntime.cs：为已验证计划创建**独立 ShardingCore 服务容器**，只使用 PdM 不自动建表的路由；不调用 UseAutoTryCompensateTable / EnsureCreated / Migrations，保留原 P1-07 的数据库端 Take(maxRows+1)、数值投影、取消令牌和超限拒绝。SQLite 测试连接以 ReadOnly 打开，SQL Server 连接带 ApplicationIntent.ReadOnly；数据库账号本身仍须采用 SELECT-only 最低权限。该运行时尚未注入主 Startup。
4. IoTSharp.Data.TimeSeries/PdmSqlServerHistoricalTableInventory.cs：SQL Server 只读 sys.tables 查询，精确参数化检查 dbo 下 1～2 张目标月表，拒绝未经许可的时间段，不支持 DDL。**本轮未实际连接 SQL Server 运行此新组件。**
5. tools/pdm-acceptance/provider/PdmHistoricalMonthlyReadPlanTests.cs：8 项规划/月份/物理表/过期/时区/审批准入/禁止自动建表测试。
6. tools/pdm-acceptance/provider/PdmSqlServerHistoricalTableInventoryTests.cs：3 项请求边界测试，确保非法 UTC、未批准窗口、提前取消在任何 SQL 连接前被拒绝。
7. tools/pdm-sharding-sqlite-probe/Program.cs：真实 ShardingCore 独立 SQLite 月分表恢复和完整数据/超限/无新增表验证。

## 真实隔离 ShardingCore 执行证据

使用随机临时 SQLite 数据库、实际 ShardingDbContext + ShardingCore 7.10.2.1：

- 由独立测试上下文生成 TelemetryData_202608、TelemetryData_202609，并跨月插入 20 条测试数据。
- 正常开始月份设置为 202608 时，UTC 半开窗口及排序一致；全局 Take(17) 前 13 条为 8 月、后 4 条为 9 月，超限拒绝成功。
- 将独立容器路由起点改成 202610，即使旧物理表存在，ShardingCore 仍抛 ShardingCoreQueryRouteNotMatchException；PdM 原有旧月份预检查可以在开库前拒绝。
- **恢复路径**：从经过审核的新鲜物理表清单生成历史读计划，在独立读容器注册不自动建表的专用路由，起点设为 202608；不调用自动补表方法，查询重新可见。
- 独立 PdM 只读运行时实际读取跨月完整 20 行，数值投影为 double；配置业务上限 16 时触发 TelemetryHistoryLimitExceededException，不允许将截断窗口评分。
- 读取前后私有 SQLite 的物理表名单完全一致，没有新增历史空表，过程中没有使用 SQL Server、PLC、MES 或真实工单。
- 最终独立运行输出：StandalonePdmReadOnlyRuntime=PASS；AllRows=20；NumericProjection=True；OverflowRejected=True；ReadOnlyRecoveryNoAdditionalTables=PASS。

## 本轮验收汇总

| 范围 | 实际结果 |
|---|---:|
| 本轮新增只读路由规划、安全和连接前阻断测试 | 11/11 |
| 累计 PdM 验收测试 | **50/50 通过** |
| P3 xUnit | 67/67 通过 |
| P2 xUnit | 80/80 通过 |
| P1 xUnit | 81/81 通过 |
| P0 .NET | 5/5 通过 |
| P0 Node | 20/20 通过 |
| **全部自动化测试** | **303/303 通过，0 失败** |
| 真正 ShardingCore 隔离 SQLite 跨月恢复运行 | **通过（独立 CLI，不计入 xUnit）** |
| IoTSharp.Data.TimeSeries 单独编译 | **0 错误、15 警告** |
| IoTSharp 全后端重新编译 | **0 错误、71 警告** |

上一轮完整编译出现的数字孪生 ValidPlanningRequest 错误，此次重新编译没有再出现；未修改数字孪生文件，不能归因于本轮 PdM 代码。

## 重要保护边界与未完成事项

- **没有为主 IoTSharp Startup 注册新 PdM 历史读取运行时，也没有修改现有 ShardingCore 采集路由/历史表写入/JsonDB/SonnetDB/主 ApplicationDbContext。**
- 这是具备只读运行能力但尚未正式接入主 Worker 的独立组件，不代表 P1-07 的生产历史恢复已经开启。
- SQL Server 实际跨月路由/查询执行计划、读取限量下推、权限及取消延迟仍需正式受控验收。上一轮 SQL Server 跨月执行被平台安全检查拦截，本轮没有绕过或重试。
- SQL Server 元数据读取器是新代码，已有连接前校验单测，但尚无开发库的真实 SQL Server 元数据访问证据；未来必须使用 SELECT-only 身份及受控环境。
- SQL Server 大表统计信息维护和单月 EF 读取属于**上轮已有的实测证据**，不能自动证明本轮历史跨月通路性能。
- UTC DateTime 合同、现场点位审核、1h/4h 百万点长稳和真实故障标签/工单流程未在本轮验收；生产 PdM Worker 仍关闭。
- 源工程里其他并行 3D/digital twin 的脏文件保留，不回滚、不覆盖。
- 没有数据库结构变更，未执行生产或开发 SQL Server DDL/DML；没有 Git 提交/推送。

## 复现命令（Windows 工程根目录）

    dotnet build IoTSharp.Data.TimeSeries/IoTSharp.Data.TimeSeries.csproj -c Debug --no-restore -p:BuildProjectReferences=false -v:q
    dotnet run --project tools/pdm-sharding-sqlite-probe/PdmShardingSqliteProbe.csproj -c Debug --no-restore -p:BuildProjectReferences=false -- isolated-sqlite
    dotnet test tools/pdm-acceptance/IoTSharp.PdM.Acceptance.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false -v:q
    dotnet test tools/pdm-p3/IoTSharp.PdM.P3.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false -v:q
    dotnet test tools/pdm-p2/IoTSharp.PdM.P2.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false -v:q
    dotnet test tools/pdm-p1/IoTSharp.PdM.P1.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false -v:q
    dotnet test tools/pdm-p0/IoTSharp.PdM.P0.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -v:q
    node --test tools/pdm-p0/replay.test.mjs tools/pdm-p0/security-time-contract.test.mjs
    dotnet build IoTSharp/IoTSharp.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false -v:q

**下一步建议**：在经授权的独立 SQL Server 只读账号/测试库中进行 ShardingCore 月路由、sys.tables 精确清单、物理查询计划与超限/取消的真实联动验收；通过后，再评估为 PdM Shadow Worker 增加明确开关的只读恢复接入，不能提前打开生产功能。

