# IoTSharp 动态 MCP Tool 开发与运维说明

## 目标

IoTSharp 保留程序集内注册的设备只读 Tool，同时允许 CustomerAdmin、TenantAdmin 或 SystemAdmin 在“AI 与 MCP 能力中心”新增数据库驱动的 HTTP API Tool。动态 Tool 与当前 `AISettings` 绑定，复用 MCP API Key 的客户/租户隔离，不建立第二套身份体系。

## 数据模型

- `McpToolDefinitions`：Tool 名称、说明、JSON Schema、HTTP Method、Endpoint Template、超时、启停、内网访问开关和加密请求头。
- `McpToolInvocationLogs`：只记录 Tool、来源、参数名、开始时间、耗时、状态码、响应大小和错误摘要。参数值、请求体、响应体以及认证头不写入审计表。
- `AISettingsId`：动态 Tool 的强制作用域外键。同一 AISettings 下 Tool 名称唯一。

SQL Server 迁移为 `AddDynamicMcpTools`。项目启用 `Database:AutoMigrate` 时会在后端下次启动自动应用。

## 管理 API

管理路由前缀为：

```text
/api/mcp-tools/{scope}/{scopeId}
```

其中 `scope` 只能是 `customer` 或 `tenant`。接口包括列表、新增、修改、软删除、真实调用测试和最近执行记录。控制器会再次校验当前登录用户的 Tenant/Customer Claim，不能仅凭前端传入的 scopeId 越权。

## HTTP Tool 规则

Endpoint Template 示例：

```text
https://mes.example.com/api/orders/{orderNo}
```

输入 Schema 示例：

```json
{
  "type": "object",
  "properties": {
    "orderNo": { "type": "string", "description": "生产订单号" },
    "includeSteps": { "type": "boolean", "description": "是否返回工序" }
  },
  "required": ["orderNo"]
}
```

`{orderNo}` 会进行 URL 编码后替换。GET/DELETE 未被模板消费的参数进入 Query String；POST/PUT/PATCH 未被消费的参数形成 JSON Body。

固定请求头以 JSON Object 输入，例如：

```json
{
  "Authorization": "Bearer replace-with-real-secret",
  "X-Plant": "plant-a"
}
```

请求头通过 ASP.NET Core Data Protection 加密后入库，管理 API 永不回显明文。编辑时留空表示保持原值，填写 `{}` 表示清空。

## MCP 协议行为

- `tools/list`：SDK 自动合并 5 个内置 Tool 与当前 API Key 下已启用的动态 Tool。
- `tools/call`：内置名称优先由程序集 ToolCollection 执行；其他名称交给动态处理器。
- AISettings 停用、API Key 无效、Tool 停用或软删除时，动态 Tool 不会被列出或执行。
- 内置名称为保留名称，数据库 Tool 无法覆盖。

## 安全边界

- 默认阻止 loopback、私网、链路本地、组播及特殊用途地址，且在实际建立 TCP 连接时重新解析 DNS，降低 DNS rebinding 风险。
- 工业内网 API 必须由管理员显式开启“允许访问内网 API”。
- 禁止自动重定向、Cookie、Host、Content-Length、Connection、Transfer-Encoding 等危险固定请求头。
- 单次调用超时范围 1–60 秒，响应最多返回 64 KiB。
- 生产环境应持久化并保护 Data Protection Key Ring；否则环境迁移后已保存请求头可能无法解密。

## 页面操作

打开“AI 与 MCP 能力中心 → MCP 服务”：

1. 选择客户或租户作用域并保存服务设置，生成 API Key。
2. 点击“新增 Tool”，填写名称、说明、HTTP 配置和输入 Schema。
3. 保存后点击“测试”，输入真实调用参数；测试会真实访问目标 API 并写审计。
4. 点击“记录”查看最近调用结果。
5. MCP 客户端重新执行 `tools/list` 后即可发现新 Tool。
