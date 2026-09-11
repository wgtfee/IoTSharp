#nullable enable
using IoTSharp.Contracts;
using IoTSharp.Data;
using IoTSharp.Models;
using IoTSharp.Services.DigitalTwin;
using IoTSharp.Services.DigitalTwin.ActionFlow;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using Xunit;

namespace IoTSharp.Test;

/// <summary>Action Flow V2 服务端运行态、幂等、资源锁与恢复回归测试。</summary>
public sealed class TwinActionFlowRuntimeServiceTests
{
    [Fact]
    public async Task StartRun_IsIdempotent_AndRequiresExplicitLiveMode()
    {
        await using var fixture = await Fixture.CreateAsync(SimplePlan(Node("start", "Start"), Node("end", "End"), Edge("start", "end")));
        var first = await fixture.Runtime.StartRunAsync(fixture.DraftFlowId, new() { IdempotencyKey = "order-1", RuntimeMode = "live" }, fixture.Profile, default);
        var second = await fixture.Runtime.StartRunAsync(fixture.DraftFlowId, new() { IdempotencyKey = "order-1", RuntimeMode = "live" }, fixture.Profile, default);
        Assert.Equal(first.Id, second.Id);
        Assert.Equal("Completed", second.Status);
        Assert.Equal(1, await fixture.Context.TwinActionFlowRuns.CountAsync());
        await Assert.ThrowsAsync<TwinOperationException>(() => fixture.Runtime.StartRunAsync(fixture.DraftFlowId, new() { IdempotencyKey = "sim", RuntimeMode = "simulation" }, fixture.Profile, default));
    }

    [Fact]
    public async Task ManualConfirm_RequiresReason_AndIsAuditable()
    {
        var manual = Node("manual", "ManualConfirm");
        manual["timeoutPolicy"] = JsonSerializer.SerializeToElement(new { seconds = 60, onTimeout = "fault" });
        await using var fixture = await Fixture.CreateAsync(SimplePlan(Node("start", "Start"), manual, Node("end", "End"), Edge("start", "manual"), Edge("manual", "end")));
        var run = await fixture.Runtime.StartRunAsync(fixture.DraftFlowId, new() { IdempotencyKey = "manual-1" }, fixture.Profile, default);
        Assert.Equal("WaitingSignal", run.Status);
        var waiting = Assert.Single(run.Steps.Where(item => item.NodeId == "manual" && item.Status == "Waiting"));
        await Assert.ThrowsAsync<TwinOperationException>(() => fixture.Runtime.ManualConfirmAsync(run.Id, new() { StepInstanceId = waiting.StepInstanceId, Reason = "" }, fixture.Profile, default));
        const string reason = "现场已确认安全";
        var completed = await fixture.Runtime.ManualConfirmAsync(run.Id, new() { StepInstanceId = waiting.StepInstanceId, Reason = reason }, fixture.Profile, default);
        Assert.Equal("Completed", completed.Status);
        var events = await fixture.Runtime.GetEventsAsync(run.Id, 0, 100, fixture.Profile, default);
        Assert.Contains(events, item => item.EventType == "StepSucceeded"
            && item.Payload.TryGetProperty("reason", out var auditReason)
            && auditReason.GetString() == reason);
    }

    [Fact]
    public async Task SlotReservation_PreventsDoubleOwnership_AndResumesAfterRelease()
    {
        var reserve = Node("reserve", "ReserveSlot", config: new { slotId = "slot-A" });
        reserve["timeoutPolicy"] = JsonSerializer.SerializeToElement(new { seconds = 60, onTimeout = "fault" });
        var wait = Node("wait", "WaitSignal", config: new { bindingId = "hold", trigger = "truthy" });
        wait["timeoutPolicy"] = JsonSerializer.SerializeToElement(new { seconds = 60, onTimeout = "fault" });
        await using var fixture = await Fixture.CreateAsync(SimplePlan(Node("start", "Start"), reserve, wait, Node("end", "End"), Edge("start", "reserve"), Edge("reserve", "wait"), Edge("wait", "end")));
        var first = await fixture.Runtime.StartRunAsync(fixture.DraftFlowId, new() { IdempotencyKey = "slot-1" }, fixture.Profile, default);
        var second = await fixture.Runtime.StartRunAsync(fixture.DraftFlowId, new() { IdempotencyKey = "slot-2" }, fixture.Profile, default);
        Assert.Equal("WaitingSignal", first.Status);
        Assert.Equal("WaitingResource", second.Status);
        var activeBefore = await fixture.Context.TwinResourceReservations.Where(item => item.ResourceType == "slot" && item.ResourceId == "slot-A" && item.Status == TwinReservationStatus.Active).ToListAsync();
        Assert.Single(activeBefore);
        Assert.Equal(first.Id, activeBefore[0].OwnerRunId);
        await fixture.Runtime.CancelAsync(first.Id, "释放测试槽位", fixture.Profile, default);
        await fixture.Runtime.MaintenanceAsync(default);
        var secondAfter = await fixture.Runtime.GetRunAsync(second.Id, fixture.Profile, default);
        Assert.Equal("WaitingSignal", secondAfter.Status);
        var activeAfter = await fixture.Context.TwinResourceReservations.Where(item => item.ResourceType == "slot" && item.ResourceId == "slot-A" && item.Status == TwinReservationStatus.Active).ToListAsync();
        Assert.Single(activeAfter);
        Assert.Equal(second.Id, activeAfter[0].OwnerRunId);
    }

    [Fact]
    public async Task MaterialOwnership_IsAtomicAcrossRuns()
    {
        var transfer = Node("transfer", "TransferMaterial", config: new { materialInstanceId = "silk-001", targetOwnerType = "slot", targetOwnerId = "slot-B" });
        transfer["timeoutPolicy"] = JsonSerializer.SerializeToElement(new { seconds = 60, onTimeout = "fault" });
        var wait = Node("wait", "WaitSignal", config: new { bindingId = "hold", trigger = "truthy" });
        wait["timeoutPolicy"] = JsonSerializer.SerializeToElement(new { seconds = 60, onTimeout = "fault" });
        await using var fixture = await Fixture.CreateAsync(SimplePlan(Node("start", "Start"), transfer, wait, Node("end", "End"), Edge("start", "transfer"), Edge("transfer", "wait"), Edge("wait", "end")));
        var first = await fixture.Runtime.StartRunAsync(fixture.DraftFlowId, new() { IdempotencyKey = "mat-1" }, fixture.Profile, default);
        var second = await fixture.Runtime.StartRunAsync(fixture.DraftFlowId, new() { IdempotencyKey = "mat-2" }, fixture.Profile, default);
        Assert.Equal("WaitingResource", second.Status);
        Assert.Single(await fixture.Context.TwinMaterialRuntimes.Where(item => item.SceneId == fixture.SceneId && item.MaterialInstanceId == "silk-001").ToListAsync());
        Assert.Single(await fixture.Context.TwinResourceReservations.Where(item => item.ResourceType == "material" && item.ResourceId == "silk-001" && item.Status == TwinReservationStatus.Active).ToListAsync());
        await fixture.Runtime.CancelAsync(first.Id, "释放物料锁", fixture.Profile, default);
        await fixture.Runtime.MaintenanceAsync(default);
        var active = await fixture.Context.TwinResourceReservations.Where(item => item.ResourceType == "material" && item.ResourceId == "silk-001" && item.Status == TwinReservationStatus.Active).ToListAsync();
        Assert.Single(active);
        Assert.Equal(second.Id, active[0].OwnerRunId);
        Assert.Single(await fixture.Context.TwinMaterialRuntimes.Where(item => item.SceneId == fixture.SceneId && item.MaterialInstanceId == "silk-001").ToListAsync());
    }

    [Fact]
    public async Task CommandFeedback_IsMonotonic_Deduplicated_AndCycleSafe()
    {
        var command = Node("cmd", "WriteCommand", "robot-1", new { bindingId = "cmd-binding", interlockIds = new[] { "safe" }, payload = new { recipe = 1 } });
        command["timeoutPolicy"] = JsonSerializer.SerializeToElement(new { seconds = 30, onTimeout = "fault" });
        var ack = Node("ack", "WaitAck", config: new { bindingId = "ack-binding" });
        ack["timeoutPolicy"] = JsonSerializer.SerializeToElement(new { seconds = 30, onTimeout = "fault" });
        var done = Node("done", "WaitSignal", config: new { bindingId = "done-binding", trigger = "truthy" });
        done["timeoutPolicy"] = JsonSerializer.SerializeToElement(new { seconds = 60, onTimeout = "fault" });
        await using var fixture = await Fixture.CreateAsync(SimplePlan(Node("start", "Start"), command, ack, done, Node("end", "End"), Edge("start", "cmd"), Edge("cmd", "ack"), Edge("ack", "done"), Edge("done", "end")), adapter: new FakeCommandAdapter(cycleId: "2"));
        var run = await fixture.Runtime.StartRunAsync(fixture.DraftFlowId, new() { IdempotencyKey = "cmd-1" }, fixture.Profile, default);
        Assert.Equal("WaitingSignal", run.Status);
        var persisted = await fixture.Context.TwinDeviceCommands.SingleAsync();
        Assert.Equal(TwinDeviceCommandStatus.Acknowledged, persisted.Status);
        var busy = new TwinActionFlowCommandFeedbackDto { CommandId = persisted.CommandId, CorrelationId = persisted.CorrelationId, CycleId = "2", Status = "Busy" };
        var afterBusy = await fixture.Runtime.ApplyCommandFeedbackAsync(run.Id, busy, fixture.Profile, default);
        var afterDuplicate = await fixture.Runtime.ApplyCommandFeedbackAsync(run.Id, busy, fixture.Profile, default);
        await fixture.Runtime.ApplyCommandFeedbackAsync(run.Id, new() { CommandId = persisted.CommandId, CorrelationId = persisted.CorrelationId, CycleId = "1", Status = "Acknowledged" }, fixture.Profile, default);
        await fixture.Runtime.ApplyCommandFeedbackAsync(run.Id, new() { CommandId = persisted.CommandId, CorrelationId = persisted.CorrelationId, CycleId = "2", Status = "Completed" }, fixture.Profile, default);
        Assert.True(afterDuplicate.CurrentSequence > afterBusy.CurrentSequence);
        var ignored = await fixture.Context.TwinActionFlowEvents.CountAsync(item => item.RunId == run.Id && item.EventType == "CommandFeedbackIgnored");
        Assert.True(ignored >= 2);
        var completed = await fixture.Runtime.ApplySignalAsync(run.Id, new() { BindingId = "done-binding", CycleId = "2", Value = JsonSerializer.SerializeToElement(true) }, fixture.Profile, default);
        Assert.Equal("Completed", completed.Status);
        var sequence = completed.CurrentSequence;
        var stale = await fixture.Runtime.ApplySignalAsync(run.Id, new() { BindingId = "done-binding", CycleId = "1", Value = JsonSerializer.SerializeToElement(false) }, fixture.Profile, default);
        Assert.True(stale.CurrentSequence > sequence);
        Assert.Contains(await fixture.Runtime.GetEventsAsync(run.Id, 0, 500, fixture.Profile, default), item => item.EventType == "SignalIgnored");
    }

    [Fact]
    public async Task Recovery_DoesNotResendExistingCommand()
    {
        var adapter = new FakeCommandAdapter(cycleId: "8");
        var command = Node("cmd", "WriteCommand", "robot-1", new { bindingId = "cmd-binding", interlockIds = new[] { "safe" } });
        command["timeoutPolicy"] = JsonSerializer.SerializeToElement(new { seconds = 30, onTimeout = "fault" });
        var wait = Node("wait", "WaitSignal", config: new { bindingId = "done-binding" });
        wait["timeoutPolicy"] = JsonSerializer.SerializeToElement(new { seconds = 60, onTimeout = "fault" });
        await using var fixture = await Fixture.CreateAsync(SimplePlan(Node("start", "Start"), command, wait, Node("end", "End"), Edge("start", "cmd"), Edge("cmd", "wait"), Edge("wait", "end")), adapter);
        var run = await fixture.Runtime.StartRunAsync(fixture.DraftFlowId, new() { IdempotencyKey = "recover-1" }, fixture.Profile, default);
        Assert.Equal(1, adapter.SendCount);
        await fixture.Runtime.RecoverActiveRunsAsync(default);
        Assert.Equal(1, adapter.SendCount);
        var recovered = await fixture.Runtime.GetRunAsync(run.Id, fixture.Profile, default);
        Assert.Equal("WaitingSignal", recovered.Status);
        Assert.Contains(await fixture.Runtime.GetEventsAsync(run.Id, 0, 200, fixture.Profile, default), item => item.EventType == "RunReconciled");
    }

    [Fact]
    public async Task Delay_CompletesFromMaintenance_WithoutBeingTreatedAsTimeout()
    {
        var delay = Node("delay", "Delay", config: new { durationSeconds = 0.01 });
        await using var fixture = await Fixture.CreateAsync(SimplePlan(Node("start", "Start"), delay, Node("end", "End"), Edge("start", "delay"), Edge("delay", "end")));
        var run = await fixture.Runtime.StartRunAsync(fixture.DraftFlowId, new() { IdempotencyKey = "delay-1" }, fixture.Profile, default);
        Assert.Equal("WaitingSignal", run.Status);
        await Task.Delay(30);
        await fixture.Runtime.MaintenanceAsync(default);
        Assert.Equal("Completed", (await fixture.Runtime.GetRunAsync(run.Id, fixture.Profile, default)).Status);
    }

    [Fact]
    public async Task CommandFailure_Retries_ThenSucceeds()
    {
        var adapter = new FakeCommandAdapter(failFirst: true);
        var command = Node("cmd", "WriteCommand", config: new { bindingId = "cmd-binding", interlockIds = new[] { "safe" } });
        command["retryPolicy"] = JsonSerializer.SerializeToElement(new { maxAttempts = 2, backoffSeconds = 0 });
        command["timeoutPolicy"] = JsonSerializer.SerializeToElement(new { seconds = 30, onTimeout = "fault" });
        await using var fixture = await Fixture.CreateAsync(SimplePlan(Node("start", "Start"), command, Node("end", "End"), Edge("start", "cmd"), Edge("cmd", "end")), adapter);
        var run = await fixture.Runtime.StartRunAsync(fixture.DraftFlowId, new() { IdempotencyKey = "retry-1" }, fixture.Profile, default);
        Assert.Equal("Completed", run.Status);
        Assert.Equal(2, adapter.SendCount);
        Assert.Contains(run.Steps, item => item.NodeId == "cmd" && item.Attempt == 1 && item.Status == "Failed");
        Assert.Contains(run.Steps, item => item.NodeId == "cmd" && item.Attempt == 2 && item.Status == "Succeeded");
    }

    [Fact]
    public async Task CommandFailure_ExecutesCompensation()
    {
        var adapter = new FakeCommandAdapter(alwaysFail: true);
        var command = Node("cmd", "WriteCommand", config: new { bindingId = "cmd-binding", interlockIds = new[] { "safe" } });
        command["compensationNodeId"] = "comp";
        command["timeoutPolicy"] = JsonSerializer.SerializeToElement(new { seconds = 30, onTimeout = "compensate" });
        await using var fixture = await Fixture.CreateAsync(SimplePlan(Node("start", "Start"), command, Node("comp", "Compensate"), Node("end", "End"), Edge("start", "cmd"), Edge("comp", "end")), adapter);
        var run = await fixture.Runtime.StartRunAsync(fixture.DraftFlowId, new() { IdempotencyKey = "comp-1" }, fixture.Profile, default);
        Assert.Equal("Completed", run.Status);
        Assert.Contains(run.Steps, item => item.NodeId == "cmd" && item.Status == "Compensated");
        Assert.Contains(run.Steps, item => item.NodeId == "comp" && item.Status == "Succeeded");
        Assert.Contains(await fixture.Runtime.GetEventsAsync(run.Id, 0, 200, fixture.Profile, default), item => item.EventType == "StepCompensated");
    }

    private static Dictionary<string, object?> Node(string id, string type, string? actor = null, object? config = null) => new()
    {
        ["nodeId"] = id, ["type"] = type, ["name"] = id, ["actorObjectId"] = actor, ["config"] = config ?? new { }
    };

    private static Dictionary<string, object?> Edge(string source, string target) => new()
    {
        ["edgeId"] = $"{source}-{target}", ["sourceNodeId"] = source, ["sourcePort"] = "success", ["targetNodeId"] = target
    };

    private static string SimplePlan(params Dictionary<string, object?>[] items)
    {
        var nodes = items.Where(item => item.ContainsKey("nodeId")).ToArray();
        var edges = items.Where(item => item.ContainsKey("edgeId")).ToArray();
        return JsonSerializer.Serialize(new
        {
            flowId = "flow-runtime-test", key = "runtime-test", name = "runtime-test", contractVersion = "2.0", revision = 1,
            entryNodeId = "start", nodes, edges,
            policies = new { defaultTimeoutSeconds = 60, maxLoopIterations = 100, requireInterlockForCommands = true },
            graphHash = "test-graph", compiledPlanHash = "test-plan"
        });
    }

    private sealed class FakeCommandAdapter : ITwinActionFlowCommandAdapter
    {
        private readonly bool _failFirst;
        private readonly bool _alwaysFail;
        private readonly string? _cycleId;
        public int SendCount { get; private set; }
        public FakeCommandAdapter(bool failFirst = false, bool alwaysFail = false, string? cycleId = null) { _failFirst = failFirst; _alwaysFail = alwaysFail; _cycleId = cycleId; }
        public Task<TwinActionFlowCommandDispatchResult> SendAsync(TwinActionFlowRun run, TwinActionFlowRunStep step, TwinDeviceCommand command, CancellationToken cancellationToken)
        {
            SendCount++;
            if (_alwaysFail || (_failFirst && SendCount == 1)) return Task.FromResult(new TwinActionFlowCommandDispatchResult(false, false, null, null, "simulated dispatch failure"));
            return Task.FromResult(new TwinActionFlowCommandDispatchResult(true, true, _cycleId, JsonSerializer.SerializeToElement(new { ack = true }), null));
        }
        public Task<TwinActionFlowCommandFeedback?> ReconcileAsync(TwinActionFlowRun run, TwinDeviceCommand command, CancellationToken cancellationToken) => Task.FromResult<TwinActionFlowCommandFeedback?>(null);
    }

    private sealed class RecordingPublisher : ITwinActionFlowEventPublisher
    {
        public List<TwinActionFlowEventDto> Events { get; } = [];
        public Task PublishAsync(TwinActionFlowEventDto actionFlowEvent, CancellationToken cancellationToken) { Events.Add(actionFlowEvent); return Task.CompletedTask; }
    }

    private sealed class Fixture : IAsyncDisposable
    {
        private readonly ServiceProvider _provider;
        private readonly IServiceScope _scope;
        public ApplicationDbContext Context { get; }
        public TwinActionFlowRuntimeService Runtime { get; }
        public UserProfile Profile { get; }
        public Guid SceneId { get; }
        public Guid DraftFlowId { get; }

        private Fixture(ServiceProvider provider, IServiceScope scope, ApplicationDbContext context, TwinActionFlowRuntimeService runtime, UserProfile profile, Guid sceneId, Guid draftFlowId)
        { _provider = provider; _scope = scope; Context = context; Runtime = runtime; Profile = profile; SceneId = sceneId; DraftFlowId = draftFlowId; }

        public static async Task<Fixture> CreateAsync(string plan, FakeCommandAdapter? adapter = null)
        {
            var services = new ServiceCollection();
            services.AddLogging(); services.AddEntityFrameworkInMemoryDatabase();
            services.AddSingleton<IDataBaseModelBuilderOptions, TestModelBuilderOptions>();
            services.AddDbContext<ApplicationDbContext>((provider, options) => { options.UseInMemoryDatabase(Guid.NewGuid().ToString("N")); options.UseInternalServiceProvider(provider); });
            var provider = services.BuildServiceProvider(validateScopes: true);
            var scope = provider.CreateScope();
            var context = scope.ServiceProvider.GetRequiredService<ApplicationDbContext>();
            var profile = new UserProfile { Id = Guid.NewGuid(), Tenant = Guid.NewGuid(), Customer = Guid.NewGuid(), Name = "runtime-test", Email = "test@example.invalid", Roles = ["SystemAdmin"] };
            var sceneId = Guid.NewGuid(); var versionId = Guid.NewGuid(); var draftFlowId = Guid.NewGuid(); var publishedFlowId = Guid.NewGuid(); var now = DateTime.UtcNow;
            var scene = new DigitalTwinScene
            {
                Id = sceneId, SceneKey = $"scene-{sceneId:N}", Name = "runtime-scene", Description = "", RootAssetId = Guid.NewGuid(), Status = DigitalTwinSceneStatus.Published,
                DraftPayload = "{\"actionFlows\":[]}", PublishedVersionId = versionId, Revision = 1, CreatedAt = now, UpdatedAt = now, CreatedBy = profile.Name, UpdatedBy = profile.Name, TenantId = profile.Tenant, CustomerId = profile.Customer
            };
            var draft = Flow(draftFlowId, sceneId, null, plan, profile, now);
            var published = Flow(publishedFlowId, sceneId, versionId, plan, profile, now);
            context.Add(scene); context.Add(draft); context.Add(published); await context.SaveChangesAsync();
            context.ChangeTracker.Clear();
            var runtime = new TwinActionFlowRuntimeService(context, adapter ?? new FakeCommandAdapter(), new RecordingPublisher(), scope.ServiceProvider.GetRequiredService<ILogger<TwinActionFlowRuntimeService>>());
            return new Fixture(provider, scope, context, runtime, profile, sceneId, draftFlowId);
        }

        private static TwinActionFlow Flow(Guid id, Guid sceneId, Guid? versionId, string plan, UserProfile profile, DateTime now) => new()
        {
            Id = id, SceneId = sceneId, SceneVersionId = versionId, FlowKey = "runtime-test", Name = "runtime-test", ContractVersion = "2.0", ActorScope = "[]", GraphPayload = plan,
            GraphHash = "test-graph", CompiledPayload = plan, CompiledPlanHash = "test-plan", Revision = 1, Enabled = true, CreatedAt = now, UpdatedAt = now, CreatedBy = profile.Name, UpdatedBy = profile.Name, TenantId = profile.Tenant, CustomerId = profile.Customer
        };

        public async ValueTask DisposeAsync() { await Context.DisposeAsync(); _scope.Dispose(); await _provider.DisposeAsync(); }
    }

    private sealed class TestModelBuilderOptions : IDataBaseModelBuilderOptions
    {
        public IInfrastructure<IServiceProvider> Infrastructure { get; set; } = null!;
        public void OnModelCreating(ModelBuilder modelBuilder) { }
    }
}
