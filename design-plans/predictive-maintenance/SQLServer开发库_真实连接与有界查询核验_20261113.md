# IoTSharp PdM：开发 SQL Server 真实连接与查询验收

核验日期：2026-11-13
工作区：H:\code\Industrial.Platform\IoTSharp-master
分支：Develop，HEAD：56fa1d63

## 实际连接

- 来源：IoTSharp/appsettings.Development.json，DataBase=SQLServer。
- 实例：DESKTOP-2ALRK02\MSSQ；库：IOTSharp。
- IoTSharp 与 TelemetryStorage 连接均指向这个库。
- 实测：SQL Server Enterprise 15.0.2110.4；数据库 READ_WRITE。
- 密码未在命令行、stdout、报告中输出，只经短生命周期 SQLCMDPASSWORD 传入 sqlcmd。
- 本轮所有 SQL 数据库访问只读，不曾创建/修改/删除业务表。

## 数据规模与索引

真实 SQL Server sys.partitions 近似行数：
- dbo.TelemetryData：0
- TelemetryData_202507：0
- TelemetryData_202508：0
- TelemetryData_202607：0
- TelemetryData_202608：0
- TelemetryData_202609：26,925,431

202609 分表包含 DeviceId(uniqueidentifier)、KeyName(nvarchar(900)、DateTime(datetime2)、Type、Value_Boolean、Value_Long、Value_Double，另有 JSON/XML/Binary 等潜在大对象字段。

- 聚集唯一 PK：DeviceId, KeyName, DateTime。
- 非聚集索引：DeviceId, DateTime。
- P2/P3 独立 Pdm 表未在当前库发现，不能标记独立迁移为通过。

## 只读执行结果

1. 实例身份、表列表、列类型、索引、规模元数据：通过。
2. 在真实 2692 万行月分表上执行聚集索引 TOP(1) ：0.09 秒，成功。
3. 针对真实设备与点位的 TOP(17) 半开 UTC 历史窗口查询：首次 SQL 15 秒超时。
4. 缩小至 5 分钟时间窗并使用聚集索引提示及仅为诊断的 NOLOCK：仍 SQL 8 秒超时。
5. 两次有界查询都没有可靠的行数和逻辑读结果，不能算通过。NOLOCK 也不适合正式 PdM 数据质量判断。
6. 202609 聚集主键和辅助索引统计信息最后更新于 2026-09-17，统计行数 21,723,431，当前修改计数 5,302,000；统计信息陈旧值得排查，但尚未证明是超时原因。
7. DMV 简单读取成功，诊断时没有其他已暴露的本库执行请求；尚未完成查询时等待/阻塞和实际执行计划抓取。

## 下一步开发与验收

- 用真实执行计划和查询期间等待信息定位是编译/自动统计更新、锁等待、物理分片扇出，还是扫描或排序导致超时。
- 核验 P1-07 EF 查询在真实 ShardingCore 月分表上的 TOP(maxRows+1) 下推、取消超时和只读投影；与直接物理表查询分别测量。
- 经开发环境 DBA 或明确的维护安排后再考虑更新统计信息、针对 DeviceId/KeyName/DateTime 建覆盖索引；本轮没有运行任何索引维护或更新语句。
- P2/P3 SQL Server 表仍需在明确的隔离迁移方案中实施，不应直接修改主 ApplicationDbContext。
- 真正 1h/4h 百万点协同长稳尚未执行，生产 Worker 仍保持关闭。

## 结论

**开发 SQL Server 的真实连接已核验通过。实际有界历史查询超时，SQL Server 性能和分片查询门禁暂不通过。**

