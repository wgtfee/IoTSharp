using System;
using System.Data.Common;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Data.SqlClient;
using Microsoft.EntityFrameworkCore;

namespace IoTSharp.Services.PredictiveMaintenance.Integration;

/// <summary>SQL Server 会话级投递互斥锁；HTTP 未知结果仍依靠 MES EventId 幂等。</summary>
internal static class PdmMesSqlDispatchLock
{
    /// <summary>立即尝试获取锁；取得后连接保持打开，直到 ReleaseAsync。</summary>
    public static async Task<bool> TryAcquireAsync(DbContext db, string resource, CancellationToken ct)
    {
        await db.Database.OpenConnectionAsync(ct);
        try
        {
            var result = await RunAsync(db, resource, true, ct);
            if (result >= 0) return true;
            if (result == -1)
            {
                await db.Database.CloseConnectionAsync();
                return false;
            }
            throw new InvalidOperationException($"MES SQL dispatch lock acquisition failed: {result}");
        }
        catch
        {
            await db.Database.CloseConnectionAsync();
            throw;
        }
    }

    /// <summary>释放会话锁并关闭连接；实例异常退出后 SQL Server 自动释放。</summary>
    public static async Task ReleaseAsync(DbContext db, string resource)
    {
        try
        {
            var result = await RunAsync(db, resource, false, CancellationToken.None);
            if (result < 0)
                throw new InvalidOperationException($"MES SQL dispatch lock release failed: {result}");
        }
        catch
        {
            // Close() normally returns a live SQL session to the pool. If releasing
            // the app lock failed, discard that physical session rather than pooling it.
            if (db.Database.GetDbConnection() is SqlConnection sql)
                SqlConnection.ClearPool(sql);
            throw;
        }
        finally
        {
            await db.Database.CloseConnectionAsync();
        }
    }

    private static async Task<int> RunAsync(DbContext db, string resource, bool acquire, CancellationToken ct)
    {
        await using DbCommand command = db.Database.GetDbConnection().CreateCommand();
        command.CommandText = acquire
            ? "DECLARE @result int; EXEC @result = sys.sp_getapplock @Resource=@resource, @LockMode='Exclusive', @LockOwner='Session', @LockTimeout=0; SELECT @result;"
            : "DECLARE @result int; EXEC @result = sys.sp_releaseapplock @Resource=@resource, @LockOwner='Session'; SELECT @result;";
        command.CommandTimeout = 5;
        var parameter = command.CreateParameter();
        parameter.ParameterName = "@resource";
        parameter.Value = resource;
        command.Parameters.Add(parameter);
        return Convert.ToInt32(await command.ExecuteScalarAsync(ct));
    }
}
