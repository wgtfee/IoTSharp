using IoTSharp.Contracts;
using Microsoft.AspNetCore.SignalR;
using System.Threading;
using System.Threading.Tasks;

namespace IoTSharp.Services.DigitalTwin.ActionFlow;

/// <summary>运行事件发布边界。REST sequence 补拉始终是权威，实时通道只负责低延迟通知。</summary>
public interface ITwinActionFlowEventPublisher
{
    Task PublishAsync(TwinActionFlowEventDto actionFlowEvent, CancellationToken cancellationToken);
}

/// <summary>SignalR 运行事件发布器。</summary>
public sealed class TwinActionFlowSignalREventPublisher : ITwinActionFlowEventPublisher
{
    private readonly IHubContext<TwinActionFlowRunEventHub> _hub;

    public TwinActionFlowSignalREventPublisher(IHubContext<TwinActionFlowRunEventHub> hub) => _hub = hub;

    public Task PublishAsync(TwinActionFlowEventDto actionFlowEvent, CancellationToken cancellationToken) =>
        _hub.Clients.Group(TwinActionFlowRunEventHub.GroupName(actionFlowEvent.RunId))
            .SendAsync("runEvent", actionFlowEvent, cancellationToken);
}
