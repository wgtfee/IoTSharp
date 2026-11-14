# IoTSharp 预测性维护：VOL.AI 飞书能力定位、实际只读联调及对接状态

日期：2026-11-14（北京时间）

## 1. 用户补充及工程定位

用户明确指出：“在 vol.ai 里面”，用于纠正上一轮只搜索 IoTSharp 与 VOL.MES 源码所导致的飞书能力误判。

通过 WebCodex Windows Runner 实际打开：

- **VOL.AI 工程**：`H:\code\Industrial.Platform\AI`；本次观察 Git 分支 `agent/microsoft-agent-framework`，HEAD 前缀 `036fee3`；工作区已有其他未提交改动，未修改。
- **独立飞书 MCP 工程**：`H:\code\Industrial.Platform\FeishuPushMCP`；未修改。
- **本次允许修改的 IoTSharp**：`H:\code\Industrial.Platform\IoTSharp-master`；`Develop`，HEAD `56fa1d63d9219008cde8e0ac3f5aae7a74822e74`；既存脏文件保留，无 commit/push。

## 2. 已核实的飞书真实实现

### VOL.AI 现成实现

`src/VOL.AI.Api/FeishuChannel.cs`：

- `FeishuTenantTokenService`：读取已启用 Channel Account，解析由 `ChannelManagedSecretService` 管理的 App Secret，走飞书 OpenAPI 获取 `tenant_access_token`。
- `FeishuChannelAdapter.SendAsync`：根据已授权通道及实际会话，POST `/open-apis/im/v1/messages?receive_id_type=chat_id`，HTTP 与飞书业务码均成功时返回已投递回执。**这使用 AppId/AppSecret 与受保护的会话绑定，并不是一个普通的群机器人 Webhook。**
- `src/VOL.AI.Api/ChannelServices.cs`：`ChannelWorker` 消费 Inbox/Outbox，投递现有 FeishuChannelAdapter。
- `src/VOL.AI.Infrastructure/ChannelOperations.cs`：`QueueSessionNotificationAsync` 根据 **Tenant/User/Session/Run** 的既有绑定生成 Outbox，使用 `runId + notificationKey` 去重；当前接口不是可匿名调用的通用 IoTSharp 生产告警接入口。
- `src/VOL.AI.Api/Controllers/ChannelsController.cs`：已具备租户鉴权的 Channel 管理和 Outbox 查询、重试等 API；未找到可以让 IoTSharp 任意设备异常直接入队的生产服务账号 API。

### 飞书 Push MCP 已有接口

`H:\code\Industrial.Platform\FeishuPushMCP\FeishuTools.cs` 已定义：

- `get_feishu_status`
- `send_feishu_message(content, chat_id?, account_id?, delivery_key?)`
- `get_feishu_delivery_status(delivery_key)`
- `get_feishu_send_audit`

`FeishuGateway.cs` 从 VOL.AI 既有 `VolAiRegistry` 读取账号与会话，解析机器保护凭据，向飞书 OpenAPI 发消息；**不会再存一份飞书应用 Secret**。`FeishuDeliveryJournal.cs` 使用先落盘的稳定 `delivery_key` 防止双发，连超时结果不明的任务都不能盲目重发。

## 3. 本轮真实联调（无通知外发）

在本机执行现有审核版 `_audit_build/FeishuPushMcp.exe --self-test`，**结果 Ready=true**：

- 来源：`VOL.AI/VolAiRegistry`
- 凭据模式：`machine-protected`
- 已发现绑定目标：`Group`
- 账号与群标识仅得到脱敏值；本报告不保存任何明文 App Secret、Token、Chat ID 或数据库连接字符串。
- 绑定上次活动时间：**2026-08-21 07:13:01 UTC**；不足以证明是当前指定的生产告警接收群。

另执行同一 EXE 的 `--latest-unread` **只读 Feishu OpenAPI 查询**；实际返回“成功，当前没有未读消息”，没有打印消息正文或修改飞书已读状态。

**真实 Feishu 发送本轮没有执行。** 当前 WebCodex Runner 的本地 MCP 工具网关 `action=list` 返回**空注册列表**，因此没有可用的受管理 `send_feishu_message` 调用入口。未绕过该调度边界，未通过 shell/stdin 私自构造等价生产发送。现有旧群绑定也未由有权限的业务人员确认用于 PdM 生产告警。

## 4. 维修系统接口：实际调查结论

实际搜索 VOL.AI `src`、`docs` 和默认 `src/VOL.AI.Api/data/mcp-servers.json`：

- 默认 MCP Servers 文件只列出 Fetch（Web Content）和 Filesystem（Industrial Data Files）。
- `IndustrialAgentProductizationServices.cs` 的 MES Agent 内置提示包含“只读核对生产订单、工单”，并明确**写入、下发、终止、状态修改必须经过受治理 Workflow**。
- **未找到**可确认的“设备维修系统创建工单”HTTP/MCP 端点、认证配置、可靠幂等键、外部工单查询或对账接口。
- VOL.AI 允许未来通过受治理 Workflow 加载租户范围的业务 Provider，但“框架能调用 Tool”不等于“已有真实维修工单创建工具”。未声称检查过未知的动态/运行时第三方 MCP Registry 全量清单。

因此，飞书通知可以利用已有 VOL.AI 通道，但**飞书消息不是维修工单**；维修系统的真实建单 API 仍需被定位和验证，不能虚构返回真实工单号。

## 5. IoTSharp 本轮实质代码

新增 `IoTSharp/Services/PredictiveMaintenance/P2/PdmVolAiFeishuMcpHandoff.cs`：

- 面向已经存在的 `send_feishu_message` MCP 参数格式，构建稳定的 `delivery_key=iotsharp-pdm:<64位提案SHA>`，严格与已有 `FeishuDeliveryJournal` 的规则兼容。
- 显式要求由受信任的后端传入已审批的 **Tenant、Customer、Feishu Account、Chat ID、审批人/审批时间**；默认选择最近活跃聊天不是允许的生产路由。
- 拒绝**合成模型、非现场遥测、未批准点位、未核验运行状态、错误租户、非 UTC 或过期评估窗口、过期/未审核接收路由**。
- 仅输出最少必要设备 GUID、严重等级、评估 UTC、关联键；不携带飞书凭据、原始传感器值或租户秘密。
- **这只是安全的 typed handoff contract，不执行发送、不持久化生产 Outbox，也不能作为上线许可。**

新增 `tools/pdm-acceptance/closed-loop/Batch8VolAiFeishuMcpHandoffTests.cs` **4 项测试**，覆盖 MCP 工具参数、确定性幂等、合成/未核验/跨租户拒绝、过期接收路由、时间窗口拒绝。

上一轮新建 `PdmFeishuVerifiedAlertSender` 是纯 Webhook 型备用适配器；**VOL.AI 当前实际使用的是受保护 App 账号 + OpenAPI / FeishuPushMCP 模式，因此 IoTSharp 生产链路应优先使用这一新 MCP handoff，而不是盲目复制或更换已有密钥**。所有生产发送路径仍默认关闭。

## 6. 实测自动化回归

| 测试集 | 通过 | 失败 |
|---|---:|---:|
| PdM Acceptance（上一轮 149 + 本轮 4） | 153 | 0 |
| P3 xUnit | 78 | 0 |
| P2 xUnit | 80 | 0 |
| P1 xUnit | 81 | 0 |
| P0 xUnit | 5 | 0 |
| P0 Node + P3 UI Node | 24 | 0 |
| 合成模型 xUnit | 6 | 0 |
| **合计** | **427** | **0** |

IoTSharp .NET 10 后端构建成功（0 错误，1 个警告；使用 `BuildProjectReferences=false` 的增量构建）。

## 7. 生产激活的剩余门禁

1. **目标群审批**：明确 PdM 告警使用哪个 Feishu Account + Chat ID，并完成租户范围、接收群成员、投递内容审查。当前找到的默认群最近活动在 8 月，不能自动当作生产群。
2. **受管理 MCP 连接**：当前 ChatGPT/WebCodex Runner 的本地 MCP 网关未注册 FeishuPushMCP；必须使用受管理调用入口，而非在对话中绕过安全检查直接通过 EXE 发送。
3. **现场数据可信**：真实设备点位、运行信号、UTC 时间戳、风险 Episode、生产审核/授权均必须真正核验。合成训练数据不能触发现场告警。
4. **本地 SQL Server 独立 PdM 库**：上一轮已通过 Windows 身份连接 `.\MSSQ`，但 `IOTSharp` 只有旧 `Alarms` 表且未发现 PdM/工单表；需要部署经过审查的独立 PdM 数据库、可靠 Outbox/通知与工单状态、幂等约束和可回滚迁移。此前 SQL Server DDL 安全门禁不能绕过。
5. **维修系统真实目标**：必须定位经过授权的维修创建/查询/对账接口，确定幂等、超时未知状态、手动复核与处理关闭的流程。VOL.AI 的通用 MES Agent 不能假冒维修工单 API。

**最终判定：找到了并验证 VOL.AI 真实飞书账号/只读 API；IoTSharp 已新增与 FeishuPushMCP 匹配的安全对接契约，427/427 回归通过。但生产自动告警、真实飞书发消息、实际维修建单仍未启用/发送；绝不伪称成功。**
