# IoTSharp 百万点遥测数据流性能优化与下一阶段优化方案 V1

> 文档状态：V1
> 适用项目：IoTSharp / IoTGateway
> 目标范围：遥测数据流、持久化、流控、SQL Server 高吞吐、多数据库兼容、集群与容量规划
> 非目标范围：SonnetDB 专项优化、3D/数字孪生业务逻辑、前端功能优化

---

## 1. 文档目标

本文用于统一记录 IoTSharp 百万点遥测链路目前已经完成的性能改造、真实压测结果、当前剩余瓶颈，以及后续建议继续实施的优化项。

本轮优化的核心目标不是单纯提高 MQTT 峰值，而是把整条遥测链路改造成：

```text
高吞吐入口
+ Latest 实时更新
+ History 持久化解耦
+ Durable 本地缓冲
+ 数据库压力反馈
+ Gateway 动态流控
+ 重启恢复
+ 多数据库兼容
+ Provider 专属高性能路径
```

最终需要同时满足以下四类指标：

1. **入口吞吐**：Gateway → MQTT → IoTSharp 能够承受百万点级突发。
2. **可靠性**：数据库暂时跟不上或服务重启时，History 不丢失。
3. **持续性**：长期平均输入不能无限高于数据库实际持久化能力。
4. **兼容性**：SQL Server 可以使用专属高性能路径，但不能破坏 PostgreSQL、MySQL、Oracle、SQLite、InfluxDB、IoTDB、Taos 等 Provider。

---

# 2. 当前总体结论

目前 IoTSharp 数据流已经完成从“同步数据库写入链路”到“实时链路 + Durable History 持久化链路”的架构升级。

当前结构：

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
   ├──────── Latest Storage
   ├──────── Rule / Event Dispatch
   └──────── Durable History Spool
                    ↓
             Background Worker
                    ↓
             History Provider
                    ↓
               SQL / TSDB
```

当前已经解决：

- MQTT 入口被 SQL History 拖慢的问题；
- CAP Consumer 必须同步等待 History 写完的问题；
- SQL Server 临时抖动导致整个入口堵塞的问题；
- History 本地缓存只存在于内存、进程退出即丢失的问题；
- SQL Server History 中间对象复制和大量 GC 分配问题；
- SQL Server History 事务过大问题；
- SQL Server 热月表二级索引写放大问题；
- Latest / History 不可独立扩展的问题；
- 指定 Key 查询仍将所有 Key 拉回应用层的问题；
- 数据库压力无法反馈给 Gateway 的问题；
- Gateway 第一次订阅拿不到流控状态的问题；
- 单库配置客户无法进入 SQL Server BulkCopy 快路径的问题。

当前最大的剩余瓶颈已经不再是 MQTT，而是：

> **History Provider 的长期物理持久化能力，尤其是 SQL Server 的磁盘、事务日志、热表索引和数据库部署方式。**

---

# 3. 已完成的关键优化

## 3.1 Latest 与 History 解耦

原链路：

```text
CAP Consumer
   ↓
Latest
   ↓
History
   ↓
全部数据库写完
   ↓
Consumer 完成
```

问题：History 写盘速度直接决定实时链路吞吐。

当前链路：

```text
CAP Consumer
   ↓
Durable History Spool
   ↓
Latest
   ↓
Rule / Event
   ↓
Consumer 可完成

History Spool
   ↓
后台 Worker
   ↓
History Database
```

已增加分离能力：

```csharp
StoreTelemetryLatestBatchAsync(...)
StoreTelemetryHistoryBatchAsync(...)
StoreTelemetryHistoryRowsAsync(...)
```

意义：

- Latest 可以保持实时；
- Rule 不再被 History 慢写长时间阻塞；
- History 可以单独选择关系数据库或时序数据库；
- 后续可以针对不同 Provider 分别优化 History Writer。

---

## 3.2 Durable History Spool

当前实现采用 Atomic File WAL，不使用简单 `Task.Run` 或纯内存队列。

写入过程：

```text
History Batch
   ↓
写入 .tmp
   ↓
Flush(true)
   ↓
计算 SHA256
   ↓
原子 rename
   ↓
<sha256>.pending
```

后台处理：

```text
*.pending
   ↓
History Worker
   ↓
数据库成功提交
   ↓
删除 pending
```

异常场景：

```text
数据库失败
→ pending 保留

IoTSharp 进程退出
→ pending 保留

IoTSharp 重启
→ 扫描 pending
→ 自动恢复
```

已经做过真实重启恢复验证：

```text
停止前 pending=2
停止后 pending=2
重启后未重新发送数据
pending 自动恢复并归零
SQL 精确补齐 +200000
```

说明当前 Durable Boundary 已经真实生效。

---

## 3.3 Persistence Lag 与 Gateway Flow Control

新增 Persistence Monitor，用于统一判断 History 实际落后程度。

监控维度：

```text
InFlight Batch Oldest Age
Recent Completed Lag
Durable Spool Oldest Pending Age
Pending Count
Failed Batches
Completed Batches
Last Batch Duration
```

流控模式：

| 模式 | Persistence Lag | 建议行为 |
|---|---:|---|
| Normal | < 5s | 正常发送 |
| Degraded | >= 5s | 降速、缩小 Batch |
| Severe | >= 20s | 强限速、防止 backlog 无限增长 |

当前默认策略：

| 模式 | Rate | Batch | Delay |
|---|---:|---:|---:|
| Normal | Unlimited | 2000 | 0 |
| Degraded | 50,000/s | 1000 | 50ms |
| Severe | 20,000/s | 500 | 200ms |

注意：这些值应视为默认保护参数，不应作为所有客户现场的固定值。

后续应根据：

```text
服务器 CPU
SQL/TSDB 吞吐
磁盘吞吐
网关数量
spool 可用空间
现场网络
```

动态配置。

---

## 3.4 SQL Server History BulkCopy 快路径

SQL Server History 已从普通 EF 写入路径优化为：

```text
TelemetryData
   ↓
按 yyyyMM 分片
   ↓
稳定排序
   ↓
50k Chunk
   ↓
SqlBulkCopy
   ↓
事务提交
```

当前参数：

```text
HistoryBulkCopyBatchSize = 50000
TelemetryHistoryTransactionRows 默认 = 50000
可配置范围 = 1000 ~ 250000
```

热态真实 benchmark：

| Transaction Rows | 30 万写入耗时 | 吞吐 |
|---:|---:|---:|
| 25k | 3040.5 ms | 98.7k rows/s |
| 50k | 2555.5 ms | 117.4k rows/s |
| 100k | 2636.5 ms | 113.8k rows/s |

因此默认从 100k 调整为 50k。

选择 50k 的原因：

- 吞吐略高于 100k；
- 与 `SqlBulkCopy BatchSize=50000` 对齐；
- 事务更短；
- 日志 burst 更小；
- 锁持有时间更短；
- 单次失败重试影响范围更小。

---

## 3.5 SQL Server History 内存分配优化

原实现：

```text
TelemetryData
   ↓
SqlServerTelemetryRow
   ↓
Value 装箱
   ↓
List<int>
   ↓
ToArray()
   ↓
BulkCopy
```

100 万点仅构建写入计划就达到：

```text
524 ms
259.8 MB allocations
```

优化后：

```text
TelemetryData
   ↓
直接 IDataReader
   ↓
SqlBulkCopy
```

同时：

- 月分片使用整数 `yyyyMM`，减少每行字符串创建；
- 按分片精确统计数量；
- 直接分配 `int[]`；
- 原地填充；
- 原地排序；
- 去掉 `List<int> -> ToArray()` 二次复制。

结果：

```text
100 万 History 写计划
524 ms → 100 ms
259.8 MB → 3.8 MB
```

内存分配下降约 98.5%。

这项优化的意义不只在于“省内存”，更重要的是减少：

```text
Gen2 GC
LOH 压力
GC Pause
入口线程抖动
CAP Consumer 延迟
```

---

## 3.6 Duplicate Key 幂等回退

History 主键：

```text
DeviceId + KeyName + DateTime
```

可能产生重复的场景：

```text
Gateway Retry
CAP Retry
断线重传
服务重启
人工重放
```

当前策略：

```text
正常 Batch
→ 直接 BulkCopy

遇到 2601 / 2627
→ 仅当前 Chunk 切换幂等 fallback
→ 临时表 / NOT EXISTS
→ 插入不存在的数据
```

这样保证：

- 正常路径仍然最快；
- 只有出现重复的 Chunk 才进入慢路径；
- 不因为极少量重复让所有数据都永久使用低性能写法。

已验证：8 种类型同一批写两次，最终仍然只有 8 行。

---

## 3.7 SQL Server 热月表索引优化模式

当前 History 表典型结构：

```text
PK:
(DeviceId, KeyName, DateTime)

Secondary Index:
(DeviceId, DateTime)
```

问题：热表每写一条数据都要同时维护 PK 和二级索引。

真实 index usage 曾观察到：

```text
(DeviceId, DateTime)
seek = 7
scan = 17
update = 1882
```

说明二级索引查询使用不高，但写维护非常频繁。

当前新增：

```text
TelemetryHistoryShardIndexMode
```

支持：

```text
ProviderDefault
WriteOptimizedHotShard
```

`WriteOptimizedHotShard` 设计：

```text
当前热月
→ 减少非必要二级索引
→ 优先写入

历史冷月
→ 恢复查询索引
→ 优先查询
```

独立 A/B：

```text
30 万 History
ProviderDefault       7.332s
WriteOptimizedHot     2.875s
```

提升约 60.8%。

当前不建议直接全局默认开启，因为 `keys=all` 等查询仍可能依赖 `(DeviceId, DateTime)` 索引。

正确策略是：

> **按客户查询模型显式开启，而不是所有现场统一强制开启。**

---

## 3.8 History 查询 Key 下推 SQL

原查询：

```text
WHERE DeviceId = xxx
AND DateTime BETWEEN ...
```

先把该设备时间范围内所有 Key 拉回应用，然后再：

```csharp
.Where(x => keys.Contains(x.KeyName))
```

现在已调整为 SQL 下推：

```sql
WHERE DeviceId = ...
AND DateTime BETWEEN ...
AND KeyName IN (...)
```

收益：

- 降低数据库返回行数；
- 降低网络传输；
- 降低应用内存分配；
- 更好利用 `(DeviceId, KeyName, DateTime)` 主键。

`keys=all` 保持原行为，用于兼容完整历史查询。

---

# 4. 当前真实 E2E 验证结果

## 4.1 最新 100 万点

```text
points = 1,000,000
elapsed = 2.548 s
throughput = 392,418 points/s
failures = 0
fallbacks = 0
```

SQL History：

```text
25,724,931
→
26,724,931
```

精确：

```text
+1,000,000
```

最终：

```text
pending=0
tmp=0
```

没有发现：

```text
History failure
Spool failure
SqlException
Deadlock
2601
2627
```

---

## 4.2 200 万点

已验证过：

```text
points = 2,000,000
elapsed = 3.432 s
throughput = 582,661 points/s
failures = 0
fallbacks = 0
```

最终 SQL 精确增加：

```text
+2,000,000
```

说明入口层已经具备百万点级突发承载能力。

---

## 4.3 Durable Restart Recovery

测试：

```text
额外发送 200000
pending=2 时停止 IoTSharp
停止后 pending 仍为 2
重启同实例
不重新发送 telemetry
worker 自动恢复
pending=0
SQL 最终精确 +200000
```

结论：

> Durable Spool 的“进程中断恢复”已经真实验证，不是单元测试假设。

---

# 5. 当前必须明确的性能边界

当前已经验证的是：

```text
百万级 telemetry points
百万级数据流吞吐
```

不是：

```text
100 万 MQTT TCP Client 同时在线
```

两者是不同测试体系。

百万连接还需要单独验证：

```text
Socket
TLS
KeepAlive
Subscription
Session
Broker Memory
NIC
Kernel TCP Stack
负载均衡
集群
连接迁移
```

因此后续文档和压测报告必须始终区分：

```text
Points Per Second
和
Concurrent Connections
```

不能混用。

---

# 6. 下一阶段优化总表

## 6.1 优先级定义

```text
P0 = 建议下一阶段优先完成
P1 = 规模进一步上升后应完成
P2 = 特定客户/超大规模部署再实施
```

| 优先级 | 优化项 | 收益 | 影响范围 |
|---|---|---|---|
| P0 | 独立 Telemetry Database | 高 | SQL Server 部署 |
| P0 | Durable CAP / EventBus Store | 高 | 整条数据流可靠性 |
| P0 | Spool 容量、水位、磁盘保护 | 高 | 所有 Durable Spool 部署 |
| P0 | 数据流 Metrics + Alert | 高 | 运维 |
| P1 | SQL Server 热表 WriteOptimized 自动生命周期 | 高 | SQL Server |
| P1 | SQL Server 数据文件/日志文件独立磁盘 | 高 | SQL Server |
| P1 | SQL Server AutoGrowth / 预分配 | 中高 | SQL Server |
| P1 | 冷月表压缩/归档 | 中高 | SQL Server |
| P1 | PostgreSQL COPY 快路径 | 高 | PostgreSQL |
| P1 | MySQL Bulk 快路径 | 高 | MySQL |
| P1 | Oracle Array Binding | 高 | Oracle |
| P1 | Provider Capability 抽象 | 高 | 多数据库架构 |
| P2 | History 多 Worker / 分区并行 | 高但复杂 | 超高持续吞吐 |
| P2 | Telemetry DB 集群 / 分片路由 | 高但复杂 | 大规模集群 |
| P2 | Kafka / 外部 Durable Queue | 高 | 超大规模 |

---

# 7. P0：独立 Telemetry Database

当前已经支持：

```json
"ConnectionStrings": {
  "IoTSharp": "...",
  "TelemetryStorage": "..."
}
```

推荐部署：

```text
SQL Server Instance
│
├─ IOTSharp
│  ├─ Device
│  ├─ User
│  ├─ Rule
│  └─ Business
│
└─ IOTSharpTelemetry
   ├─ TelemetryData_202609
   ├─ TelemetryData_202610
   └─ ...
```

原因：SQL Server Recovery Model 是 Database Level，不是 Table Level。

不能做到：

```text
业务表 FULL
History 表 SIMPLE
```

如果在同一个 Database 中，这种配置无法实现。

建议：

```text
IOTSharp
→ FULL

IOTSharpTelemetry
→ 根据业务恢复要求评估 SIMPLE / BULK_LOGGED / FULL
```

注意：Recovery Model 必须结合客户备份、RPO、RTO 要求确定，不能只为了性能直接改成 SIMPLE。

---

# 8. P0：CAP / EventBus Durability

当前需要明确一个可靠性边界：

```text
MQTT 收到
↓
进入 CAP Consumer
↓
History 成功写 Durable Spool
```

从“History 已进入 spool”以后已经具备本地 durability。

但如果当前配置仍然是：

```text
EventBusStore = InMemory
```

那么在：

```text
MQTT 已接收
但 CAP 尚未消费并写入 spool
```

这个极短窗口内，如果整个进程崩溃，仍然不能宣称端到端绝对 Durable。

因此如果客户要求：

```text
Gateway 已发送成功
→ IoTSharp 任意时刻崩溃
→ 数据仍必须恢复
```

建议将 EventBus Store 升级为 Durable Store。

可选方向根据当前 CAP 支持能力评估：

```text
SQL Server CAP Store
PostgreSQL CAP Store
MySQL CAP Store
外部 Durable Message Broker
```

集群环境尤其不能继续依赖 InMemory EventBus Store 作为最终可靠方案。

---

# 9. P0：Spool 容量与磁盘保护

Durable Spool 解决的是：

```text
短期突发
数据库抖动
数据库短时故障
IoTSharp 重启
```

它不能无限吸收：

```text
入口 500k/s
数据库 50k/s
长期持续数小时
```

因为 backlog 增长速率：

```text
BacklogGrowth = IngestRate - PersistenceRate
```

例如：

```text
500k/s - 50k/s = 450k/s
```

最终任何磁盘都会写满。

因此建议新增明确 Spool Watermark：

```text
Normal       < 50%
Warning      >= 50%
Degraded     >= 70%
Severe       >= 85%
Critical     >= 95%
```

Critical 行为必须预先定义，例如：

```text
强制 Gateway 限流
拒绝低优先级遥测
停止非核心历史写入
触发告警
禁止继续无限接收
```

推荐增加配置：

```text
MaxSpoolBytes
WarningPercent
SeverePercent
CriticalPercent
MinFreeDiskBytes
```

并将磁盘剩余空间加入 `TelemetryPersistenceMonitor`。

---

# 10. P0：建立完整 Metrics

建议把当前内部数据全部暴露到 OpenTelemetry / Prometheus。

核心指标建议：

```text
telemetry_ingress_points_total
telemetry_ingress_points_per_second
telemetry_latest_batch_duration_ms
telemetry_history_batch_duration_ms
telemetry_history_rows_per_second
telemetry_spool_pending_files
telemetry_spool_pending_rows
telemetry_spool_bytes
telemetry_spool_oldest_age_seconds
telemetry_persistence_lag_seconds
telemetry_failed_batches_total
telemetry_duplicate_fallback_total
telemetry_sql_deadlock_total
telemetry_flow_mode
telemetry_gateway_rate_limit
```

必须同时监控两类吞吐：

```text
Ingress PPS
Persistence PPS
```

只有两者长期接近，系统才是可持续状态。

如果：

```text
Ingress PPS = 300k
Persistence PPS = 80k
```

即使入口完全正常，也属于持续容量不足。

---

# 11. P1：SQL Server 热/冷索引自动生命周期

当前 `WriteOptimizedHotShard` 已经存在，但建议进一步做成完整生命周期：

```text
当月创建
→ Hot
→ 写优化索引集合

跨月
→ Freeze previous month
→ 创建查询索引
→ 可选压缩
→ Update Statistics
→ 标记 Cold
```

建议增加状态：

```text
Hot
Closing
Cold
Archived
```

推荐自动任务：

```text
月切换 T+5min
↓
确认上一月没有迟到数据高峰
↓
创建 Cold Index
↓
Update Statistics
↓
可选 Data Compression
```

不能在月切换瞬间对几十亿行表直接做重型 DDL，必须考虑：

```text
ONLINE Index
维护窗口
最大执行时间
失败恢复
重复执行幂等
```

---

# 12. P1：SQL Server 文件和日志部署优化

推荐：

```text
Telemetry MDF/NDF
→ 高吞吐数据盘

Telemetry LDF
→ 独立低延迟日志盘
```

避免：

```text
OS
MDF
LDF
Spool
全部放同一个盘
```

因为这样数据库写盘和 spool WAL 会争抢同一个物理设备。

更合理：

```text
Disk A → OS / App
Disk B → Telemetry Data
Disk C → Telemetry Log
Disk D → Durable Spool
```

至少应做到：

```text
Telemetry Log
和
Durable Spool
不要共用高竞争磁盘
```

---

# 13. P1：SQL Server AutoGrowth 与预分配

百万点持续写入时，频繁 AutoGrowth 会产生明显停顿。

建议：

- 数据文件提前预分配；
- 日志文件提前预分配；
- AutoGrowth 使用固定 MB，而不是百分比；
- 监控 VLF 数量；
- 避免 LDF 每几分钟增长一次。

推荐做容量模型后一次性规划：

```text
日写入量
月写入量
平均单行字节
索引开销
日志开销
增长冗余
```

例如：

```text
MonthlyRequired =
PointsPerDay
× Days
× AverageRowBytes
× IndexFactor
× SafetyFactor
```

必须通过客户真实数据类型测量 `AverageRowBytes`，不能用固定理论值。

---

# 14. P1：冷数据压缩

对于历史冷月表，可评估：

```text
ROW Compression
PAGE Compression
```

原则：

```text
热表优先写性能
冷表优先存储效率和查询效率
```

不要对当前高频写入热表直接默认 PAGE Compression。

建议过程：

```text
月结
↓
建立查询索引
↓
压缩评估
↓
读取性能验证
↓
再启用
```

---

# 15. P1：多数据库 Provider 专属 Bulk Writer

当前 SQL Server 已有专属快路径。

下一阶段如果 PostgreSQL / MySQL / Oracle 客户也需要百万点 History，应分别实现 Provider Capability，而不是复制 SQL Server SQL。

## PostgreSQL

推荐方向：

```text
COPY BINARY
```

不要长期依赖：

```text
EF AddRange + SaveChanges
```

## MySQL

可评估：

```text
MySqlBulkCopy
LOAD DATA
批量 Prepared Insert
```

根据驱动、事务和安全策略选择。

## Oracle

推荐评估：

```text
Array Binding
OracleBulkCopy
```

## SQLite

SQLite 不适合作为百万点中心 History 主数据库。

可以保留用于：

```text
开发
单机轻量部署
边缘缓存
测试
```

但不应以 SQLite benchmark 代表中心数据平台能力。

---

# 16. P1：Provider Capability 抽象

建议继续抽象：

```text
ITelemetryHistoryBulkWriter
ITelemetryLatestWriter
ITelemetryShardLifecycleManager
```

Provider 自行声明：

```text
SupportsBulkCopy
SupportsOnlineIndex
SupportsTableCompression
SupportsMonthlyShardLifecycle
SupportsNativeUpsert
SupportsCopyProtocol
```

例如：

```text
SQL Server
→ SqlBulkCopy

PostgreSQL
→ COPY

MySQL
→ BulkCopy / LOAD DATA

Oracle
→ Array Binding

InfluxDB
→ Line Protocol

IoTDB
→ Tablet API
```

公共数据流只关心：

```text
History Rows
Batch
Retry
Durability
Flow Control
```

不要让公共层出现大量：

```csharp
if (sqlserver)
else if (postgres)
else if (mysql)
...
```

---

# 17. P2：History Worker 并行化

当前后台 History Worker 采用顺序 drain，优点是：

```text
行为可预测
数据库压力稳定
重试简单
顺序清晰
```

后续持续吞吐仍不足时，可以考虑：

```text
按 shard 分区并行
```

例如：

```text
Shard 202609 Worker A
Shard 202610 Worker B
```

或者：

```text
Device Hash Partition
```

但不能简单开：

```text
Task.WhenAll(20 batches)
```

因为可能造成：

```text
SQL Log Saturation
Latch Contention
Deadlock
IO Queue 爆炸
Index Page Contention
```

建议并发度：

```text
1 → 2 → 4
```

逐级 A/B，不建议直接高并发。

---

# 18. P2：集群场景数据流

单机 Durable Spool 不能直接等同于集群共享队列。

集群建议：

```text
Gateway
   ↓
Load Balancer / MQTT Cluster
   ↓
IoTSharp Node A / B / C
   ↓
Node-local Durable Spool
   ↓
Shared History Database
```

必须解决：

```text
Node Identity
Spool Directory 隔离
同一 Batch 去重
Gateway Sticky Session / Consistent Hash
Durable EventBus Store
Node Crash Recovery
Drain Ownership
```

推荐每节点 spool：

```text
/spool/{nodeId}/...
```

不要让多个节点同时写同一个本地 spool 目录。

如果未来要求节点无状态化，则应进一步考虑：

```text
Kafka
RabbitMQ Quorum Queue
Pulsar
其他外部 Durable Log
```

作为 History Durable Boundary。

---

# 19. 推荐容量规划公式

Durable Spool 必须按“数据库最长不可用时间”规划。

基本公式：

```text
RequiredSpoolBytes =
PeakIngressPointsPerSecond
× MaxDatabaseOutageSeconds
× AverageSerializedPointBytes
× SafetyFactor
```

例如：

```text
Ingress = 300,000 points/s
Database outage = 600s
Average spool point = 80 bytes
SafetyFactor = 1.5
```

则：

```text
300000 × 600 × 80 × 1.5
≈ 21.6 GB
```

这只是示例，实际必须根据真实 spool 文件测量平均字节数。

建议至少测量：

```text
Bool
Long
Double
String
Large JSON
Binary
```

不同业务差异会非常大。

---

# 20. 推荐配置基线

SQL Server 月分片高吞吐客户可从以下思路开始：

```json
{
  "TelemetryHistoryStorage": "Sharding",
  "TelemetryLatestStorage": "Relational",
  "ShardingByDateMode": "PerMonth",
  "TelemetryHistoryTransactionRows": 50000,
  "TelemetryHistoryShardIndexMode": "ProviderDefault",
  "TelemetryHistorySpool": {
    "Enabled": true,
    "Directory": "runtime-data/telemetry-history-spool",
    "RetryDelayMilliseconds": 1000,
    "IdleDelayMilliseconds": 100
  }
}
```

在确认客户 History 查询模式后，再评估：

```text
ProviderDefault
↓
WriteOptimizedHotShard
```

不能在未知查询负载下直接强制开启。

---

# 21. 最终验收标准

以后所有百万点数据流改动都建议至少通过以下验收。

## 21.1 入口

```text
100 万点
failures=0
fallbacks=0
```

并记录：

```text
elapsed
points/sec
flow updates
effective batch
```

## 21.2 History

必须区分：

```text
Sender Finished
和
SQL Landing Finished
```

最终：

```text
SQL Delta == Expected Point Count
```

不能只看 sender 成功。

## 21.3 Spool

必须：

```text
pending → 0
tmp → 0
```

## 21.4 Restart Recovery

至少一次：

```text
制造 pending
↓
停止 IoTSharp
↓
确认 pending 仍存在
↓
重启
↓
不重新发送
↓
自动 drain
↓
SQL 精确补齐
```

## 21.5 Flow Control

必须验证：

```text
backlog 增大
→ degraded / severe

backlog 清空 + hold window 到期
→ normal
```

## 21.6 错误扫描

检查：

```text
Deadlock 1205
Duplicate 2601 / 2627
Timeout
Spool failure
History failure
OutOfMemory
GC pressure
Disk full
```

---

# 22. 推荐实施顺序

下一阶段建议不要再继续优先优化 MQTT，而按照下面顺序实施。

```text
Phase 1
独立 Telemetry Database
+ SQL 数据/日志磁盘规划
+ Spool 水位保护
+ 完整 Metrics

Phase 2
Durable CAP Store
+ 集群可靠性边界

Phase 3
WriteOptimizedHotShard 自动生命周期
+ 冷表索引/压缩

Phase 4
PostgreSQL / MySQL / Oracle Provider 专属 Bulk Writer

Phase 5
History Worker 分区并行
+ 集群级 Durable Queue
```

目前不建议继续优先投入：

```text
MQTT 微小批次调参
Channel 微调
无依据增加线程
无依据提高并发
```

因为当前实测已经说明：

> **入口已经足够快，下一阶段最有价值的优化点在数据库持续吞吐、Durable 容量和集群可靠性。**

---

# 23. 当前阶段完成度

当前代码层百万点数据流优化：

```text
Gateway / MQTT 高吞吐              已完成
Latest / History 解耦              已完成
Durable History Spool              已完成
Restart Recovery                   已完成
Persistence Lag                    已完成
Gateway Flow Control               已完成
SQL Server BulkCopy                已完成
History 50k Transaction            已完成
History Direct TelemetryData       已完成
History Allocation 优化            已完成
Duplicate Idempotent Fallback      已完成
查询 Key SQL 下推                  已完成
SQL Server 热表索引模式            已完成，可选启用
多数据库兼容边界                   已完成
百万 / 两百万 E2E                  已完成

独立 Telemetry DB 部署优化          待实施
Durable CAP Store                  待实施
Spool 磁盘容量保护                  待实施
Prometheus/OpenTelemetry 指标       待实施
热/冷索引自动生命周期              待实施
冷数据压缩                         待实施
PostgreSQL COPY 快路径              待实施
MySQL Bulk 快路径                  待实施
Oracle Array Binding               待实施
集群级 Durable Queue               后续规模化实施
```

---

# 24. 最终建议

IoTSharp 当前最重要的成果不是单个 benchmark 数字，而是数据流已经具备正确的分层：

```text
Real-time Lane
     ↓
Durable Boundary
     ↓
Persistence Lane
```

即：

```text
Gateway / MQTT / Latest / Rules
```

不再被：

```text
SQL Server History 物理写盘速度
```

直接锁死。

下一阶段应把重点从“入口还能不能再快一点”转为：

```text
1. 数据库持续吞吐
2. Durable 容量管理
3. 完整监控
4. 数据库冷热生命周期
5. 集群可靠性
6. 各 Provider 原生 Bulk Writer
```

只有把这些继续补齐，IoTSharp 才会从“百万点压测能通过”，进一步升级为“百万点规模能够长期稳定运行、可以运维、可以扩容、可以故障恢复”的企业级遥测平台。
