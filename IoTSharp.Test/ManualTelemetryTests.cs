#nullable enable

using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;
using System.Threading.Tasks;
using IoTSharp.Contracts;
using IoTSharp.Dtos;
using Xunit;

namespace IoTSharp.Test;

public sealed class ManualTelemetryTests : IClassFixture<SqliteAppFixture>
{
    private readonly SqliteAppFixture _fixture;

    public ManualTelemetryTests(SqliteAppFixture fixture)
    {
        _fixture = fixture;
    }

    [Fact]
    public async Task AuthenticatedManualTelemetryStoresTypedLatestAndHistory()
    {
        using var client = _fixture.CreateClient();
        var created = await _fixture.CreateDeviceAsync(client, $"manual-telemetry-{Guid.NewGuid():N}");
        var deviceId = created.Data!.Id;
        var collectedAt = DateTimeOffset.UtcNow;

        var response = await client.PostAsJsonAsync($"/api/Devices/{deviceId}/Telemetry/Manual", new
        {
            timestamp = collectedAt,
            values = new object[]
            {
                new { keyName = "manual_double", dataType = "Double", value = "26.5" },
                new { keyName = "manual_long", dataType = "Long", value = "1200" },
                new { keyName = "manual_running", dataType = "Boolean", value = true },
                new { keyName = "manual_label", dataType = "String", value = "line-a" },
                new { keyName = "manual_json", dataType = "Json", value = new { state = "running", speed = 12 } }
            }
        });
        var write = await ReadApiResultAsync<bool>(response);

        Assert.Equal((int)ApiCode.Success, write.Code);
        Assert.True(write.Data);

        var latest = await WaitForLatestAsync(client, deviceId,
            ["manual_double", "manual_long", "manual_running", "manual_label", "manual_json"]);
        Assert.Contains(latest, item => item.KeyName == "manual_double" && ToDouble(item.Value) == 26.5);
        Assert.Contains(latest, item => item.KeyName == "manual_long" && ToLong(item.Value) == 1200);
        Assert.Contains(latest, item => item.KeyName == "manual_running" && ToBoolean(item.Value));
        Assert.Contains(latest, item => item.KeyName == "manual_label" && ToText(item.Value) == "line-a");
        Assert.Contains(latest, item => item.KeyName == "manual_json");

        var begin = Uri.EscapeDataString(collectedAt.AddMinutes(-1).ToString("O"));
        var end = Uri.EscapeDataString(collectedAt.AddMinutes(1).ToString("O"));
        var historyResponse = await client.GetAsync($"/api/Devices/{deviceId}/TelemetryData/manual_double/{begin}/{end}");
        var history = await ReadApiResultAsync<List<TelemetryDataDto>>(historyResponse);

        Assert.Equal((int)ApiCode.Success, history.Code);
        Assert.Contains(history.Data!, item => item.KeyName == "manual_double" && ToDouble(item.Value) == 26.5);
    }

    private static async Task<List<TelemetryDataDto>> WaitForLatestAsync(HttpClient client, Guid deviceId, string[] keys)
    {
        ApiResult<List<TelemetryDataDto>>? result = null;
        for (var attempt = 0; attempt < 30; attempt++)
        {
            var response = await client.GetAsync($"/api/Devices/{deviceId}/TelemetryLatest/{string.Join(',', keys)}");
            result = await ReadApiResultAsync<List<TelemetryDataDto>>(response);
            if (result.Data?.Select(item => item.KeyName).Distinct().Count() == keys.Length)
            {
                return result.Data;
            }
            await Task.Delay(250);
        }

        Assert.NotNull(result?.Data);
        return result!.Data!;
    }

    private static async Task<ApiResult<T>> ReadApiResultAsync<T>(HttpResponseMessage response)
    {
        var body = await response.Content.ReadAsStringAsync();
        Assert.True(response.IsSuccessStatusCode,
            $"{response.RequestMessage?.Method} {response.RequestMessage?.RequestUri} => {(int)response.StatusCode}: {body}");
        var result = JsonSerializer.Deserialize<ApiResult<T>>(body, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Assert.NotNull(result);
        return result!;
    }

    private static double ToDouble(object? value) => value is JsonElement element ? element.GetDouble() : Convert.ToDouble(value);
    private static long ToLong(object? value) => value is JsonElement element ? element.GetInt64() : Convert.ToInt64(value);
    private static bool ToBoolean(object? value) => value is JsonElement element ? element.GetBoolean() : Convert.ToBoolean(value);
    private static string? ToText(object? value) => value is JsonElement element ? element.GetString() : Convert.ToString(value);
}
