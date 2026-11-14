using IoTSharp.Data;
using IoTSharp.Services.PredictiveMaintenance.P3;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P3.Tests;

public sealed class PdmP3OfflineExtractTests
{
    private sealed class FakeSource : IPdmP3BoundedTelemetrySource
    {
        public int Calls;
        public int LastLimit;
        public Func<Guid,string,DateTimeOffset,DateTimeOffset,int,IReadOnlyList<PdmP3RawTelemetryRow>>? Factory;
        public Task<IReadOnlyList<PdmP3RawTelemetryRow>> ReadBoundedAsync(
            Guid id,string key,DateTimeOffset from,DateTimeOffset to,int max,CancellationToken ct)
        {
            ct.ThrowIfCancellationRequested(); Calls++; LastLimit=max;
            return Task.FromResult(Factory?.Invoke(id,key,from,to,max)
                ?? Enumerable.Range(0,9).Select(i => new PdmP3RawTelemetryRow(
                    id,key,from.AddMinutes(i*15),1.0+i*0.01,
                    PdmP3SampleQuality.Good,"source-"+i)).ToArray() as IReadOnlyList<PdmP3RawTelemetryRow>);
        }
    }

    private static PdmP3OfflineExtractRequest Request()
    {
        var profile = new PdmDeviceProfile
        {
            TenantId=Guid.NewGuid(), CustomerId=Guid.NewGuid(), DeviceId=Guid.NewGuid(),
            Version=3, Enabled=true, PointMappingsVerified=true, RunStateVerified=true
        };
        var point = new PdmPointPolicy
        {
            ProfileId=profile.Id, TelemetryKey="bearing.rms",
            Unit="mm/s", Enabled=true
        };
        return new(profile,point,"Running",true,
            PdmP3Fixtures.Start,PdmP3Fixtures.Start.AddHours(3),100);
    }

    [Fact]
    public async Task ApprovedScopeProducesVerifiedOfflineDataWithoutWritingAnything()
    {
        var fake = new FakeSource();
        var request = Request();
        var export = await new PdmP3OfflineExtractService(fake).ExportAsync(request);
        Assert.True(export.Accepted);
        Assert.Equal(9,export.Observations.Count);
        Assert.True(export.IsReadOnly);
        Assert.Equal(request.Profile.TenantId,export.Scope!.TenantId);
        Assert.Equal(request.PointPolicy.Unit,export.Scope.EngineeringUnit);
        Assert.Equal(101,fake.LastLimit);
    }

    [Fact]
    public async Task UnverifiedMappingOrUnitCannotReadProvider()
    {
        var request = Request();
        var fake = new FakeSource();
        var service = new PdmP3OfflineExtractService(fake);
        request.Profile.PointMappingsVerified = false;
        Assert.False((await service.ExportAsync(request)).Accepted);
        request.Profile.PointMappingsVerified = true;
        request.PointPolicy.Unit = "";
        Assert.False((await service.ExportAsync(request)).Accepted);
        Assert.Equal(0,fake.Calls);
    }
    [Fact]
    public async Task ProviderOverflowOrStaleTimestampFailsClosed()
    {
        var request = Request();
        var fake = new FakeSource
        {
            Factory=(id,key,from,to,limit) =>
                Enumerable.Range(0,limit).Select(i=>new PdmP3RawTelemetryRow(
                    id,key,from.AddSeconds(i),1,PdmP3SampleQuality.Good,"r"+i)).ToArray()
        };
        var service = new PdmP3OfflineExtractService(fake);
        Assert.False((await service.ExportAsync(request)).Accepted);
        Assert.Equal(101,fake.LastLimit);
        fake.Factory=(id,key,from,to,limit) =>
            Enumerable.Range(0,9).Select(i=>new PdmP3RawTelemetryRow(
                id,key,from.AddHours(4),1,PdmP3SampleQuality.Good,"r"+i)).ToArray();
        Assert.False((await service.ExportAsync(request)).Accepted);
    }

    [Fact]
    public async Task CrossDeviceAndMixedPointCannotBeImported()
    {
        var request=Request();
        var fake=new FakeSource {
            Factory=(id,key,from,to,limit) =>
                Enumerable.Range(0,9).Select(i=>new PdmP3RawTelemetryRow(
                    i==4?Guid.NewGuid():id,key,from.AddMinutes(i*15),1,
                    PdmP3SampleQuality.Good,"r"+i)).ToArray()
        };
        Assert.False((await new PdmP3OfflineExtractService(fake).ExportAsync(request)).Accepted);
    }

    [Fact]
    public async Task CancelledRequestNeverInitiatesRead()
    {
        var fake=new FakeSource();
        using var cts=new CancellationTokenSource();
        cts.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(()=>
            new PdmP3OfflineExtractService(fake).ExportAsync(Request(),cts.Token));
        Assert.Equal(0,fake.Calls);
    }

    [Fact]
    public async Task OversizedTimeAndNonUtcWindowAreRejected()
    {
        var fake=new FakeSource();
        var req=Request();
        var service=new PdmP3OfflineExtractService(fake);
        Assert.False((await service.ExportAsync(req with {
            ToUtc=req.FromUtc.AddDays(8)
        })).Accepted);
        Assert.False((await service.ExportAsync(req with {
            FromUtc=req.FromUtc.ToOffset(TimeSpan.FromHours(8))
        })).Accepted);
        Assert.Equal(0,fake.Calls);
    }

}

