#nullable enable
using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace IoTSharp.Services.DigitalTwin.ActionFlow;

/// <summary>
/// Action Flow V2 服务端权威运行时。所有生产状态均先持久化为 Run/Step/Event/Command/Reservation/Material，
/// 3D 页面只消费可重建投影；设备命令只能通过 ITwinActionFlowCommandAdapter 发送。
/// </summary>
public sealed class TwinActionFlowRuntimeService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly HashSet<TwinActionFlowRunStatus> ActiveRunStates =
    [
        TwinActionFlowRunStatus.Ready, TwinActionFlowRunStatus.Running, TwinActionFlowRunStatus.WaitingSignal,
        TwinActionFlowRunStatus.WaitingResource, TwinActionFlowRunStatus.Paused, TwinActionFlowRunStatus.Recovering
    ];
    private readonly ApplicationDbContext _context;
    private readonly ITwinActionFlowCommandAdapter _commandAdapter;
    private readonly ITwinActionFlowEventPublisher _eventPublisher;
    private readonly ILogger<TwinActionFlowRuntimeService> _logger;

    public TwinActionFlowRuntimeService(
        ApplicationDbContext context,
        ITwinActionFlowCommandAdapter commandAdapter,
        ITwinActionFlowEventPublisher eventPublisher,
        ILogger<TwinActionFlowRuntimeService> logger)
    {
        _context = context;
        _commandAdapter = commandAdapter;
        _eventPublisher = eventPublisher;
        _logger = logger;
    }

    /// <summary>以当前场景草稿作为引用上下文执行服务端校验/编译。</summary>
    public async Task<TwinActionFlowCompileResultDto> CompileAsync(Guid sceneId, JsonElement flow, UserProfile profile, CancellationToken cancellationToken)
    {
        var scene = await _context.DigitalTwinScenes.AsNoTracking().FirstOrDefaultAsync(item =>
            item.Id == sceneId && !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "场景不存在。");
        using var manifest = JsonDocument.Parse(scene.DraftPayload);
        var allFlowIds = ReadFlowIds(manifest.RootElement);
        var compiled = TwinActionFlowServerCompiler.Compile(flow, manifest.RootElement, allFlowIds);
        return new TwinActionFlowCompileResultDto
        {
            Diagnostics = compiled.Diagnostics,
            GraphHash = compiled.Draft?.GraphHash ?? string.Empty,
            CompiledPlanHash = compiled.Draft?.CompiledPlanHash ?? string.Empty,
            CompiledPayload = compiled.Draft == null ? null : ParseJson(compiled.Draft.CompiledPayload)
        };
    }

    /// <summary>读取当前租户/客户可见的流程定义。</summary>
    public async Task<TwinActionFlowDto?> GetFlowAsync(Guid flowId, UserProfile profile, CancellationToken cancellationToken)
    {
        var flow = await _context.TwinActionFlows.AsNoTracking().FirstOrDefaultAsync(item =>
            item.Id == flowId && !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer, cancellationToken);
        return flow == null ? null : ToFlowDto(flow);
    }

    /// <summary>基于不可变发布流程创建运行实例；相同 idempotencyKey 不会创建第二个 Run。</summary>
    public async Task<TwinActionFlowRunDto> StartRunAsync(Guid flowId, TwinActionFlowRunCreateDto request, UserProfile profile, CancellationToken cancellationToken)
    {
        if (!string.Equals(request.RuntimeMode?.Trim(), "live", StringComparison.OrdinalIgnoreCase))
            throw new TwinOperationException(ApiCode.InValidData, "服务端 Action Flow Run 只接受显式 runtimeMode=live；simulation 请使用确定性模拟器。");
        var rawKey = request.IdempotencyKey?.Trim();
        if (string.IsNullOrWhiteSpace(rawKey)) throw new TwinOperationException(ApiCode.InValidData, "idempotencyKey 不能为空。");
        var idempotencyKey = $"{flowId:N}:{rawKey}";
        var existing = await _context.TwinActionFlowRuns.AsNoTracking().Include(item => item.ActionFlow).Include(item => item.Steps)
            .FirstOrDefaultAsync(item => !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer
                && item.IdempotencyKey == idempotencyKey, cancellationToken);
        if (existing != null) return ToRunDto(existing);

        var requestedFlow = await _context.TwinActionFlows.AsNoTracking().FirstOrDefaultAsync(item =>
            item.Id == flowId && !item.Deleted && item.Enabled
            && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "Action Flow 不存在或无权访问。");
        var scene = await _context.DigitalTwinScenes.AsNoTracking().FirstOrDefaultAsync(item =>
            item.Id == requestedFlow.SceneId && !item.Deleted && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "流程所属场景不存在。");
        if (scene.PublishedVersionId == null)
            throw new TwinOperationException(ApiCode.InValidData, "场景尚未发布，禁止创建实时 Run。");
        var flow = requestedFlow.SceneVersionId == scene.PublishedVersionId
            ? requestedFlow
            : await _context.TwinActionFlows.AsNoTracking().FirstOrDefaultAsync(item =>
                item.SceneId == requestedFlow.SceneId && item.SceneVersionId == scene.PublishedVersionId
                && item.FlowKey == requestedFlow.FlowKey && !item.Deleted && item.Enabled
                && item.TenantId == profile.Tenant && item.CustomerId == profile.Customer, cancellationToken)
                ?? throw new TwinOperationException(ApiCode.CantFindObject, "当前发布版本中不存在该 Action Flow。");
        if (scene.PublishedVersionId != flow.SceneVersionId)
            throw new TwinOperationException(ApiCode.InValidData, "该流程不是场景当前发布版本，禁止创建新 Run。");

        using var plan = JsonDocument.Parse(flow.CompiledPayload);
        var entryNodeId = String(plan.RootElement, "entryNodeId");
        if (string.IsNullOrWhiteSpace(entryNodeId)) throw new TwinOperationException(ApiCode.InValidData, "发布流程缺少编译入口。");

        var now = DateTime.UtcNow;
        var actor = ResolveActor(profile);
        var run = new TwinActionFlowRun
        {
            Id = Guid.NewGuid(), SceneId = flow.SceneId, SceneVersionId = flow.SceneVersionId!.Value, ActionFlowId = flow.Id,
            IdempotencyKey = idempotencyKey, Status = TwinActionFlowRunStatus.Ready,
            InputPayload = request.Input.HasValue ? request.Input.Value.GetRawText() : "{}",
            RuntimePayload = JsonSerializer.Serialize(new { runtimeMode = "live", activeTokens = 1, nodeVisits = new Dictionary<string, int>(), lastSignals = new Dictionary<string, object?>(), lastSignalCycles = new Dictionary<string, string>(), waitingResources = new Dictionary<string, string>() }, JsonOptions),
            GraphHash = flow.GraphHash, CompiledPlanHash = flow.CompiledPlanHash, CreatedAt = now, UpdatedAt = now,
            CreatedBy = actor, UpdatedBy = actor, TenantId = profile.Tenant, CustomerId = profile.Customer
        };
        _context.TwinActionFlowRuns.Add(run);
        AppendEvent(run, "RunCreated", null, null, Guid.NewGuid().ToString("N"), actor, new { flowId = flow.Id, flow.FlowKey, run.IdempotencyKey }, now);
        run.Status = TwinActionFlowRunStatus.Running;
        run.StartedAt = now;
        AppendEvent(run, "RunStarted", null, null, Guid.NewGuid().ToString("N"), actor, new { entryNodeId }, now);
        await ExecuteNodeAsync(run, flow, entryNodeId!, 1, actor, cancellationToken);
        await SaveAndPublishAsync(run, 0, cancellationToken);
        return await GetRunInternalAsync(run.Id, profile.Tenant, profile.Customer, cancellationToken);
    }

    /// <summary>读取 Run 快照。</summary>
    public Task<TwinActionFlowRunDto> GetRunAsync(Guid runId, UserProfile profile, CancellationToken cancellationToken) =>
        GetRunInternalAsync(runId, profile.Tenant, profile.Customer, cancellationToken);

    /// <summary>按 sequence 增量读取不可变事件，断线重连时用于补齐缺口。</summary>
    public async Task<List<TwinActionFlowEventDto>> GetEventsAsync(Guid runId, long afterSequence, int take, UserProfile profile, CancellationToken cancellationToken)
    {
        await RequireRunAccessAsync(runId, profile.Tenant, profile.Customer, cancellationToken);
        take = Math.Clamp(take <= 0 ? 500 : take, 1, 2000);
        var events = await _context.TwinActionFlowEvents.AsNoTracking()
            .Where(item => item.RunId == runId && item.Sequence > afterSequence && !item.Deleted)
            .OrderBy(item => item.Sequence).Take(take).ToListAsync(cancellationToken);
        return events.Select(ToEventDto).ToList();
    }

    /// <summary>请求安全暂停；不会中断设备已执行到一半的动作。</summary>
    public async Task<TwinActionFlowRunDto> PauseAsync(Guid runId, string? reason, UserProfile profile, CancellationToken cancellationToken)
    {
        var run = await LoadRunForUpdateAsync(runId, profile.Tenant, profile.Customer, cancellationToken);
        if (run.Status is TwinActionFlowRunStatus.Completed or TwinActionFlowRunStatus.Faulted or TwinActionFlowRunStatus.Cancelled) return ToRunDto(run);
        var from = run.CurrentSequence;
        run.Status = TwinActionFlowRunStatus.Paused;
        run.UpdatedAt = DateTime.UtcNow; run.UpdatedBy = ResolveActor(profile); run.ConcurrencyVersion += 1;
        AppendEvent(run, "RunPaused", null, null, Guid.NewGuid().ToString("N"), ResolveActor(profile), new { reason = reason?.Trim() ?? string.Empty }, run.UpdatedAt);
        await SaveAndPublishAsync(run, from, cancellationToken);
        return ToRunDto(run);
    }

    /// <summary>对账后恢复；恢复逻辑绝不盲目重发已有 commandId。</summary>
    public async Task<TwinActionFlowRunDto> ResumeAsync(Guid runId, string? reason, UserProfile profile, CancellationToken cancellationToken)
    {
        var run = await LoadRunForUpdateAsync(runId, profile.Tenant, profile.Customer, cancellationToken);
        if (run.Status is TwinActionFlowRunStatus.Completed or TwinActionFlowRunStatus.Cancelled) return ToRunDto(run);
        var from = run.CurrentSequence;
        run.Status = TwinActionFlowRunStatus.Recovering;
        run.UpdatedAt = DateTime.UtcNow; run.UpdatedBy = ResolveActor(profile); run.ConcurrencyVersion += 1;
        AppendEvent(run, "RunRecovering", null, null, Guid.NewGuid().ToString("N"), ResolveActor(profile), new { reason = reason?.Trim() ?? string.Empty }, run.UpdatedAt);
        await ReconcileRunAsync(run, ResolveActor(profile), cancellationToken);
        await SaveAndPublishAsync(run, from, cancellationToken);
        return ToRunDto(run);
    }

    /// <summary>取消 Run，释放 lease 并记录原因。</summary>
    public async Task<TwinActionFlowRunDto> CancelAsync(Guid runId, string reason, UserProfile profile, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(reason)) throw new TwinOperationException(ApiCode.InValidData, "取消运行必须填写原因。");
        var run = await LoadRunForUpdateAsync(runId, profile.Tenant, profile.Customer, cancellationToken);
        if (run.Status is TwinActionFlowRunStatus.Completed or TwinActionFlowRunStatus.Cancelled) return ToRunDto(run);
        var from = run.CurrentSequence; var now = DateTime.UtcNow; var actor = ResolveActor(profile);
        foreach (var step in run.Steps.Where(item => item.Status is TwinActionFlowStepStatus.Pending or TwinActionFlowStepStatus.Ready or TwinActionFlowStepStatus.Running or TwinActionFlowStepStatus.Waiting))
        {
            step.Status = TwinActionFlowStepStatus.Skipped; step.EndedAt = now; step.UpdatedAt = now; step.UpdatedBy = actor;
        }
        await ReleaseRunReservationsAsync(run.Id, actor, now, cancellationToken);
        run.Status = TwinActionFlowRunStatus.Cancelled; run.EndedAt = now; run.UpdatedAt = now; run.UpdatedBy = actor; run.ConcurrencyVersion += 1;
        AppendEvent(run, "RunCancelled", null, null, Guid.NewGuid().ToString("N"), actor, new { reason = reason.Trim() }, now);
        await SaveAndPublishAsync(run, from, cancellationToken);
        return ToRunDto(run);
    }

    /// <summary>对失败步骤执行受审计重试。</summary>
    public async Task<TwinActionFlowRunDto> RetryStepAsync(Guid runId, string stepInstanceId, string? reason, UserProfile profile, CancellationToken cancellationToken)
    {
        var run = await LoadRunForUpdateAsync(runId, profile.Tenant, profile.Customer, cancellationToken);
        var step = run.Steps.FirstOrDefault(item => item.StepInstanceId == stepInstanceId && !item.Deleted)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "步骤不存在。");
        if (step.Status != TwinActionFlowStepStatus.Failed) throw new TwinOperationException(ApiCode.InValidData, "只有 Failed 步骤可以人工重试。");
        var flow = await _context.TwinActionFlows.AsNoTracking().FirstAsync(item => item.Id == run.ActionFlowId, cancellationToken);
        var from = run.CurrentSequence; var actor = ResolveActor(profile);
        run.Status = TwinActionFlowRunStatus.Running; run.FaultCode = null; run.FaultMessage = null; run.EndedAt = null;
        AppendEvent(run, "StepRetryRequested", step.NodeId, step.StepInstanceId, Guid.NewGuid().ToString("N"), actor, new { reason = reason?.Trim() ?? string.Empty, nextAttempt = step.Attempt + 1 }, DateTime.UtcNow);
        await ExecuteNodeAsync(run, flow, step.NodeId, step.Attempt + 1, actor, cancellationToken);
        await SaveAndPublishAsync(run, from, cancellationToken);
        return ToRunDto(run);
    }

    /// <summary>人工确认必须填写原因，完成指定 ManualConfirm 等待步骤后继续。</summary>
    public async Task<TwinActionFlowRunDto> ManualConfirmAsync(Guid runId, TwinActionFlowManualConfirmDto request, UserProfile profile, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Reason)) throw new TwinOperationException(ApiCode.InValidData, "人工确认必须填写原因。");
        var run = await LoadRunForUpdateAsync(runId, profile.Tenant, profile.Customer, cancellationToken);
        var step = run.Steps.FirstOrDefault(item => item.StepInstanceId == request.StepInstanceId && item.Status == TwinActionFlowStepStatus.Waiting)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "待人工确认步骤不存在。");
        var flow = await _context.TwinActionFlows.AsNoTracking().FirstAsync(item => item.Id == run.ActionFlowId, cancellationToken);
        using var plan = JsonDocument.Parse(flow.CompiledPayload);
        var node = FindNode(plan.RootElement, step.NodeId);
        if (!node.HasValue || String(node.Value, "type") != "ManualConfirm") throw new TwinOperationException(ApiCode.InValidData, "指定步骤不是 ManualConfirm。");
        var from = run.CurrentSequence; var actor = ResolveActor(profile); var now = DateTime.UtcNow;
        step.OutputPayload = request.Output.HasValue ? request.Output.Value.GetRawText() : "{}";
        SucceedStep(run, step, actor, new { reason = request.Reason.Trim(), manual = true }, now);
        run.Status = TwinActionFlowRunStatus.Running;
        await ContinueFromNodeAsync(run, flow, step.NodeId, actor, cancellationToken);
        await SaveAndPublishAsync(run, from, cancellationToken);
        return ToRunDto(run);
    }

    /// <summary>接收设备 Ack/Busy/Done/Fault；重复或乱序反馈只记审计，不重复推进步骤。</summary>
    public async Task<TwinActionFlowRunDto> ApplyCommandFeedbackAsync(Guid runId, TwinActionFlowCommandFeedbackDto request, UserProfile profile, CancellationToken cancellationToken)
    {
        if (!Enum.TryParse<TwinDeviceCommandStatus>(request.Status, true, out var incoming))
            throw new TwinOperationException(ApiCode.InValidData, "未知命令状态。");
        var run = await LoadRunForUpdateAsync(runId, profile.Tenant, profile.Customer, cancellationToken);
        var command = await _context.TwinDeviceCommands.FirstOrDefaultAsync(item => item.RunId == run.Id && item.CommandId == request.CommandId && !item.Deleted, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "commandId 不属于该 Run。");
        if (!string.Equals(command.CorrelationId, request.CorrelationId, StringComparison.Ordinal))
            throw new TwinOperationException(ApiCode.InValidData, "correlationId 与命令不匹配。");
        var from = run.CurrentSequence; var actor = ResolveActor(profile); var now = request.DeviceOccurredAt?.ToUniversalTime() ?? DateTime.UtcNow;
        if (IsDuplicateOrStale(command, incoming, request.CycleId))
        {
            AppendEvent(run, "CommandFeedbackIgnored", command.Step?.NodeId, command.Step?.StepInstanceId, request.CorrelationId, "device", new { request.CommandId, request.CycleId, request.Status, reason = "duplicate-or-out-of-order" }, now);
            await SaveAndPublishAsync(run, from, cancellationToken);
            return ToRunDto(run);
        }
        ApplyCommandStatus(command, incoming, request.CycleId, now, request.Payload);
        AppendEvent(run, $"Command{incoming}", command.Step?.NodeId, command.Step?.StepInstanceId, request.CorrelationId, "device", new { request.CommandId, cycleId = request.CycleId, payload = request.Payload }, now);
        if (incoming == TwinDeviceCommandStatus.Completed && command.StepId.HasValue)
        {
            // WriteCommand 在“送达/Ack”后即完成；Done 由后续 WaitSignal/cycleId 节点消费。
        }
        else if (incoming == TwinDeviceCommandStatus.Faulted && command.StepId.HasValue)
        {
            var step = run.Steps.FirstOrDefault(item => item.Id == command.StepId.Value);
            if (step != null) await FaultRunAsync(run, "DEVICE_FAULT", command.LastError ?? "设备返回 Fault。", actor, cancellationToken);
        }
        await SaveAndPublishAsync(run, from, cancellationToken);
        return ToRunDto(run);
    }

    /// <summary>接收绑定信号；cycleId 去重并用于 WaitSignal 的 rising-edge/周期语义。</summary>
    public async Task<TwinActionFlowRunDto> ApplySignalAsync(Guid runId, TwinActionFlowSignalDto request, UserProfile profile, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.BindingId)) throw new TwinOperationException(ApiCode.InValidData, "bindingId 不能为空。");
        var run = await LoadRunForUpdateAsync(runId, profile.Tenant, profile.Customer, cancellationToken);
        var runtime = RuntimeObject(run);
        var signalCycles = runtime["lastSignalCycles"] as JsonObject ?? new JsonObject();
        var previousCycle = signalCycles[request.BindingId]?.GetValue<string>();
        if (!string.IsNullOrWhiteSpace(previousCycle) && !string.IsNullOrWhiteSpace(request.CycleId) && CompareCycle(request.CycleId!, previousCycle!) < 0)
        {
            var ignoredFrom = run.CurrentSequence;
            AppendEvent(run, "SignalIgnored", null, null, $"stale-signal:{request.BindingId}:{request.CycleId}", "device", new { request.BindingId, request.CycleId, reason = "out-of-order-cycle" }, DateTime.UtcNow);
            await SaveAndPublishAsync(run, ignoredFrom, cancellationToken);
            return ToRunDto(run);
        }
        var dedup = $"signal:{request.BindingId}:{request.CycleId ?? "none"}:{Hash(request.Value.GetRawText())}";
        if (await _context.TwinActionFlowEvents.AsNoTracking().AnyAsync(item => item.RunId == run.Id && item.CorrelationId == dedup && item.Source == "device", cancellationToken))
            return ToRunDto(run);
        var from = run.CurrentSequence; var actor = ResolveActor(profile); var now = request.DeviceOccurredAt?.ToUniversalTime() ?? DateTime.UtcNow;
        var signals = runtime["lastSignals"] as JsonObject ?? new JsonObject();
        var previous = signals[request.BindingId]?.DeepClone();
        signals[request.BindingId] = JsonNode.Parse(request.Value.GetRawText()); runtime["lastSignals"] = signals;
        if (!string.IsNullOrWhiteSpace(request.CycleId)) { signalCycles[request.BindingId] = request.CycleId; runtime["lastSignalCycles"] = signalCycles; }
        run.RuntimePayload = runtime.ToJsonString(JsonOptions);
        AppendEvent(run, "SignalReceived", null, null, dedup, "device", new { request.BindingId, request.CycleId, value = request.Value }, now);
        var flow = await _context.TwinActionFlows.AsNoTracking().FirstAsync(item => item.Id == run.ActionFlowId, cancellationToken);
        using var plan = JsonDocument.Parse(flow.CompiledPayload);
        foreach (var step in run.Steps.Where(item => item.Status == TwinActionFlowStepStatus.Waiting).ToList())
        {
            var node = FindNode(plan.RootElement, step.NodeId); if (!node.HasValue || String(node.Value, "type") is not ("WaitSignal" or "WaitAck")) continue;
            var config = Object(node.Value, "config"); if (!config.HasValue || String(config.Value, "bindingId") != request.BindingId) continue;
            var trigger = String(config.Value, "trigger") ?? "truthy";
            if (!SignalMatches(trigger, previous, request.Value)) continue;
            SucceedStep(run, step, actor, new { bindingId = request.BindingId, cycleId = request.CycleId, value = request.Value }, DateTime.UtcNow);
            run.Status = TwinActionFlowRunStatus.Running;
            await ContinueFromNodeAsync(run, flow, step.NodeId, actor, cancellationToken);
        }
        await SaveAndPublishAsync(run, from, cancellationToken);
        return ToRunDto(run);
    }

    /// <summary>恢复进程启动时的未结束 Run；不重发已有设备命令。</summary>
    public async Task RecoverActiveRunsAsync(CancellationToken cancellationToken)
    {
        var ids = await _context.TwinActionFlowRuns.AsNoTracking().Where(item => !item.Deleted && ActiveRunStates.Contains(item.Status)).Select(item => item.Id).ToListAsync(cancellationToken);
        foreach (var id in ids)
        {
            try
            {
                var run = await _context.TwinActionFlowRuns.Include(item => item.Steps).FirstAsync(item => item.Id == id, cancellationToken);
                var from = run.CurrentSequence; run.Status = TwinActionFlowRunStatus.Recovering; run.ConcurrencyVersion += 1; run.UpdatedAt = DateTime.UtcNow;
                AppendEvent(run, "RunRecovering", null, null, Guid.NewGuid().ToString("N"), "recovery-worker", new { startup = true }, run.UpdatedAt);
                await ReconcileRunAsync(run, "recovery-worker", cancellationToken);
                await SaveAndPublishAsync(run, from, cancellationToken);
            }
            catch (Exception exception) { _logger.LogError(exception, "Recover Action Flow run {RunId} failed.", id); _context.ChangeTracker.Clear(); }
        }
    }

    /// <summary>租约心跳、过期处理和步骤 deadline 检查。</summary>
    public async Task MaintenanceAsync(CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        var expired = await _context.TwinResourceReservations.Where(item => !item.Deleted && item.Status == TwinReservationStatus.Active && item.LeaseUntil <= now).ToListAsync(cancellationToken);
        foreach (var item in expired) { item.Status = TwinReservationStatus.Expired; item.UpdatedAt = now; item.Revision += 1; item.UpdatedBy = "runtime-maintenance"; }
        var activeRunIds = await _context.TwinActionFlowRuns.AsNoTracking().Where(item => !item.Deleted && ActiveRunStates.Contains(item.Status) && item.Status != TwinActionFlowRunStatus.Paused).Select(item => item.Id).ToListAsync(cancellationToken);
        var leases = await _context.TwinResourceReservations.Where(item => activeRunIds.Contains(item.OwnerRunId) && item.Status == TwinReservationStatus.Active && !item.Deleted).ToListAsync(cancellationToken);
        foreach (var lease in leases) { lease.LeaseUntil = now.AddSeconds(30); lease.Revision += 1; lease.UpdatedAt = now; lease.UpdatedBy = "runtime-heartbeat"; }
        await _context.SaveChangesAsync(cancellationToken);

        await ResumeWaitingResourcesAsync(now, cancellationToken);
        await DetectSimpleDeadlocksAsync(now, cancellationToken);
        var dueRunIds = await _context.TwinActionFlowRunSteps.AsNoTracking().Where(item => item.Status == TwinActionFlowStepStatus.Waiting && item.DeadlineAt != null && item.DeadlineAt <= now && !item.Deleted).Select(item => item.RunId).Distinct().ToListAsync(cancellationToken);
        foreach (var runId in dueRunIds)
        {
            _context.ChangeTracker.Clear();
            var run = await _context.TwinActionFlowRuns.Include(item => item.Steps).FirstOrDefaultAsync(item => item.Id == runId && !item.Deleted, cancellationToken);
            if (run == null || !ActiveRunStates.Contains(run.Status) || run.Status == TwinActionFlowRunStatus.Paused) continue;
            var from = run.CurrentSequence; var flow = await _context.TwinActionFlows.AsNoTracking().FirstAsync(item => item.Id == run.ActionFlowId, cancellationToken);
            using var plan = JsonDocument.Parse(flow.CompiledPayload);
            foreach (var step in run.Steps.Where(item => item.Status == TwinActionFlowStepStatus.Waiting && item.DeadlineAt <= now).ToList())
            {
                var node = FindNode(plan.RootElement, step.NodeId);
                if (node.HasValue && String(node.Value, "type") == "Delay")
                {
                    SucceedStep(run, step, "runtime-maintenance", new { delayCompleted = true }, now);
                    run.Status = TwinActionFlowRunStatus.Running;
                    await ContinueFromNodeAsync(run, flow, step.NodeId, "runtime-maintenance", cancellationToken);
                }
                else await HandleTimeoutAsync(run, flow, step, plan.RootElement, "runtime-maintenance", cancellationToken);
            }
            await SaveAndPublishAsync(run, from, cancellationToken);
        }
    }

    private async Task ReconcileRunAsync(TwinActionFlowRun run, string actor, CancellationToken cancellationToken)
    {
        var commands = await _context.TwinDeviceCommands.Where(item => item.RunId == run.Id && !item.Deleted && item.Status != TwinDeviceCommandStatus.Completed && item.Status != TwinDeviceCommandStatus.Faulted && item.Status != TwinDeviceCommandStatus.Cancelled).ToListAsync(cancellationToken);
        foreach (var command in commands)
        {
            var feedback = await _commandAdapter.ReconcileAsync(run, command, cancellationToken);
            if (feedback == null) continue;
            if (!IsDuplicateOrStale(command, feedback.Status, feedback.CycleId))
            {
                ApplyCommandStatus(command, feedback.Status, feedback.CycleId, feedback.OccurredAt, feedback.Payload);
                AppendEvent(run, $"Command{feedback.Status}", command.Step?.NodeId, command.Step?.StepInstanceId, feedback.CorrelationId, "reconcile", new { feedback.CommandId, feedback.CycleId }, feedback.OccurredAt);
            }
        }
        var incomplete = commands.Any(item => item.Status is TwinDeviceCommandStatus.Pending or TwinDeviceCommandStatus.Sent or TwinDeviceCommandStatus.Acknowledged or TwinDeviceCommandStatus.Busy);
        run.Status = incomplete ? TwinActionFlowRunStatus.WaitingSignal : TwinActionFlowRunStatus.Running;
        run.UpdatedAt = DateTime.UtcNow; run.UpdatedBy = actor;
        AppendEvent(run, "RunReconciled", null, null, Guid.NewGuid().ToString("N"), actor, new { waitingDevice = incomplete }, run.UpdatedAt);
    }

    private async Task ExecuteNodeAsync(TwinActionFlowRun run, TwinActionFlow flow, string nodeId, int attempt, string actor, CancellationToken cancellationToken)
    {
        if (run.Status == TwinActionFlowRunStatus.Paused || run.Status == TwinActionFlowRunStatus.Cancelled) return;
        using var plan = JsonDocument.Parse(flow.CompiledPayload);
        var node = FindNode(plan.RootElement, nodeId);
        if (!node.HasValue) { await FaultRunAsync(run, "NODE_NOT_FOUND", $"编译计划不存在节点 {nodeId}。", actor, cancellationToken); return; }
        if (!RegisterVisit(run, nodeId, plan.RootElement)) { await FaultRunAsync(run, "LOOP_LIMIT", $"节点 {nodeId} 超过 maxLoopIterations。", actor, cancellationToken); return; }
        var type = String(node.Value, "type") ?? string.Empty;
        if (type == "ParallelJoin" && !CanEnterJoin(run, plan.RootElement, nodeId)) return;
        var now = DateTime.UtcNow;
        var step = new TwinActionFlowRunStep
        {
            Id = Guid.NewGuid(), RunId = run.Id, Run = run, StepInstanceId = $"{nodeId}:{attempt}:{Guid.NewGuid():N}", NodeId = nodeId, Attempt = attempt,
            Status = TwinActionFlowStepStatus.Running, InputPayload = "{}", OutputPayload = "{}", StartedAt = now,
            CreatedAt = now, UpdatedAt = now, CreatedBy = actor, UpdatedBy = actor, TenantId = run.TenantId, CustomerId = run.CustomerId
        };
        run.Steps.Add(step); _context.TwinActionFlowRunSteps.Add(step);
        AppendEvent(run, "StepStarted", nodeId, step.StepInstanceId, Guid.NewGuid().ToString("N"), actor, new { type, attempt }, now);
        var config = Object(node.Value, "config");
        var actorObjectId = String(node.Value, "actorObjectId");
        if (!string.IsNullOrWhiteSpace(actorObjectId) && type is not ("Start" or "End" or "Condition" or "Switch" or "Merge" or "ParallelFork" or "ParallelJoin"))
        {
            if (!await AcquireReservationAsync(run, step, "actor", actorObjectId!, actor, cancellationToken))
            {
                WaitForResource(run, step, "actor", actorObjectId!, node.Value, plan.RootElement, actor);
                return;
            }
        }

        switch (type)
        {
            case "End":
                SucceedStep(run, step, actor, new { }, DateTime.UtcNow);
                if (ConsumeParallelToken(run) <= 0)
                {
                    run.Status = TwinActionFlowRunStatus.Completed; run.EndedAt = DateTime.UtcNow; run.UpdatedAt = run.EndedAt.Value;
                    await ReleaseRunReservationsAsync(run.Id, actor, run.EndedAt.Value, cancellationToken);
                    AppendEvent(run, "RunCompleted", nodeId, step.StepInstanceId, Guid.NewGuid().ToString("N"), actor, new { }, run.EndedAt.Value);
                }
                return;
            case "Condition": case "Switch":
                SucceedStep(run, step, actor, new { }, DateTime.UtcNow);
                await ContinueFromNodeAsync(run, flow, nodeId, actor, cancellationToken, conditional: true);
                return;
            case "ParallelFork":
                AddParallelTokens(run, Math.Max(0, EdgesFrom(plan.RootElement, nodeId).Count() - 1));
                SucceedStep(run, step, actor, new { type }, DateTime.UtcNow);
                await ContinueFromNodeAsync(run, flow, nodeId, actor, cancellationToken);
                return;
            case "ParallelJoin":
                var incomingBranchCount = plan.RootElement.TryGetProperty("edges", out var allEdges) && allEdges.ValueKind == JsonValueKind.Array
                    ? allEdges.EnumerateArray().Count(item => String(item, "targetNodeId") == nodeId) : 1;
                AddParallelTokens(run, -Math.Max(0, incomingBranchCount - 1));
                SucceedStep(run, step, actor, new { type }, DateTime.UtcNow);
                await ContinueFromNodeAsync(run, flow, nodeId, actor, cancellationToken);
                return;
            case "Start": case "Merge":
            case "PrepareSlot": case "EnterSection": case "SelectRoute": case "MoveTo": case "MovePose":
            case "JointMove": case "AxisMove": case "Home": case "GripOpen": case "GripClose": case "Attach": case "Detach":
            case "RaiseAlarm": case "Compensate":
                SucceedStep(run, step, actor, new { type }, DateTime.UtcNow);
                await ContinueFromNodeAsync(run, flow, nodeId, actor, cancellationToken);
                return;
            case "Delay": case "Deadline":
                step.Status = TwinActionFlowStepStatus.Waiting; step.DeadlineAt = DateTime.UtcNow.AddSeconds(Math.Max(0.05, Number(config, "durationSeconds") ?? Number(config, "seconds") ?? TimeoutSeconds(node.Value, plan.RootElement)));
                run.Status = TwinActionFlowRunStatus.WaitingSignal;
                AppendEvent(run, "StepWaiting", nodeId, step.StepInstanceId, Guid.NewGuid().ToString("N"), actor, new { type, deadlineAt = step.DeadlineAt }, DateTime.UtcNow);
                return;
            case "WaitAck":
            {
                var latest = await _context.TwinDeviceCommands.Where(item => item.RunId == run.Id && !item.Deleted).OrderByDescending(item => item.CreatedAt).FirstOrDefaultAsync(cancellationToken);
                if (latest != null && CommandRank(latest.Status) >= CommandRank(TwinDeviceCommandStatus.Acknowledged))
                {
                    SucceedStep(run, step, actor, new { commandId = latest.CommandId, latest.CorrelationId, acknowledged = true }, DateTime.UtcNow);
                    await ContinueFromNodeAsync(run, flow, nodeId, actor, cancellationToken);
                    return;
                }
                step.Status = TwinActionFlowStepStatus.Waiting; step.DeadlineAt = DateTime.UtcNow.AddSeconds(TimeoutSeconds(node.Value, plan.RootElement));
                run.Status = TwinActionFlowRunStatus.WaitingSignal;
                AppendEvent(run, "StepWaiting", nodeId, step.StepInstanceId, Guid.NewGuid().ToString("N"), actor, new { type, deadlineAt = step.DeadlineAt }, DateTime.UtcNow);
                return;
            }
            case "WaitSignal": case "ManualConfirm":
                step.Status = TwinActionFlowStepStatus.Waiting; step.DeadlineAt = DateTime.UtcNow.AddSeconds(TimeoutSeconds(node.Value, plan.RootElement));
                run.Status = TwinActionFlowRunStatus.WaitingSignal;
                AppendEvent(run, "StepWaiting", nodeId, step.StepInstanceId, Guid.NewGuid().ToString("N"), actor, new { type, deadlineAt = step.DeadlineAt }, DateTime.UtcNow);
                return;
            case "ReserveSlot": case "ReserveSection":
            {
                var resourceType = type == "ReserveSlot" ? "slot" : "section";
                var resourceId = String(config, type == "ReserveSlot" ? "slotId" : "sectionId") ?? String(config, "routeId") ?? string.Empty;
                var acquired = await AcquireReservationAsync(run, step, resourceType, resourceId, actor, cancellationToken);
                if (!acquired)
                {
                    WaitForResource(run, step, resourceType, resourceId, node.Value, plan.RootElement, actor);
                    return;
                }
                SucceedStep(run, step, actor, new { resourceType, resourceId }, DateTime.UtcNow);
                await ContinueFromNodeAsync(run, flow, nodeId, actor, cancellationToken); return;
            }
            case "ReleaseSlot": case "LeaveSection":
            {
                var resourceType = type == "ReleaseSlot" ? "slot" : "section";
                var resourceId = String(config, type == "ReleaseSlot" ? "slotId" : "sectionId") ?? String(config, "routeId") ?? string.Empty;
                await ReleaseReservationAsync(run.Id, resourceType, resourceId, actor, cancellationToken);
                SucceedStep(run, step, actor, new { resourceType, resourceId }, DateTime.UtcNow);
                await ContinueFromNodeAsync(run, flow, nodeId, actor, cancellationToken); return;
            }
            case "TransferMaterial":
            {
                var materialId = String(config, "materialInstanceId") ?? string.Empty;
                var ownerType = String(config, "targetOwnerType") ?? "slot"; var ownerId = String(config, "targetOwnerId") ?? String(config, "slotId") ?? string.Empty;
                if (string.IsNullOrWhiteSpace(materialId) || string.IsNullOrWhiteSpace(ownerId)) { await FailStepAsync(run, step, "MATERIAL_TARGET_INVALID", "TransferMaterial 缺少 materialInstanceId/targetOwnerId。", actor, cancellationToken); return; }
                if (!await AcquireReservationAsync(run, step, "material", materialId, actor, cancellationToken))
                {
                    WaitForResource(run, step, "material", materialId, node.Value, plan.RootElement, actor);
                    return;
                }
                await TransferMaterialAsync(run, step, materialId, ownerType, ownerId, actor, cancellationToken);
                SucceedStep(run, step, actor, new { materialId, ownerType, ownerId }, DateTime.UtcNow);
                await ContinueFromNodeAsync(run, flow, nodeId, actor, cancellationToken); return;
            }
            case "WriteCommand":
                await DispatchCommandAsync(run, flow, step, node.Value, actor, cancellationToken); return;
            case "Subflow":
                await FailStepAsync(run, step, "SUBFLOW_RUNTIME_UNAVAILABLE", "Subflow 必须由已发布子流程运行器显式启动，当前节点未配置独立运行上下文。", actor, cancellationToken); return;
            default:
                await FailStepAsync(run, step, "NODE_TYPE_UNSUPPORTED", $"运行时不支持节点类型 {type}。", actor, cancellationToken); return;
        }
    }

    private async Task DispatchCommandAsync(TwinActionFlowRun run, TwinActionFlow flow, TwinActionFlowRunStep step, JsonElement node, string actor, CancellationToken cancellationToken)
    {
        var config = Object(node, "config"); var bindingId = String(config, "bindingId") ?? string.Empty;
        if (string.IsNullOrWhiteSpace(bindingId)) { await FailStepAsync(run, step, "COMMAND_BINDING_REQUIRED", "WriteCommand 缺少 bindingId。", actor, cancellationToken); return; }
        var commandId = $"{run.Id:N}:{step.StepInstanceId}:{bindingId}";
        var existing = await _context.TwinDeviceCommands.FirstOrDefaultAsync(item => item.CommandId == commandId && !item.Deleted, cancellationToken);
        if (existing != null)
        {
            step.Status = existing.Status == TwinDeviceCommandStatus.Completed ? TwinActionFlowStepStatus.Succeeded : TwinActionFlowStepStatus.Waiting;
            run.Status = existing.Status == TwinDeviceCommandStatus.Completed ? TwinActionFlowRunStatus.Running : TwinActionFlowRunStatus.WaitingSignal;
            if (existing.Status == TwinDeviceCommandStatus.Completed) await ContinueFromNodeAsync(run, flow, step.NodeId, actor, cancellationToken);
            return;
        }
        var correlationId = Guid.NewGuid().ToString("N");
        var payloadNode = new JsonObject
        {
            ["commandId"] = commandId, ["correlationId"] = correlationId, ["runId"] = run.Id.ToString("D"), ["stepInstanceId"] = step.StepInstanceId,
            ["cycleId"] = $"{run.Id:N}-{run.CurrentSequence + 1}", ["payload"] = config.HasValue && config.Value.TryGetProperty("payload", out var payload) ? JsonNode.Parse(payload.GetRawText()) : new JsonObject()
        };
        var payloadText = payloadNode.ToJsonString(JsonOptions);
        var command = new TwinDeviceCommand
        {
            Id = Guid.NewGuid(), RunId = run.Id, Run = run, StepId = step.Id, Step = step, CommandId = commandId, CorrelationId = correlationId,
            BindingKey = bindingId, Payload = payloadText, PayloadHash = Hash(payloadText), Status = TwinDeviceCommandStatus.Pending,
            CreatedAt = DateTime.UtcNow, UpdatedAt = DateTime.UtcNow, CreatedBy = actor, UpdatedBy = actor, TenantId = run.TenantId, CustomerId = run.CustomerId
        };
        _context.TwinDeviceCommands.Add(command);
        AppendEvent(run, "CommandCreated", step.NodeId, step.StepInstanceId, correlationId, actor, new { commandId, bindingId, command.PayloadHash }, DateTime.UtcNow);
        // 先写 command/outbox 状态再跨进程发送，进程崩溃后恢复器能看到 Pending/Sent，且不会根据页面状态重建命令。
        await _context.SaveChangesAsync(cancellationToken);
        var dispatch = await _commandAdapter.SendAsync(run, step, command, cancellationToken);
        command.UpdatedAt = DateTime.UtcNow;
        if (!dispatch.Accepted)
        {
            command.Status = TwinDeviceCommandStatus.Faulted; command.LastError = dispatch.Error; command.CompletedAt = command.UpdatedAt;
            AppendEvent(run, "CommandFaulted", step.NodeId, step.StepInstanceId, correlationId, "command-adapter", new { commandId, error = dispatch.Error }, command.UpdatedAt);
            await FailStepAsync(run, step, "COMMAND_DISPATCH_FAILED", dispatch.Error ?? "设备命令发送失败。", actor, cancellationToken); return;
        }
        command.Status = dispatch.Acknowledged ? TwinDeviceCommandStatus.Acknowledged : TwinDeviceCommandStatus.Sent;
        command.SentAt = command.UpdatedAt; if (dispatch.Acknowledged) command.AcknowledgedAt = command.UpdatedAt; command.DeviceCycleId = dispatch.DeviceCycleId;
        AppendEvent(run, dispatch.Acknowledged ? "CommandAcknowledged" : "CommandSent", step.NodeId, step.StepInstanceId, correlationId, "command-adapter", new { commandId, dispatch.DeviceCycleId, dispatch.Response }, command.UpdatedAt);
        var runtime = RuntimeObject(run); runtime["lastCommandId"] = commandId; runtime["lastCorrelationId"] = correlationId; run.RuntimePayload = runtime.ToJsonString(JsonOptions);
        SucceedStep(run, step, actor, new { commandId, correlationId, acknowledged = dispatch.Acknowledged }, DateTime.UtcNow);
        run.Status = TwinActionFlowRunStatus.Running;
        await ContinueFromNodeAsync(run, flow, step.NodeId, actor, cancellationToken);
    }

    private async Task ContinueFromNodeAsync(TwinActionFlowRun run, TwinActionFlow flow, string nodeId, string actor, CancellationToken cancellationToken, bool conditional = false)
    {
        if (run.Status is TwinActionFlowRunStatus.Paused or TwinActionFlowRunStatus.Cancelled or TwinActionFlowRunStatus.Faulted) return;
        using var plan = JsonDocument.Parse(flow.CompiledPayload);
        var edges = EdgesFrom(plan.RootElement, nodeId).OrderByDescending(item => Int(item, "priority") ?? 0).ThenBy(item => String(item, "edgeId"), StringComparer.Ordinal).ToList();
        if (conditional)
        {
            var matching = edges.Where(item => PredicateMatches(run, item)).ToList();
            var selected = matching.FirstOrDefault(item => !(Bool(item, "isDefault") ?? false));
            if (selected.ValueKind == JsonValueKind.Undefined) selected = matching.FirstOrDefault();
            if (selected.ValueKind == JsonValueKind.Undefined) selected = edges.FirstOrDefault(item => Bool(item, "isDefault") ?? false);
            if (selected.ValueKind != JsonValueKind.Undefined)
            {
                var target = String(selected, "targetNodeId"); if (!string.IsNullOrWhiteSpace(target)) await ExecuteNodeAsync(run, flow, target!, NextAttempt(run, target!), actor, cancellationToken);
            }
            else await FaultRunAsync(run, "NO_MATCHING_EDGE", $"节点 {nodeId} 没有匹配分支且未配置 default edge。", actor, cancellationToken);
            return;
        }
        foreach (var edge in edges)
        {
            var target = String(edge, "targetNodeId"); if (string.IsNullOrWhiteSpace(target)) continue;
            await ExecuteNodeAsync(run, flow, target!, NextAttempt(run, target!), actor, cancellationToken);
        }
    }

    private async Task HandleTimeoutAsync(TwinActionFlowRun run, TwinActionFlow flow, TwinActionFlowRunStep step, JsonElement plan, string actor, CancellationToken cancellationToken)
    {
        var node = FindNode(plan, step.NodeId); var timeoutPolicy = node.HasValue ? Object(node.Value, "timeoutPolicy") : null;
        var onTimeout = String(timeoutPolicy, "onTimeout") ?? "fault";
        AppendEvent(run, "StepTimedOut", step.NodeId, step.StepInstanceId, Guid.NewGuid().ToString("N"), actor, new { onTimeout }, DateTime.UtcNow);
        switch (onTimeout.ToLowerInvariant())
        {
            case "retry": await FailStepAsync(run, step, "TIMEOUT", "步骤超时。", actor, cancellationToken, forceRetry: true); break;
            case "skip": step.Status = TwinActionFlowStepStatus.Skipped; step.EndedAt = DateTime.UtcNow; await ContinueFromNodeAsync(run, flow, step.NodeId, actor, cancellationToken); break;
            case "manualconfirm": run.Status = TwinActionFlowRunStatus.WaitingSignal; step.DeadlineAt = null; AppendEvent(run, "ManualConfirmationRequired", step.NodeId, step.StepInstanceId, Guid.NewGuid().ToString("N"), actor, new { reason = "timeout" }, DateTime.UtcNow); break;
            case "compensate": await FailStepAsync(run, step, "TIMEOUT", "步骤超时，需要补偿。", actor, cancellationToken, forceCompensation: true); break;
            default: await FailStepAsync(run, step, "TIMEOUT", "步骤超时。", actor, cancellationToken); break;
        }
    }

    private async Task FailStepAsync(TwinActionFlowRun run, TwinActionFlowRunStep step, string errorCode, string errorMessage, string actor, CancellationToken cancellationToken, bool forceRetry = false, bool forceCompensation = false)
    {
        step.Status = TwinActionFlowStepStatus.Failed; step.ErrorCode = errorCode; step.ErrorMessage = errorMessage; step.EndedAt = DateTime.UtcNow; step.UpdatedAt = step.EndedAt.Value; step.UpdatedBy = actor;
        AppendEvent(run, "StepFailed", step.NodeId, step.StepInstanceId, Guid.NewGuid().ToString("N"), actor, new { errorCode, errorMessage, step.Attempt }, step.EndedAt.Value);
        var flow = await _context.TwinActionFlows.AsNoTracking().FirstAsync(item => item.Id == run.ActionFlowId, cancellationToken);
        using var plan = JsonDocument.Parse(flow.CompiledPayload); var node = FindNode(plan.RootElement, step.NodeId);
        var retry = node.HasValue ? Object(node.Value, "retryPolicy") : null; var maxAttempts = Int(retry, "maxAttempts") ?? 1;
        if ((forceRetry || step.Attempt < maxAttempts) && step.Attempt < Math.Max(maxAttempts, forceRetry ? step.Attempt + 1 : maxAttempts))
        {
            AppendEvent(run, "StepRetryScheduled", step.NodeId, step.StepInstanceId, Guid.NewGuid().ToString("N"), actor, new { nextAttempt = step.Attempt + 1 }, DateTime.UtcNow);
            run.Status = TwinActionFlowRunStatus.Running; await ExecuteNodeAsync(run, flow, step.NodeId, step.Attempt + 1, actor, cancellationToken); return;
        }
        var compensationNodeId = node.HasValue ? String(node.Value, "compensationNodeId") : null;
        if ((forceCompensation || !string.IsNullOrWhiteSpace(compensationNodeId)) && !string.IsNullOrWhiteSpace(compensationNodeId))
        {
            step.Status = TwinActionFlowStepStatus.Compensating;
            AppendEvent(run, "StepCompensating", step.NodeId, step.StepInstanceId, Guid.NewGuid().ToString("N"), actor, new { compensationNodeId }, DateTime.UtcNow);
            await ExecuteNodeAsync(run, flow, compensationNodeId!, NextAttempt(run, compensationNodeId!), actor, cancellationToken);
            step.Status = TwinActionFlowStepStatus.Compensated; step.UpdatedAt = DateTime.UtcNow;
            AppendEvent(run, "StepCompensated", step.NodeId, step.StepInstanceId, Guid.NewGuid().ToString("N"), actor, new { compensationNodeId }, step.UpdatedAt);
            return;
        }
        await FaultRunAsync(run, errorCode, errorMessage, actor, cancellationToken);
    }

    private async Task FaultRunAsync(TwinActionFlowRun run, string code, string message, string actor, CancellationToken cancellationToken)
    {
        run.Status = TwinActionFlowRunStatus.Faulted; run.FaultCode = code; run.FaultMessage = message; run.EndedAt = DateTime.UtcNow; run.UpdatedAt = run.EndedAt.Value; run.UpdatedBy = actor; run.ConcurrencyVersion += 1;
        await ReleaseRunReservationsAsync(run.Id, actor, run.EndedAt.Value, cancellationToken);
        AppendEvent(run, "RunFaulted", null, null, Guid.NewGuid().ToString("N"), actor, new { code, message }, run.EndedAt.Value);
    }

    private async Task<bool> AcquireReservationAsync(TwinActionFlowRun run, TwinActionFlowRunStep step, string resourceType, string resourceId, string actor, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(resourceId) || resourceType is not ("actor" or "slot" or "section" or "material")) return false;
        var now = DateTime.UtcNow;
        var local = _context.TwinResourceReservations.Local.FirstOrDefault(item => !item.Deleted
            && item.ResourceType == resourceType && item.ResourceId == resourceId
            && item.Status == TwinReservationStatus.Active && item.LeaseUntil > now);
        if (local != null)
        {
            if (local.OwnerRunId != run.Id) return false;
            local.LeaseUntil = now.AddSeconds(30); local.Revision += 1; local.UpdatedAt = now; local.UpdatedBy = actor;
            return true;
        }
        var stale = await _context.TwinResourceReservations.Where(item => !item.Deleted && item.ResourceType == resourceType && item.ResourceId == resourceId && item.Status == TwinReservationStatus.Active && item.LeaseUntil <= now).ToListAsync(cancellationToken);
        foreach (var item in stale) { item.Status = TwinReservationStatus.Expired; item.UpdatedAt = now; item.UpdatedBy = actor; item.Revision += 1; }
        var owned = await _context.TwinResourceReservations.FirstOrDefaultAsync(item => !item.Deleted && item.ResourceType == resourceType && item.ResourceId == resourceId && item.Status == TwinReservationStatus.Active && item.LeaseUntil > now, cancellationToken);
        if (owned != null)
        {
            if (owned.OwnerRunId != run.Id) return false;
            owned.LeaseUntil = now.AddSeconds(30); owned.Revision += 1; owned.UpdatedAt = now; owned.UpdatedBy = actor; return true;
        }
        var reservation = new TwinResourceReservation
        {
            Id = Guid.NewGuid(), ReservationId = Guid.NewGuid().ToString("N"), ResourceType = resourceType, ResourceId = resourceId,
            OwnerRunId = run.Id, OwnerRun = run, OwnerStepId = step.Id, OwnerStep = step, Status = TwinReservationStatus.Active,
            LeaseUntil = now.AddSeconds(30), CreatedAt = now, UpdatedAt = now, CreatedBy = actor, UpdatedBy = actor, TenantId = run.TenantId, CustomerId = run.CustomerId
        };
        _context.TwinResourceReservations.Add(reservation);
        AppendEvent(run, "ResourceReserved", step.NodeId, step.StepInstanceId, reservation.ReservationId, actor, new { resourceType, resourceId, reservation.LeaseUntil }, now);
        return true;
    }

    private async Task ReleaseReservationAsync(Guid runId, string resourceType, string resourceId, string actor, CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        var rows = await _context.TwinResourceReservations.Where(item => item.OwnerRunId == runId && !item.Deleted && item.Status == TwinReservationStatus.Active && item.ResourceType == resourceType && item.ResourceId == resourceId).ToListAsync(cancellationToken);
        foreach (var item in rows) { item.Status = TwinReservationStatus.Released; item.UpdatedAt = now; item.UpdatedBy = actor; item.Revision += 1; }
    }

    private async Task ReleaseRunReservationsAsync(Guid runId, string actor, DateTime now, CancellationToken cancellationToken)
    {
        var rows = await _context.TwinResourceReservations.Where(item => item.OwnerRunId == runId && !item.Deleted && item.Status == TwinReservationStatus.Active).ToListAsync(cancellationToken);
        foreach (var item in rows) { item.Status = TwinReservationStatus.Released; item.UpdatedAt = now; item.UpdatedBy = actor; item.Revision += 1; }
    }

    private async Task TransferMaterialAsync(TwinActionFlowRun run, TwinActionFlowRunStep step, string materialId, string ownerType, string ownerId, string actor, CancellationToken cancellationToken)
    {
        var now = DateTime.UtcNow;
        var material = await _context.TwinMaterialRuntimes.FirstOrDefaultAsync(item => item.SceneId == run.SceneId && item.MaterialInstanceId == materialId && !item.Deleted, cancellationToken);
        if (material == null)
        {
            material = new TwinMaterialRuntime { Id = Guid.NewGuid(), SceneId = run.SceneId, MaterialInstanceId = materialId, OwnerType = ownerType, OwnerId = ownerId, PoseSource = "telemetry", Status = TwinMaterialRuntimeStatus.InTransit, Revision = 1, LastEventSequence = run.CurrentSequence + 1, CreatedAt = now, UpdatedAt = now, CreatedBy = actor, UpdatedBy = actor, TenantId = run.TenantId, CustomerId = run.CustomerId };
            _context.TwinMaterialRuntimes.Add(material);
        }
        else
        {
            material.OwnerType = ownerType; material.OwnerId = ownerId; material.Status = TwinMaterialRuntimeStatus.InTransit; material.Revision += 1; material.LastEventSequence = run.CurrentSequence + 1; material.UpdatedAt = now; material.UpdatedBy = actor;
        }
        AppendEvent(run, "MaterialOwnershipTransferred", step.NodeId, step.StepInstanceId, Guid.NewGuid().ToString("N"), actor, new { materialId, ownerType, ownerId, material.Revision }, now);
    }

    private void SucceedStep(TwinActionFlowRun run, TwinActionFlowRunStep step, string actor, object output, DateTime now)
    {
        step.Status = TwinActionFlowStepStatus.Succeeded; step.OutputPayload = JsonSerializer.Serialize(output, JsonOptions); step.EndedAt = now; step.UpdatedAt = now; step.UpdatedBy = actor;
        AppendEvent(run, "StepSucceeded", step.NodeId, step.StepInstanceId, Guid.NewGuid().ToString("N"), actor, output, now);
    }

    private static bool IsDuplicateOrStale(TwinDeviceCommand command, TwinDeviceCommandStatus incoming, string? cycleId)
    {
        if (!string.IsNullOrWhiteSpace(command.DeviceCycleId) && !string.IsNullOrWhiteSpace(cycleId) && CompareCycle(cycleId!, command.DeviceCycleId!) < 0) return true;
        return CommandRank(incoming) <= CommandRank(command.Status);
    }

    private static void ApplyCommandStatus(TwinDeviceCommand command, TwinDeviceCommandStatus status, string? cycleId, DateTime at, JsonElement? payload)
    {
        command.Status = status; if (!string.IsNullOrWhiteSpace(cycleId)) command.DeviceCycleId = cycleId; command.UpdatedAt = DateTime.UtcNow;
        switch (status)
        {
            case TwinDeviceCommandStatus.Sent: command.SentAt ??= at; break;
            case TwinDeviceCommandStatus.Acknowledged: command.AcknowledgedAt ??= at; break;
            case TwinDeviceCommandStatus.Busy: command.BusyAt ??= at; break;
            case TwinDeviceCommandStatus.Completed: command.CompletedAt ??= at; break;
            case TwinDeviceCommandStatus.Faulted: command.CompletedAt ??= at; command.LastError = payload?.GetRawText(); break;
        }
    }

    private static int CommandRank(TwinDeviceCommandStatus status) => status switch { TwinDeviceCommandStatus.Pending => 0, TwinDeviceCommandStatus.Sent => 1, TwinDeviceCommandStatus.Acknowledged => 2, TwinDeviceCommandStatus.Busy => 3, TwinDeviceCommandStatus.Completed => 4, TwinDeviceCommandStatus.Faulted => 4, TwinDeviceCommandStatus.Cancelled => 4, _ => 0 };
    private static int CompareCycle(string left, string right) => long.TryParse(left, out var l) && long.TryParse(right, out var r) ? l.CompareTo(r) : string.CompareOrdinal(left, right);

    private void AppendEvent(TwinActionFlowRun run, string type, string? nodeId, string? stepId, string correlationId, string source, object payload, DateTime occurredAt)
    {
        run.CurrentSequence += 1; run.UpdatedAt = DateTime.UtcNow; run.ConcurrencyVersion += 1;
        if (!string.IsNullOrWhiteSpace(stepId))
        {
            var step = run.Steps.FirstOrDefault(item => item.StepInstanceId == stepId);
            if (step != null) step.LastSequence = run.CurrentSequence;
        }
        _context.TwinActionFlowEvents.Add(new TwinActionFlowEvent
        {
            Id = Guid.NewGuid(), RunId = run.Id, Run = run, Sequence = run.CurrentSequence, EventType = type, NodeId = nodeId, StepInstanceId = stepId,
            CorrelationId = correlationId, Source = source, Payload = JsonSerializer.Serialize(payload, JsonOptions), OccurredAt = occurredAt, CreatedAt = DateTime.UtcNow,
            TenantId = run.TenantId, CustomerId = run.CustomerId
        });
    }

    private async Task SaveAndPublishAsync(TwinActionFlowRun run, long afterSequence, CancellationToken cancellationToken)
    {
        try { await _context.SaveChangesAsync(cancellationToken); }
        catch (DbUpdateConcurrencyException exception) { throw new TwinOperationException(ApiCode.InValidData, "Run 并发版本冲突，请重新读取最新 sequence 后重试。", exception); }
        var events = await _context.TwinActionFlowEvents.AsNoTracking().Where(item => item.RunId == run.Id && item.Sequence > afterSequence && !item.Deleted).OrderBy(item => item.Sequence).ToListAsync(cancellationToken);
        foreach (var item in events) await _eventPublisher.PublishAsync(ToEventDto(item), cancellationToken);
    }

    private async Task<TwinActionFlowRun> LoadRunForUpdateAsync(Guid runId, Guid tenantId, Guid customerId, CancellationToken cancellationToken) =>
        await _context.TwinActionFlowRuns.Include(item => item.ActionFlow).Include(item => item.Steps).FirstOrDefaultAsync(item => item.Id == runId && !item.Deleted && item.TenantId == tenantId && item.CustomerId == customerId, cancellationToken)
        ?? throw new TwinOperationException(ApiCode.CantFindObject, "Run 不存在或无权访问。");

    private async Task RequireRunAccessAsync(Guid runId, Guid tenantId, Guid customerId, CancellationToken cancellationToken)
    {
        if (!await _context.TwinActionFlowRuns.AsNoTracking().AnyAsync(item => item.Id == runId && !item.Deleted && item.TenantId == tenantId && item.CustomerId == customerId, cancellationToken))
            throw new TwinOperationException(ApiCode.CantFindObject, "Run 不存在或无权访问。");
    }

    private async Task<TwinActionFlowRunDto> GetRunInternalAsync(Guid runId, Guid tenantId, Guid customerId, CancellationToken cancellationToken)
    {
        var run = await _context.TwinActionFlowRuns.AsNoTracking().Include(item => item.ActionFlow).Include(item => item.Steps).FirstOrDefaultAsync(item => item.Id == runId && !item.Deleted && item.TenantId == tenantId && item.CustomerId == customerId, cancellationToken)
            ?? throw new TwinOperationException(ApiCode.CantFindObject, "Run 不存在或无权访问。");
        var dto = ToRunDto(run);
        dto.Commands = await _context.TwinDeviceCommands.AsNoTracking()
            .Where(item => item.RunId == run.Id && !item.Deleted)
            .OrderBy(item => item.CreatedAt)
            .Select(item => new TwinDeviceCommandDto
            {
                Id = item.Id, CommandId = item.CommandId, CorrelationId = item.CorrelationId, BindingKey = item.BindingKey,
                Status = item.Status.ToString(), DeviceCycleId = item.DeviceCycleId, SentAt = item.SentAt,
                AcknowledgedAt = item.AcknowledgedAt, BusyAt = item.BusyAt, CompletedAt = item.CompletedAt, LastError = item.LastError
            }).ToListAsync(cancellationToken);
        dto.Reservations = await _context.TwinResourceReservations.AsNoTracking()
            .Where(item => item.OwnerRunId == run.Id && !item.Deleted)
            .OrderBy(item => item.CreatedAt)
            .Select(item => new TwinResourceReservationDto
            {
                ReservationId = item.ReservationId, ResourceType = item.ResourceType, ResourceId = item.ResourceId,
                OwnerRunId = item.OwnerRunId, Status = item.Status.ToString(), LeaseUntil = item.LeaseUntil, Revision = item.Revision
            }).ToListAsync(cancellationToken);
        dto.Materials = await _context.TwinMaterialRuntimes.AsNoTracking()
            .Where(item => item.SceneId == run.SceneId && !item.Deleted)
            .OrderBy(item => item.MaterialInstanceId)
            .Select(item => new TwinMaterialRuntimeDto
            {
                MaterialInstanceId = item.MaterialInstanceId, TransportUnitId = item.TransportUnitId, MaterialType = item.MaterialType,
                OwnerType = item.OwnerType, OwnerId = item.OwnerId, PoseSource = item.PoseSource, Status = item.Status.ToString(),
                Revision = item.Revision, LastEventSequence = item.LastEventSequence
            }).ToListAsync(cancellationToken);
        return dto;
    }

    private static TwinActionFlowRunDto ToRunDto(TwinActionFlowRun run) => new()
    {
        Id = run.Id, SceneId = run.SceneId, SceneVersionId = run.SceneVersionId, ActionFlowId = run.ActionFlowId, FlowKey = run.ActionFlow?.FlowKey ?? string.Empty,
        IdempotencyKey = run.IdempotencyKey, Status = run.Status.ToString(), Input = ParseJson(run.InputPayload), Runtime = ParseJson(run.RuntimePayload),
        CurrentSequence = run.CurrentSequence, ConcurrencyVersion = run.ConcurrencyVersion, GraphHash = run.GraphHash, CompiledPlanHash = run.CompiledPlanHash,
        FaultCode = run.FaultCode, FaultMessage = run.FaultMessage, StartedAt = run.StartedAt, EndedAt = run.EndedAt, CreatedAt = run.CreatedAt, UpdatedAt = run.UpdatedAt,
        Steps = run.Steps.Where(item => !item.Deleted).OrderBy(item => item.CreatedAt).Select(item => new TwinActionFlowRunStepDto
        {
            Id = item.Id, StepInstanceId = item.StepInstanceId, NodeId = item.NodeId, Attempt = item.Attempt, Status = item.Status.ToString(), Input = ParseJson(item.InputPayload), Output = ParseJson(item.OutputPayload), ErrorCode = item.ErrorCode, ErrorMessage = item.ErrorMessage, DeadlineAt = item.DeadlineAt, StartedAt = item.StartedAt, EndedAt = item.EndedAt, LastSequence = item.LastSequence
        }).ToList()
    };

    private static TwinActionFlowDto ToFlowDto(TwinActionFlow item) => new()
    {
        Id = item.Id, SceneId = item.SceneId, SceneVersionId = item.SceneVersionId, FlowKey = item.FlowKey, Name = item.Name,
        ContractVersion = item.ContractVersion, ActorScope = ParseJson(item.ActorScope), GraphPayload = ParseJson(item.GraphPayload), GraphHash = item.GraphHash,
        CompiledPayload = ParseJson(item.CompiledPayload), CompiledPlanHash = item.CompiledPlanHash, Revision = item.Revision, Enabled = item.Enabled
    };

    private static TwinActionFlowEventDto ToEventDto(TwinActionFlowEvent item) => new() { Id = item.Id, RunId = item.RunId, Sequence = item.Sequence, EventType = item.EventType, NodeId = item.NodeId, StepInstanceId = item.StepInstanceId, CorrelationId = item.CorrelationId, Source = item.Source, Payload = ParseJson(item.Payload), OccurredAt = item.OccurredAt };

    private static JsonElement ParseJson(string? json) { using var doc = JsonDocument.Parse(string.IsNullOrWhiteSpace(json) ? "{}" : json); return doc.RootElement.Clone(); }
    private static HashSet<string> ReadFlowIds(JsonElement manifest) => manifest.TryGetProperty("actionFlows", out var flows) && flows.ValueKind == JsonValueKind.Array ? flows.EnumerateArray().Select(item => String(item, "flowId")).Where(item => !string.IsNullOrWhiteSpace(item)).Cast<string>().ToHashSet(StringComparer.Ordinal) : [];
    private static JsonElement? FindNode(JsonElement plan, string nodeId) => plan.TryGetProperty("nodes", out var nodes) && nodes.ValueKind == JsonValueKind.Array ? nodes.EnumerateArray().Cast<JsonElement?>().FirstOrDefault(item => item.HasValue && String(item.Value, "nodeId") == nodeId) : null;
    private static IEnumerable<JsonElement> EdgesFrom(JsonElement plan, string nodeId) => plan.TryGetProperty("edges", out var edges) && edges.ValueKind == JsonValueKind.Array ? edges.EnumerateArray().Where(item => String(item, "sourceNodeId") == nodeId).ToArray() : [];
    private static JsonElement? Object(JsonElement element, string name) => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.Object ? value : null;
    private static string? String(JsonElement? element, string name) => element.HasValue && element.Value.ValueKind == JsonValueKind.Object && element.Value.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;
    private static double? Number(JsonElement? element, string name) => element.HasValue && element.Value.ValueKind == JsonValueKind.Object && element.Value.TryGetProperty(name, out var value) && value.TryGetDouble(out var result) ? result : null;
    private static int? Int(JsonElement? element, string name) => element.HasValue && element.Value.ValueKind == JsonValueKind.Object && element.Value.TryGetProperty(name, out var value) && value.TryGetInt32(out var result) ? result : null;
    private static bool? Bool(JsonElement element, string name) => element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && (value.ValueKind == JsonValueKind.True || value.ValueKind == JsonValueKind.False) ? value.GetBoolean() : null;
    private static int NextAttempt(TwinActionFlowRun run, string nodeId) => run.Steps.Where(item => item.NodeId == nodeId).Select(item => item.Attempt).DefaultIfEmpty(0).Max() + 1;
    private static int ParallelTokens(TwinActionFlowRun run) => RuntimeObject(run)["activeTokens"]?.GetValue<int>() ?? 1;
    private static void AddParallelTokens(TwinActionFlowRun run, int delta)
    {
        var runtime = RuntimeObject(run);
        runtime["activeTokens"] = Math.Max(0, ParallelTokens(run) + delta);
        run.RuntimePayload = runtime.ToJsonString(JsonOptions);
    }
    private static int ConsumeParallelToken(TwinActionFlowRun run) { AddParallelTokens(run, -1); return ParallelTokens(run); }

    private static bool CanEnterJoin(TwinActionFlowRun run, JsonElement plan, string joinId)
    {
        if (!plan.TryGetProperty("edges", out var edges) || edges.ValueKind != JsonValueKind.Array) return true;
        var sources = edges.EnumerateArray().Where(item => String(item, "targetNodeId") == joinId).Select(item => String(item, "sourceNodeId")).Where(item => !string.IsNullOrWhiteSpace(item)).Cast<string>().Distinct().ToList();
        return sources.All(source => run.Steps.Any(step => step.NodeId == source && step.Status is TwinActionFlowStepStatus.Succeeded or TwinActionFlowStepStatus.Compensated or TwinActionFlowStepStatus.Skipped));
    }

    private static double TimeoutSeconds(JsonElement node, JsonElement plan)
    {
        var nodePolicy = Object(node, "timeoutPolicy"); var seconds = Number(nodePolicy, "seconds");
        if (seconds.HasValue && seconds.Value > 0) return seconds.Value;
        var policies = Object(plan, "policies"); return Math.Max(0.1, Number(policies, "defaultTimeoutSeconds") ?? 300);
    }

    private static bool RegisterVisit(TwinActionFlowRun run, string nodeId, JsonElement plan)
    {
        var runtime = RuntimeObject(run); var visits = runtime["nodeVisits"] as JsonObject ?? new JsonObject(); var count = visits[nodeId]?.GetValue<int>() ?? 0; count += 1; visits[nodeId] = count; runtime["nodeVisits"] = visits; run.RuntimePayload = runtime.ToJsonString(JsonOptions);
        var policies = Object(plan, "policies"); var max = Int(policies, "maxLoopIterations") ?? 1000; return count <= Math.Max(1, max);
    }

    private static JsonObject RuntimeObject(TwinActionFlowRun run)
    {
        try { return JsonNode.Parse(string.IsNullOrWhiteSpace(run.RuntimePayload) ? "{}" : run.RuntimePayload)?.AsObject() ?? new JsonObject(); }
        catch { return new JsonObject(); }
    }

    private static void SetWaitingResource(TwinActionFlowRun run, string stepId, string resource)
    {
        var runtime = RuntimeObject(run); var waiting = runtime["waitingResources"] as JsonObject ?? new JsonObject(); waiting[stepId] = resource; runtime["waitingResources"] = waiting; run.RuntimePayload = runtime.ToJsonString(JsonOptions);
    }

    private void WaitForResource(TwinActionFlowRun run, TwinActionFlowRunStep step, string resourceType, string resourceId, JsonElement node, JsonElement plan, string actor)
    {
        step.Status = TwinActionFlowStepStatus.Waiting;
        step.DeadlineAt = DateTime.UtcNow.AddSeconds(TimeoutSeconds(node, plan));
        run.Status = TwinActionFlowRunStatus.WaitingResource;
        SetWaitingResource(run, step.StepInstanceId, $"{resourceType}:{resourceId}");
        AppendEvent(run, "ResourceWaiting", step.NodeId, step.StepInstanceId, Guid.NewGuid().ToString("N"), actor,
            new { resourceType, resourceId, deadlineAt = step.DeadlineAt }, DateTime.UtcNow);
    }

    private async Task ResumeWaitingResourcesAsync(DateTime now, CancellationToken cancellationToken)
    {
        var runIds = await _context.TwinActionFlowRuns.AsNoTracking()
            .Where(item => !item.Deleted && item.Status == TwinActionFlowRunStatus.WaitingResource)
            .Select(item => item.Id).ToListAsync(cancellationToken);
        foreach (var runId in runIds)
        {
            _context.ChangeTracker.Clear();
            var run = await _context.TwinActionFlowRuns.Include(item => item.ActionFlow).Include(item => item.Steps)
                .FirstOrDefaultAsync(item => item.Id == runId && !item.Deleted, cancellationToken);
            if (run == null) continue;
            var runtime = RuntimeObject(run); var waiting = runtime["waitingResources"] as JsonObject;
            if (waiting == null || waiting.Count == 0) continue;
            var from = run.CurrentSequence;
            foreach (var pair in waiting.ToList())
            {
                var step = run.Steps.FirstOrDefault(item => item.StepInstanceId == pair.Key && item.Status == TwinActionFlowStepStatus.Waiting);
                if (step == null) { waiting.Remove(pair.Key); continue; }
                var spec = pair.Value?.GetValue<string>() ?? string.Empty; var separator = spec.IndexOf(':');
                if (separator <= 0) continue;
                var resourceType = spec[..separator]; var resourceId = spec[(separator + 1)..];
                if (!await AcquireReservationAsync(run, step, resourceType, resourceId, "runtime-maintenance", cancellationToken)) continue;
                step.Status = TwinActionFlowStepStatus.Skipped; step.EndedAt = now; step.UpdatedAt = now; step.UpdatedBy = "runtime-maintenance";
                waiting.Remove(pair.Key);
                AppendEvent(run, "ResourceAvailable", step.NodeId, step.StepInstanceId, Guid.NewGuid().ToString("N"), "runtime-maintenance", new { resourceType, resourceId }, now);
                run.Status = TwinActionFlowRunStatus.Running;
                await ExecuteNodeAsync(run, run.ActionFlow, step.NodeId, step.Attempt + 1, "runtime-maintenance", cancellationToken);
            }
            runtime["waitingResources"] = waiting; run.RuntimePayload = runtime.ToJsonString(JsonOptions);
            if (run.CurrentSequence > from) await SaveAndPublishAsync(run, from, cancellationToken);
        }
        _context.ChangeTracker.Clear();
    }

    private async Task DetectSimpleDeadlocksAsync(DateTime now, CancellationToken cancellationToken)
    {
        var waitingRuns = await _context.TwinActionFlowRuns.Include(item => item.Steps)
            .Where(item => !item.Deleted && item.Status == TwinActionFlowRunStatus.WaitingResource).ToListAsync(cancellationToken);
        if (waitingRuns.Count < 2) return;
        var active = await _context.TwinResourceReservations.AsNoTracking()
            .Where(item => !item.Deleted && item.Status == TwinReservationStatus.Active && item.LeaseUntil > now).ToListAsync(cancellationToken);
        var waitFor = new Dictionary<Guid, Guid>();
        foreach (var run in waitingRuns)
        {
            var waiting = RuntimeObject(run)["waitingResources"] as JsonObject; if (waiting == null) continue;
            foreach (var spec in waiting.Select(item => item.Value?.GetValue<string>()).Where(item => !string.IsNullOrWhiteSpace(item)))
            {
                var separator = spec!.IndexOf(':'); if (separator <= 0) continue;
                var resourceType = spec[..separator]; var resourceId = spec[(separator + 1)..];
                var owner = active.FirstOrDefault(item => item.ResourceType == resourceType && item.ResourceId == resourceId && item.OwnerRunId != run.Id);
                if (owner != null) { waitFor[run.Id] = owner.OwnerRunId; break; }
            }
        }
        var victims = waitFor.Where(pair => waitFor.TryGetValue(pair.Value, out var back) && back == pair.Key)
            .Select(pair => pair.Key).Distinct().OrderBy(id => id).Skip(1).ToList();
        foreach (var victimId in victims)
        {
            var run = waitingRuns.FirstOrDefault(item => item.Id == victimId); if (run == null) continue;
            var from = run.CurrentSequence;
            await FaultRunAsync(run, "RESOURCE_DEADLOCK", "检测到资源等待环，运行已按确定性 victim 规则终止。", "runtime-maintenance", cancellationToken);
            await ReleaseRunReservationsAsync(run.Id, "runtime-maintenance", now, cancellationToken);
            await SaveAndPublishAsync(run, from, cancellationToken);
        }
        _context.ChangeTracker.Clear();
    }

    private static bool PredicateMatches(TwinActionFlowRun run, JsonElement edge)
    {
        if (!edge.TryGetProperty("predicate", out var predicate) || predicate.ValueKind != JsonValueKind.Object) return true;
        return GroupMatches(run, predicate);
    }

    private static bool GroupMatches(TwinActionFlowRun run, JsonElement group)
    {
        var logic = String(group, "logic") ?? "and"; if (!group.TryGetProperty("items", out var items) || items.ValueKind != JsonValueKind.Array) return true;
        var results = items.EnumerateArray().Select(item => item.TryGetProperty("logic", out _) ? GroupMatches(run, item) : LeafMatches(run, item)).ToList();
        return logic.Equals("or", StringComparison.OrdinalIgnoreCase) ? results.Any(item => item) : results.All(item => item);
    }

    private static bool LeafMatches(TwinActionFlowRun run, JsonElement leaf)
    {
        var source = String(leaf, "source") ?? string.Empty; var reference = String(leaf, "ref") ?? string.Empty; var op = String(leaf, "operator") ?? "truthy"; JsonNode? current = null;
        if (source == "binding") current = (RuntimeObject(run)["lastSignals"] as JsonObject)?[reference]?.DeepClone();
        else if (source == "variable" || source == "runtime") current = RuntimeObject(run)[reference]?.DeepClone();
        else if (source == "input") { try { current = JsonNode.Parse(run.InputPayload)?[reference]?.DeepClone(); } catch { } }
        JsonNode? expected = leaf.TryGetProperty("value", out var value) ? JsonNode.Parse(value.GetRawText()) : null;
        return CompareNodes(current, expected, op);
    }

    private static bool CompareNodes(JsonNode? current, JsonNode? expected, string op)
    {
        if (op == "truthy") return Truthy(current); if (op == "falsy") return !Truthy(current);
        var left = current?.ToJsonString() ?? "null"; var right = expected?.ToJsonString() ?? "null";
        if (op == "eq") return left == right; if (op == "ne") return left != right;
        if (double.TryParse(current?.ToString(), out var l) && double.TryParse(expected?.ToString(), out var r)) return op switch { "gt" => l > r, "gte" => l >= r, "lt" => l < r, "lte" => l <= r, _ => false };
        return false;
    }

    private static bool Truthy(JsonNode? node)
    {
        if (node == null) return false; var text = node.ToString(); if (bool.TryParse(text, out var b)) return b; if (double.TryParse(text, out var n)) return Math.Abs(n) > double.Epsilon; return !string.IsNullOrWhiteSpace(text) && text != "0" && !text.Equals("null", StringComparison.OrdinalIgnoreCase);
    }

    private static bool SignalMatches(string trigger, JsonNode? previous, JsonElement current)
    {
        var nowNode = JsonNode.Parse(current.GetRawText());
        return trigger switch
        {
            "risingEdge" => !Truthy(previous) && Truthy(nowNode),
            "changed" => (previous?.ToJsonString() ?? "null") != (nowNode?.ToJsonString() ?? "null"),
            "falsy" => !Truthy(nowNode),
            _ => Truthy(nowNode)
        };
    }

    private static string Hash(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
    private static string ResolveActor(UserProfile profile) => string.IsNullOrWhiteSpace(profile.Name) ? profile.Id.ToString("D") : profile.Name;
}
