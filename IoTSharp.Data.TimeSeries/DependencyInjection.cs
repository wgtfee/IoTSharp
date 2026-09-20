using IoTSharp.Contracts;
using IoTSharp.Data.Shardings;
using IoTSharp.Storage;
using Microsoft.Extensions.DependencyInjection;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using ShardingCore;
using IoTSharp.Data.Shardings.Routes;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.ObjectPool;
using IoTSharp.Data.Taos;
using InfluxDB.Client;
using IoTSharp.Data.SonnetDB;
using ShardingCore.TableExists.Abstractions;
using System.Collections.Specialized;
using System.Web;

namespace IoTSharp.Data.TimeSeries
{
    public static class DependencyInjection
    {
        public static void AddTelemetryStorage(this IServiceCollection services, AppSettings settings, IHealthChecksBuilder healthChecks)
        {
            var runtimeConfiguration = TelemetryStorageConfigurationResolver.Resolve(settings);
            services.AddSingleton(runtimeConfiguration);
            healthChecks.AddCheck<TelemetryStorageConfigurationHealthCheck>(
                "Telemetry Storage Configuration",
                tags: new[] { "telemetry", "configuration", "readiness" });

            var historyStorage = runtimeConfiguration.HistoryStorage;
            string _hc_telemetryStorage = $"{nameof(TelemetryStorage)}-{Enum.GetName(historyStorage)}";
            var _connectionString = runtimeConfiguration.HistoryConnectionString;
            settings.ConnectionStrings ??= new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            settings.ConnectionStrings["TelemetryStorage"] = _connectionString;
            var useRelationalLatestFacade = settings.TelemetryLatestStorage == TelemetryLatestStorageMode.Relational
                                            && runtimeConfiguration.UsesIndependentHistoryProvider;

            var historyImplementation = RegisterHistoryStorage(
                services,
                settings,
                healthChecks,
                historyStorage,
                _connectionString,
                _hc_telemetryStorage,
                registerAsDefaultStorage: !useRelationalLatestFacade);

            if (useRelationalLatestFacade)
            {
                services.AddSingleton<IRelationalTelemetryLatestStore, RelationalTelemetryLatestStore>();
                services.AddSingleton<CompositeTelemetryStorage>(sp => new CompositeTelemetryStorage(
                    (IStorage)sp.GetRequiredService(historyImplementation),
                    sp.GetRequiredService<IRelationalTelemetryLatestStore>()));
                services.AddSingleton<IStorage>(sp => sp.GetRequiredService<CompositeTelemetryStorage>());
            }
        }

        private static Type RegisterHistoryStorage(
            IServiceCollection services,
            AppSettings settings,
            IHealthChecksBuilder healthChecks,
            TelemetryStorage historyStorage,
            string connectionString,
            string healthCheckName,
            bool registerAsDefaultStorage)
        {
            switch (historyStorage)
            {
                case TelemetryStorage.Sharding:
                    ShardingByDateMode settingsShardingByDateMode = settings.ShardingByDateMode;
                    var _sharding = services.AddShardingDbContext<ShardingDbContext>();
                    _sharding.UseRouteConfig(o =>
                    {
                        switch (settingsShardingByDateMode)
                        {
                            case ShardingByDateMode.PerMinute:
                                o.AddShardingTableRoute<TelemetryDataMinuteRoute>();
                                break;
                            case ShardingByDateMode.PerHour:
                                o.AddShardingTableRoute<TelemetryDataHourRoute>();
                                break;
                            case ShardingByDateMode.PerDay:
                                o.AddShardingTableRoute<TelemetryDataDayRoute>();
                                break;
                            case ShardingByDateMode.PerMonth:
                                o.AddShardingTableRoute<TelemetryDataMonthRoute>();
                                break;
                            case ShardingByDateMode.PerYear:
                                o.AddShardingTableRoute<TelemetryDataYearRoute>();
                                break;
                            default: throw new InvalidOperationException($"unknown sharding mode:{settingsShardingByDateMode}");
                        }
                    });
                    _sharding.UseConfig(o =>
                    {
                        o.ThrowIfQueryRouteNotMatch = false;
                        o.UseShellDbContextConfigure(builder => builder.UseQueryTrackingBehavior(QueryTrackingBehavior.NoTracking));
                        o.AddDefaultDataSource("ds0", connectionString);
                        switch (settings.DataBase)
                        {
                            case DataBaseType.MySql:
                                o.UseMySqlToSharding();
                                break;

                            case DataBaseType.SqlServer:
                                o.UseSqlServerToSharding();
                                break;

                            case DataBaseType.Oracle:
                                o.UseOracleToSharding();
                                break;

                            case DataBaseType.Sqlite:
                                o.UseSQLiteToSharding();
                                break;
                            case DataBaseType.SonnetDB:
                                o.UseSonnetDBToSharding();
                                break;
                            case DataBaseType.PostgreSql:
                            default:
                                o.UseNpgsqlToSharding();
                                break;
                        }
                    });
                    _sharding.AddShardingCore();
                    if (settings.DataBase == DataBaseType.SonnetDB)
                    {
                        services.AddSingleton<ITableEnsureManager, SonnetDbTableEnsureManager>();
                    }
                    return RegisterStorage<ShardingStorage>(services, registerAsDefaultStorage);

                case TelemetryStorage.Taos:
                    var taosType = RegisterStorage<TaosStorage>(services, registerAsDefaultStorage);
                    healthChecks.AddTDengine(new TaosConnectionStringBuilder(connectionString).UseRESTful().ConnectionString, name: healthCheckName);
                    return taosType;
                case TelemetryStorage.InfluxDB:
                    //https://github.com/julian-fh/influxdb-setup
                    //"TelemetryStorage": "http://localhost:8086/?org=iotsharp&bucket=iotsharp-bucket&token=iotsharp-token"
                    services.AddObjectPool(() => new InfluxDBClient(CreateInfluxDbClientOptions(connectionString)));
                    services.AddSingleton<InfluxTelemetryHistoryWriter>();
                    var influxType = RegisterStorage<InfluxDBStorage>(services, registerAsDefaultStorage);
                    healthChecks.AddInfluxDB(connectionString, name: healthCheckName);
                    return influxType;

                case TelemetryStorage.PinusDB:
                    throw new NotSupportedException("PinusDB is not supported yet");
                case TelemetryStorage.TimescaleDB:
                    return RegisterStorage<TimescaleDBStorage>(services, registerAsDefaultStorage);
                case TelemetryStorage.IoTDB:
                    var str = connectionString;
                    var ioTDbConnectionString = RemoveConnectionStringKey(str, "DefaultGroupName");
                    services.AddSingleton(s =>
                    {
                        return new Apache.IoTDB.Data.IoTDBConnection(ioTDbConnectionString);
                    });
                    services.AddSingleton<IoTDBTelemetryHistoryWriter>();
                    var iotDbType = RegisterStorage<IoTDBStorage>(services, registerAsDefaultStorage);
                    healthChecks.AddIoTDB(ioTDbConnectionString);
                    return iotDbType;
                case TelemetryStorage.SonnetDB:
                    return RegisterStorage<SonnetDBStorage>(services, registerAsDefaultStorage);
                case TelemetryStorage.SingleTable:
                default:
                    if (settings.DataBase == DataBaseType.SqlServer)
                    {
                        return RegisterStorage<SqlServerStorage>(services, registerAsDefaultStorage);
                    }
                    else
                    {
                        return RegisterStorage<EFStorage>(services, registerAsDefaultStorage);
                    }
            }
        }

        private static string RemoveConnectionStringKey(string connectionString, string key)
            => string.Join(
                ';',
                connectionString
                    .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Where(item =>
                    {
                        var pair = item.Split('=', 2, StringSplitOptions.TrimEntries);
                        return pair.Length != 2 || !pair[0].Equals(key, StringComparison.OrdinalIgnoreCase);
                    }));

        private static Type RegisterStorage<TStorage>(IServiceCollection services, bool registerAsDefaultStorage)
            where TStorage : class, IStorage
        {
            if (registerAsDefaultStorage)
            {
                services.AddSingleton<IStorage, TStorage>();
            }
            else
            {
                services.AddSingleton<TStorage>();
            }

            return typeof(TStorage);
        }

        private static InfluxDBClientOptions CreateInfluxDbClientOptions(string connectionString)
        {
            Uri uri = new Uri(connectionString);
            NameValueCollection query = HttpUtility.ParseQueryString(uri.Query);
            var builder = InfluxDBClientOptions.Builder.CreateNew()
                .Url(uri.GetLeftPart(UriPartial.Authority));

            string? token = query.Get("token");
            if (!string.IsNullOrWhiteSpace(token))
            {
                builder.AuthenticateToken(token);
            }

            string? org = query.Get("org");
            if (!string.IsNullOrWhiteSpace(org))
            {
                builder.Org(org);
            }

            string? bucket = query.Get("bucket");
            if (!string.IsNullOrWhiteSpace(bucket))
            {
                builder.Bucket(bucket);
            }

            return builder.Build();
        }
    }
}
