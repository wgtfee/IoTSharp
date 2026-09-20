# IoTSharp 百万点遥测数据流性能优化与下一阶段优化方案 V2

> 文档状态：V2
> 适用项目：IoTSharp / IoTGateway
> 更新时间：2026-09-17
> 目标范围：遥测数据流、持久化、流控、SQL Server 高吞吐、多数据库 Provider 优化、集群与容量规划
> 非目标范围：SonnetDB 专项优化、3D/数字孪生业务逻辑、前端页面性能优化

---

# 1. V2 修订说明

V2 相比 V1 的核心修订不是增加几个数据库名称，而是重新定义“已完成”的口径。

必须明确区分三种状态：

```text
A. 已完成并经过真实百万点/持久化验收
B. 已兼容新架构，但还没有完成 Provider 专属深度性能优化
C. 规划阶段，尚未实现
```

当前真正达到 A 级完成度的数据库写入链路主要是：

```text
SQL Server
+ Sharding
+ PerMonth
```

PostgreSQL、InfluxDB、IoTDB、Taos/TDengine、MySQL、Oracle、SQLite 当前不能表述为“已经完成与 SQL Server 同等级别的百万点优化”。

它们当前主要处于：

```text
存储接口兼容
Latest / History Split 适配
Composite Storage 兼容
Provider 原有路径保持可用
```

但是还缺少各自数据库原生的高吞吐 Writer、Durable Spool 全量接入、百万点真实 E2E、重启恢复和精确落库验收。

因此 V2 统一使用以下术语：

- **兼容**：新架构不会破坏该 Provider，功能可以继续工作。
- **优化**：使用该 Provider 原生高性能能力进行了专属写入优化。
- **完成**：优化已经通过真实 E2E、精确数据量、故障恢复和性能测试。

---

# 2. 当前真实完成度矩阵

## 2.1 总体状态

| 能力 | SQL Server | PostgreSQL | TimescaleDB | InfluxDB | IoTDB | Taos/TDengine | MySQL | Oracle | SQLite |
|---|---|---|---|---|---|---|---|---|---|
| Latest / History 分离接口 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Composite Storage 兼容 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| History / Latest 可选存储 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Persistence Lag 架构 | ✅ | ✅ 架构可用 | ✅ 架构可用 | ✅ 架构可用 | ✅ 架构可用 | ✅ 架构可用 | ✅ 架构可用 | ✅ 架构可用 | ✅ 架构可用 |
| Gateway Flow Control | ✅ | ✅ 通用 | ✅ 通用 | ✅ 通用 | ✅ 通用 | ✅ 通用 | ✅ 通用 | ✅ 通用 | ✅ 通用 |
| Durable History Spool | ✅ 已接入并实测 | ❌ 未通用接入 | ❌ 未通用接入 | ❌ 未通用接入 | ❌ 未通用接入 | ❌ 未通用接入 | ❌ 未通用接入 | ❌ 未通用接入 | ❌ 未通用接入 |
| Provider 原生 Bulk Writer | ✅ SqlBulkCopy | ❌ | ❌ | 部分原 Provider 能力，未专项验收 | ❌ Tablet 专项未做 | ❌ Batch 专项未做 | ❌ | ❌ | ❌ |
| Provider 专属事务调优 | ✅ 50k 实测 | ❌ | ❌ | 不适用关系型事务模型 | ❌ | ❌ | ❌ | ❌ | ❌ |
| 热/冷索引生命周期 | ✅ 可选模式 | ❌ | ❌ | 不适用同类模型 | 不适用同类模型 | 不适用同类模型 | ❌ | ❌ | ❌ |
| Duplicate 高速幂等 fallback | ✅ | ❌ 等价方案未完成 | ❌ | Provider 模型不同 | Provider 模型不同 | Provider 模型不同 | ❌ | ❌ | ❌ |
| 百万点真实 E2E | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 重启恢复 E2E | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| 精确 SQL/TSDB 落库计数验收 | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |

## 2.2 当前结论

必须明确：

> 当前“百万点完整验收基线”是 SQL Server，不是所有数据库。

当前多数据库方面已经完成的是：

```text
架构兼容
接口拆分
Provider 可插拔
History / Latest 可组合
公共流控框架
```

还没有完成的是：

```text
各 Provider 原生 Bulk Writer
各 Provider Durable History Lane
各 Provider 百万点 E2E
各 Provider 崩溃恢复测试
各 Provider 数据精确性验收
```

---

# 3. 当前数据流真实架构

当前已经形成两层架构。

## 3.1 通用实时链路

```text
IoTGateway
   ↓
MQTT
   ↓
IoTSharp Broker
   ↓
TelemetryIngestPipeline
   ↓
CAP / EventBus
   ↓
EventBusSubscriber
   ↓
Latest / Rule / History Storage Abstraction
```

这一层是多数据库架构，不应绑定 SQL Server。

## 3.2 当前 SQL Server Durable History 快路径

当前 durable spool 的完整生产级实现和 E2E 验证主要针对：

```text
SQLServer
+ Sharding
+ PerMonth
```

真实路径：

```text
CAP Consumer
   ↓
Durable History Spool
   ↓
Latest Storage
   ↓
Rule / Event
   ↓
Consumer 完成

Durable Spool
   ↓
Background History Worker
   ↓
ShardingSqlServerBatchWriter
   ↓
SqlBulkCopy
   ↓
TelemetryData_yyyyMM
```

注意：

```text
当前不能把上面的 Durable Spool → History Provider
描述成所有 Provider 已经通用接入。
```

目标架构应改造成第 10 章所述的 Provider 通用 Durable History Queue。

---

# 4. 已完成并验收的 SQL Server 优化

## 4.1 Latest / History 解耦

原来：

```text
CAP
→ Latest
→ History SQL
→ 全部完成后 Consumer 才结束
```

现在：

```text
CAP
→ History Durable Boundary
→ Latest
→ Rule
→ Consumer 可完成
```

History 进入后台 Persistence Lane。

拆分接口：

```csharp
StoreTelemetryLatestBatchAsync(...)
StoreTelemetryHistoryBatchAsync(...)
StoreTelemetryHistoryRowsAsync(...)
```

收益：

- 实时 Latest 不再绑定 History 写盘速度；
- Rule 不再长时间等待 History；
- 后续 Provider 可以拥有独立 History Writer；
- 为跨数据库 Latest / History 组合提供基础。

---

## 4.2 SQL Server Durable History Spool

当前采用 Atomic File WAL。

```text
History Batch
   ↓
.tmp
   ↓
Flush(true)
   ↓
SHA256
   ↓
原子 rename
   ↓
<sha256>.pending
```

数据库成功后：

```text
pending
→ SQL Commit
→ 删除 pending
```

失败：

```text
SQL 失败
→ pending 保留

进程退出
→ pending 保留

重启
→ 扫描 pending
→ 自动继续 drain
```

真实验证：

```text
发送 200,000
pending=2 时停止 1888
停止后 pending=2
重启后不重新发送
pending 自动归零
SQL 精确 +200,000
```

---

## 4.3 SQL Server BulkCopy 快路径

```text
TelemetryData
   ↓
按月分片
   ↓
稳定排序
   ↓
50k Transaction
   ↓
SqlBulkCopy
   ↓
Commit
```

关键参数：

```text
HistoryBulkCopyBatchSize = 50,000
TelemetryHistoryTransactionRows = 50,000
允许范围 = 1,000 ~ 250,000
```

真实热态基准：

| Transaction Rows | 30 万耗时 | Rows/s |
|---:|---:|---:|
| 25k | 3040.5 ms | 98.7k |
| 50k | 2555.5 ms | 117.4k |
| 100k | 2636.5 ms | 113.8k |

因此默认选 50k。

---

## 4.4 History 直接 TelemetryData Reader

旧路径：

```text
TelemetryData
→ SqlServerTelemetryRow
→ object 装箱
→ BulkCopy
```

新路径：

```text
TelemetryData
→ IDataReader
→ SqlBulkCopy
```

100 万点计划阶段：

```text
524 ms → 100 ms
259.8 MB → 3.8 MB
```

Allocation 下降约 98.5%。

随后又进一步把：

```text
List<int>
→ ToArray()
```

改成：

```text
精确 int[]
→ 原地填充
→ 原地排序
```

减少二次索引数组复制。

---

## 4.5 Duplicate 幂等 fallback

正常路径：

```text
直接 BulkCopy
```

遇到 SQL Server：

```text
2601
2627
```

只对当前 chunk 进入：

```text
Temp Table
+ NOT EXISTS
+ Idempotent Insert
```

不让极少量重复污染全部正常写入路径。

8 种类型重复写验证通过：

```text
Boolean
String
Long
DateTime
Double
JSON
XML
Binary
```

同一批写两次后仍然只有预期行数。

---

## 4.6 热月索引模式

当前支持：

```text
TelemetryHistoryShardIndexMode
```

模式：

```text
ProviderDefault
WriteOptimizedHotShard
```

SQL Server 独立 A/B：

```text
30 万 History
ProviderDefault = 7.332s
WriteOptimizedHotShard = 2.875s
```

提升约 60.8%。

该模式不作为全局默认，因为：

```text
keys=all
```

等查询可能仍依赖 `(DeviceId, DateTime)`。

---

# 5. 已完成的通用多数据库架构能力

这一章只描述“通用架构能力”，不代表各数据库百万点已经验收。

## 5.1 Composite Storage

支持将：

```text
Latest
History
```

分配到不同存储。

例如：

```text
Latest → SQL Server
History → InfluxDB
```

或者：

```text
Latest → PostgreSQL
History → IoTDB
```

或者：

```text
Latest → SQL Server
History → Taos
```

架构目标：

```text
Telemetry Pipeline
       │
       ├── Latest Storage
       └── History Storage
```

---

## 5.2 History / Latest Split Interface

公共层已经能够区分：

```text
Latest Batch
History Batch
Materialized History Rows
```

这让后续不同 Provider 可以单独优化自己的 History Writer，而不用修改实时链路。

---

## 5.3 多数据库连接串兼容

支持：

```json
"ConnectionStrings": {
  "IoTSharp": "...",
  "TelemetryStorage": "..."
}
```

优先：

```text
TelemetryStorage
```

缺省时：

```text
fallback → IoTSharp
```

从而兼容：

- 旧客户单库部署；
- 新客户独立 Telemetry 数据库部署。

---

## 5.4 Flow Control 属于通用数据流能力

Gateway Flow Control 不应只服务 SQL Server。

目标压力来源应统一为：

```text
Provider backlog
Durable queue age
Persistence latency
Disk pressure
Provider error rate
```

因此 PostgreSQL、InfluxDB、IoTDB、Taos 接入统一 Durable Queue 后，可以继续使用同一套 Flow Control。

---

# 6. 当前还没有完成的 PostgreSQL 优化

PostgreSQL 下一阶段不能继续使用“普通 EF 大批量 SaveChanges”作为百万点 History 最终方案。

## 6.1 目标快路径

推荐：

```text
TelemetryData
   ↓
按分区 / 时间范围分组
   ↓
Npgsql Binary COPY
   ↓
PostgreSQL
```

核心能力：

```text
COPY ... FROM STDIN (FORMAT BINARY)
```

对应关系：

```text
SQL Server → SqlBulkCopy
PostgreSQL → Npgsql Binary COPY
```

---

## 6.2 PostgreSQL 专属 Writer

建议新增：

```text
PostgreSqlTelemetryHistoryWriter
```

职责：

```text
Materialized TelemetryData
→ COPY Buffer
→ Binary COPY
→ Commit
```

避免公共层写：

```csharp
if (database == PostgreSQL)
```

由 Provider Capability 选择实现。

---

## 6.3 PostgreSQL Transaction Rows 必须单独 A/B

不能直接照搬 SQL Server 50k。

建议：

```text
10k
25k
50k
100k
250k
```

分别测试：

```text
Rows/s
WAL MB/s
Commit latency
CPU
IO latency
Checkpoint impact
```

再决定 PostgreSQL 默认值。

---

## 6.4 PostgreSQL 索引策略

不要复制 SQL Server 索引策略。

重点评估：

```text
B-Tree(DeviceId, KeyName, DateTime)
B-Tree(DeviceId, DateTime)
BRIN(DateTime)
Partial Index
```

对于时间顺序高度相关的大表，BRIN 可能比传统大 B-Tree 更适合部分时间范围查询。

---

# 7. TimescaleDB 应独立于普通 PostgreSQL 优化

TimescaleDB 不应简单视为 PostgreSQL 的另一个连接字符串。

推荐架构：

```text
TelemetryData
   ↓
Hypertable
   ↓
Chunk
   ↓
Compression
   ↓
Retention
```

重点能力：

```text
Hypertable
Chunk interval
Compression policy
Retention policy
Continuous Aggregate
```

建议 Provider 能力分成：

```text
PostgreSQL Native Table Writer
TimescaleDB Hypertable Writer
```

TimescaleDB 仍可复用 Npgsql COPY，但表生命周期、压缩和查询策略应单独实现。

---

# 8. InfluxDB 下一阶段优化

InfluxDB 的瓶颈与 SQL Server 完全不同。

重点不是事务和 B-Tree，而是：

```text
Write API batch
Flush interval
HTTP connection reuse
gzip
Line Protocol allocation
Concurrent write pipeline
Tag cardinality
```

## 8.1 推荐 Writer

```text
InfluxTelemetryHistoryWriter
```

目标路径：

```text
TelemetryData
→ 低分配 Line Protocol Buffer
→ Batch
→ Reused HTTP Connection
→ Influx Write API
```

---

## 8.2 必须控制 Tag Cardinality

必须单独设计：

```text
DeviceId
KeyName
TenantId
LineId
```

哪些是 Tag，哪些是 Field。

错误的高基数 Tag 设计可能让 InfluxDB 在数据量大以后比写入速度更早出现内存和索引问题。

---

## 8.3 InfluxDB 验收项

必须单独测：

```text
10k batch
25k batch
50k batch
100k batch
```

记录：

```text
Write API latency
HTTP throughput
gzip CPU
Series cardinality
Memory
Disk write
Query impact
```

不能用 SQL Server benchmark 推导 InfluxDB 性能。

---

# 9. IoTDB 下一阶段优化

IoTDB 百万点写入应重点使用 Tablet，而不是逐点 RPC。

目标：

```text
Telemetry Batch
   ↓
按 Device 分组
   ↓
Tablet
   ↓
SessionPool
   ↓
InsertTablet / InsertTablets
```

建议新增：

```text
IoTDBTelemetryHistoryWriter
```

重点优化：

```text
SessionPool size
Tablet row count
Device grouping
Measurement mapping
RPC batch size
Retry
Connection reuse
```

当前 IoTDB Provider 能继续工作，不代表 Tablet 高吞吐路径已经完成。

同时应逐步清理当前代码中的旧同步 API，例如已有 obsolete warning 的：

```text
SessionDataSet.HasNext()
```

但该问题属于 Provider 现代化，不应和 History 写吞吐混为同一个任务。

---

# 10. Taos / TDengine 下一阶段优化

TDengine/Taos 更适合使用其原生时序数据模型，而不是关系数据库思路。

重点评估：

```text
STable
SubTable
Schemaless Insert
Prepared Statement Batch
Tag Design
Device → SubTable Mapping
```

建议新增：

```text
TaosTelemetryHistoryWriter
```

推荐路径：

```text
TelemetryData
→ 按 stable/device 分组
→ Batch
→ Schemaless / Stmt
→ TDengine
```

必须避免：

```text
一条 telemetry 一条 SQL
```

---

# 11. MySQL、Oracle、SQLite 后续策略

## 11.1 MySQL

目标：

```text
MySqlBulkCopy
LOAD DATA
Prepared Multi-row Insert
```

根据实际驱动支持和部署权限决定。

## 11.2 Oracle

重点：

```text
Array Binding
OracleBulkCopy
```

Oracle 的高吞吐优化不能复制 SQL Server 临时表语法。

## 11.3 SQLite

SQLite 保留用途：

```text
开发
测试
边缘节点
轻量单机
```

不建议作为中心百万点 History 主存储的核心验收数据库。

---

# 12. P0：Durable Spool Provider 化

这是 V2 中最重要的下一阶段架构任务。

当前状态：

```text
SQLServer + Sharding + PerMonth
→ Durable History Spool 已完整接入
```

目标状态：

```text
所有支持高吞吐 History 的 Provider
→ 共用 Durable History Queue
```

推荐抽象：

```text
IDurableTelemetryHistoryQueue
```

接口职责：

```text
EnqueueAsync
PeekOldestAsync
AckAsync
NackAsync
GetBacklogSnapshot
RecoverAsync
```

上层：

```text
CAP
↓
IDurableTelemetryHistoryQueue
↓
IHistoryBulkWriter
```

下层：

```text
SqlServerBulkWriter
PostgreSqlCopyWriter
InfluxBatchWriter
IoTDBTabletWriter
TaosBatchWriter
MySqlBulkWriter
OracleArrayBindingWriter
```

这样实时链路不再关心最终 History 是哪种数据库。

---

# 13. Provider Capability 统一设计

建议新增能力模型：

```text
ITelemetryHistoryBulkWriter
ITelemetryLatestWriter
ITelemetryShardLifecycleManager
ITelemetryProviderCapabilities
```

能力声明示例：

```text
SupportsBulkWrite
SupportsNativeCopy
SupportsNativeUpsert
SupportsMonthlyShardLifecycle
SupportsOnlineIndex
SupportsCompression
SupportsRetentionPolicy
SupportsTimeSeriesNativeModel
SupportsParallelPartitions
```

Provider 选择：

```text
SQL Server
→ SqlBulkCopy Writer

PostgreSQL
→ Binary COPY Writer

TimescaleDB
→ Binary COPY + Hypertable Lifecycle

InfluxDB
→ Line Protocol Batch Writer

IoTDB
→ Tablet Writer

Taos
→ Schemaless / Statement Batch Writer

MySQL
→ Bulk Writer

Oracle
→ Array Binding Writer
```

公共层禁止演变成：

```csharp
if (sqlserver) ...
else if (postgres) ...
else if (influx) ...
else if (...)
```

---

# 14. 通用 Durable Queue 后的目标架构

最终推荐：

```text
                    ┌──────── Latest Writer
                    │
MQTT → Ingest → CAP ┤
                    │
                    └──────── Durable History Queue
                                   ↓
                            Persistence Dispatcher
                                   ↓
          ┌────────────────────────┼────────────────────────┐
          ↓                        ↓                        ↓
 SqlServer Writer          PostgreSQL Writer         InfluxDB Writer
 SqlBulkCopy               Binary COPY               Batch Write API
          ↓                        ↓                        ↓
    SQL Server                PostgreSQL                 InfluxDB

          ↓                        ↓
    IoTDB Writer              Taos Writer
    Tablet                    Schemaless / Stmt
```

实时 Lane：

```text
MQTT / Latest / Rule
```

Durable Boundary：

```text
Provider-neutral Durable History Queue
```

Persistence Lane：

```text
Provider-specific Bulk Writer
```

---

# 15. 新的优先级规划

## P0

```text
1. Durable Spool Provider 化
2. Provider Capability 抽象
3. PostgreSQL Binary COPY
4. InfluxDB Batch Writer
5. IoTDB Tablet Writer
6. Taos/TDengine Batch Writer
```

原因：这些任务决定多数据库是否真正具备与 SQL Server 同等级的数据流基础。

## P1

```text
1. 各 Provider 独立百万点 E2E
2. 各 Provider 崩溃恢复验收
3. PostgreSQL / TimescaleDB 索引与生命周期
4. InfluxDB Cardinality 基准
5. IoTDB Tablet 参数基准
6. Taos stable/subtable 参数基准
7. MySQL Bulk Writer
8. Oracle Array Binding
```

## P2

```text
1. 多 History Worker 分区并行
2. Provider 自动容量探测
3. 集群级 Durable Queue
4. Kafka / Pulsar 等外部 Durable Log
5. 冷热分层与归档
```

---

# 16. 各 Provider 必须独立建立 benchmark

以后不能再写：

```text
SQL Server 100 万通过
→ 推断 PostgreSQL / InfluxDB / IoTDB / Taos 都能通过
```

每个 Provider 必须独立记录：

```text
Ingress PPS
Durable Queue Enqueue PPS
Provider Persistence PPS
P50 / P95 / P99 Batch Latency
CPU
Memory
Disk IO
Network IO
Backlog Growth
Recovery Time
```

并单独测试：

```text
100k
500k
1M
2M
```

---

# 17. PostgreSQL 验收标准

至少满足：

```text
Binary COPY 正常路径
Duplicate / Retry 策略
Durable Queue 接入
100 万 sender failures=0
最终 SQL Delta 精确
restart recovery 精确
flow 恢复 normal
```

还必须记录：

```text
WAL MB/s
checkpoint duration
COPY rows/s
index write amplification
```

---

# 18. InfluxDB 验收标准

至少满足：

```text
Write API Batch
Connection reuse
Durable Queue
100 万点精确写入
重启恢复
无重复/丢失
```

还必须记录：

```text
Series count
Tag cardinality
Write latency
HTTP payload size
gzip ratio
```

---

# 19. IoTDB 验收标准

至少满足：

```text
Tablet / InsertTablets
SessionPool
Durable Queue
100 万点精确写入
重启恢复
```

记录：

```text
Tablet rows
RPC latency
SessionPool utilization
Device grouping efficiency
```

---

# 20. Taos / TDengine 验收标准

至少满足：

```text
STable / SubTable 模型
Batch write
Durable Queue
100 万点精确落库
重启恢复
```

记录：

```text
Batch rows
SubTable count
Tag cardinality
Network throughput
Server write throughput
```

---

# 21. SQL Server 当前 E2E 基线

最新真实 100 万：

```text
points = 1,000,000
elapsed = 2.548s
points_per_sec = 392,418
failures = 0
fallbacks = 0
flow = normal
```

SQL：

```text
25,724,931
→
26,724,931
```

精确：

```text
+1,000,000
```

Spool：

```text
pending=0
tmp=0
```

随后重启恢复 200k：

```text
停止前 pending=2
停止后 pending=2
重启后自动 drain
不重新发送
SQL 精确 +200,000
```

最后 500 点恢复探针：

```text
flow=normal
failures=0
fallbacks=0
SQL 精确 +500
```

因此当前 SQL Server 路径可以作为其它 Provider 后续验收模板。

---

# 22. 当前可靠性边界仍需说明

即使 SQL Server Durable Spool 已完成，也不能宣称：

```text
MQTT ACK 后任意时刻崩溃都绝不丢
```

如果：

```text
EventBusStore = InMemory
```

那么：

```text
MQTT 已接收
但 CAP 尚未消费并写入 durable queue
```

这段窗口仍不是完整端到端 durability。

因此下一阶段仍建议：

```text
Durable CAP Store
```

或者外部 durable broker。

---

# 23. Spool 容量保护仍然是所有 Provider 共性任务

通用 Durable Queue 后必须增加：

```text
MaxSpoolBytes
MinFreeDiskBytes
WarningPercent
SeverePercent
CriticalPercent
```

建议水位：

```text
Normal    <50%
Warning   >=50%
Degraded  >=70%
Severe    >=85%
Critical  >=95%
```

Critical 时不能继续无上限接收。

推荐行为：

```text
Gateway 强限流
低优先级数据降级
告警
停止继续扩大 backlog
```

---

# 24. Metrics 必须做成 Provider-neutral

推荐指标：

```text
telemetry_ingress_points_total
telemetry_ingress_points_per_second
telemetry_history_queue_pending_batches
telemetry_history_queue_pending_rows
telemetry_history_queue_bytes
telemetry_history_queue_oldest_age_seconds
telemetry_provider_write_rows_per_second
telemetry_provider_batch_duration_ms
telemetry_provider_failed_batches_total
telemetry_provider_retry_total
telemetry_persistence_lag_seconds
telemetry_flow_mode
```

并增加标签：

```text
provider=sqlserver
provider=postgresql
provider=influxdb
provider=iotdb
provider=taos
```

这样同一套 Grafana 可以比较不同 Provider。

---

# 25. 推荐实施顺序

## Phase 1：Durable Queue 通用化

```text
提取 IDurableTelemetryHistoryQueue
提取 Persistence Dispatcher
保留 SQL Server 现有实现作为第一实现
```

验收：SQL Server 现有 E2E 不退化。

## Phase 2：PostgreSQL

```text
Binary COPY Writer
Transaction benchmark
Duplicate strategy
Durable Queue 接入
1M E2E
Restart Recovery
```

## Phase 3：InfluxDB

```text
Batch Writer
Line Protocol allocation
Tag cardinality
Durable Queue
1M E2E
```

## Phase 4：IoTDB

```text
Tablet Writer
SessionPool
Device grouping
Durable Queue
1M E2E
```

## Phase 5：Taos / TDengine

```text
STable / SubTable
Schemaless / Stmt Batch
Durable Queue
1M E2E
```

## Phase 6：MySQL / Oracle

```text
MySql Bulk
Oracle Array Binding
```

## Phase 7：集群与长期运行

```text
多节点 Durable Queue
Kafka / Pulsar 可选
冷热数据生命周期
统一 Metrics
72h soak test
```

---

# 26. 重新定义“完成”的验收标准

以后某个 Provider 只有同时通过以下项目，才允许在文档中标记“百万点优化完成”。

## 功能

```text
Latest 正确
History 正确
类型正确
查询正确
```

## 性能

```text
100 万点 Sender failures=0
Provider persistence 可持续
无异常 GC / OOM
```

## 数据完整性

```text
Expected Point Count == Actual Persisted Count
```

## Durable

```text
产生 backlog
停止进程
pending 保留
重启
无需重新发送
最终精确补齐
```

## Flow Control

```text
backlog 上升 → degraded/severe
backlog 清空 → normal
```

## 长时间

```text
至少 1h sustained
最终建议 24h / 72h soak
```

---

# 27. 当前完成度重新整理

## 已完成并真实验收

```text
Gateway / MQTT 百万点入口
Latest / History Split
Composite Storage 基础
Persistence Lag
Gateway Flow Control
SQL Server Durable History Spool
SQL Server SqlBulkCopy
SQL Server 50k Transaction
SQL Server Direct TelemetryData Reader
SQL Server Allocation 优化
SQL Server Duplicate fallback
SQL Server Hot Shard Index Mode
SQL Server 100万 / 200万 E2E
SQL Server Restart Recovery
SQL Server 精确落库验收
```

## 已兼容但未完成 Provider 深度优化

```text
PostgreSQL
TimescaleDB
InfluxDB
IoTDB
Taos / TDengine
MySQL
Oracle
SQLite
```

## 下一阶段必须补齐

```text
Provider-neutral Durable Queue
Provider Capability
PostgreSQL Binary COPY
InfluxDB Batch Writer
IoTDB Tablet Writer
Taos Batch Writer
各 Provider 百万点 E2E
各 Provider Restart Recovery
统一 Metrics
```

---

# 28. 最终结论

V2 对当前项目状态给出更严格的结论：

> IoTSharp 的百万点数据流架构已经完成关键解耦，并且 SQL Server 路径已经完成深度优化和真实百万点验收；其他数据库已经具备架构兼容基础，但不能宣称已经完成同等级别的百万点优化。

下一阶段不应该继续把主要精力投入 SQL Server 微调，而应该优先完成：

```text
Durable Queue Provider 化
+
PostgreSQL Binary COPY
+
InfluxDB Batch Writer
+
IoTDB Tablet Writer
+
Taos/TDengine Batch Writer
```

最终目标不是“支持很多数据库名称”，而是：

> **每个主流 History Provider 都拥有自己的原生高吞吐 Writer、统一 Durable Boundary、统一 Flow Control、统一 Metrics，并通过独立百万点 E2E 与重启恢复验收。**

只有达到这个标准，才能称为真正的多数据库百万点工业遥测平台。
