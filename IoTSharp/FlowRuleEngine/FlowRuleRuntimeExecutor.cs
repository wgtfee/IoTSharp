using Castle.Components.DictionaryAdapter;
using IoTSharp.Data;
using IoTSharp.Data.Extensions;
using IoTSharp.Extensions;
using IoTSharp.Interpreter;
using IoTSharp.TaskActions;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using RulesEngine.Models;
using System;
using System.Collections.Generic;
using System.Dynamic;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Tasks;

namespace IoTSharp.FlowRuleEngine;

public readonly record struct FlowRuleRuntimeResult(int VisitedNodes, bool ReachedEnd, bool Succeeded);

/// <summary>
/// Production rule runtime that executes the flow graph without allocating FlowOperation trace objects.
/// TestPurpose continues to use the traced execution path in FlowRuleProcessor.
/// </summary>
public sealed class FlowRuleRuntimeExecutor
{
    private static readonly ConditionalWeakTable<List<Flow>, RuntimePlan> PlanCache = new();
    private readonly ILogger<FlowRuleRuntimeExecutor> _logger;
    private readonly IServiceScopeFactory _scopeFactory;
    private readonly TaskExecutorHelper _helper;
    private readonly int _maximumIteration;

    public FlowRuleRuntimeExecutor(
        ILogger<FlowRuleRuntimeExecutor> logger,
        IServiceScopeFactory scopeFactory,
        TaskExecutorHelper helper)
        : this(logger, scopeFactory, helper, 1000)
    {
    }

    internal FlowRuleRuntimeExecutor(
        ILogger<FlowRuleRuntimeExecutor> logger,
        IServiceScopeFactory scopeFactory,
        TaskExecutorHelper helper,
        int maximumIteration)
    {
        _logger = logger;
        _scopeFactory = scopeFactory;
        _helper = helper;
        _maximumIteration = Math.Max(1, maximumIteration);
    }

    public async Task<FlowRuleRuntimeResult> ExecuteAsync(
        List<Flow> allFlows,
        Flow start,
        object data,
        Guid deviceId,
        string serializedData)
    {
        if (start == null)
            return new FlowRuleRuntimeResult(0, false, false);

        var plan = PlanCache.GetValue(allFlows, BuildPlan);
        var result = await ProcessOutgoingAsync(plan, start, data, deviceId, serializedData, 2);
        return result with { VisitedNodes = result.VisitedNodes + 1 };
    }

    private async Task<FlowRuleRuntimeResult> ProcessAsync(
        RuntimePlan plan,
        Flow current,
        object data,
        Guid deviceId,
        string serializedData,
        int step)
    {
        if (current == null || step > _maximumIteration)
            return new FlowRuleRuntimeResult(0, false, false);

        if (string.IsNullOrEmpty(current.TargetId)
            || !plan.ByBpmnId.TryGetValue(current.TargetId, out var flow)
            || flow.FlowType == "label")
        {
            _logger.LogWarning("Flow runtime target {TargetId} was not found.", current.TargetId);
            return new FlowRuleRuntimeResult(0, false, false);
        }

        switch (flow.FlowType)
        {
            case "bpmn:SequenceFlow":
            {
                var nested = await ProcessAsync(plan, flow, data, deviceId, serializedData, step + 1);
                return nested with { VisitedNodes = nested.VisitedNodes + 1 };
            }
            case "bpmn:Task":
            {
                var visited = 1;
                object nextData = data;
                var nextSerializedData = serializedData;

                if (!string.IsNullOrEmpty(flow.NodeProcessScriptType)
                    && (!string.IsNullOrEmpty(flow.NodeProcessScript) || !string.IsNullOrEmpty(flow.NodeProcessClass)))
                {
                    var execution = await ExecuteTaskAsync(flow, serializedData, deviceId);
                    if (!execution.Succeeded || execution.Output == null)
                        return new FlowRuleRuntimeResult(visited, false, false);

                    nextData = execution.Output;
                    nextSerializedData = JsonObjectSerializer.Serialize(nextData);
                }

                var outgoing = await ProcessOutgoingAsync(plan, flow, nextData, deviceId, nextSerializedData, step + 1);
                return outgoing with { VisitedNodes = outgoing.VisitedNodes + visited };
            }
            case "bpmn:EndEvent":
                return new FlowRuleRuntimeResult(1, true, true);
            case "label":
            case "bpmn:Lane":
            case "bpmn:Participant":
            case "bpmn:DataStoreReference":
            case "bpmn:SubProcess":
                return new FlowRuleRuntimeResult(1, false, true);
            default:
                return new FlowRuleRuntimeResult(1, false, true);
        }
    }

    private async Task<(bool Succeeded, object Output)> ExecuteTaskAsync(Flow flow, string serializedData, Guid deviceId)
    {
        try
        {
            var script = flow.NodeProcessScript;
            switch (flow.NodeProcessScriptType)
            {
                case "executor":
                {
                    if (string.IsNullOrEmpty(flow.NodeProcessClass) || _helper == null)
                        return (false, null);

                    using var executorLease = _helper.CreateLeaseByTypeName(flow.NodeProcessClass);
                    var executor = executorLease?.Executor;
                    if (executor == null)
                        return (false, null);

                    var result = await executor.ExecuteAsync(new TaskActionInput
                    {
                        Input = serializedData,
                        DeviceId = deviceId,
                        ExecutorConfig = flow.NodeProcessParams
                    });
                    if (!result.ExecutionStatus)
                    {
                        _logger.LogWarning("执行器执行失败: {ExecutionInfo}; Executor={Executor}", result.ExecutionInfo, flow.NodeProcessClass);
                        return (false, result.DynamicOutput);
                    }
                    return (true, result.DynamicOutput);
                }
                case "python":
                    return (true, JsonObjectSerializer.DeserializeUntyped(UseScopedService<PythonScriptEngine, string>(engine => engine.Do(script, serializedData))));
                case "sql":
                    return (true, JsonObjectSerializer.DeserializeUntyped(UseScopedService<SQLEngine, string>(engine => engine.Do(script, serializedData))));
                case "lua":
                    return (true, JsonObjectSerializer.DeserializeUntyped(UseScopedService<LuaScriptEngine, string>(engine => engine.Do(script, serializedData))));
                case "javascript":
                    return (true, JsonObjectSerializer.DeserializeUntyped(UseScopedService<JavaScriptEngine, string>(engine => engine.Do(script, serializedData))));
                case "csharp":
                    return (true, JsonObjectSerializer.DeserializeUntyped(UseScopedService<CSharpScriptEngine, string>(engine => engine.Do(script, serializedData))));
                default:
                    return (true, null);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "规则任务 {FlowId} 执行异常", flow.FlowId);
            return (false, null);
        }
    }

    private async Task<FlowRuleRuntimeResult> ProcessOutgoingAsync(
        RuntimePlan plan,
        Flow source,
        object data,
        Guid deviceId,
        string serializedData,
        int step)
    {
        if (step > _maximumIteration)
            return new FlowRuleRuntimeResult(0, false, false);

        if (!plan.Outgoing.TryGetValue(source.FlowId, out var outgoing))
            return new FlowRuleRuntimeResult(0, false, true);

        var visited = 0;
        var reachedEnd = false;
        var succeeded = true;
        foreach (var edge in outgoing.Unconditional)
        {
            var result = await ProcessAsync(plan, edge, data, deviceId, serializedData, step);
            visited += result.VisitedNodes;
            reachedEnd |= result.ReachedEnd;
            succeeded &= result.Succeeded;
        }

        if (outgoing.Engine != null)
        {
            var results = await outgoing.Engine.ExecuteAllRulesAsync(outgoing.WorkflowName, NormalizeRuleInput(data));
            foreach (var resultTree in results)
            {
                if (!resultTree.IsSuccess
                    || resultTree.Rule?.SuccessEvent == null
                    || !outgoing.ConditionalByEvent.TryGetValue(resultTree.Rule.SuccessEvent, out var edge))
                    continue;

                var result = await ProcessAsync(plan, edge, data, deviceId, serializedData, step);
                visited += result.VisitedNodes;
                reachedEnd |= result.ReachedEnd;
                succeeded &= result.Succeeded;
            }
        }

        return new FlowRuleRuntimeResult(visited, reachedEnd, succeeded);
    }

    private TResult UseScopedService<TService, TResult>(Func<TService, TResult> action)
        where TService : notnull
    {
        if (_scopeFactory == null)
            throw new InvalidOperationException("Script execution requires an IServiceScopeFactory.");
        using var scope = _scopeFactory.CreateScope();
        var service = scope.ServiceProvider.GetRequiredService<TService>();
        return action(service);
    }

    private static RuntimePlan BuildPlan(List<Flow> allFlows)
    {
        var byBpmnId = new Dictionary<string, Flow>(StringComparer.Ordinal);
        foreach (var flow in allFlows)
        {
            if (!string.IsNullOrEmpty(flow.bpmnid) && !byBpmnId.ContainsKey(flow.bpmnid))
                byBpmnId.Add(flow.bpmnid, flow);
        }

        var edgesBySource = allFlows
            .Where(flow => !string.IsNullOrEmpty(flow.SourceId))
            .GroupBy(flow => flow.SourceId, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.ToArray(), StringComparer.Ordinal);
        var outgoingPlans = new Dictionary<Guid, RuntimeOutgoingPlan>();
        foreach (var source in allFlows)
        {
            if (string.IsNullOrEmpty(source.bpmnid)
                || !edgesBySource.TryGetValue(source.bpmnid, out var edges))
                continue;

            var unconditional = edges.Where(edge => string.IsNullOrEmpty(edge.Conditionexpression)).ToArray();
            var conditional = edges.Where(edge => !string.IsNullOrEmpty(edge.Conditionexpression)).ToArray();
            RulesEngine.RulesEngine engine = null;
            Dictionary<string, Flow> conditionalByEvent = null;
            if (conditional.Length > 0)
            {
                var rules = conditional.Select(edge => new Rule
                {
                    RuleName = edge.bpmnid,
                    RuleExpressionType = RuleExpressionType.LambdaExpression,
                    Expression = edge.Conditionexpression,
                    SuccessEvent = edge.bpmnid
                }).ToList();
                engine = new RulesEngine.RulesEngine(
                    [new Workflow { WorkflowName = source.bpmnid, Rules = rules }],
                    null);
                conditionalByEvent = conditional.ToDictionary(edge => edge.bpmnid, StringComparer.Ordinal);
            }

            outgoingPlans[source.FlowId] = new RuntimeOutgoingPlan(
                source.bpmnid,
                unconditional,
                engine,
                conditionalByEvent);
        }

        return new RuntimePlan(byBpmnId, outgoingPlans);
    }

    private static object NormalizeRuleInput(object data)
    {
        return data switch
        {
            null => null,
            JsonNode node => node.ToClrObject(),
            JsonElement element => element.ToClrObject(),
            IDictionary<string, object> dictionary when data is not ExpandoObject => ToExpandoObject(dictionary),
            _ => data
        };
    }

    private static ExpandoObject ToExpandoObject(IDictionary<string, object> dictionary)
    {
        var expando = new ExpandoObject();
        var target = (IDictionary<string, object>)expando;
        foreach (var item in dictionary)
            target[item.Key] = item.Value;
        return expando;
    }

    private sealed record RuntimePlan(
        Dictionary<string, Flow> ByBpmnId,
        Dictionary<Guid, RuntimeOutgoingPlan> Outgoing);

    private sealed record RuntimeOutgoingPlan(
        string WorkflowName,
        Flow[] Unconditional,
        RulesEngine.RulesEngine Engine,
        Dictionary<string, Flow> ConditionalByEvent);
}
