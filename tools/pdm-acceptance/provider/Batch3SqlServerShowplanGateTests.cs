using System.Xml;
using System.Xml.Linq;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Provider;

public sealed record Batch3PlanReview(
    bool CandidateForReadOnlyReview, bool RealSqlServerExecuted,
    bool GlobalTopProven, IReadOnlyList<string> Reasons);

/// <summary>
/// Strict offline XML SHOWPLAN review. A synthetic/good plan is NEVER actual
/// SQL Server evidence, and the existence of a Top operator is insufficient
/// to prove correct global top after multi-shard merge.
/// </summary>
public static class Batch3SqlServerShowplanGate
{
    public static Batch3PlanReview Review(string showplanXml,
        IReadOnlyCollection<string> requiredPhysicalTables)
    {
        var reasons=new List<string>();
        if(string.IsNullOrWhiteSpace(showplanXml) ||
           showplanXml.Length>1024*1024 ||
           requiredPhysicalTables is null ||
           requiredPhysicalTables.Count is <1 or >2 ||
           requiredPhysicalTables.Any(t=>
               !System.Text.RegularExpressions.Regex.IsMatch(
                   t,@"^TelemetryData_20\d{4}$")) ||
           requiredPhysicalTables.Distinct(StringComparer.Ordinal).Count()!=
               requiredPhysicalTables.Count)
            return new(false,false,false,new[]{"invalid XML or explicitly approved physical shard list"});
        XDocument doc;
        try
        {
            using var reader=XmlReader.Create(new StringReader(showplanXml),
                new XmlReaderSettings {
                    DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null,
                    MaxCharactersInDocument=1024*1024
                });
            doc=XDocument.Load(reader);
        }
        catch(XmlException)
        {
            return new(false,false,false,new[]{"malformed or unsafe XML plan"});
        }
        var operators=doc.Descendants().Where(x=>x.Name.LocalName=="RelOp").ToArray();
        var objects=doc.Descendants().Where(x=>x.Name.LocalName=="Object").ToArray();
        if(operators.Length==0)reasons.Add("no optimizer operators");
        if(operators.Any(x=>((string?)x.Attribute("PhysicalOp")) is
            ("Clustered Index Scan" or "Index Scan" or "Table Scan")))
            reasons.Add("unbounded table or index scan detected");
        if(!operators.Any(x=>string.Equals(
            (string?)x.Attribute("PhysicalOp"),"Top",StringComparison.OrdinalIgnoreCase)))
            reasons.Add("no TOP operator in SQL plan");
        var sought=new HashSet<string>(StringComparer.Ordinal);
        foreach(var obj in objects)
        {
            var literal=((string?)obj.Attribute("Table") ?? "")
                .Replace("[","",StringComparison.Ordinal)
                .Replace("]","",StringComparison.Ordinal);
            if(literal.StartsWith("TelemetryData_",StringComparison.Ordinal) &&
               !requiredPhysicalTables.Contains(literal))
                reasons.Add("unapproved physical telemetry table accessed: "+literal);
            if(requiredPhysicalTables.Contains(literal))
                sought.Add(literal);
        }
        if(requiredPhysicalTables.Any(t=>!sought.Contains(t)))
            reasons.Add("one or more required physical months were absent from plan");
        if(!operators.Any(x=>
            ((string?)x.Attribute("PhysicalOp"))?.Contains("Seek",
                StringComparison.OrdinalIgnoreCase)==true))
            reasons.Add("no index seek operation found");

        return new(reasons.Count==0,false,false,reasons);
    }
}

public sealed class Batch3SqlServerShowplanGateTests
{
    private const string Prefix="<ShowPlanXML xmlns=\"http://schemas.microsoft.com/sqlserver/2004/07/showplan\"><BatchSequence><Batch><Statements><StmtSimple><QueryPlan>";
    private const string Suffix="</QueryPlan></StmtSimple></Statements></Batch></BatchSequence></ShowPlanXML>";
    private static string Seek(string month) =>
        $"""<RelOp PhysicalOp="Index Seek"><IndexScan><Object Database="[IOTSharp]" Schema="[dbo]" Table="[TelemetryData_{month}]" Index="[PK]"/></IndexScan></RelOp>""";
    private static string Plan(string body)=>Prefix+body+Suffix;
    private static readonly string[] Months={"TelemetryData_202608","TelemetryData_202609"};

    [Fact]
    public void IndexedMonthPlanIsOnlyACandidateNotRealSqlServerApproval()
    {
        var r=Batch3SqlServerShowplanGate.Review(
            Plan("<RelOp PhysicalOp=\"Top\"/>"+Seek("202608")+Seek("202609")),Months);
        Assert.True(r.CandidateForReadOnlyReview);
        Assert.False(r.RealSqlServerExecuted);
        Assert.False(r.GlobalTopProven);
    }

    [Fact]
    public void AdditionalUnapprovedMonthAndMissingMonthAreRejected()
    {
        var r=Batch3SqlServerShowplanGate.Review(
            Plan("<RelOp PhysicalOp=\"Top\"/>"+Seek("202608")+Seek("202607")),Months);
        Assert.False(r.CandidateForReadOnlyReview);
        Assert.Contains(r.Reasons,x=>x.Contains("unapproved"));
        Assert.Contains(r.Reasons,x=>x.Contains("absent"));
    }

    [Fact]
    public void SeekWithoutTopOrScanWithTopIsRejected()
    {
        Assert.False(Batch3SqlServerShowplanGate.Review(
            Plan(Seek("202608")),new[]{"TelemetryData_202608"})
            .CandidateForReadOnlyReview);
        var scan="<RelOp PhysicalOp=\"Index Scan\"><IndexScan><Object Table=\"[TelemetryData_202608]\"/></IndexScan></RelOp>";
        Assert.False(Batch3SqlServerShowplanGate.Review(
            Plan("<RelOp PhysicalOp=\"Top\"/>"+scan),new[]{"TelemetryData_202608"})
            .CandidateForReadOnlyReview);
    }

    [Fact]
    public void XmlEntityAndUnknownShardNameAreRejected()
    {
        var evil="<!DOCTYPE x [ <!ENTITY xx SYSTEM 'file:///C:/secret'> ]>"+Plan(Seek("202608"));
        Assert.False(Batch3SqlServerShowplanGate.Review(
            evil,new[]{"TelemetryData_202608"}).CandidateForReadOnlyReview);
        Assert.False(Batch3SqlServerShowplanGate.Review(
            Plan(Seek("202608")),new[]{"TelemetryData_name"}).CandidateForReadOnlyReview);
    }
}

