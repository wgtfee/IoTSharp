using IoTSharp.Storage;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Provider;

/// <summary>
/// Real-provider checks are evidence requirements, not automatically passed by
/// an offline SQL string test. No network or database connection in this suite.
/// </summary>
public enum ProviderAcceptanceVerdict { Blocked, StagingEvidenceReady }

public sealed record ProviderEvidence(
    string Provider, string NonProductionEnvironment,
    string EndpointFingerprint, string ReadOnlyPlanSha256,
    string UtcWindowTraceSha256, string CancellationTraceSha256,
    string OverflowTraceSha256, bool LeastPrivilegeReadOnly,
    bool PhysicalShardFanoutReviewed, bool RealProviderObserved,
    DateTimeOffset CapturedUtc);

public sealed record ProviderAcceptanceResult(ProviderAcceptanceVerdict Verdict, IReadOnlyList<string> Missing);

public static class ProviderAcceptanceGate
{
    private static bool Sha(string? value) => value is {Length:64} &&
        value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');
    public static ProviderAcceptanceResult Check(ProviderEvidence evidence, DateTimeOffset now)
    {
        var issues = new List<string>();
        if(evidence.Provider is not ("sqlserver" or "postgresql" or "influxdb"))
            issues.Add("unsupported provider");
        if(evidence.NonProductionEnvironment is not ("isolated-dev" or "staging"))
            issues.Add("not an isolated environment");
        if(!Sha(evidence.EndpointFingerprint)) issues.Add("endpoint fingerprint missing");
        if(!Sha(evidence.ReadOnlyPlanSha256)) issues.Add("real execution plan missing");
        if(!Sha(evidence.UtcWindowTraceSha256)) issues.Add("UTC half-open trace missing");
        if(!Sha(evidence.CancellationTraceSha256)) issues.Add("cancel and timeout trace missing");
        if(!Sha(evidence.OverflowTraceSha256)) issues.Add("limit+1 and no truncate trace missing");
        if(!evidence.LeastPrivilegeReadOnly) issues.Add("least privilege not proven");
        if(evidence.Provider!="influxdb" && !evidence.PhysicalShardFanoutReviewed)
            issues.Add("physical shard fanout not reviewed");
        if(!evidence.RealProviderObserved) issues.Add("real provider not observed");
        if(now.Offset!=TimeSpan.Zero || evidence.CapturedUtc.Offset!=TimeSpan.Zero ||
           evidence.CapturedUtc>now || now-evidence.CapturedUtc>TimeSpan.FromDays(30))
            issues.Add("stale or untrusted timestamp");
        return new(issues.Count==0?ProviderAcceptanceVerdict.StagingEvidenceReady:
            ProviderAcceptanceVerdict.Blocked,issues);
    }
}

public sealed class ProviderAcceptanceTests
{
    [Fact]
    public void ExistingBoundedContractRequiresCancellationLimitAndSourceRowBound()
    {
        var method=typeof(IBoundedTelemetryHistoryStorage).GetMethod("LoadTelemetryBoundedAsync");
        Assert.NotNull(method);
        Assert.Contains(method!.GetParameters(), x=>x.ParameterType==typeof(CancellationToken));
        Assert.Contains(method.GetParameters(), x=>x.Name=="maxRows");
        var flux=PdmBoundedFluxBuilder.Build("test",Guid.NewGuid(),
            new[]{"bearing.rms"},new DateTime(2026,11,13,1,0,0,DateTimeKind.Utc),
            new DateTime(2026,11,13,1,5,0,DateTimeKind.Utc),100);
        Assert.Equal(2,flux.Split("limit(n: 101)",StringSplitOptions.None).Length-1);
        Assert.True(flux.IndexOf("limit(n: 101)",StringComparison.Ordinal) <
            flux.IndexOf("group(columns: [])",StringComparison.Ordinal));
    }

    [Fact]
    public void OfflineFilesCannotClaimRealProviderReady()
    {
        foreach(var provider in new[]{"sqlserver","postgresql","influxdb"})
        {
            var sample=new ProviderEvidence(provider,"isolated-dev","","","","","",
                false,false,false,DateTimeOffset.UtcNow);
            var result=ProviderAcceptanceGate.Check(sample,DateTimeOffset.UtcNow);
            Assert.Equal(ProviderAcceptanceVerdict.Blocked,result.Verdict);
            Assert.Contains("real provider not observed",result.Missing);
        }
    }

    [Fact]
    public void PhysicalShardReviewIsMandatoryForRelationalProviders()
    {
        const string h="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        var now=new DateTimeOffset(2026,11,13,12,0,0,TimeSpan.Zero);
        var proof=new ProviderEvidence("sqlserver","staging",h,h,h,h,h,
            true,false,true,now.AddMinutes(-10));
        Assert.Equal(ProviderAcceptanceVerdict.Blocked,
            ProviderAcceptanceGate.Check(proof,now).Verdict);
        Assert.Equal(ProviderAcceptanceVerdict.StagingEvidenceReady,
            ProviderAcceptanceGate.Check(proof with {PhysicalShardFanoutReviewed=true},now).Verdict);
    }

    [Fact]
    public void ProductionEnvironmentAndExpiredEvidenceAlwaysBlock()
    {
        const string h="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
        var now=new DateTimeOffset(2026,11,13,12,0,0,TimeSpan.Zero);
        var e=new ProviderEvidence("influxdb","production",h,h,h,h,h,true,true,true,now);
        Assert.Equal(ProviderAcceptanceVerdict.Blocked,
            ProviderAcceptanceGate.Check(e,now).Verdict);
        e=e with {NonProductionEnvironment="staging",CapturedUtc=now.AddDays(-31)};
        Assert.Equal(ProviderAcceptanceVerdict.Blocked,
            ProviderAcceptanceGate.Check(e,now).Verdict);
    }
}

