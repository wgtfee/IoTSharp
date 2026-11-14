using System.Globalization;
using Microsoft.Data.SqlClient;

namespace IoTSharp.Storage;

/// <summary>
/// SQL Server catalog inspection for PdM historical route admission.
/// Reads sys.tables only. This class has no CREATE/ALTER/DROP capability and
/// is intentionally NOT registered into IoTSharp Startup/ingestion DI.
/// Database permission must be SELECT-only for the supplied principal.
/// </summary>
public sealed class PdmSqlServerHistoricalTableInventory
{
    public async Task<PdmHistoricalMonthlyReadPlan> PrepareAsync(
        string connectionString,
        DateTime beginUtc,DateTime endExclusiveUtc,
        DateTime approvedEarliestUtc,DateTime approvedLatestExclusiveUtc,
        CancellationToken ct=default)
    {
        ct.ThrowIfCancellationRequested();
        if(beginUtc.Kind!=DateTimeKind.Utc ||
           endExclusiveUtc.Kind!=DateTimeKind.Utc ||
           beginUtc>=endExclusiveUtc ||
           endExclusiveUtc-beginUtc>TimeSpan.FromMinutes(60) ||
           beginUtc.Year<2000 ||
           approvedEarliestUtc.Kind!=DateTimeKind.Utc ||
           approvedLatestExclusiveUtc.Kind!=DateTimeKind.Utc ||
           approvedEarliestUtc>=approvedLatestExclusiveUtc ||
           beginUtc<approvedEarliestUtc ||
           endExclusiveUtc>approvedLatestExclusiveUtc ||
           beginUtc>DateTime.UtcNow ||
           beginUtc<DateTime.UtcNow.AddMonths(-24))
            throw new PdmHistoricalShardNotVerifiedException(
                "Cannot query physical SQL Server catalog for an unbounded or non-UTC window.");
        if(string.IsNullOrWhiteSpace(connectionString))
            throw new ArgumentException("Approved SQL read-only connection required.");

        var first=new DateTime(beginUtc.Year,beginUtc.Month,1,0,0,0,DateTimeKind.Utc);
        var lastInstant=endExclusiveUtc.AddTicks(-1);
        var last=new DateTime(lastInstant.Year,lastInstant.Month,1,0,0,0,DateTimeKind.Utc);
        var requested=new List<string>();
        for(var month=first;month<=last;month=month.AddMonths(1))
            requested.Add("TelemetryData_"+month.ToString("yyyyMM",CultureInfo.InvariantCulture));
        if(requested.Count is <1 or >2)
            throw new PdmHistoricalShardNotVerifiedException(
                "Historical read must touch no more than two verified monthly tables.");

        var csb=new SqlConnectionStringBuilder(connectionString)
        {
            ApplicationIntent=ApplicationIntent.ReadOnly,
            ApplicationName="IoTSharp-Pdm-Shard-Inventory-ReadOnly",
            ConnectTimeout=5
        };
        if(string.IsNullOrWhiteSpace(csb.DataSource) ||
           string.IsNullOrWhiteSpace(csb.InitialCatalog))
            throw new ArgumentException("Database instance and catalog must be explicit.");

        await using var connection=new SqlConnection(csb.ConnectionString);
        await connection.OpenAsync(ct);
        await using var command=connection.CreateCommand();
        command.CommandTimeout=6;
        command.CommandText=requested.Count==1
            ? """
                SELECT t.name FROM sys.tables AS t
                INNER JOIN sys.schemas AS s ON t.schema_id=s.schema_id
                WHERE s.name=N'dbo' AND t.name=@first
                """
            : """
                SELECT t.name FROM sys.tables AS t
                INNER JOIN sys.schemas AS s ON t.schema_id=s.schema_id
                WHERE s.name=N'dbo' AND t.name IN (@first,@second)
                """;
        command.Parameters.AddWithValue("@first",requested[0]);
        if(requested.Count>1)
            command.Parameters.AddWithValue("@second",requested[1]);
        var names=new List<string>();
        await using(var reader=await command.ExecuteReaderAsync(ct))
            while(await reader.ReadAsync(ct))
                names.Add(reader.GetString(0));
        // Capture the attestation time AFTER the database read, not before.
        var now=DateTime.UtcNow;
        return PdmHistoricalMonthlyReadPlanner.Create(
            beginUtc,endExclusiveUtc,approvedEarliestUtc,approvedLatestExclusiveUtc,
            names,now,now);
    }
}

