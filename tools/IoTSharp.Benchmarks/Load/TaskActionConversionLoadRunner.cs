using IoTSharp.TaskActions;
using System;
using System.Diagnostics;
using System.Threading.Tasks;

namespace IoTSharp.Benchmarks.Load;

internal static class TaskActionConversionLoadRunner
{
    private const string Json = "{\"device\":\"D001\",\"temperature\":23.5,\"enabled\":true,\"values\":[1,2,3,4,5,6,7,8]}";

    public static Task<int> RunAsync(string[] args)
    {
        var iterations = ReadInt(args, "--iterations", 500_000);
        var dynamicValue = new { device = "D001", temperature = 23.5, enabled = true, values = new[] { 1, 2, 3, 4, 5, 6, 7, 8 } };

        Measure("input-same", iterations, () =>
        {
            var input = new TaskActionInput { Input = Json };
            if (!ReferenceEquals(input.Input, Json) && input.Input != Json)
                throw new InvalidOperationException();
        });

        Measure("input-cross", iterations, () =>
        {
            var input = new TaskActionInput { Input = Json };
            if (input.DynamicInput == null)
                throw new InvalidOperationException();
        });

        Measure("output-same", iterations, () =>
        {
            var output = new TaskActionOutput { DynamicOutput = dynamicValue };
            if (!ReferenceEquals((object)output.DynamicOutput, dynamicValue))
                throw new InvalidOperationException();
        });

        Measure("output-cross", iterations, () =>
        {
            var output = new TaskActionOutput { DynamicOutput = dynamicValue };
            if (string.IsNullOrEmpty(output.Output))
                throw new InvalidOperationException();
        });

        Console.WriteLine("TASK_ACTION_CONVERSION_LOAD_OK");
        return Task.FromResult(0);
    }

    private static void Measure(string mode, int iterations, Action action)
    {
        for (var i = 0; i < Math.Min(2_000, iterations); i++)
            action();

        GC.Collect();
        GC.WaitForPendingFinalizers();
        GC.Collect();
        var before = GC.GetTotalAllocatedBytes(true);
        var gen0 = GC.CollectionCount(0);
        var gen1 = GC.CollectionCount(1);
        var gen2 = GC.CollectionCount(2);
        var sw = Stopwatch.StartNew();
        for (var i = 0; i < iterations; i++)
            action();
        sw.Stop();
        var allocated = GC.GetTotalAllocatedBytes(true) - before;
        var seconds = Math.Max(0.000001, sw.Elapsed.TotalSeconds);
        Console.WriteLine($"mode={mode} iterations={iterations:N0} elapsedMs={sw.Elapsed.TotalMilliseconds:N1} opsPerSec={iterations / seconds:N0}");
        Console.WriteLine($"mode={mode} allocatedMB={allocated / 1024d / 1024d:N1} bytesPerOp={allocated / (double)iterations:N1} gcGen0={GC.CollectionCount(0) - gen0} gcGen1={GC.CollectionCount(1) - gen1} gcGen2={GC.CollectionCount(2) - gen2}");
    }

    private static int ReadInt(string[] args, string name, int fallback)
    {
        for (var i = 0; i < args.Length - 1; i++)
            if (string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase) && int.TryParse(args[i + 1], out var value) && value > 0)
                return value;
        return fallback;
    }
}
