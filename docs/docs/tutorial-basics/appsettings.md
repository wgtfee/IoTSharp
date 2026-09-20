---
sidebar_position: 5
---

# 配置IoTSharp

​		本教程主要讲述 appsettings 的配置 , 大家可以在 代码目录或者安装文件目录看到  有很多个 appsettings.xxxxx.json 的文件, 主要的默认配置， 我们是通过 appsettings.json  配置。但是由于开发需要， 我们提供了根据数据库不通而不通的配置， 可以根据你使用情况来参考这些配置。 比如， 环境中使用Mysql ， 可以把   appsettings.MySql.json  改为 appsettings.Production.json  。但推荐通过环境变量 ASPNETCORE_ENVIRONMENT  来决定使用的配置文件，   比如 ASPNETCORE_ENVIRONMENT 设置为 MySQL ， 使用的配置文件就是 appsettings.MySQL.json 文件， 如果ASPNETCORE_ENVIRONMENT 设置为 Sqlite，使用的配置文件就是 appsettings.Sqlite.json 文件。于此同时， 在VS中调试时 ， 也通过 launchSettings.json 文件预配了支持的数据库 环境变量和对应的文件 ， 方便调试， 只需要在VS中选择调试环境即可。  

# 数据库和中间件配置

  开始使用前， 我们需要最先了解的应该是数据库， 数据如何存放， 时序数据如何存放等， 这里我们考虑到了各种情况， 多种数据库和多种中间件的组合，你可以根据你的喜好， 选择五种关系型数据库的其中一个， 也可以从我们支持的时序数据库中选择一个， 当然， 你可以选择在关系数据库中存储时序数据， 可以选择单表 ， 也可以选择分表， 如果分表， 你可以选择按分钟， 按日， 按月， 按年，也可以选择各种支持的 消息中间件等，  下面我们描述如何配置他们：

1. 你需要通过 "DataBase" 来指定关系型数据库， 比如指定为  "Sqlite"。 
2. 配置关系型数据库连接字符串 ， 通过  "ConnectionStrings"  中的 "IoTSharp"配置项配置关系型数据库连接字符串，  比如 "Data Source=IoTSharp.db"
3. 配置时序存储模式 ， 通过 "TelemetryStorage" 来配置时序数据存储方式， 比如 我们在Sqlite中使用分表模式， 那么就需要 "Sharding" , 如果是单表就填写为 SingleTable , 如果使用InfluxDB , 则填写InfluxDB。
4. 配置时序存储连接字符串。外部时序数据库通过 "ConnectionStrings" 中的 "TelemetryStorage" 配置；如果 History 使用 `SingleTable`、`Sharding` 等关系型模式，并且希望与业务数据共用同一个关系数据库，则可以只配置 `ConnectionStrings:IoTSharp`，系统会自动回退使用该连接。
5. 配置事件总线中间件, 通过配置项"EventBusMQ" 来配置消息总线使用什么中间件， 你可以配置 RabbitMQ或 内存模式 InMemory ，如果使用了InMemory可以不用配置连接字符串，请忽略 第六条。  
6. 配置事件总线连接字符串 ，通过"ConnectionStrings"中的 "EventBusMQ" 来配置连接字符串， 内存模式时不需要配人， 但比如当我们使用 RabbitMQ等中间件时则需要配置， 比如  "EventBusMQ": "amqp://root:kissme@rabbitmq:5672"
7. 配置事件总线消息存储方式， 我们通过 "EventBusStore" 来设置用何种方式来存储消息， 比如使用， MongoDB, 那么就需要将配置项 "EventBusStore" 改为 MongoDB, 也可以使用 InMemory， 如果使用了InMemory可以不配置 连接字符串，请忽略第八条。 
8. 配置事件消息存储连接字符串 ， 如果使用了MongoDB 等一些存储消息的组件， 那么需要通过 通过"ConnectionStrings"中的 "EventBusStore" 来配置， 比如 如果使用了MongoDB 的连接字符串是 "mongodb://root:kissme@mongodb:27017



# 支持的关系型数据库配置项
配置项名称是 DataBase

  1. PostgreSql
  2. SqlServer
  3. MySql
  4. Oracle
  5. Sqlite
  6. InMemory

 # 支持的时序数据库及其配置项
 配置项名称是 TelemetryStorage 

 1. SingleTable
 2. Sharding
 3. Taos
 4. InfluxDB
 5. PinusDB
 6. TimescaleDB
 7. IoTDB
 8. SonnetDB

## 遥测存储组合模式

IoTSharp 支持由客户选择“纯关系型数据库”或“关系型业务数据库 + 独立时序数据库”。原有 `TelemetryStorage` 配置继续兼容；如果不配置 `TelemetryHistoryStorage`，系统会继续使用 `TelemetryStorage`，旧部署无需修改配置。

- `TelemetryHistoryStorage`：可选，指定 Telemetry History Provider；未配置时回退到 `TelemetryStorage`。
- `TelemetryLatestStorage`：指定最新值存储位置。`SameAsHistory` 保持原有行为；`Relational` 表示最新值保存在业务关系数据库中。
- `ConnectionStrings:IoTSharp`：业务关系数据库连接字符串；混合模式下 Latest 使用该连接。
- `ConnectionStrings:TelemetryStorage`：Telemetry History Provider 的连接字符串。`InfluxDB`、`Taos`、`IoTDB`、`SonnetDB` 等独立时序 History 必须显式配置；关系型 History 如果与业务库共库，可以省略并自动复用 `ConnectionStrings:IoTSharp`。
- 对于关系型 History，系统启动时会把最终解析出的 History 连接串标准化为运行时 `ConnectionStrings:TelemetryStorage`；因此旧部署只配置 `ConnectionStrings:IoTSharp` 时仍可使用 SQL Server 分片 BulkCopy 等高吞吐快路径，不需要为了性能强制增加重复配置。显式配置 `TelemetryStorage` 时始终优先使用该值，因此也可以把 History 放在独立关系型数据库中。

### 纯关系型数据库

适合只希望维护一套 SQL Server 的客户。历史数据和最新值都保存在同一关系数据库时，只需要一条 `IoTSharp` 连接字符串：

```json
{
  "DataBase": "SqlServer",
  "TelemetryHistoryStorage": "Sharding",
  "TelemetryLatestStorage": "SameAsHistory",
  "ConnectionStrings": {
    "IoTSharp": "Server=localhost;Database=IoTSharp;Trusted_Connection=True;TrustServerCertificate=True"
  }
}
```

如果希望业务库与关系型 Telemetry History 使用不同数据库，仍然可以单独配置 `ConnectionStrings:TelemetryStorage`。

旧配置仍然有效，例如：

```json
{
  "TelemetryStorage": "Sharding"
}
```

### 关系型数据库 + 独立时序数据库

适合业务数据和最新值继续保存在 SQL Server，而大量历史遥测进入独立时序数据库的客户。例如 InfluxDB：

```json
{
  "DataBase": "SqlServer",
  "TelemetryHistoryStorage": "InfluxDB",
  "TelemetryLatestStorage": "Relational",
  "ConnectionStrings": {
    "IoTSharp": "Server=localhost;Database=IoTSharp;Trusted_Connection=True;TrustServerCertificate=True",
    "TelemetryStorage": "http://localhost:8086/?org=iotsharp&bucket=iotsharp-bucket&token=iotsharp-token"
  }
}
```

该模式下：

- History 写入和历史查询走时序数据库。
- Latest 写入和最新值查询走业务关系数据库。
- History 不会再重复写入关系数据库。
- Latest 与 History 之间不声明分布式事务；Latest 使用幂等写入并先于 History 写入，便于失败后安全重试。
- 外部 History Provider 缺少 `ConnectionStrings:TelemetryStorage` 时，应用会在启动配置阶段给出明确错误。
- 使用 `TelemetryLatestStorage=Relational` 时必须配置 `ConnectionStrings:IoTSharp`。

当前可作为独立 History Provider 参与该混合模式的实现包括 `InfluxDB`、`Taos`、`IoTDB` 和 `SonnetDB`。

`SingleTable`、`Sharding` 继续使用原有关系型 History + Latest 行为。当前 `TimescaleDBStorage` 仍直接复用 `ApplicationDbContext`，所以 `TelemetryHistoryStorage=TimescaleDB` 目前要求 `DataBase=PostgreSql`；如果配置为 SQL Server 等其他业务数据库，应用会在启动阶段直接报出明确错误。若后续需要“业务 SQL Server + 独立 TimescaleDB History”，需要为 TimescaleDB 单独拆分 History DbContext。

### 高吞吐 History 配置

- `TelemetryHistoryTransactionRows`：SQL Server 月分片 History 的单事务最大行数，默认 `50000`。只影响 SQL Server 分片 `SqlBulkCopy` 快路径；PostgreSQL、MySQL、Oracle、SQLite 以及外部时序数据库保持各自原有写入实现。
- `TelemetryHistorySpool`：可选 durable History 本地缓冲。启用后先将 History 原子写入本地 spool，再提交 Latest/规则链，History 由后台 worker 顺序落库。当前只在 `SqlServer + Sharding + PerMonth` 组合注册；其他数据库继续走原有同步存储路径。
- `TelemetryHistoryShardIndexMode`：History 分片物理索引策略，默认 `ProviderDefault`。
  - `ProviderDefault`：保持 EF/数据库 Provider 原有索引模型，是所有数据库的兼容默认值。
  - `WriteOptimizedHotShard`：当前只对 `SqlServer + Sharding + PerMonth` 生效。当前月热分片在 History 写入前移除 `(DeviceId, DateTime)` 二级索引以降低追加写的索引维护开销；上一月和其他被写入的冷分片会确保恢复该查询索引。
  - PostgreSQL、MySQL、Oracle、SQLite 以及外部时序 History Provider 即使配置 `WriteOptimizedHotShard`，也不会执行 SQL Server DDL，而是继续保持 Provider 默认行为。

示例：

```json
{
  "DataBase": "SqlServer",
  "TelemetryHistoryStorage": "Sharding",
  "ShardingByDateMode": "PerMonth",
  "TelemetryHistoryTransactionRows": 50000,
  "TelemetryHistoryShardIndexMode": "WriteOptimizedHotShard",
  "TelemetryHistorySpool": {
    "Enabled": true,
    "Directory": "runtime-data/telemetry-history-spool",
    "RetryDelayMilliseconds": 1000,
    "IdleDelayMilliseconds": 100
  }
}
```

如果部署需要优先保证跨数据库一致行为，不配置这些高级选项即可，系统会保持 `ProviderDefault` 和原有 Provider 路径。

# 支持的事件总线
 配置项名称为 EventBusMQ

 1. RabbitMQ
 2. Kafka
 3. InMemory
 4. ZeroMQ
 5. NATS
 6. Pulsar
 7. RedisStreams
 8. AmazonSQS
 9. AzureServiceBus

# 支持的事件总线存储方式
配置项名称为 EventBusStore     
   1. PostgreSql
   2. MongoDB  
   3. InMemory
   4. LiteDB
   5. MySql
   6. SqlServer


    下面是几个示例:

