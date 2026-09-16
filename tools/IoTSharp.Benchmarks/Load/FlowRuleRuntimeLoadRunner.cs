using IoTSharp.Data;
using IoTSharp.FlowRuleEngine;
using Microsoft.Extensions.Logging.Abstractions;
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Dynamic;
using System.Linq;
using System.Threading.Tasks;

namespace IoTSharp.Benchmarks.Load;

internal static class FlowRuleRuntimeLoadRunner
{
    public static async Task<int> RunAsync(string[] args)
    {
        var iterations = ReadInt(args, "--iterations", 100_000);
        var warmup = Math.Min(2_000, Math.Max(100, iterations / 20));
        var mode = ReadString(args, "--mode", "both").ToLowerInvariant();
        var task = BuildRuleTask();
        var graph = BuildGraph();
        dynamic payload = new ExpandoObject();
        payload.Value = 42L;
        payload.Enabled = true;

        if (mode is "engine" or "both")
        {
            var executor = new SimpleFlowExcutor();
            for (var i = 0; i < warmup; i++)
                await executor.Excute(new FlowExcuteEntity { Task = task, Params = payload });
            var result = await MeasureAsync(iterations, async () =>
            {
                var rules = await executor.Excute(new FlowExcuteEntity { Task = task, Params = payload });
                if (rules.Count != 1 || !rules[0].IsSuccess)
                    throw new InvalidOperationException("RulesEngine validation failed.");
            });
            Print("engine", iterations, result);
        }

        if (mode is "runtime" or "both")
        {
            var executor = new FlowRuleRuntimeExecutor(
                NullLogger<FlowRuleRuntimeExecutor>.Instance,
                null,
                null,
                1000);
            for (var i = 0; i < warmup; i++)
            {
                var warm = await executor.ExecuteAsync(graph.Flows, graph.Start, payload, Guid.Empty, "{\"Value\":42,\"Enabled\":true}");
                if (!warm.ReachedEnd || !warm.Succeeded)
                    throw new InvalidOperationException("Runtime warmup validation failed.");
            }
            var result = await MeasureAsync(iterations, async () =>
            {
                var run = await executor.ExecuteAsync(graph.Flows, graph.Start, payload, Guid.Empty, "{\"Value\":42,\"Enabled\":true}");
                if (!run.ReachedEnd || !run.Succeeded)
                    throw new InvalidOperationException("Runtime validation failed.");
            });
            Print("runtime", iterations, result);
        }

        Console.WriteLine("FLOW_RULE_RUNTIME_LOAD_OK");
        return 0;
    }

    private static async Task<Measurement> MeasureAsync(int iterations, Func<Task> action)
    {
        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        var before = GC.GetTotalAllocatedBytes(true);
        var gen0 = GC.CollectionCount(0);
        var gen1 = GC.CollectionCount(1);
        var gen2 = GC.CollectionCount(2);
        var sw = Stopwatch.StartNew();
        for (var i = 0; i < iterations; i++)
            await action();
        sw.Stop();
        var allocated = GC.GetTotalAllocatedBytes(true) - before;
        return new Measurement(sw.Elapsed, allocated,
            GC.CollectionCount(0) - gen0,
            GC.CollectionCount(1) - gen1,
            GC.CollectionCount(2) - gen2);
    }

    private static void Print(string mode, int iterations, Measurement result)
    {
        var seconds = Math.Max(0.000001, result.Elapsed.TotalSeconds);
        Console.WriteLine($"mode={mode} iterations={iterations:N0} elapsedMs={result.Elapsed.TotalMilliseconds:N1} opsPerSec={iterations / seconds:N0}");
        Console.WriteLine($"mode={mode} allocatedMB={result.AllocatedBytes / 1024d / 1024d:N1} bytesPerOp={result.AllocatedBytes / (double)iterations:N1} gcGen0={result.Gen0} gcGen1={result.Gen1} gcGen2={result.Gen2}");
    }

    private static BaseRuleTask BuildRuleTask() => new()
    {
        id = "benchmark-start",
        outgoing =
        [
            new BaseRuleFlow { id = "benchmark-edge", Expression = "Value > 0 && Enabled == true" }
        ]
    };

    private static (Flow Start, List<Flow> Flows) BuildGraph()
    {
        var start = new Flow { FlowId = Guid.NewGuid(), bpmnid = "start", FlowType = "bpmn:StartEvent", FlowStatus = 1 };
        var firstEdge = new Flow
        {
            FlowId = Guid.NewGuid(), bpmnid = "edge-1", FlowType = "bpmn:SequenceFlow", FlowStatus = 1,
            SourceId = "start", TargetId = "task-1", Conditionexpression = "Value > 0 && Enabled == true"
        };
        var task = new Flow { FlowId = Guid.NewGuid(), bpmnid = "task-1", FlowType = "bpmn:Task", FlowStatus = 1 };
        var secondEdge = new Flow
        {
            FlowId = Guid.NewGuid(), bpmnid = "edge-2", FlowType = "bpmn:SequenceFlow", FlowStatus = 1,
            SourceId = "task-1", TargetId = "end-1", Conditionexpression = string.Empty
        };
        var end = new Flow { FlowId = Guid.NewGuid(), bpmnid = "end-1", FlowType = "bpmn:EndEvent", FlowStatus = 1 };
        return (start, [start, firstEdge, task, secondEdge, end]);
    }

    private static int ReadInt(string[] args, string name, int fallback)
    {
        for (var i = 0; i < args.Length - 1; i++)
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase) && int.TryParse(args[i + 1], out var value) && value > 0)
                return value;
        return fallback;
    }

    private static string ReadString(string[] args, string name, string fallback)
    {
        for (var i = 0; i < args.Length - 1; i++)
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase))
                return args[i + 1];
        return fallback;
    }

    private readonly record struct Measurement(TimeSpan Elapsed, long AllocatedBytes, int Gen0, int Gen1, int Gen2);
}
