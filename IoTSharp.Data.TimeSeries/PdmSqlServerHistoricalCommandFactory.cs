using System;
using System.Collections.Generic;
using System.Data;
using System.Globalization;
using System.Linq;
using Microsoft.Data.SqlClient;

namespace IoTSharp.Storage;

/// <summary>
/// 把已审计、未过期的真实月份清单构造成参数化的 SQL Server 全局限量 SELECT。
/// 仅生成命令，不连接数据库、不执行 SQL、不修改现有 ShardingCore 热链。
/// 仅当只读账号、实际 SHOWPLAN 和 UTC 数据契约获得独立批准时方可执行。
/// </summary>
public static class PdmSqlServerHistoricalCommandFactory
{
    /// <summary>
    /// 每个物理月份与 UNION 外层均进行 TOP(maxRows+1) 限量，防止将无界结果拉入内存。
    /// 查询使用半开 UTC 范围；DateTime2 无时区，不能据此证明源数据确为 UTC。
    /// </summary>
    public static SqlCommand Create(
        SqlConnection connection, PdmHistoricalMonthlyReadPlan plan,
        Guid deviceId, IReadOnlyList<string> keys, int maxRows, DateTime nowUtc)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(plan);
        var selected = BoundedTelemetryHistoryQuery.Validate(
            deviceId, keys, plan.BeginUtc, plan.EndExclusiveUtc, maxRows);
        if (nowUtc.Kind != DateTimeKind.Utc || nowUtc < plan.VerifiedAtUtc ||
            nowUtc - plan.VerifiedAtUtc > TimeSpan.FromMinutes(5) ||
            plan.AllowsAutoCreate || plan.AllowsWrite ||
            plan.RequiredTables.Count is < 1 or > 2)
            throw new PdmHistoricalShardNotVerifiedException("月份清单过期或不可信");

        var first = new DateTime(plan.BeginUtc.Year, plan.BeginUtc.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        var final = plan.EndExclusiveUtc.AddTicks(-1);
        var last = new DateTime(final.Year, final.Month, 1, 0, 0, 0, DateTimeKind.Utc);
        var expected = new List<string>();
        for (var t = first; t <= last; t = t.AddMonths(1))
            expected.Add("TelemetryData_" + t.ToString("yyyyMM", CultureInfo.InvariantCulture));
        if (!plan.RequiredTables.SequenceEqual(expected, StringComparer.Ordinal))
            throw new PdmHistoricalShardNotVerifiedException("计划物理表与 UTC 月份不一致");

        var cmd = connection.CreateCommand();
        cmd.CommandTimeout = 12;
        cmd.Parameters.Add("@fetch", SqlDbType.Int).Value = checked(maxRows + 1);
        cmd.Parameters.Add("@device", SqlDbType.UniqueIdentifier).Value = deviceId;
        cmd.Parameters.Add("@begin", SqlDbType.DateTime2).Value = plan.BeginUtc;
        cmd.Parameters.Add("@end", SqlDbType.DateTime2).Value = plan.EndExclusiveUtc;
        var keyParams = new List<string>();
        for (var i = 0; i < selected.Length; i++)
        {
            var param = "@key" + i.ToString(CultureInfo.InvariantCulture);
            keyParams.Add(param);
            cmd.Parameters.Add(param, SqlDbType.NVarChar, 128).Value = selected[i];
        }
        const string columns = "[DeviceId],[KeyName],[DateTime],[Type],[Value_Boolean],[Value_Long],[Value_Double]";
        var parts = expected.Select((table, index) =>
            "SELECT " + columns + " FROM (SELECT TOP (@fetch) " + columns +
            " FROM [dbo].[" + table + "] WHERE [DeviceId]=@device" +
            " AND [KeyName] IN (" + string.Join(",", keyParams) + ")" +
            " AND [DateTime]>=@begin AND [DateTime]<@end" +
            " ORDER BY [DateTime],[KeyName]) AS shard" +
            index.ToString(CultureInfo.InvariantCulture));
        cmd.CommandText = "SELECT TOP (@fetch) " + columns +
            " FROM (" + string.Join(" UNION ALL ", parts) +
            ") AS bounded ORDER BY [DateTime],[KeyName],[DeviceId]";
        return cmd;
    }
}
