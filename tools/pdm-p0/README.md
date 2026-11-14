# PdM P0/V0.1：离线合成回放

**仅用于 P0 合同、数据质量、幂等性验证，不是生产推理服务。**
不调用 IoTSharp 主程序、不连接真实 PLC/MES、不访问任何业务数据库。

## 执行

在 IoTSharp-master 根目录使用 Node.js 22：

    node --test tools/pdm-p0/replay.test.mjs

- 固定数据来源：fixtures/pilot-motor.synthetic.json，明确标注 provenance=synthetic-only。
- 每次使用 SQLite :memory: 隔离数据库，无文件或生产数据库写入。
- DQ-01～04：正常、缺失、单位不匹配、无效值、离线、重复、乱序、停机。
- ALG-01：持续升温规则提示，不等于已训练故障概率。
- EVT-01：同一个 Episode 重试复用同一风险事件唯一键。
- Node v22 中 node:sqlite 会提示 ExperimentalWarning。这是 P0 工具，P1 生产代码不得依赖该实验 API。
- 不能以本工具通过证明 IoTSharp Provider、业务 API、跨租户鉴权或长期负载通过。


## P0 第二阶段：.NET 10 实际控制器/EF Reader 测试

独立测试项目：tools/pdm-p0/IoTSharp.PdM.P0.Tests.csproj。

运行指令（已先恢复包且已有 IoTSharp 当前 Debug 引用产物）：

    dotnet test tools/pdm-p0/IoTSharp.PdM.P0.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false -v:q

实际结果：5/5 PASS；2 个接口的 [Authorize] 反射检查，2 组跨租户/跨客户防护与本租户状态修改，以及 1 个 EFStorage UTC [begin,end) 历史查询/设备/Key 过滤验证。

由于主 IoTSharp.Test 有未修复的非 PdM CS9007，本阶段使用独立测试项目，但也不能替代 HTTP/JWT/实际 SQLServer/PostgreSQL/InfluxDB Provider E2E。

详细记录：design-plans/predictive-maintenance/P0_第二阶段执行报告.md。

