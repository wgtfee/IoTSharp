using IoTSharp.Storage;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Provider;

/// <summary>
/// These tests must reject before attempting network/database access.
/// There are no SQL Server test credentials or live endpoints here.
/// </summary>
public sealed class PdmSqlServerHistoricalTableInventoryTests
{
    private static readonly DateTime Aug=
        new(2026,8,31,23,59,30,DateTimeKind.Utc);
    private static readonly DateTime Sep=
        new(2026,9,1,0,0,30,DateTimeKind.Utc);
    private static readonly DateTime ApprovedFrom=
        new(2026,8,1,0,0,0,DateTimeKind.Utc);
    private static readonly DateTime ApprovedThrough=
        new(2026,11,1,0,0,0,DateTimeKind.Utc);

    [Fact]
    public async Task NonUtcRequestIsRejectedBeforeResolvingAnyDatabase()
    {
        var source=new PdmSqlServerHistoricalTableInventory();
        var value=DateTime.SpecifyKind(Aug,DateTimeKind.Unspecified);
        await Assert.ThrowsAsync<PdmHistoricalShardNotVerifiedException>(()=>
            source.PrepareAsync("not a valid connection string",value,Sep,
                ApprovedFrom,ApprovedThrough));
    }

    [Fact]
    public async Task UnapprovedRangeIsRejectedWithoutOpeningConnection()
    {
        var source=new PdmSqlServerHistoricalTableInventory();
        await Assert.ThrowsAsync<PdmHistoricalShardNotVerifiedException>(()=>
            source.PrepareAsync("not a valid connection string",
                ApprovedFrom.AddDays(-1),ApprovedFrom.AddMinutes(1),
                ApprovedFrom,ApprovedThrough));
    }

    [Fact]
    public async Task CancellationIsObservedBeforeConnectionParsing()
    {
        var source=new PdmSqlServerHistoricalTableInventory();
        using var cts=new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(()=>
            source.PrepareAsync("not a valid connection string",
                Aug,Sep,ApprovedFrom,ApprovedThrough,cts.Token));
    }
}

