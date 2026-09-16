using Microsoft.Extensions.DependencyInjection;
using IoTSharp.Contracts;
using System;

namespace IoTSharp.EventBus
{
    [Flags]
    public enum TelemetryRuleDispatchMode
    {
        None = 0,
        Telemetry = 1,
        TelemetryArray = 2,
        All = Telemetry | TelemetryArray
    }

    public class EventBusOption
    {
        public EventBusOption()
        {
            DispatchTelemetryRules = async (devid, telemetry, telemetryArray) =>
            {
                if (telemetry != null)
                {
                    await RunRules(devid, telemetry, EventType.Telemetry);
                }
                if (telemetryArray != null)
                {
                    await RunRules(devid, telemetryArray, EventType.TelemetryArray);
                }
            };
            GetTelemetryRuleDispatchMode = async devid =>
                await ShouldDispatchTelemetryRules(devid)
                    ? TelemetryRuleDispatchMode.All
                    : TelemetryRuleDispatchMode.None;
        }

#pragma warning disable CS8618 // 在退出构造函数时，不可为 null 的字段必须包含非 null 值。请考虑声明为可以为 null。
        public AppSettings AppSettings { get; set; }

        public EventBusFramework EventBus => AppSettings.EventBus;



        public string EventBusStore { get; set; }

        public string EventBusMQ { get; set; }
        public IHealthChecksBuilder HealthChecks { get; set; }
        public IServiceCollection services { get; internal set; }

        public delegate Task RunRulesEventHander(Guid devid, object obj, EventType mountType);

        public delegate Task DispatchTelemetryRulesEventHander(Guid devid, object? telemetry, object? telemetryArray);
        public delegate Task<bool> ShouldDispatchTelemetryRulesEventHander(Guid devid);
        public delegate Task<TelemetryRuleDispatchMode> GetTelemetryRuleDispatchModeEventHander(Guid devid);

        public RunRulesEventHander RunRules = (_, _, _) => Task.CompletedTask;
        public DispatchTelemetryRulesEventHander DispatchTelemetryRules;
        public ShouldDispatchTelemetryRulesEventHander ShouldDispatchTelemetryRules = _ => Task.FromResult(true);
        public GetTelemetryRuleDispatchModeEventHander GetTelemetryRuleDispatchMode;
#pragma warning restore CS8618 // 在退出构造函数时，不可为 null 的字段必须包含非 null 值。请考虑声明为可以为 null。
    }
}
