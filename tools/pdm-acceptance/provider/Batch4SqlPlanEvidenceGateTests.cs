using System.Security.Cryptography;
using System.Text;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Provider;

public sealed record Batch4SqlPlanEvidenceEnvelope(
    string Provider, string DatabaseIdentity, DateTimeOffset WindowStartUtc,
    DateTimeOffset WindowEndExclusiveUtc, string DeviceId, string PointKey,
    int RequestedMaxRows, string PlanSha256,
    string CaptureOrigin, IReadOnlyList<string> ExpectedTables);

public sealed record Batch4SqlPlanEvidenceVerdict(
    bool EligibleForManualReview, bool SqlServerRuntimeVerified,
    bool GlobalLimitVerified, IReadOnlyList<string> Reasons);

/// <summary>
/// Detached SHOWPLAN evidence reconciliation. Even an intact envelope cannot
/// demonstrate that SQL was actually run against SQL Server.
/// </summary>
public static class Batch4SqlPlanEvidenceGate
{
    public static Batch4SqlPlanEvidenceVerdict Review(
        Batch4SqlPlanEvidenceEnvelope envelope,string showplanXml)
    {
        var reasons=new List<string>();
        if(envelope is null || string.IsNullOrWhiteSpace(showplanXml))
            return new(false,false,false,new[]{"missing envelope or execution-plan artifact"});
        var hash=Convert.ToHexString(SHA256.HashData(
            Encoding.UTF8.GetBytes(showplanXml))).ToLowerInvariant();
        if(!string.Equals(hash,envelope.PlanSha256,StringComparison.Ordinal))
            reasons.Add("plan artifact checksum mismatch");
        if(envelope.Provider!="SQLServer" ||
           !string.Equals(envelope.DatabaseIdentity,"IsolatedDevReview",StringComparison.Ordinal) ||
           envelope.CaptureOrigin!="OfflineArtifactUnverified")
            reasons.Add("only explicitly isolated and unverified offline artifacts are accepted");
        if(envelope.WindowStartUtc.Offset!=TimeSpan.Zero ||
           envelope.WindowEndExclusiveUtc.Offset!=TimeSpan.Zero ||
           envelope.WindowEndExclusiveUtc<=envelope.WindowStartUtc ||
           envelope.WindowEndExclusiveUtc-envelope.WindowStartUtc>TimeSpan.FromHours(1))
            reasons.Add("query time window is not bounded UTC half-open");
        if(!Guid.TryParse(envelope.DeviceId,out var device)||device==Guid.Empty ||
           string.IsNullOrWhiteSpace(envelope.PointKey) ||
           envelope.PointKey.Length>160 || envelope.RequestedMaxRows is <1 or >1000)
            reasons.Add("device, point or row budget cannot be trusted");
        var checkedPlan=Batch3SqlServerShowplanGate.Review(
            showplanXml,envelope.ExpectedTables);
        if(!checkedPlan.CandidateForReadOnlyReview)
            reasons.AddRange(checkedPlan.Reasons);
        // SQL execution evidence, permissions, per-table row IO and global
        // cross-shard top must be verified by a separate controlled test.
        return new(reasons.Count==0,false,false,reasons);
    }
}

public sealed class Batch4SqlPlanEvidenceGateTests
{
    private const string Start="<ShowPlanXML><Batch><QueryPlan>";
    private const string End="</QueryPlan></Batch></ShowPlanXML>";
    private static string Plan(bool extra=false) =>
        Start+"<RelOp PhysicalOp=\"Top\"/>"+
        "<RelOp PhysicalOp=\"Index Seek\"><IndexScan><Object Table=\"[TelemetryData_202608]\"/></IndexScan></RelOp>"+
        "<RelOp PhysicalOp=\"Index Seek\"><IndexScan><Object Table=\"[TelemetryData_202609]\"/></IndexScan></RelOp>"+
        (extra?"<RelOp PhysicalOp=\"Table Scan\"><TableScan><Object Table=\"[TelemetryData_202607]\"/></TableScan></RelOp>":"")+End;
    private static Batch4SqlPlanEvidenceEnvelope Envelope(string plan) => new(
        "SQLServer","IsolatedDevReview",
        new DateTimeOffset(2026,8,31,23,59,30,TimeSpan.Zero),
        new DateTimeOffset(2026,9,1,0,0,30,TimeSpan.Zero),
        Guid.NewGuid().ToString(),"bearing.rms",16,
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(plan))).ToLowerInvariant(),
        "OfflineArtifactUnverified",new[]{"TelemetryData_202608","TelemetryData_202609"});

    [Fact]
    public void IntactPlanCanOnlyAdvanceToManualReviewNotToSqlServerSignoff()
    {
        var xml=Plan();
        var result=Batch4SqlPlanEvidenceGate.Review(Envelope(xml),xml);
        Assert.True(result.EligibleForManualReview,string.Join(";",result.Reasons));
        Assert.False(result.SqlServerRuntimeVerified);
        Assert.False(result.GlobalLimitVerified);
    }

    [Fact]
    public void AlteredPlanCannotRetainEvidenceChecksum()
    {
        var xml=Plan();var forged=xml.Replace("Index Seek","Table Scan",StringComparison.Ordinal);
        var result=Batch4SqlPlanEvidenceGate.Review(Envelope(xml),forged);
        Assert.False(result.EligibleForManualReview);
        Assert.Contains(result.Reasons,x=>x.Contains("checksum"));
    }

    [Fact]
    public void ExtraPhysicalShardNeverQualifies()
    {
        var xml=Plan(extra:true);
        Assert.False(Batch4SqlPlanEvidenceGate.Review(
            Envelope(xml),xml).EligibleForManualReview);
    }

    [Fact]
    public void NonUtcAndExcessiveWindowAreRejected()
    {
        var xml=Plan();
        var envelope=Envelope(xml) with {
            WindowStartUtc=new DateTimeOffset(2026,8,31,23,59,30,TimeSpan.FromHours(8))
        };
        Assert.False(Batch4SqlPlanEvidenceGate.Review(
            envelope,xml).EligibleForManualReview);
        envelope=Envelope(xml) with {
            WindowEndExclusiveUtc=new DateTimeOffset(2026,9,2,0,0,30,TimeSpan.Zero)
        };
        Assert.False(Batch4SqlPlanEvidenceGate.Review(
            envelope,xml).EligibleForManualReview);
    }

    [Fact]
    public void ForgedCaptureOriginCannotSelfCertifyRealSqlServer()
    {
        var xml=Plan();
        var result=Batch4SqlPlanEvidenceGate.Review(
            Envelope(xml) with {CaptureOrigin="LiveSQLServerCertified"},xml);
        Assert.False(result.EligibleForManualReview);
        Assert.False(result.SqlServerRuntimeVerified);
    }
}

