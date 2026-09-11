using System;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.SignalR;

namespace IoTSharp.Services.DigitalTwin.ActionFlow;

/// <summary>Action Flow 运行事件实时推送。断线重连仍必须先通过 REST 按 sequence 补拉。</summary>
[Authorize]
public sealed class TwinActionFlowRunEventHub : Hub
{
    public static string GroupName(Guid runId) => $"twin-action-flow:{runId:D}";

    public Task Subscribe(Guid runId) => Groups.AddToGroupAsync(Context.ConnectionId, GroupName(runId));
    public Task Unsubscribe(Guid runId) => Groups.RemoveFromGroupAsync(Context.ConnectionId, GroupName(runId));
}
