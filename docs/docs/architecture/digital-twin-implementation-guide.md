---
title: 数字孪生实现与使用指南
---

# 数字孪生实现与使用指南

## 1. 已交付范围

IoTSharp 内置数字孪生工作台已经形成一个端到端 MVP，不依赖 Meteor3DEditor 或 Astral3D 的后端。编辑态直接使用固定提交的 `threejs-editor` Apache-2.0 内核源码，运行态使用 IoTSharp `TwinRuntime`；IoTSharp 负责全部业务数据、权限、资源绑定、版本和运行数据。

当前链路如下：

1. 管理员可以上传单文件 GLB，也可以在“模型生成”页面提交参考图和建模要求；生成任务由 img2threejs Worker 处理并自动进入同一模型库。
2. 服务端检查 GLB 头、JSON Chunk 和外部 URI，统计节点、Mesh、材质、动画及三角形，计算 SHA-256，再写入租户隔离的模型资源库。
3. 用户创建归属于根 Asset 的场景，在“专业编辑”模式中将模型放入 `threejs-editor`，编辑模型、子节点、材质、灯光、相机和后期处理。
4. 用户选择模型或模型子节点，把根 Asset 下 Device 的遥测、属性或在线状态绑定到显示属性或运动属性。
5. 保存草稿时，Manifest、threejs-editor 编辑快照、模型对象绑定、设备点位绑定和路线同步写入数据库；编辑快照不保存模型 URL，只保存稳定 `objectId/resourceId`。
6. 发布时生成不可变场景版本，并复制该版本的绑定和路线快照。
7. 运行态只读取当前发布版本，批量读取 Device 最新数据并驱动 Three.js 对象；回滚只切换发布指针，不覆盖草稿。

## 2. 数据库结构

| 表 | 作用 |
| --- | --- |
| `DigitalTwinScenes` | 场景元数据、根 Asset、当前草稿、revision 和当前发布版本指针。 |
| `DigitalTwinSceneVersions` | 不可变 Manifest、版本号、Hash、校验报告和变更说明。 |
| `TwinModelResources` | GLB 存储路径、文件 Hash、节点索引、模型统计、处理状态和许可证。 |
| `TwinModelGenerationJobs` | 参考图存储路径、提示词、质量档位、任务状态/进度、失败原因和最终模型资源 ID。 |
| `TwinObjectBindings` | 模型资源/场景对象绑定，以及对象节点到 Asset、Device、数据 Key、目标属性和白名单转换器的绑定。 |
| `TwinRoutes` | 路线类型、控制点图、revision 和启用状态。 |

`TwinObjectBindings.SceneVersionId` 和 `TwinRoutes.SceneVersionId` 是版本边界：为空表示当前草稿记录；有值表示某个已发布版本的不可变快照。因此资源绑定不只存在于 JSON 中，也可以直接查询、审计、约束和按版本运行。

基础迁移名称为 `AddDigitalTwinPlatform`，模型生成任务增量迁移为 `AddTwinModelGeneration`；两组迁移均已分别生成在各数据库 Provider 的 `Migrations` 目录。部署时沿用 IoTSharp 现有数据库迁移启动流程；生产升级前必须先备份数据库，并在同类型预发布环境演练。

## 3. 工作台操作

入口为“数字孪生 → 三维场景”。

### 3.1 新建场景

- 填写场景名称。
- 必须选择一个根 Asset。根 Asset 界定场景的租户/客户业务范围，也决定可选择的 Device 和点位。
- 创建成功后，场景、初始程序化对象和默认输送路线立即入库。

### 3.2 模型资源

- 在“模型资源库”先填写许可证信息并确认商业使用权限，再上传 `.glb`。
- 当前只接收 GLB；不直接接收 `.gltf` 外链贴图、STEP、DWG、FBX 或 OBJ。
- “模型生成”页面已接入 img2threejs 异步任务链。img2threejs 原生输出是 Three.js TypeScript 工厂和 Sculpt Spec，Worker 负责 Agent 视觉循环、受控构建与 GLB 导出，IoTSharp 不执行用户提交的任意脚本。
- 厂家 CAD 和精确工业设备优先经过 Blender 或专用转换工具减面、合并材质、烘焙贴图后再入库。
- 点击“放入场景”后生成稳定 `objectId` 和 `resourceId` 引用。点击“保存草稿”才完成数据库绑定同步。

#### 3.2.1 img2threejs 模型生成

入口为“数字孪生 → 模型生成”，也可以从三维场景的“生成模型”按钮进入。

1. 上传 PNG、JPEG 或 WebP 参考图片；服务端校验真实文件签名，最大 15 MB。
2. 填写模型名称、真实比例、必须拆分的部件、关节/滑轨、材质和动画要求。
3. 选择 Draft、Preview 或 Production 质量档位，并确认参考图片与生成内容的使用权。
4. IoTSharp 先把任务和参考图写入租户隔离存储；Worker 未配置时状态为 `WaitingForWorker`，不会丢失任务。
5. Worker 返回 GLB 后，复用模型库的文件头、外部 URI、节点、三角形、Hash、重复内容和授权检查；通过后 `ResultModelResourceId` 写回任务。
6. 在结果抽屉中可以对照参考图旋转查看 GLB，然后进入三维场景使用。

img2threejs 是 Agent Skill，而不是官方托管 API。IoTSharp 因此使用可替换的 Worker 合同。在 `appsettings.json` 或环境变量中配置：

```json
{
  "DigitalTwin": {
    "ModelGeneration": {
      "Enabled": true,
      "Provider": "Img2ThreeJs",
      "Endpoint": "http://127.0.0.1:8791/v1/generate/glb",
      "ApiKey": "replace-with-worker-secret",
      "PollIntervalSeconds": 5,
      "TimeoutMinutes": 30
    }
  }
}
```

Worker 端点接收 `multipart/form-data`：`referenceImage`、`jobId`、`name`、`prompt`、`qualityProfile`、`animationReady`、`outputFormat=glb` 和 `contractVersion=iotsharp-img2threejs-worker/v1`；成功时返回 `200`、`Content-Type: model/gltf-binary` 和单文件 GLB。密钥通过 Bearer Header 传递。生产 Worker 应在独立容器中运行 Agent、img2threejs、浏览器渲染和 GLB 导出，并限制 CPU、内存、执行时间和出站网络。

### 3.3 专业编辑与路线运行

工作台顶部有两种视图：

- **专业编辑**：使用 `threejs-editor` 完成场景树、根/子节点选择、移动、旋转、缩放、撤销重做、相机、灯光、材质和后期处理。右侧属性面板来自开源编辑内核，左侧模型入口只读取 IoTSharp 资源库。
- **路线运行**：使用 IoTSharp 确定性运行时绘制路线、拖动控制点、运行/暂停，并预览实时 Device 绑定。

从专业编辑切换到路线运行前，工作台会先把未保存的模型变换写回内存 Manifest，因此路线预览能立即看到最新模型位置。点击“保存草稿”后，`editorExtension.threeEditor`、顶层 `objects/resources/bindings/routes` 一起保存；其中顶层资源和绑定是数据库关系的权威来源。

### 3.4 设备数据绑定

1. 在三维场景中选择模型根对象或具体子节点。
2. 选择根 Asset 关系下的 Device。
3. 选择 Telemetry、Attribute 或 Connectivity。
4. 选择/输入数据 Key。
5. 选择颜色、可见性、旋转动画、路线进度、透明度或数值目标。
6. 加入绑定清单并保存草稿。

首版转换器是白名单配置，不执行用户脚本：

| 转换器 | 典型用途 |
| --- | --- |
| `booleanColor` | 运行/停止、开/关转换为绿色/红色。 |
| `booleanVisibility` | 控制对象显隐。 |
| `booleanAnimation` | 控制电机、风扇或滚筒是否旋转。 |
| `numberScale` | 把数值按系数和上下限映射到透明度或尺寸。 |
| `routeProgress` | 把 0～1 进度值映射为路线距离。 |
| `routeEvent` | 把 Device 遥测/属性/在线状态送入自动选路、输送段占用和故障判断，不直接修改模型属性。 |
| `rangeColor` | 按数值区间映射颜色，适合温度或压力。 |

运行态带有时间戳去乱序和陈旧数据样式。数据缺失、质量不良或超过 `staleAfterMs` 时，对象变为灰色半透明；后续新鲜数据到达后恢复原材质。

### 3.5 路线、发布和回滚

- 路线支持直线与 Catmull-Rom 平滑曲线、控制点拖动、速度、循环、运行/暂停和位置校正。
- 路线采用图结构：`points` 支持途经点、普通交叉口、分流器、汇流器、缓存段、加工工位、传感器和站点；`edges` 是有方向的输送段；`startPointId` 指定运行入口，`junctionDecisions` 保存默认出口。
- 在“路线运行”中点击“新增分支节点”，设置坐标后选择“从节点/到节点”并点击“连接分支”。一个节点连接三条及以上路线边时会自动成为橙色交叉口。
- 包装线应把一进多出的节点设为“分流器”，多进一出的节点设为“汇流器”。编辑器会校验分流器至少两条启用出边、汇流器至少两条启用入边，并以橙色/紫色辅助体区分。
- “手动”模式使用交叉口默认出口；“自动规则”模式可按预览包裹的 `sku`、`weight` 等嵌套属性或已入库 Device 信号选择出口。规则按 `priority` 从高到低匹配；没有规则命中时依次回退到默认出口和边优先级。
- 每条输送段可以设置容量、预览占用、单向/双向、静态封锁、实时占用绑定、实时故障/封锁绑定和关联输送机对象。占用达到容量、静态封锁、实时封锁为真，或相关实时信号陈旧/质量不良时，边显示为红色并从本次路径中排除；新鲜信号恢复后重新选路。
- 在右侧新增绑定时选择“分流/占用信号”，会生成白名单 `routeEvent` 转换器。保存草稿后该绑定写入 `TwinObjectBindings`，路线节点/输送段/自动规则只通过稳定 `bindingId` 引用它。
- 删除节点会同时删除关联边、默认出口和自动选路规则；删除边也会清理引用该边的规则。旧版只有顺序 `points` 的场景在加载时自动生成顺序边，因此不需要数据库迁移。
- 当前运行预览只移动一个包裹，用于验证拓扑和选路。容量参与“该边是否可选”的判断，但多包裹队列、汇流公平性、占用释放和防碰撞仍需独立调度器。
- 场景使用 `revision` 乐观并发，冲突时重新加载服务器草稿后再编辑。
- 发布会重新检查模型 Ready 状态、许可证确认、Asset/Device 权限和 Manifest 安全约束。
- 发布成功后生成版本 Hash、绑定快照和路线快照。
- “版本与回滚”只切换运行版本指针，当前草稿不被旧版本覆盖。
- 打开“实时”后，工作台每两秒批量读取一次当前发布版本需要的数据。后续可在不改变绑定合同的前提下替换为 SignalR 增量更新。

## 4. API

| 方法 | 地址 | 说明 |
| --- | --- | --- |
| `GET/POST` | `/api/digital-twin/scenes` | 查询或创建场景。 |
| `GET/PUT/DELETE` | `/api/digital-twin/scenes/{id}` | 场景详情、元数据更新或软删除。 |
| `PUT` | `/api/digital-twin/scenes/{id}/draft` | 按 revision 保存草稿并同步草稿绑定/路线。 |
| `POST` | `/api/digital-twin/scenes/{id}/validate` | 校验 Manifest 和数据库引用。 |
| `POST` | `/api/digital-twin/scenes/{id}/publish` | 发布不可变版本和绑定/路线快照。 |
| `GET` | `/api/digital-twin/scenes/{id}/versions` | 查询版本历史。 |
| `POST` | `/api/digital-twin/scenes/{id}/rollback/{version}` | 切换发布版本指针。 |
| `GET` | `/api/digital-twin/scenes/{id}/runtime-manifest` | 获取带 ETag 的当前运行 Manifest。 |
| `GET/POST` | `/api/digital-twin/model-resources`、`.../upload` | 查询或上传模型资源。 |
| `GET` | `/api/digital-twin/model-resources/{id}/content` | 鉴权下载 GLB，支持 Range。 |
| `GET/POST` | `/api/digital-twin/model-generation/jobs` | 查询或创建持久化 img2threejs 任务。 |
| `GET` | `/api/digital-twin/model-generation/capabilities` | 查询 Worker 是否已配置。 |
| `POST` | `/api/digital-twin/model-generation/jobs/{id}/cancel`、`.../retry` | 取消或重新排队任务。 |
| `POST` | `/api/digital-twin/runtime/snapshot` | 按发布版本批量读取全部绑定的最新值。 |

普通用户可查看、编辑草稿和读取运行数据；模型上传、许可证变更、发布、回滚和删除要求客户管理员、租户管理员或系统管理员角色。所有查询同时应用 TenantId 和 CustomerId 隔离。

## 5. 文件与存储

模型文件通过 IoTSharp 的 `IBlobStorage` 写入 `digital-twin/{tenantId}/{customerId}/models/{resourceId}/runtime/model.glb`；生成参考图写入 `digital-twin/{tenantId}/{customerId}/generation/{jobId}/reference.{ext}`。实际磁盘或对象存储位置由现有 Blob Storage 配置决定；数据库只保存受控相对路径，下载必须经过 IoTSharp 鉴权接口，不允许浏览器直接访问物理文件。

场景合同版本是 `iotsharp-twin-scene/v1`，JSON Schema 位于 `IoTSharp.Contracts/digital-twin-scene.v1.schema.json`。前端和后端都禁止场景脚本、函数、外部 URL、data URL 和非有限数值。`editorExtension` 只是可丢弃的编辑器扩展：模型二进制始终通过顶层 `resourceId` 和鉴权下载接口恢复，运行端可以完全忽略该扩展。

`threejs-editor` 上游交互基线固定在 `d7e2ddf6cc1fa8c626356a3606167abff68daaed`，公开内核源码固定在 `98197115af2318ed20f334873517018509b8e079`。源码许可证保存在 `ClientApp/src/digital-twin/vendor/three-editor-cores/LICENSE`，Draco 解码器位于 `ClientApp/public/iotsharp-three-editor/draco`。

## 6. 验收清单

- 至少创建一个根 Asset，并把一个 Device 及其遥测/属性关系加入该 Asset。
- 上传一个已确认授权的 GLB，资源状态为 Ready，节点和模型统计可见。
- 提交一个参考图生成任务；数据库存在 `TwinModelGenerationJobs` 记录。配置测试 Worker 后，任务达到 Succeeded，且 `ResultModelResourceId` 指向 Ready 模型。
- 创建场景、在专业编辑器中放置/变换模型、绘制路线并保存；数据库草稿包含 threejs-editor 快照，并存在可查询的资源绑定、数据绑定和路线记录。
- 新增一个分流器和一个汇流器，连接主/支包装线；给支线设置容量 3，并配置 `sku == B` 走支线。分别用 SKU A/B 预览，确认绿色路径不同；把支线占用设为 3 或封锁信号设为真，确认路径回退到主线。保存后检查 `TwinRoutes.GraphPayload` 包含 `points`、`edges.capacity`、`routingMode`、`decisionRules` 和 `junctionDecisions`。
- 给一个场景对象创建“分流/占用信号” Device 绑定；保存后检查 `TwinObjectBindings.TransformKind=routeEvent`，并确认路线中的 `blockedBindingId`、`occupancyBindingId` 或规则 `bindingId` 与其一致。
- 发布 v1；数据库存在带同一 `SceneVersionId` 的绑定与路线快照。
- 设备上报新值后开启实时模式，对象在两个轮询周期内按绑定变化。
- 修改并发布 v2，再回滚 v1；运行态使用 v1 的 Manifest 和绑定，草稿仍保持当前内容。
- 未授权模型、跨租户 Asset/Device、外部 URL、脚本、缺失模型和重复 objectId 均无法保存或发布。

## 7. 后续生产深化

MVP 之后优先完成 threejs-editor 高级组件的安全白名单、模型异步处理与缩略图、SignalR 增量推送、独立细粒度权限码、多包裹/多车辆占用区、队列、汇流公平性、互斥锁与防碰撞调度、命令下发二次确认，以及大场景 LOD/分片/实例化性能门槛。当前已完成单包裹的自动分流、容量避让和实时封锁绕行；不能把它等同于 PLC 控制或多对象调度。现有 API、路线 `GraphPayload` 和版本化绑定表可以继续复用。
