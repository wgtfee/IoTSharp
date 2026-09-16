using BenchmarkDotNet.Running;
using IoTSharp.Benchmarks.Load;
using System;
using System.Linq;

if (args.Any(arg => string.Equals(arg, "--coap-load", StringComparison.OrdinalIgnoreCase)))
{
    return await CoapLoadRunner.RunAsync(args);
}

if (args.Any(arg => string.Equals(arg, "--gateway-ingest-load", StringComparison.OrdinalIgnoreCase)))
{
    return await GatewayIngestLoadRunner.RunAsync(args);
}

if (args.Any(arg => string.Equals(arg, "--telemetry-rule-load", StringComparison.OrdinalIgnoreCase)))
{
    return await TelemetryRuleLoadRunner.RunAsync(args);
}

if (args.Any(arg => string.Equals(arg, "--flow-rule-runtime-load", StringComparison.OrdinalIgnoreCase)))
{
    return await FlowRuleRuntimeLoadRunner.RunAsync(args);
}

if (args.Any(arg => string.Equals(arg, "--task-action-conversion-load", StringComparison.OrdinalIgnoreCase)))
{
    return await TaskActionConversionLoadRunner.RunAsync(args);
}

if (args.Any(arg => string.Equals(arg, "--sqlserver-batch-build-load", StringComparison.OrdinalIgnoreCase)))
{
    return SqlServerBatchBuildLoadRunner.Run(args);
}

if (args.Any(arg => string.Equals(arg, "--pipeline-drain-check", StringComparison.OrdinalIgnoreCase)))
{
    return await PipelineShutdownCheckRunner.RunAsync();
}

BenchmarkSwitcher.FromAssembly(typeof(Program).Assembly).Run(args);
return 0;
