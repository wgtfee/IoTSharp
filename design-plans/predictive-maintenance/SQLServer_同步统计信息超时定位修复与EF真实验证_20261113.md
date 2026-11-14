# IoTSharp PdM：开发 SQL Server 同步统计信息阻塞定位、受控修复与 EF Core 实测

日期：2026-11-13（开发服务器时间）
项目：H:\code\Industrial.Platform\IoTSharp-master
分支：Develop；HEAD 56fa1d63；未提交、未推送

## 结论

**开发 SQL Server 上的 P1-07 有界历史查询超时问题已复现、定位并通过定向统计信息维护解除。** 该结论针对实际 IOTSharp 数据库中的 TelemetryData_202609 物理分表及 EF Core 直连物理分表查询。**不包含** ShardingCore 跨分表路由、现场 UTC 合同或生产 1h/4h 长稳验收。

## 实际环境

- 连接来源：IoTSharp/appsettings.Development.json。
- SQL Server：DESKTOP-2ALRK02\MSSQ；数据库：IOTSharp。
- 实例：SQL Server 2019 Enterprise 15.0.2110.4，DB 状态 READ_WRITE。
- IoTSharp 与 TelemetryStorage 配置指向同一个开发库。
- dbo.TelemetryData_202609：约 26,925,431 行。
- 聚集主键：(DeviceId, KeyName, DateTime)，辅助非聚集索引：(DeviceId, DateTime)。
- 测试全程不输出 SQL 登录密码；密码仅在命令运行时经 SQLCMDPASSWORD 环境变量供 sqlcmd 使用。

## 根因证据

- 维护前：带设备、点位及半开 UTC 时间窗的 TOP(17) 查询两次出现 8～15 秒 SQL 超时。
- 不带复杂过滤的聚集索引 TOP(1) 读取约 0.09 秒，表连接本身正常。
- 在超时查询执行期间同步采集 sys.dm_exec_requests，发现任务 command = SELECT (STATMAN)，wait_type = CXPACKET，blocking_session_id = 0；这表明请求在自动统计信息计算阶段停顿，并非简单的其他会话阻塞。
- 数据库设置：is_auto_update_stats_on = 1；is_auto_update_stats_async_on = 0。
- 四项索引/自动统计信息上次刷新于 2026-09-17，记录当时 21,723,431 行，modification_counter 达 5,302,000。
- 因此同步自动统计信息更新与本次查询超时有强因果证据；目前未证明所有未来高延迟都来自同一原因。

## 实施动作

- 先核实目标实例/数据库、没有其他活跃执行请求。
- 在原开发库中只对 dbo.TelemetryData_202609 执行受控统计信息维护，参数 SAMPLE 1 PERCENT、MAXDOP 2、低锁等待优先级。未修改遥测业务行，未新增或删除索引，也未修改遥测写入链路。
- 维护耗时约 30.8 秒。
- 维护后四项统计信息记录均为 26,925,431 行、采样 276,842 行、modification_counter 为 0。
- 可复用的开发维护 SQL：tools/pdm-acceptance/provider/SqlServerDevStatsRefresh_20261113.sql。
- 为避免无谓重复维护，脚本后来增加实例/DB 校验、其他请求检查，以及修改量达到统计行数 10% 时才运行的防重复门禁（这部分追加时没有再次执行 UPDATE STATISTICS）。

## 真实数据库复测

| 检查 | 实测结果 |
|---|---|
| 维护前设备/点位/时间窗 TOP(17) | 8～15 秒超时 |
| 维护后相同查询模式 | **约 0.12 秒** |
| 维护后 SQL Server 逻辑读取 | **5 页** |
| SQL Server 物理读取 | **0 页** |
| TOP(17)，配置上限 16 | 返回 17 行，正确判为 OVER_LIMIT |
| 真实 EF Core 直连分表，首次运行 | **44 毫秒** |
| 真实 EF Core 独立程序迁移目录后再次运行 | **162 毫秒** |
| EF Core ToQueryString | 生成 SQL Server TOP，未查询 Value_String、Value_Json、Value_XML 或 Value_Binary |
| EF 结果行数与超限异常 | 17 行 / 16 上限，正确触发 TelemetryHistoryLimitExceededException |
| 原 P1-07 EFStorage/ShardingStorage 实现 | 本轮没有修改 |
| ShardingCore 跨分表扇出和物理路由 | **尚未实测** |
| 现场 UTC 时间约定 | **未核准，保持门禁关闭** |

真实 EF 复现工具：tools/pdm-sqlserver-live-probe/SqlServerLiveProbe.csproj（包含 Program.cs），仅接受显式 dev-readonly 参数、核验实例与库、只读抽取实际 DeviceId/KeyName/DateTime、调用现有 BoundedTelemetryHistoryQuery.Build，并核验 TOP/限量/大字段投影。该工具直接映射 202609 物理表，不冒充实际 ShardingCore 运行时验收。

复现命令：

    dotnet run --project tools/pdm-sqlserver-live-probe/SqlServerLiveProbe.csproj -c Debug --no-restore -p:BuildProjectReferences=false -- dev-readonly

## P2 / P3 SQL Server 迁移状态

- 已生成独立 P2-V001 和 P3-V001 SQL Server 建表草案，既有离线 SHA/SQLite 回滚测试仍然通过。
- 准备了 tools/pdm-acceptance/schema/SqlServerDevSchemaRollback_20261113.sql，用于仅在开发实例 tempdb 中开启事务、读取两个 schema 初始化脚本、核验八张表并回滚。
- **真实执行这份数据库 DDL 的请求被平台安全检查拦截。没有执行、没有创建表，也没有完成 SQL Server 实际事务回滚验收。**
- 不会通过更换命令或工具绕过安全拦截。P2/P3 schema 上线门禁仍待单独授权的 DBA 流程验收。

## 回归证据

- .NET 10 后端 build：0 错误（1 个警告）。
- 六线独立验收：27/27 通过（新 EF 探测工具单独运行，不计入 xUnit 数量）。
- P1：81/81；P2：80/80；P3：67/67。
- P0：.NET 5/5；Node 20/20。
- 合计自动化测试：**280/280 通过**，额外有真实 EF Core 开发 SQL Server 探测成功。
- 创建独立 probe 时，最初放在测试目录的子项目被默认文件 glob 编译，导致重复程序集特性错误；已移至 tools/pdm-sqlserver-live-probe，测试工程复测通过。
- IoTSharp.Data/ApplicationDbContext.cs 相对 HEAD 未修改；原采集、持久化、P1 适配、JSON DB、SonnetDB 未由本批编辑。
- 共享工作区数字孪生合约 index.ts 的 SHA 与上轮记录值出现并行变化，本轮未触碰或回滚；AGENTS.md、ClientApp/package.json、TwinManifestInspector.cs 仍匹配先前记录的基线。不能宣称整个共享脏工作树 hash 全部不变。

## 后续验收

1. 受控开发环境核验 ShardingCore EF 的真实物理分表路由、合并排序与跨分表 TOP(maxRows+1) 下推；确认不会出现扇出查询或超限时大量数据进入应用内存。
2. 与现场确认 telemetry DateTime 的 UTC 规范和设备点位/运行工况映射；避免直接把数据库中的 datetime2 无时区字段声明为已核准 UTC。
3. 建立每个大月分表统计信息的定期检查与变更量阈值提示；避免未来大量追加数据触发同步 STATMAN 耗时。
4. P2/P3 独立 metadata 表应走明确授权的开发 DBA 迁移/回滚流程（本次执行被安全检查拦截）。
5. 在真实数据库启用前仍需 1h/4h 协同长稳以及模型标注、IAM 和真实工单联调。

**最终判断：开发 SQL Server 上的单月物理分表有界查询阻塞已解除并有真实 EF Core 证据；全面 Provider/生产发布门禁尚未完成。**

