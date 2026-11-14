# IoTSharp PdM 预测性维护 P2 第二批：API、前端与人工审核契约实施验收

- 日期：2026-11-13（北京时间）
- Windows 工作区：H:\code\Industrial.Platform\IoTSharp-master
- Git：Develop，HEAD 56fa1d63，未 commit / push
- 结论：**P2 第二批只读影子分析链路及纯合同开发完成，隔离安全测试通过；真实生产上线及 P1-07 Provider 长稳门禁仍未完成。**

## 一、并行分工和交付

本轮通过三个独立 WebCodex 会话并行推进，明确各自文件所有权，主会话只协调共享代码验证。

| 开发线 | 实际交付 | 状态 |
|---|---|---|
| P2-API | IoTSharp/Controllers/PdmP2ShadowController.cs、tools/pdm-p2/PdmP2ReadApiTests.cs、PdmP2HttpJwtTests.cs | 已实现、测试通过 |
| P2-UI | ClientApp/src/api/pdm/p2.ts、ClientApp/src/views/iot/pdm/P2ShadowPanel.vue、workbench.vue 的 P2 标签页 | 类型检查与 Vite 构建通过 |
| P2-Review | IoTSharp/Services/PredictiveMaintenance/P2/PdmApprovalContract.cs、tools/pdm-p2/PdmApprovalContractTests.cs | 已实现仅草稿的审核合同，测试通过 |
| 总体验收 | 独立 SQLite + Kestrel/JWT + P0/P1 回归、源码保护校验 | 通过隔离测试，真实浏览器验收待完成 |

## 二、P2 Shadow API

**GET /api/pdm/p2/shadow?deviceId={guid}**

- 类级 [Authorize]；租户与客户 ID 只能从 JWT 的可信 Claims 获取，不接受客户端覆盖。
- 独立配置开关：PredictiveMaintenance:P2:ReadOnlyEnabled，默认 false；同时要求 P1 Enabled、SchemaReady、SingleInstanceAcknowledged、PointMappingsApproved、HistoryQueryPlanApproved 和 HistoryUtcContractApproved 全部为 true，任一不满足返回 503，且不解析数据库服务。
- 验证 deviceId，不允许跨租户/客户查询；无权或不存在的设备返回 404，缺失身份范围返回 403；未认证由实际 JWT 中间件返回 401。
- 根据可信设备 Profile + 当前版本从已保存 P1 HealthSnapshot 读取最多 32 个窗口（仅小型列），严格隔离租户/设备/配置版本，不从前端接收质量或核验结果。
- 最近快照过期、未来时间、UTC 标记无效、连续性不足或同设备同版本存在多个 Open 风险片段时，禁止随意选一个风险生成提案。
- 当前版本无 Open 风险返回 NoOpenRisk；无可信历史返回 Unknown；正常查询采用 P2 纯编排器返回趋势、告警提案、人工维护草稿的只读结果。
- 不读取真实设备控制寄存器，不调用 WorkOrder/MES/PLC，不修改风险状态或生成实际通知。
- 当前缺少可信“点位测量类别”和持久化的历史通知/审批审计。因此不会从 Key 或单位猜测已核验类别；维护草稿保持 NeedsDataVerification。预警结果即使显示 Notify/Escalate 也只是计算提案，IsDelivered=false。

## 三、前端

在原有“预测性维护 → 设备健康监测 → 设备详情”中新添 **P2 影子分析** 标签页：

- 只读查看连续有效窗口、趋势方向、健康指数变化斜率（点/小时）、风险提案决策与原因、最近 UTC 时间、规则版本、64 位提案幂等标识。
- 显示人工维护建议状态、现场核验提示及可操作边界。
- 模块未启用或网络失败显示真实错误，不构造演示设备、不虚构分数或历史。
- 没有批准、发送通知或创建工单按钮；隐藏的按钮或模拟成功都不存在。
- Vue TypeScript 与 Vite production build 成功。本轮没有在真实后端登录态下测试浏览器菜单点击或截图，因此不签署 UI E2E。

## 四、人工审批与工单契约

新增 PdmApprovalContract.Prepare(...) 只负责生成 PdmReviewPacket：

- 必须匹配 TenantId/CustomerId/DeviceId/ProfileId/ProfileVersion/RiskEventId 作用域。
- 要求有效风险证据 JSON、64 位十六进制提案 ID、与活动风险事件一致的 UTC 窗口、只读且有可信趋势及维护建议。
- 对缺乏证据、错误审批上下文、关闭风险或跨租户对象返回 Blocked 或抛出范围错误。
- 满足条件也只是 AwaitingHumanReview；RequiresVerifiedReviewer=true、RequiresAuditPersistence=true，IsAuthorizedToExecute=false、IsAlertDelivered=false、IsWorkOrderCreated=false。
- **尚未开发真正的审批状态持久化、审核人员角色验证、审批日志事务、工单写入或消息发送**，不能根据这些纯对象宣称审批已经完成。

## 五、实测结果

| 实测命令/范围 | 结果 |
|---|---|
| IoTSharp .NET 10 后端编译 | **0 错误、48 个警告**（未做完整 clean build） |
| tools/pdm-p2 独立 xUnit | **46/46 通过** |
| tools/pdm-p1 独立 xUnit | **81/81 通过** |
| tools/pdm-p0 独立 xUnit | **5/5 通过** |
| tools/pdm-p0 Node 回放、安全/UTC | **20/20 通过** |
| 合计 | **152/152 项通过，0 失败** |
| ClientApp npm run typecheck | 通过 |
| ClientApp npm run build | 通过（约 1m03s） |
| 真实 Kestrel + JWT Bearer + SQLite :memory: | P2 匿名 401、伪造 JWT 401、跨租户 404、关闭发布门禁 503 |
| SQLite :memory: P2 可信快照/旧快照/错误版本/缺少事件/重复 Open 事件 | 通过 |
| 核验过的保护源码哈希 + 主 ApplicationDbContext | 不变 |
| 真正 SQL Server、PostgreSQL、InfluxDB + 1h/4h 长稳 | **未执行** |
| 真实登录态浏览器截图 | **未执行** |

可复现：

    dotnet build IoTSharp/IoTSharp.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false -v:q
    dotnet test tools/pdm-p2/IoTSharp.PdM.P2.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false -v:q
    dotnet test tools/pdm-p1/IoTSharp.PdM.P1.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false -v:q
    dotnet test tools/pdm-p0/IoTSharp.PdM.P0.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false -v:q
    node --test tools/pdm-p0/replay.test.mjs tools/pdm-p0/security-time-contract.test.mjs
    cd ClientApp
    npm run typecheck
    npm run build

## 六、代码保护和上线门禁

- 主 ApplicationDbContext 没有改动，未新增生产数据库迁移。
- AGENTS.md、ClientApp/package.json、ClientApp/src/digital-twin/contracts/index.ts、TwinManifestInspector.cs 经 SHA-256 检查无变化。
- 原数字孪生脏文件、JsonDB、SonnetDB、Durable Spool、时序库写入热链未被本批修改。
- 没有真正运行 PdM Worker，没有执行 PLC、MES、真实告警或工单指令。
- Git HEAD 未变，所有新增文件和原 P0/P1 修改仍在本地工作树，未经提交与推送。

**仍需完成**：

1. P1-07 SQL Server / PostgreSQL / InfluxDB 的真实 Provider 查询计划、UTC、分片路由、取消/超时和 1h/4h 协同长稳。
2. 受控开发环境中的真实前后端、登录态及页面截图验收。
3. P2 可信点位类别来源、可配置策略审计、通知去重持久化和人工审批权限。
4. 人工审批/审核日志与现有工单系统的正式事务合同，明确工单回写幂等与失败补偿。
5. 只有完成上述环境和权限验证才考虑单实例受控试运行；生产保持 PredictiveMaintenance:Enabled=false 及 P2:ReadOnlyEnabled=false。

最终状态：**P2 第二批代码与隔离验收通过；P2 真实业务闭环和生产上线尚未完成。**

