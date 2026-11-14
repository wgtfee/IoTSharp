# IoTSharp 预测性维护 P3 第一批并行开发与隔离验收

日期：2026-11-13（北京时间）
Windows 工程：H:\code\Industrial.Platform\IoTSharp-master
分支：Develop，HEAD：56fa1d63
阶段结论：**P3-0 / P3-1 / P3-2 / P3-Shadow 第一批核心开发及隔离测试通过；P3 整体、真实模型评测与生产上线尚未完成。**

## 1. 开发范围和并行交付

本轮通过四个独立 WebCodex 开发会话，按互斥源码路径推进，主会话建立 .NET 10 xUnit 项目并统一回归，避免和共享脏工作区发生覆盖。

| 任务 | 主要代码 | 实现内容 |
|---|---|---|
| P3-0 数据与标签 | IoTSharp/Services/PredictiveMaintenance/P3/PdmP3DataContracts.cs | Tenant/Customer/Device/Profile/版本/PointKey/工程单位/工况核验；严格 UTC、单调且不重复的采样时刻、来源与数值质量；人工故障/正常标签带事件发生时间、核验时间、Case 与核验人；无标签绝不认作确认正常 |
| P3-1 统计异常 | PdmP3AnomalyDetector.cs | 最近 N 个历史样本建立因果滑窗中位数/MAD 稳健基线，按阈值解释统计异常，候选观测不能参与自己的基线；冷启动、不可信时间/单位/工况、坏质量或异常数值拒绝 |
| P3-1 分布漂移 | PdmP3DistributionShiftDetector.cs | 非重叠的早期/近期同工况窗口对比中位数分布偏移，防止单位或租户混入；仅描述统计分布变化，不宣称故障或 ML 概念漂移已得到证明 |
| P3-2 离线评测 | PdmP3ReplayEvaluator.cs、PdmP3OfflineReplayRunner.cs | 只用评测样本之前的历史做预测；按时间留出验证集；人工确认的标签必须在 as-of 之前已可用；精确率、召回率、TP/FP/FN/TN；无标签返回 null 而非虚构指标；输出确定性 SHA-256 输入与回放指纹 |
| P3-Shadow | PdmP3ShadowCoordinator.cs | 同步检查 P1 Profile 身份/版本及 P2 趋势窗口，只生成只读 Shadow 证据；工单、告警、设备控制均无副作用，故障概率和剩余寿命保持未知 |

测试文件均位于 tools/pdm-p3，测试工程 tools/pdm-p3/IoTSharp.PdM.P3.Tests.csproj。所有输入均为隔离合成数据，并非真实设备历史或模型基准测试。

## 2. 安全性和可信性约束

- 没有 DeviceId、TenantId、CustomerId、ProfileId、ProfileVersion 和已核验单位/点位/工况的完整一致性，就拒绝进行可信评估。
- Bad/Partial/Unknown 数据质量、NaN/Infinity、非 UTC 时间、乱序、重复、长时间断档和混合设备来源会拒绝或标记 Unknown。
- 正常统计基线是正常波动的启发式描述，绝不等价于“确认设备无故障”。
- 任何缺失标签仍然是 Unlabeled；未在 as-of 时间前核验的标签不可用于评测；不凭统计分数生成 failure probability 或 RUL。
- 离线 Runner 对第 i 个样本仅使用 i 以前的历史建立基线，不允许把未来观测或确认故障标签泄漏到异常检测。
- Shadow 评估只接受 P2 已验证的时间窗口。P3 无自动数据库查询、HostedService、生产 DI 注册、通知、工单或 PLC/MES 调用。

## 3. 实际回归结果

| 验证 | 实测结果 |
|---|---|
| IoTSharp .NET 10 后端 | 成功，0 errors，60 warnings |
| P3 xUnit | **33/33 通过** |
| P2 xUnit | **80/80 通过** |
| P1 xUnit | **81/81 通过** |
| P0 .NET xUnit | **5/5 通过** |
| P0 Node 回放和安全时间测试 | **20/20 通过** |
| 合计 | **219/219 项通过，0 失败** |
| 主 IoTSharp.Data/ApplicationDbContext.cs | 相对 HEAD 未修改 |
| P3 注册生产 Worker/Startup | 未注册 |
| Git commit/push | 未执行 |
| 真实 SQL Server/PostgreSQL/InfluxDB、百万点协同、1h/4h | 未执行 |
| 现场故障标签、真实设备模型效果及误报漏报率 | 未验证 |
| P3 真实登录态浏览器/API | 尚无 P3 API/UI；未执行 |

复现命令（仓库根目录）：

    dotnet build IoTSharp/IoTSharp.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false -v:q
    dotnet test tools/pdm-p3/IoTSharp.PdM.P3.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false -v:q
    dotnet test tools/pdm-p2/IoTSharp.PdM.P2.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false -v:q
    dotnet test tools/pdm-p1/IoTSharp.PdM.P1.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false -v:q
    dotnet test tools/pdm-p0/IoTSharp.PdM.P0.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -v:q
    node --test tools/pdm-p0/replay.test.mjs tools/pdm-p0/security-time-contract.test.mjs

## 4. 代码边界与并行工作树

- 本轮 P3 文件全部为新目录下的独立源码和测试，不修改原数字孪生、JsonDB、SonnetDB、遥测写入热链、Durable Spool 或主 ApplicationDbContext。
- AGENTS.md SHA256 保持此前记录值 2BC62306472818712463BB8F63473663A64B25F83BA46224532C7A12EEF8361A。
- 共享 Develop 工作区已有其他数字孪生相关修改。ClientApp/package.json、ClientApp/src/digital-twin/contracts/index.ts、TwinManifestInspector.cs 的 SHA256 不再等于更早 P1/P2 基线；上一轮已记录该并行差异，本轮没有修改或恢复这些文件。不能宣称整仓旧哈希完全一致。
- 没有创建或修改生产数据库，没有真实硬件指令，没有提交、推送 Git。

## 5. P3 后续路线和发布门禁

**下一批 P3（继续研发）：**
1. 实际 IoTSharp 离线遥测适配器：设计限量、可取消的历史数据导出，记录单位、运行状态和点位来源；所有真实 Provider 先通过 P1-07 历史查询边界。
2. 数据标注与设备工况元数据核验：建立现场 Case/故障票据的人工标签审核链、时间线和保密协议，防止标签泄漏；数据偏斜时先报告覆盖率和不足。
3. 模型版本与实验登记：保存统计特征配方、阈值/数据集与代码版本、时间留出基线、可复现脚本及误报漏报结果；缺少足量真实标签时不进行生产故障概率/RUL 宣称。
4. 只读 P3 Shadow API + Vue 页面，明确 Unknown / Unverified / StatisticsOnly 状态，继承服务端 JWT Tenant/Customer/Device 隔离和默认关闭门禁。
5. 生产级鲁棒性：实际 SQL Server/PostgreSQL/InfluxDB 的查询计划、分区下推、UTC 合同、超时取消与 P1/P2 的 1h/4h 长稳；工单/IAM 生产联调单独验收。

**当前允许继续 P3 下一批研发；不批准生产模型、自动派工或 Worker 启用。**

