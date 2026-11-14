using IoTSharp.Storage;
using Microsoft.Data.SqlClient;
using Xunit;

namespace IoTSharp.PdM.Acceptance.Provider;

/// <summary>构造真实 SqlCommand，但不向被拦截的 SQL Server 发送跨月 SQL。</summary>
public sealed class Batch6SqlServerParameterizedCommandTests
{
    private static PdmHistoricalMonthlyReadPlan Approved(DateTime now)
    {
        var begin = new DateTime(2026, 8, 31, 23, 55, 0, DateTimeKind.Utc);
        return PdmHistoricalMonthlyReadPlanner.Create(
            begin, begin.AddMinutes(10),
            begin.AddHours(-1), begin.AddHours(2),
            new[] { "TelemetryData_202608", "TelemetryData_202609" }, now, now);
    }

    [Fact]
    public void SqlServerCommandHasPerShardAndGlobalTopWithStrictUtcParameters()
    {
        var now = DateTime.UtcNow;
        using var sql = new SqlConnection();
        using var command = PdmSqlServerHistoricalCommandFactory.Create(
            sql, Approved(now), Guid.NewGuid(), new[] { "bearing.rms", "temperature" }, 16, now);
        Assert.Equal(17, command.Parameters["@fetch"].Value);
        Assert.Equal("bearing.rms", command.Parameters["@key0"].Value);
        Assert.Equal("temperature", command.Parameters["@key1"].Value);
        Assert.Contains("[dbo].[TelemetryData_202608]", command.CommandText);
        Assert.Contains("[dbo].[TelemetryData_202609]", command.CommandText);
        Assert.Equal(3, command.CommandText.Split("TOP (@fetch)").Length - 1);
        Assert.Contains("UNION ALL", command.CommandText);
        Assert.Contains("[DateTime]<@end", command.CommandText);
        Assert.Contains("ORDER BY [DateTime],[KeyName],[DeviceId]", command.CommandText);
        Assert.DoesNotContain("Value_Binary", command.CommandText);
        Assert.Equal(System.Data.CommandType.Text, command.CommandType);
        Assert.Equal(System.Data.SqlDbType.DateTime2, command.Parameters["@begin"].SqlDbType);
        Assert.Equal(System.Data.SqlDbType.UniqueIdentifier, command.Parameters["@device"].SqlDbType);
    }

    [Fact]
    public void StaleRouteInventoryCannotBuildReadCommand()
    {
        var now = DateTime.UtcNow;
        using var sql = new SqlConnection();
        Assert.Throws<PdmHistoricalShardNotVerifiedException>(() =>
            PdmSqlServerHistoricalCommandFactory.Create(sql, Approved(now),
                Guid.NewGuid(), new[] { "x" }, 20, now.AddMinutes(6)));
    }

    [Fact]
    public void UntrustedPointOrLimitCannotBuildReadCommand()
    {
        var now = DateTime.UtcNow;
        using var sql = new SqlConnection();
        Assert.Throws<ArgumentException>(() =>
            PdmSqlServerHistoricalCommandFactory.Create(sql, Approved(now),
                Guid.NewGuid(), new[] { "x'); DROP TABLE bad" }, 20, now));
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            PdmSqlServerHistoricalCommandFactory.Create(sql, Approved(now),
                Guid.NewGuid(), new[] { "x" }, 100001, now));
    }
}
