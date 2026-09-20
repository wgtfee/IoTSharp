
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Linq;
using System.Threading.Tasks;

namespace IoTSharp.Contracts
{
    public enum TelemetryStorage
    {
        SingleTable,
        Sharding,
        Taos,
        InfluxDB,
        PinusDB,
        TimescaleDB,
        IoTDB,
        SonnetDB
    }
    public enum TelemetryLatestStorageMode
    {
        SameAsHistory,
        Relational
    }
    public enum TelemetryPersistenceMode
    {
        /// <summary>
        /// Preserve legacy configuration semantics and infer the active topology.
        /// </summary>
        Auto,
        /// <summary>
        /// Business data, Latest telemetry and History telemetry all remain in relational storage.
        /// </summary>
        RelationalOnly,
        /// <summary>
        /// Business data and Latest telemetry remain relational while History uses an independent time-series provider.
        /// </summary>
        RelationalWithTimeSeries
    }
    public enum TelemetryHistoryShardIndexMode
    {
        ProviderDefault,
        WriteOptimizedHotShard
    }
    public enum EventBusStore
    {
        PostgreSql,
        MongoDB,
        InMemory,
        LiteDB,
        MySql,
        SqlServer
    }
    public enum EventBusMQ
    {
        RabbitMQ,
        Kafka,
        InMemory,
        ZeroMQ,
        NATS,
        Pulsar,
        RedisStreams,
        AmazonSQS,
        AzureServiceBus,
        SonnetMQ
    }
    public enum CachingUseIn
    {
        InMemory,
        Redis,
        LiteDB,
        SQlite,
        SonnetDB
    }
    public enum EventBusFramework
    {
        CAP,
        Shashlik,
        SonnetMQ,
    }
    public sealed class TelemetryHistorySpoolSetting
    {
        public bool Enabled { get; set; } = false;
        public string Directory { get; set; } = "runtime-data/telemetry-history-spool";
        public int RetryDelayMilliseconds { get; set; } = 1000;
        public int IdleDelayMilliseconds { get; set; } = 100;
    }

    public class AppSettings
    {
        public string? JwtKey { get; set; }
        public string? JwtIssuer { get; set; }
        public string? JwtAudience { get; set; }
        public double JwtExpireHours { get; set; }

        [DefaultValue(EventBusFramework.CAP)]
        public EventBusFramework EventBus { get; set; } = EventBusFramework.CAP;
        /// <summary>
        /// Broker settings
        /// </summary>
        public MqttBrokerSetting MqttBroker { get; set; } = new MqttBrokerSetting();
        /// <summary>
        /// mqtt client settings
        /// </summary>
        public MqttClientSetting MqttClient { get; set; } = new MqttClientSetting() { MqttBroker = "built-in", UserName = Guid.NewGuid().ToString(), Password = Guid.NewGuid().ToString(), Port = 1883 };
        public Dictionary<string, string>? ConnectionStrings { get; set; }

        public ModBusServerSetting ModBusServer { get; set; } = new ModBusServerSetting();

        public TelemetryStorage TelemetryStorage { get; set; } = TelemetryStorage.SingleTable;

        /// <summary>
        /// Optional history provider override. When omitted, the legacy TelemetryStorage setting is used.
        /// </summary>
        public TelemetryStorage? TelemetryHistoryStorage { get; set; }

        /// <summary>
        /// High-level telemetry persistence topology. Auto keeps existing deployments backward compatible.
        /// New deployments should prefer RelationalOnly or RelationalWithTimeSeries explicitly.
        /// </summary>
        public TelemetryPersistenceMode TelemetryMode { get; set; } = TelemetryPersistenceMode.Auto;

        /// <summary>
        /// Controls where latest telemetry values are read/written.
        /// SameAsHistory preserves legacy behavior; Relational keeps latest values in the business database.
        /// </summary>
        public TelemetryLatestStorageMode TelemetryLatestStorage { get; set; } = TelemetryLatestStorageMode.SameAsHistory;

        /// <summary>
        /// Maximum number of sharded SQL Server History rows committed in one transaction.
        /// Smaller transactions reduce log/lock hold time while preserving ordered sequential writes.
        /// </summary>
        public int TelemetryHistoryTransactionRows { get; set; } = 50_000;
        /// <summary>
        /// Maximum number of PostgreSQL sharded History rows written by one binary COPY transaction.
        /// </summary>
        public int TelemetryPostgreSqlCopyRows { get; set; } = 50_000;
        /// <summary>
        /// Maximum number of InfluxDB telemetry field values written by one Write API batch.
        /// 25,000 is the current verified InfluxDB 2.7.5 local baseline; the writer clamps
        /// environment-specific overrides to 1,000..100,000.
        /// </summary>
        public int TelemetryInfluxBatchValues { get; set; } = 25_000;
        public bool TelemetryInfluxGzipEnabled { get; set; } = true;
        /// <summary>
        /// Maximum rows placed in one IoTDB Tablet. Kept configurable so the provider can
        /// be A/B benchmarked independently from relational and Influx batch sizes.
        /// </summary>
        public int TelemetryIoTDBTabletRows { get; set; } = 10_000;
        /// <summary>
        /// Maximum number of device/schema Tablets sent by one InsertTabletsAsync RPC.
        /// SessionPool size remains controlled by the IoTDB connection-string PoolSize option.
        /// </summary>
        public int TelemetryIoTDBTabletsPerWrite { get; set; } = 64;
        /// <summary>
        /// Safety bound for the total number of dense Tablet field values carried by one
        /// InsertTabletsAsync RPC. This prevents a wide schema multiplied by many Tablets
        /// from creating multi-million-value request bodies and excessive temporary memory.
        /// </summary>
        public int TelemetryIoTDBMaxValuesPerWrite { get; set; } = 250_000;
        public TelemetryHistorySpoolSetting TelemetryHistorySpool { get; set; } = new();
        public TelemetryHistoryShardIndexMode TelemetryHistoryShardIndexMode { get; set; } = TelemetryHistoryShardIndexMode.ProviderDefault;

        public TelemetryStorage EffectiveTelemetryHistoryStorage => TelemetryHistoryStorage ?? TelemetryStorage;


        public EventBusStore EventBusStore { get; set; } = EventBusStore.InMemory;
        public EventBusMQ EventBusMQ { get; set; } = EventBusMQ.InMemory;
        public int ConsumerThreadCount { get; set; } = Environment.ProcessorCount;
        public int DbContextPoolSize { get; set; } = 128;
        public CachingUseIn CachingUseIn { get; set; } = CachingUseIn.InMemory;
        public string? CachingUseRedisHosts { get; set; }
        public string? CachingUseSonnetDBConnectionString { get; set; }
        public string CachingUseSonnetDBKeyspace { get; set; } = "cache";
        public string CachingUseSonnetDBNamespace { get; set; } = "iotsharp";
        //public DiscoveryOptions Discovery { get; set; } = null;
        //public ZMQOption ZMQOption { get; set; } = null;
        public int SucceedMessageExpiredAfter { get; set; } = 3600 * 6;
        public DataBaseType DataBase { get; set; } = DataBaseType.PostgreSql;
        public int RuleCachingExpiration { get; set; } = 60;
        public int RuleExecutionMaxConcurrency { get; set; } = Math.Clamp(Environment.ProcessorCount, 1, 8);
        public ShardingByDateMode ShardingByDateMode { get; set; } = ShardingByDateMode.PerMonth;

        private DateTime shardingBeginTime;
        public DateTime ShardingBeginTime
        {
            get
            {
                //shardingBeginTime没值时给默认值
                if (shardingBeginTime == DateTime.MinValue || shardingBeginTime.Year <= 1970)
                {
                    switch (ShardingByDateMode)
                    {
                        case ShardingByDateMode.PerMinute:
                            shardingBeginTime = DateTime.UtcNow.AddMinutes(-5);
                            break;
                        case ShardingByDateMode.PerHour:
                            shardingBeginTime = DateTime.UtcNow.AddHours(-1);
                            break;
                        case ShardingByDateMode.PerDay:
                            shardingBeginTime = DateTime.UtcNow.AddDays(-1).Date;
                            break;
                        case ShardingByDateMode.PerMonth:
                            shardingBeginTime = DateTime.UtcNow.AddMonths(-1).Date;
                            break;
                        case ShardingByDateMode.PerYear:
                            shardingBeginTime = DateTime.UtcNow.AddYears(-1).Date;
                            break;
                        default:
                            shardingBeginTime = DateTime.UtcNow.Date;
                            break;
                    }
                }
                return shardingBeginTime;
            }
            set
            {
                shardingBeginTime = value;
            }

        }

        public string? RootKey { get; set; }
    }
    public enum ShardingByDateMode
    {
        //
        // 摘要:
        //     每分钟
        PerMinute,
        //
        // 摘要:
        //     每小时
        PerHour,
        //
        // 摘要:
        //     每天
        PerDay,
        //
        // 摘要:
        //     每月
        PerMonth,
        //
        // 摘要:
        //     每年
        PerYear
    }
    public class ModBusServerSetting
    {
        public int Port { get; set; } = 502;
        public int TimeOut { get; set; } = 120000;
    }
    public class MqttClientSetting
    {
        /// <summary>
        /// built-in or IP、HostName
        /// </summary>
        public string? MqttBroker { get; set; }
        public string? UserName { get; set; }
        public string? Password { get; set; }
        public int Port { get; set; }
    }
}
