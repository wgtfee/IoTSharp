# IoTSharp.Benchmarks

本项目覆盖 `#09A CoAP 性能与压测` 的可复现入口。

## BenchmarkDotNet

```powershell
dotnet run -c Release --project tools/IoTSharp.Benchmarks -- --filter *Coap*
```

覆盖项：

- IoTSharp 推荐 CoAP path 约定匹配。
- CoAP.NET endpoint matcher 与 resource tree 构建。
- CoAP telemetry UTF-8 payload 解析。
- CoAP alarm payload 的 System.Text.Json source generation 解析与 DTO 映射。

## CoAP 压测 Runner

先启动 IoTSharp 并启用 `CoapServer`，再运行：

```powershell
dotnet run -c Release --project tools/IoTSharp.Benchmarks -- --coap-load --uri coap://127.0.0.1:5683/devices/device-001/telemetry --token "<device-access-token>" --requests 10000 --concurrency 32
```

说明：

- 压测 runner 通过真实 UDP CoAP POST 写入平台推荐 route。
- `--block-size` 可调小以覆盖 Blockwise 分片压力。
- payload 字典会交给事件总线，不做对象池复用；只池化或复用不会逃逸的临时结构，避免压测优化破坏业务所有权。

## Gateway 百万点接入基线

该 runner 在进程内覆盖 `Gateway batch JSON -> Validate/Deserialize -> telemetry dictionary -> bounded TelemetryIngestPipeline -> batch publisher`，用于比较版本间解析、分配、队列峰值和背压变化。它不把网络、SQL Server 或真实 EventBus 的性能混进同一数字，因此不是生产环境 SLA。

```powershell
dotnet run -c Release --project tools/IoTSharp.Benchmarks -- --gateway-ingest-load --points 100000
dotnet run -c Release --project tools/IoTSharp.Benchmarks -- --gateway-ingest-load --points 500000
dotnet run -c Release --project tools/IoTSharp.Benchmarks -- --gateway-ingest-load --points 1000000
```

### Telemetry storage-to-rule hot path

This runner isolates database I/O with a fake `IStorage`, but uses the real
`EventBusSubscriber.StoreTelemetryDataBatch` and real bounded
`TelemetryRuleDispatchPipeline`. It measures rule projection/queue throughput,
managed allocation, GC, backpressure and verifies zero message/rule loss.

```powershell
dotnet run -c Release --project tools/IoTSharp.Benchmarks -- --telemetry-rule-load --points 100000
dotnet run -c Release --project tools/IoTSharp.Benchmarks -- --telemetry-rule-load --points 500000
dotnet run -c Release --project tools/IoTSharp.Benchmarks -- --telemetry-rule-load --points 1000000
dotnet run -c Release --project tools/IoTSharp.Benchmarks -- --telemetry-rule-load --points 1000000 --rules-enabled false
dotnet run -c Release --project tools/IoTSharp.Benchmarks -- --telemetry-rule-load --points 1000000 --rule-mode telemetry
dotnet run -c Release --project tools/IoTSharp.Benchmarks -- --telemetry-rule-load --points 1000000 --rule-mode array
dotnet run -c Release --project tools/IoTSharp.Benchmarks -- --telemetry-rule-load --duration-seconds 60 --rules-enabled true
```

常用参数：`--batch-points 2000`、`--devices-per-batch 20`、`--producers 4`、`--partitions 8`、`--capacity-per-partition 4096`、`--pipeline-batch-size 256`。

输出包含：points/s、device messages/s、托管分配量、Working Set 变化、最大 queue depth、backpressure waits、EventBus batch 数和 Gen0/1/2 GC 次数。

可使用慢消费者和故障注入验证背压/重试：

```powershell
dotnet run -c Release --project tools/IoTSharp.Benchmarks -- --gateway-ingest-load --points 100000 --capacity-per-partition 16 --pipeline-batch-size 16 --publisher-delay-ms 10 --fail-every-batch 17
```

- `--publisher-delay-ms`：模拟 EventBus/存储下游变慢。
- `--fail-every-batch`：每 N 次 publish attempt 注入一次失败；Pipeline 应重试同一批次而不丢消息。
- 成功结束时 runner 会再次核对 `published device messages == enqueued device messages`，故障场景也必须满足零丢失。
