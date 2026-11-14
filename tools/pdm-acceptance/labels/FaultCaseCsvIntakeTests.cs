using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using IoTSharp.Services.PredictiveMaintenance.P3;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Labels;

/// <summary>
/// Restrictive CSV intake for customer-submitted case references. Parsing a CSV
/// does NOT verify its human reviewer: rows must be independently signed in
/// PdmP3FaultCaseLedger before becoming ground truth.
/// </summary>
public sealed record CandidateFaultCase(
    DateTimeOffset EventUtc, DateTimeOffset ClaimedReviewUtc,
    PdmP3FaultTruth ClaimedTruth, string CaseReference,
    string ClaimedReviewer, string EvidenceSha256);

public sealed record FaultCaseImportResult(
    bool Accepted, int CandidateRows, int FaultClaims, int NormalClaims,
    string InputSha256, IReadOnlyList<string> RejectionReasons,
    IReadOnlyList<CandidateFaultCase> Candidates,
    bool HumanEvidenceVerified = false, bool ReadyForModelTraining = false);

public static class FaultCaseCsvIntake
{
    private const string Header =
        "tenantId,customerId,deviceId,profileId,profileVersion,pointKey,unit,operatingMode,eventUtc,claimedReviewUtc,truth,caseRef,reviewerRef,evidenceSha256";

    public static FaultCaseImportResult Parse(
        string csv, PdmP3SeriesScope expectedScope, DateTimeOffset asOfUtc)
    {
        ArgumentNullException.ThrowIfNull(csv);
        ArgumentNullException.ThrowIfNull(expectedScope);
        const int maxBytes=8*1024*1024;
        var hash=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(csv)))
            .ToLowerInvariant();
        var errors=new List<string>();
        var candidates=new List<CandidateFaultCase>();
        if(Encoding.UTF8.GetByteCount(csv)>maxBytes ||
           asOfUtc.Offset!=TimeSpan.Zero || asOfUtc.Year<2000 ||
           !expectedScope.MappingVerified || !expectedScope.UnitVerified ||
           !expectedScope.OperatingModeVerified)
            return new(false,0,0,0,hash,
                new[]{"CSV size/UTC/scope not approved"},Array.Empty<CandidateFaultCase>());

        using var reader=new StringReader(csv);
        if((reader.ReadLine()??"").TrimStart('\uFEFF')!=Header)
            return new(false,0,0,0,hash,
                new[]{"Schema/header mismatch"},Array.Empty<CandidateFaultCase>());
        var seen=new HashSet<DateTimeOffset>();
        var seenCases=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var lineNumber=1;
        string? line;
        while((line=reader.ReadLine())!=null)
        {
            lineNumber++;
            if(lineNumber>10001) {errors.Add("Maximum 10000 cases exceeded");break;}
            if(line.Length==0) continue;
            // Identifiers only: quoted/newline-bearing free text must be exported
            // through a reviewed external format, never parsed ambiguously.
            if(line.Length>1800 || line.Contains('"') || line.Contains('\0'))
            {
                errors.Add($"line {lineNumber}: unsupported CSV escape");break;
            }
            var cells=line.Split(',');
            if(cells.Length!=14) {errors.Add($"line {lineNumber}: column count");break;}
            if(!Guid.TryParse(cells[0],out var tenant) || tenant!=expectedScope.TenantId ||
               !Guid.TryParse(cells[1],out var customer) || customer!=expectedScope.CustomerId ||
               !Guid.TryParse(cells[2],out var device) || device!=expectedScope.DeviceId ||
               !Guid.TryParse(cells[3],out var profile) || profile!=expectedScope.ProfileId ||
               !int.TryParse(cells[4],NumberStyles.None,CultureInfo.InvariantCulture,out var version) ||
               version!=expectedScope.ProfileVersion ||
               cells[5]!=expectedScope.PointKey || cells[6]!=expectedScope.EngineeringUnit ||
               cells[7]!=expectedScope.OperatingMode)
            {errors.Add($"line {lineNumber}: scope/unit/mode mismatch");break;}
            if(!cells[8].EndsWith('Z') || !cells[9].EndsWith('Z') ||
               !DateTimeOffset.TryParse(cells[8],CultureInfo.InvariantCulture,
                   DateTimeStyles.None,out var eventTime) ||
               !DateTimeOffset.TryParse(cells[9],CultureInfo.InvariantCulture,
                   DateTimeStyles.None,out var reviewed) ||
               eventTime.Offset!=TimeSpan.Zero || reviewed.Offset!=TimeSpan.Zero ||
               eventTime>reviewed || reviewed>asOfUtc ||
               eventTime.Year<2000 ||
               !seen.Add(eventTime))
            {errors.Add($"line {lineNumber}: future/duplicate/non-UTC case");break;}
            var truth=cells[10] switch
            {
                "ConfirmedFault"=>PdmP3FaultTruth.ConfirmedFault,
                "ConfirmedNormal"=>PdmP3FaultTruth.ConfirmedNormal,
                _=>PdmP3FaultTruth.Unlabeled
            };
            if(truth==PdmP3FaultTruth.Unlabeled ||
               string.IsNullOrWhiteSpace(cells[11]) || cells[11].Length>160 ||
               !seenCases.Add(cells[11]) ||
               string.IsNullOrWhiteSpace(cells[12]) || cells[12].Length>100 ||
               cells[13].Length!=64 ||
               cells[13].Any(c=>c is not (>= '0' and <= '9' or >= 'a' and <= 'f')))
            {errors.Add($"line {lineNumber}: untrusted truth/case/reviewer/evidence");break;}
            candidates.Add(new(eventTime,reviewed,truth,cells[11],cells[12],cells[13]));
        }
        if(candidates.Count==0)errors.Add("No importable case");
        if(errors.Count>0) return new(false,0,0,0,hash,errors,Array.Empty<CandidateFaultCase>());
        return new(true,candidates.Count,
            candidates.Count(x=>x.ClaimedTruth==PdmP3FaultTruth.ConfirmedFault),
            candidates.Count(x=>x.ClaimedTruth==PdmP3FaultTruth.ConfirmedNormal),
            hash,Array.Empty<string>(),candidates);
    }
}

public sealed class FaultCaseCsvIntakeTests
{
    private static readonly DateTimeOffset AsOf =
        new(2026,11,13,12,0,0,TimeSpan.Zero);
    private static readonly string FakeEvidence = new('a',64);
    private static PdmP3SeriesScope Scope() =>
        new(Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid(),Guid.NewGuid(),3,
            "bearing.rms","mm/s","Running",true,true,true);
    private static string Csv(PdmP3SeriesScope s,params string[] rows) =>
        "tenantId,customerId,deviceId,profileId,profileVersion,pointKey,unit,operatingMode,eventUtc,claimedReviewUtc,truth,caseRef,reviewerRef,evidenceSha256\n"+
        string.Join("\n",rows.Select((r,i)=>
            $"{s.TenantId},{s.CustomerId},{s.DeviceId},{s.ProfileId},{s.ProfileVersion},{s.PointKey},{s.EngineeringUnit},{s.OperatingMode},2026-11-10T0{i}:00:00Z,2026-11-12T00:00:00Z,{r},case-{i},reviewer-ref-1,{FakeEvidence}"))+"\n";

    [Fact]
    public void WellFormedCandidateCasesStillRequireIndependentHumanVerification()
    {
        var scope=Scope();
        var result=FaultCaseCsvIntake.Parse(Csv(scope,"ConfirmedFault","ConfirmedNormal"),scope,AsOf);
        Assert.True(result.Accepted);
        Assert.Equal(2,result.CandidateRows);
        Assert.Equal(1,result.FaultClaims);
        Assert.Equal(1,result.NormalClaims);
        Assert.False(result.HumanEvidenceVerified);
        Assert.False(result.ReadyForModelTraining);
    }

    [Fact]
    public void DuplicateTimestampAndFutureReviewRejectWholeImport()
    {
        var scope=Scope();
        var valid=Csv(scope,"ConfirmedFault");
        Assert.False(FaultCaseCsvIntake.Parse(valid.Replace("2026-11-12T00:00:00Z",
            "2026-11-15T00:00:00Z"),scope,AsOf).Accepted);
        var duplicated=valid+valid.Split('\n')[1]+"\n";
        Assert.False(FaultCaseCsvIntake.Parse(duplicated,scope,AsOf).Accepted);
    }

    [Fact]
    public void CrossTenantAndUnknownLabelNeverBecomeTrainingTruth()
    {
        var scope=Scope();
        Assert.False(FaultCaseCsvIntake.Parse(
            Csv(scope,"ConfirmedFault").Replace(scope.TenantId.ToString(),Guid.NewGuid().ToString()),
            scope,AsOf).Accepted);
        Assert.False(FaultCaseCsvIntake.Parse(Csv(scope,"Unknown"),scope,AsOf).Accepted);
    }

    [Fact]
    public void NoDataOrMissingEvidenceCannotClaimRealMetric()
    {
        var scope=Scope();
        Assert.False(FaultCaseCsvIntake.Parse(Csv(scope),scope,AsOf).Accepted);
        Assert.False(FaultCaseCsvIntake.Parse(
            Csv(scope,"ConfirmedFault").Replace(FakeEvidence,"not-a-real-sha"),
            scope,AsOf).Accepted);
    }
}

