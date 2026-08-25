---
title: 数字孪生三维平台开发设计
---

# 数字孪生三维平台开发设计

## 1. 文档信息

| 项目 | 内容 |
| --- | --- |
| 文档状态 | Implemented MVP，作为后续 threejs-editor 深化和生产加固基线 |
| 适用仓库 | IoTSharp |
| 目标前端 | `ClientApp`，Vue 3 + Vite + Three.js |
| 编辑器基线 | `threejs-editor` 二次开发 |
| 核心原则 | 编辑能力复用，数字孪生领域模型、运行时、数据绑定和路线引擎由 IoTSharp 持有 |
| 首版场景 | 工厂、车间、产线、输送线、设备、物料、AGV 等工业可视化 |
| 文档日期 | 2026-08-24 |

本文给出 IoTSharp 数字孪生三维能力的完整开发方案。它既是技术选型结论，也是数据模型、接口、前端结构、模型资产管线、路线系统、实时数据绑定、测试与交付计划的实现依据。

### 1.1 2026-08-24 实现状态

本仓库已经完成可运行 MVP：场景草稿/发布/版本/回滚、GLB 模型资源、img2threejs 图片生成任务页与 Worker 合同、模型授权和 Hash、对象资源绑定、Device 数据绑定、路线图持久化、交叉口/分支编辑、包装线分流器与汇流器、输送段容量、物料/Device 自动选路、实时封锁绕行、发布版本绑定快照、批量运行数据快照、Three.js 确定性路线运行以及 IoTSharp 内置工作台。工作台已经接入固定版本的 `threejs-editor` 专业创作模式，支持对象/子节点选择、移动/旋转/缩放、撤销重做、场景树、相机、灯光、材质和后期处理；编辑快照与资源 ID 一起写入场景草稿。数据库迁移已覆盖 SQLite、PostgreSQL、SQL Server、MySQL、Oracle 和 SonnetDB。

仍按本文后续阶段继续深化的内容包括：上游高级组件库白名单化、缩略图与 Meshopt/KTX2 离线处理队列、SignalR 增量推送、复杂 AGV 路网调度、LOD/分片和大型场景性能基线。上述内容不改变当前场景合同和数据库边界。

## 2. 决策摘要

### 2.1 最终选型

采用以下组合，而不是选择一个第三方项目包办全部能力：

1. IoTSharp 继续作为平台控制面，负责租户、客户、Product、Asset、Device、权限、审计、模型资源、场景、版本、发布和实时数据。
2. IoTSharp `ClientApp` 内新增数字孪生模块，基于 `threejs-editor` 源码进行受控二次开发。
3. IoTSharp 自研 `TwinRuntime`、`RouteEditor`、`RouteEngine`、`BindingEngine` 和 `TwinDataSource`。
4. 运行时模型统一使用 glTF 2.0/GLB；厂家 CAD、Blender、合规模型库和 img2threejs 都只是模型来源。
5. img2threejs 只作为简单硬表面设备和占位模型的辅助生成工具，不作为运行时框架，也不作为精确工业模型的唯一来源。
6. 不引入 Meteor3DEditor 的 Node.js/MongoDB 后端，不采用 Astral3D 作为基础框架。

### 2.2 为什么选择 threejs-editor

`threejs-editor` 的场景树、对象变换、属性面板、组件机制、导入导出、撤销重做和 Three.js 组件生态适合作为编辑器起点。与完整自研编辑器相比，可以减少大量通用编辑功能工作；与 Meteor3DEditor 相比，不需要在 IoTSharp 之外再维护一套业务后端；与 Astral3D 相比，集成边界更轻，也不把首期项目带入 BIM/CAD 和附加商业授权复杂度。

`threejs-editor` 只负责创作体验。其内部场景 JSON、浏览器本地存储、全局对象和脚本机制不能成为 IoTSharp 的领域边界或生产存储格式。

### 2.3 两个最高优先级问题

首期工作的优先级不是继续比较编辑器，而是解决：

1. **模型生成和模型来源**：形成可持续的模型获取、转换、优化、检查、入库和版本管理流程。
2. **物体运动路线**：形成可编辑、可校验、可仿真、可由真实设备状态驱动的路线图和运行引擎。

## 3. 目标、范围和非目标

### 3.1 建设目标

- 用户可以在 IoTSharp 内创建与 Asset 关联的三维场景。
- 用户可以上传、管理、预览和复用 GLB 模型资源。
- 用户可以摆放模型、编辑层级、灯光、相机、材质和基础效果。
- 用户可以选择模型节点并绑定 Device 遥测、属性、告警、在线状态和命令反馈。
- 用户可以绘制输送线、轨道、AGV 路网和受约束轴路线。
- 物料、载具或部件可以在仿真数据与真实数据两种模式下运行。
- 场景支持草稿、校验、发布、版本、回滚和审计。
- 查看端和编辑端共享同一份 IoTSharp 场景合同，但加载不同的代码和权限。
- 大型场景具备分片、延迟加载、LOD、压缩、实例化和性能降级能力。

### 3.2 首期范围

- GLB 上传、检查、缩略图和元数据入库。
- 场景 CRUD、草稿保存、版本发布、运行时清单读取。
- 基础编辑器集成和 IoTSharp 存储替换。
- 设备状态、遥测、属性、告警到对象属性的单向绑定。
- 输送线类型路线编辑、分支、占用、暂停、恢复和仿真。
- 运行时查看、选择对象、状态高亮、告警定位和相机跳转。
- 租户/客户隔离、角色权限、审计和模型文件访问控制。

### 3.3 首期非目标

- 不实现完整 CAD/BIM 编辑器。
- 不在浏览器中直接编辑 STEP、SolidWorks、Revit、DWG 或 IFC 原始模型。
- 不承诺从单张图片生成尺寸精确、结构完整的工业设备模型。
- 不实现机器人离线编程、碰撞认证或安全 PLC 控制逻辑。
- 不让场景脚本绕过 IoTSharp 权限直接控制设备。
- 不把实时规则链改造成长时运行的三维工作流引擎。
- 不重写 IoTSharp 现有 Product、Asset、Device、遥测和告警体系。

## 4. 与 IoTSharp 现有领域的关系

数字孪生必须遵守 IoTSharp 的核心概念边界。

| IoTSharp 概念 | 数字孪生中的责任 |
| --- | --- |
| Product | 设备类别和能力模板；后续可关联默认可视模型和默认节点绑定模板，但不保存运行状态。 |
| Device | 真实运行实例；提供在线状态、遥测、属性、告警、事件、命令和反馈。 |
| Asset | 厂区、建筑、车间、产线、工位和设备系统等业务对象；数字孪生场景必须归属一个根 Asset。 |
| SemanticPoint | 为点位绑定提供稳定语义 ID、数据类型、单位和质量信息。 |
| RuleChain | 继续处理实时规则；可以产生数字孪生消费的状态或事件，但不保存场景动画生命周期。 |
| AuditLog | 记录场景发布、回滚、资源上传、绑定修改和控制动作。 |

模型文件不能命名为领域 `Asset`。本文统一使用 `TwinModelResource` 表示 GLB、贴图、缩略图和模型元数据，避免与 IoTSharp `Asset` 混淆。

### 4.1 场景归属规则

- 每个 `DigitalTwinScene` 必须有 `RootAssetId`。
- 一个 Asset 可以有多个场景，例如“运行总览”“维护视图”“培训视图”。
- 场景对象可以通过 `AssetId` 关联根 Asset 下的业务对象。
- 场景对象可以通过 `DeviceId` 绑定一个或多个运行设备。
- 删除 Asset 时不得直接物理删除已发布场景；应阻止删除或使场景进入 `Orphaned` 待处理状态。
- Product 可以在后续阶段关联默认模型模板，但不能替代实际 Asset 和 Device 绑定。

## 5. 总体架构

```text
模型来源
  厂家 CAD / Blender / 合规模型库 / img2threejs
                    │
                    ▼
          模型转换、优化、检查流水线
                    │ GLB + 元数据 + 缩略图
                    ▼
┌──────────────────── IoTSharp 后端 ────────────────────┐
│ TwinModelResource  DigitalTwinScene  SceneVersion     │
│ Binding / Route / Publish / Permission / Audit        │
│ REST API + TwinRealtimeHub + IBlobStorage             │
└─────────────────────────┬─────────────────────────────┘
                          │
          ┌───────────────┴────────────────┐
          ▼                                ▼
┌──── IoTSharp 三维编辑端 ────┐   ┌──── IoTSharp 三维运行端 ────┐
│ threejs-editor 适配层       │   │ TwinRuntime                 │
│ 场景编辑 / 路线编辑         │   │ AssetLoader / RouteEngine   │
│ 绑定配置 / 校验 / 发布      │   │ BindingEngine / DataSource  │
└─────────────────────────────┘   └─────────────────────────────┘
```

### 5.1 创作、发布和运行分离

数字孪生采用三阶段模型：

1. **创作态**：编辑器保存可继续编辑的草稿，允许辅助对象、网格、控制点和编辑器扩展数据存在。
2. **发布态**：后端校验引用、模型、绑定、路线和权限，生成不可变 `DigitalTwinSceneVersion`。
3. **运行态**：运行端只读取已发布的精简清单，不加载编辑器 UI、TransformControls、辅助线和任意脚本。

### 5.2 核心设计原则

- IoTSharp 场景合同是主合同，第三方编辑器 JSON 是适配数据。
- 场景 ID、对象 ID、路线 ID 和绑定 ID 必须稳定，不使用数组下标作为标识。
- 编辑器与运行端只允许一个 Three.js 实例。
- 实时数据与渲染帧解耦；数据更新不能直接创建无界动画或对象。
- 路线位置使用距离和拓扑表示，不使用帧序号表示。
- 控制动作必须经过 IoTSharp 授权 API、人工确认和审计。
- 上传文件、场景扩展和绑定表达式默认不可信。

## 6. 技术栈和依赖策略

### 6.1 当前基础与已落地版本

IoTSharp `ClientApp` 当前使用 Vue 3.4、Vite 5、TypeScript 5.4、Element Plus 和 Three.js 0.165。已固定 `z2586300277/threejs-editor` 的 `page` 提交 `d7e2ddf6cc1fa8c626356a3606167abff68daaed` 作为交互基线，并将 `z2586300277/three-editor-cores` 提交 `98197115af2318ed20f334873517018509b8e079` 的 Apache-2.0 源码受控放入 `ClientApp/src/digital-twin/vendor/three-editor-cores`。该源码直接引用 IoTSharp 的 Three.js 0.165，因此编辑端与运行端只存在一个 Three.js 实例。

上游最新版页面依赖 `three-edit-cores@0.0.19`，但该 npm 包未随包发布许可证和已声明的类型文件。IoTSharp 没有直接引入该许可不明产物，而是使用作者公开仓库中的 Apache-2.0 源码，并在独立适配层实现 IoTSharp 存储、资源 ID 和选择事件。

### 6.2 目标依赖策略

1. 当前保持 Vue/Three.js 主版本不变，先用公开源码完成受控接入，避免为编辑器升级整个平台。
2. 使用 `package-lock.json` 固定实际解析版本；每次上游更新必须记录提交哈希并复核许可证。
3. Vite 对 `three` 使用 `resolve.dedupe`，编辑器源码、运行时和加载器共享同一个包实例。
4. Draco 解码器位于 `ClientApp/public/iotsharp-three-editor/draco`；KTX2、Meshopt 在模型处理阶段继续补充。
5. 上游源码只放在 vendor 目录，IoTSharp 定制集中在 `ThreeEditorCoreHost`，便于更新时做差异审查。
6. 不直接引入许可或源码来源不明的 `three-edit-cores` 发布包。
7. 数字孪生路由采用懒加载；普通业务页面不会加载编辑器代码。

### 6.3 许可证要求

- 保存 `threejs-editor`、Three.js、解码器、后处理库及模型来源的许可证和 NOTICE。
- 对 `threejs-editor` 主仓库许可证与其文档、核心包声明不一致的部分建立审计记录。
- 每个 `TwinModelResource` 必须记录 `LicenseType`、`LicenseTextUrl`、`SourceUrl`、`Author` 和 `CommercialUseAllowed`。
- 未明确授权的模型只能进入个人草稿或隔离区，不能发布到生产场景。

## 7. 后端领域模型

### 7.1 DigitalTwinScene

表示一个可编辑、可发布的数字孪生场景。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| Id | Guid | 场景 ID。 |
| SceneKey | string | 租户内稳定键。 |
| Name | string | 场景名称。 |
| Description | string | 场景说明。 |
| RootAssetId | Guid | 根业务 Asset。 |
| Status | enum | Draft、Published、Archived、Orphaned。 |
| DraftPayload | JSON/text | 当前编辑草稿，不能直接作为运行时载荷。 |
| PublishedVersionId | Guid? | 当前正式版本。 |
| ThumbnailResourceId | Guid? | 场景封面。 |
| Revision | long | 乐观并发版本。 |
| TenantId/CustomerId | Guid | 隔离范围。 |
| CreatedAt/UpdatedAt | DateTime | UTC 时间。 |
| CreatedBy/UpdatedBy | string | 操作人。 |
| Deleted | bool | 软删除。 |

约束和索引：

- 唯一索引：`TenantId + CustomerId + SceneKey + Deleted`。
- 普通索引：`RootAssetId + Status`、`PublishedVersionId`。
- 所有读写必须同时校验 TenantId 和 CustomerId。
- `Revision` 用于防止多个编辑会话静默覆盖。

### 7.2 DigitalTwinSceneVersion

表示发布后的不可变场景版本。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| Id | Guid | 版本 ID。 |
| SceneId | Guid | 所属场景。 |
| Version | int | 场景内递增版本。 |
| SchemaVersion | string | 例如 `iotsharp-twin-scene/v1`。 |
| Manifest | JSON/text | 规范化场景清单。 |
| ManifestHash | string | SHA-256，用于完整性和缓存。 |
| ValidationReport | JSON/text | 发布校验结果。 |
| ChangeSummary | string | 发布说明。 |
| CreatedAt/CreatedBy | - | 发布时间和发布人。 |
| TenantId/CustomerId | Guid | 隔离范围。 |

发布后禁止更新 `Manifest`。回滚不是修改旧版本，而是把旧版本重新设为当前发布版本，并记录审计。

### 7.3 TwinModelResource

表示可复用的模型资源及其派生文件。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| Id | Guid | 模型资源 ID。 |
| ResourceKey | string | 租户内稳定键。 |
| Name | string | 模型名称。 |
| SourceType | enum | ManufacturerCad、Blender、ModelLibrary、Img2ThreeJs、Upload、Generated。 |
| RuntimeFormat | string | 首期固定为 `model/gltf-binary`。 |
| OriginalFileName | string | 原文件名，仅用于展示和审计。 |
| StoragePath | string | 服务器内部路径，不直接暴露给场景。 |
| FileSize | long | 字节数。 |
| ContentHash | string | SHA-256，用于去重和完整性检查。 |
| NodeIndex | JSON/text | 节点路径、名称、包围盒、活动节点和锚点。 |
| ModelMetadata | JSON/text | 单位、轴、包围盒、三角形、材质、贴图、动画等。 |
| ProcessingStatus | enum | Uploaded、Scanning、Processing、Ready、Rejected、Failed。 |
| LicenseMetadata | JSON/text | 来源和授权信息。 |
| ProductId | Guid? | 可选的 Product 默认可视模型关联。 |
| PreviewResourcePath | string | 缩略图或 turntable 预览。 |
| TenantId/CustomerId | Guid | 隔离范围。 |
| CreatedAt/UpdatedAt | DateTime | UTC 时间。 |
| Deleted | bool | 软删除。 |

文件访问通过资源 ID 和授权下载接口完成。场景清单不得保存可跨租户猜测的物理文件路径。

### 7.4 TwinObjectBinding

表示场景对象与 IoTSharp 数据源之间的绑定。首期可以嵌入场景草稿并在发布时规范化；为了查询、审计和增量更新，建议同时建立独立表。

主要字段：

- `Id`、`SceneId`、`ObjectId`。
- `AssetId`、`DeviceId`、`SemanticId`。
- `SourceKind`：Telemetry、Attribute、Alarm、Connectivity、CommandFeedback、Constant、Simulation。
- `SourceKey`：遥测或属性键。
- `TargetKind`：Visible、Color、Emissive、Opacity、Text、Number、Position、Rotation、Scale、Animation、RouteProgress、CustomProperty。
- `TargetPath`：受控目标属性路径。
- `TransformKind` 和 `TransformConfig`：白名单转换器及配置。
- `Priority`、`StaleAfterMs`、`Enabled`。
- Tenant/Customer、审计字段和软删除字段。

### 7.5 TwinRoute

表示一张可独立校验和复用的运动路线图。

主要字段：

- `Id`、`SceneId`、`RouteKey`、`Name`。
- `RouteType`：Conveyor、Rail、AgvGraph、Axis、CameraTour。
- `GraphPayload`：当前 v1 保存 `points`、`edges`、节点业务类型、方向、优先级、容量、占用/封锁绑定、默认出口、`routingMode` 和 `decisionRules`；后续在同一版本化 JSON 中扩展多对象队列、占用区锁和触发器。
- `Revision`、`Enabled`。
- Tenant/Customer、审计字段和软删除字段。

### 7.6 TwinPublishArtifact

可选模型，用于记录某次发布生成的运行时清单、资源依赖表、资源总大小、预加载分组和验证报告。首期如果 `DigitalTwinSceneVersion` 已覆盖这些字段，可以后续再拆分。

## 8. 场景清单合同 v1

### 8.1 设计要求

- 独立于 `threejs-editor` 私有 JSON。
- JSON 字段使用 camelCase。
- 所有标识均为稳定字符串或 Guid，不使用对象名称作为唯一键。
- 坐标单位固定为米，默认 Y-up、右手坐标系。
- 不允许保存可执行 JavaScript。
- 编辑器扩展数据放在 `editorExtension`，运行端可以完全忽略。
- 所有资源通过 `resourceId` 引用，不直接信任外部 URL。

### 8.2 示例

```json
{
  "schemaVersion": "iotsharp-twin-scene/v1",
  "sceneId": "d5fa423e-08cc-4bdc-b91e-e47c360ad2bd",
  "version": 3,
  "rootAssetId": "d03d421c-3240-4cd6-a0e8-e411bc37ac53",
  "world": {
    "unit": "meter",
    "upAxis": "Y",
    "origin": [0, 0, 0],
    "background": "#111827",
    "environmentResourceId": null
  },
  "resources": [
    {
      "resourceId": "95a6610f-6d31-4d35-aeaa-89033b6e2fb1",
      "kind": "model",
      "lod": [
        { "level": 0, "distance": 0 },
        { "level": 1, "distance": 40 },
        { "level": 2, "distance": 100 }
      ]
    }
  ],
  "objects": [
    {
      "objectId": "motor-01-instance",
      "name": "一号输送机电机",
      "resourceId": "95a6610f-6d31-4d35-aeaa-89033b6e2fb1",
      "assetId": "623bbde6-4fae-4bc6-b914-f2eeb5e50783",
      "transform": {
        "position": [12.5, 0, 3.2],
        "rotation": [0, 1.5707963, 0],
        "scale": [1, 1, 1]
      },
      "tags": ["equipment", "motor"],
      "selectable": true
    }
  ],
  "bindings": [
    {
      "bindingId": "motor-01-running",
      "objectId": "motor-01-instance",
      "nodePath": "Root/Fan",
      "source": {
        "kind": "telemetry",
        "deviceId": "7bccd168-b8db-4ba9-8550-46930546fc12",
        "semanticId": "motor.running",
        "key": "running"
      },
      "target": {
        "kind": "animation",
        "property": "rotation.y"
      },
      "transform": {
        "kind": "booleanAnimation",
        "trueValue": { "speed": 4.0 },
        "falseValue": { "speed": 0.0 }
      },
      "staleAfterMs": 10000
    }
  ],
  "routes": [
    {
      "routeId": "conveyor-main",
      "type": "conveyor",
      "defaultSpeed": 0.6,
      "nodes": [],
      "segments": [],
      "occupancyZones": []
    }
  ],
  "runtime": {
    "initialCamera": "overview-camera",
    "maxPixelRatio": 2,
    "enableShadows": true,
    "dataMode": "live"
  },
  "editorExtension": {
    "source": "threejs-editor",
    "payloadVersion": 2,
    "threeEditor": {
      "sceneParams": {},
      "modelParams": [],
      "upstream": {
        "repository": "z2586300277/threejs-editor",
        "editorCommit": "d7e2ddf6cc1fa8c626356a3606167abff68daaed",
        "coreRepository": "z2586300277/three-editor-cores",
        "coreCommit": "98197115af2318ed20f334873517018509b8e079",
        "license": "Apache-2.0"
      }
    }
  }
}
```

### 8.3 合同校验

在 `IoTSharp.Contracts` 增加 `digital-twin-scene.v1.schema.json`、DTO 和 validator。发布前至少校验：

- schemaVersion 可识别。
- RootAsset 在当前租户/客户范围内且未删除。
- resourceId 全部 Ready 且允许发布。
- objectId、bindingId、routeId 全局唯一。
- Object 引用的 Asset、Device 和 SemanticPoint 有效。
- nodePath 存在于模型 `NodeIndex`，或明确标记为可选路径。
- 路线拓扑无悬空引用、非法自环和不可达必选出口。
- 所有数值有限，不接受 NaN、Infinity 或超出安全范围的变换。
- TransformKind、TargetKind 和扩展组件在允许清单内。
- 运行清单不含函数、脚本、data URL 或未授权外部 URL。

## 9. 模型来源与生成策略

### 9.1 来源优先级

| 优先级 | 来源 | 适用场景 | 处理要求 |
| --- | --- | --- | --- |
| 1 | 厂家 CAD/设计模型 | 核心设备、尺寸和结构要求高 | 减面、拆分、材质重做、坐标修正、转 GLB。 |
| 2 | Blender 人工低模 | 厂房、产线、定制设备 | 按数字孪生视距和交互需求建模。 |
| 3 | 有商业授权的模型库 | 通用设备、车辆、环境物件 | 核实作者、授权、再分发和修改权限。 |
| 4 | img2threejs | 简单硬表面设备、占位物、快速原型 | 多视图和尺寸辅助，人工复核，必要时转 GLB。 |
| 5 | 程序化 Three.js 几何 | 管道、区域、标记、简单容器 | 保留参数化能力，避免复杂高面数建模。 |

### 9.2 img2threejs 使用边界

img2threejs 的开源核心更接近“参考图片到程序化 Three.js 组件树”，主要输出规范 JSON 和创建 `THREE.Group` 的 TypeScript。它适合零件结构清晰的电机、箱体、传感器、滚筒、托盘和简单车辆。

以下情况不能直接依赖 img2threejs：

- 需要工程尺寸、法兰位置和碰撞边界精确。
- 单图无法看到背面、底面、内部或遮挡结构。
- 复杂曲面、软体、线束和高精度机床。
- 需要与厂家维修手册或 CAD 节点一一对应。

推荐流程是：多角度照片和尺寸输入 → img2threejs 草模 → 人工检查部件、比例和 pivot → 转换为 GLB 或保留受控程序化组件 → 进入统一资源检查流程。

### 9.3 模型运行标准

所有发布模型应满足：

- 格式：glTF 2.0 二进制 GLB。
- 单位：1 Three.js world unit = 1 米。
- 坐标：Y-up、右手坐标系。
- 原点：默认位于设备安装底面中心；移动物料位于几何中心或明确锚点。
- 朝向：默认正向为 +Z；不符合时在元数据中明确 `forwardAxis`。
- 节点：使用稳定、可读、区分大小写的英文技术名，例如 `Motor_01`、`Belt_Main`、`Sensor_Infeed`。
- 活动部件：单独 Mesh/Group，并把 pivot 放到真实旋转或平移轴。
- 材质：优先标准 PBR 材质；避免依赖无法导出的自定义着色器。
- 贴图：优先 1K/2K；4K 必须有实际视觉收益并经过批准。
- 动画：可复用机械循环可以保存为 glTF animation，但 PLC 状态和路线不烘焙进模型。
- 碰撞：使用简化代理体，不直接把渲染网格作为复杂碰撞体。

### 9.4 初始性能预算

以下是桌面工业看板的起始门槛，应由真实场景基准测试调整：

| 指标 | 建议值 |
| --- | --- |
| 首屏资源下载 | 推荐不超过 30 MB |
| 单个普通设备 GLB | 推荐不超过 20 MB |
| 单个大型产线分片 | 超过 50 MB 必须拆分或审批 |
| 首屏可见三角形 | 推荐不超过 200 万 |
| 首屏 draw calls | 推荐不超过 500 |
| 普通设备 LOD0 | 推荐不超过 15 万三角形 |
| 常规贴图 | 2K 以内 |
| 目标帧率 | 1080p 桌面 45 FPS 以上，目标 60 FPS |
| 首次可交互时间 | 企业内网目标 5 秒以内，超限必须渐进加载 |

大型厂区必须按建筑、楼层、产线或空间区块切片，并使用视锥裁剪、距离加载和 LOD，不能依赖一个超大 GLB。

## 10. 模型资产处理流水线

### 10.1 状态流程

```text
Uploaded
   │
   ▼
Scanning ──失败──> Rejected
   │
   ▼
Processing ─失败──> Failed
   │
   ▼
Ready ──新文件──> 产生新资源版本，不覆盖旧发布文件
```

### 10.2 处理步骤

1. 上传前校验扩展名、声明 MIME、文件头、大小和租户配额。
2. 上传到租户隔离的临时路径，不立即允许场景引用。
3. 计算 SHA-256，执行恶意文件扫描和压缩包炸弹检查。
4. 转换源格式为 GLB；源文件和运行文件分开保存。
5. 检查 glTF 合法性、外部 URI、丢失贴图和不支持扩展。
6. 统一单位、坐标轴、原点和节点命名。
7. 统计顶点、三角形、材质、贴图、动画、骨骼、draw call 估计和包围盒。
8. 根据策略应用 Meshopt/Draco、KTX2、贴图缩放和 LOD。
9. 生成节点索引、活动节点、锚点、碰撞代理和缩略图。
10. 记录来源和许可证，人工确认后进入 Ready。

### 10.3 存储设计

现有 `IBlobStorage` 可以作为底层存储抽象，但数字孪生必须新增专用服务，不能直接把通用 Blob 列表、任意路径下载和删除接口暴露给模型管理页面。

推荐内部路径：

```text
digital-twin/{tenantId}/{customerId}/models/{resourceId}/source/{file}
digital-twin/{tenantId}/{customerId}/models/{resourceId}/runtime/model.glb
digital-twin/{tenantId}/{customerId}/models/{resourceId}/lod/model-lod1.glb
digital-twin/{tenantId}/{customerId}/models/{resourceId}/preview/thumbnail.webp
digital-twin/{tenantId}/{customerId}/models/{resourceId}/metadata/model.json
```

所有下载接口根据资源 ID 查数据库并校验权限，然后再解析内部路径。客户端不能提交或拼接服务器物理路径。

## 11. 运动路线领域模型

### 11.1 路线类型

| 类型 | 适用对象 | 核心模型 |
| --- | --- | --- |
| Conveyor | 物料、托盘、箱体 | 有向图、曲线段、占用区、传感器、分支。 |
| Rail | 行车、堆垛机、轨道车 | 一维或多轴受约束线段。 |
| AgvGraph | AGV、叉车、移动机器人 | 路网、路口、单/双向边、代价和 A*。 |
| Axis | 升降台、推杆、门、滑台 | 局部坐标轴、最小/最大位置。 |
| CameraTour | 巡检视角 | 相机位置、目标点、停留和缓动。 |

机械臂不使用普通路线引擎。首期机械臂只播放预定义 glTF 动画或根据遥测驱动各关节角度；机器人运动学和离线编程另立项目。

### 11.2 路线图结构

```json
{
  "routeId": "conveyor-main",
  "type": "conveyor",
  "defaultSpeed": 0.6,
  "loop": false,
  "startPointId": "infeed",
  "points": [
    {
      "pointId": "infeed",
      "name": "入口",
      "position": [0, 0.8, 0],
      "kind": "station"
    },
    {
      "pointId": "sorter",
      "name": "包装分流器",
      "position": [8, 0.8, 0],
      "kind": "diverter"
    },
    {
      "pointId": "out-a",
      "name": "出口 A",
      "position": [12, 0.8, 3],
      "kind": "station"
    },
    {
      "pointId": "out-b",
      "name": "出口 B",
      "position": [12, 0.8, -3],
      "kind": "station"
    }
  ],
  "edges": [
    {
      "edgeId": "s1",
      "fromPointId": "infeed",
      "toPointId": "sorter",
      "bidirectional": false,
      "enabled": true,
      "blocked": false,
      "priority": 0,
      "capacity": 2
    },
    {
      "edgeId": "s2a",
      "fromPointId": "sorter",
      "toPointId": "out-a",
      "bidirectional": false,
      "enabled": true,
      "blocked": false,
      "priority": 10,
      "capacity": 3
    },
    {
      "edgeId": "s2b",
      "fromPointId": "sorter",
      "toPointId": "out-b",
      "bidirectional": false,
      "enabled": true,
      "blocked": false,
      "priority": 0,
      "capacity": 3,
      "blockedBindingId": "branch-b-blocked"
    }
  ],
  "junctionDecisions": {
    "sorter": "s2a"
  },
  "routingMode": "automatic",
  "decisionRules": [{
    "ruleId": "sku-b",
    "name": "SKU-B 进入 B 线",
    "junctionPointId": "sorter",
    "edgeId": "s2b",
    "source": "payload",
    "payloadKey": "sku",
    "operator": "equals",
    "matchValue": "B",
    "priority": 100,
    "enabled": true
  }]
}
```

当前 v1 运行合同使用 `points/edges`。节点类型为 `waypoint/junction/station/diverter/merger/buffer/processStation/sensor`；普通交叉口、分流器和汇流器至少连接三条启用边，分流器至少两条启用出边，汇流器至少两条启用入边。`junctionDecisions` 是默认出口，没有更高优先级规则命中时再使用；最后按边 `priority` 和稳定 ID 确定性选择。旧版只有顺序 `points` 的路线在加载时自动生成边，循环路线同时生成末点回到起点的兼容边。

包装线复用同一路线图，不另建“叉路口表”。边上的 `capacity` 定义预览容量，`occupancyBindingId` 和 `blockedBindingId` 引用已入库的 Device 数据绑定，`conveyorObjectId` 可关联具体输送机对象。`blocked=true`、实时封锁为真或占用值达到容量时，该边不可选，运行引擎重新解析可用路径。

`routingMode=automatic` 时，`decisionRules` 按优先级匹配。规则来源可以是包裹业务载荷（如 `sku`、`weight`，支持点号访问嵌套属性），也可以是 `routeEvent` Device 绑定；支持等于、不等于、大小比较、包含、真/假操作符。规则、节点、边和所有稳定绑定引用随 `TwinRoutes.GraphPayload` 入库并随场景版本复制。

当前容量语义用于单包裹路径可用性判断；多包裹/多 AGV 的实际占用增减、队列、汇流公平性、互斥锁和防碰撞仍属于后续调度层，不能宣称已经完成生产节拍仿真或 PLC 控制。

### 11.3 路线编辑器功能

`RouteEditor` 作为 threejs-editor 的 IoTSharp 插件实现：

- 新建路线和选择路线类型。
- 在地面、模型表面或工作平面上添加控制点。
- 支持直线、圆弧、Catmull-Rom 和后续 Bezier 曲线。
- 显示方向箭头、长度、坡度和速度限制。
- 控制点移动、插入、删除、吸附、复制和对齐。
- 定义入口、出口、分支、合流、停止点和传感器点。
- 定义占用区、容量和资源互斥关系。
- 选择分支绑定和传感器绑定。
- 单对象选路预览、暂停和倍速；批量物料、队列与时间轴属于后续调度扩展。
- 保存前做拓扑、几何和绑定校验。

路线辅助对象只存在于创作态。发布时转换成简洁路线图，运行端不加载 TransformControls 和编辑控制点 Mesh。

### 11.4 路线几何计算

- 位置参数使用行进距离 `distanceMeters`，而不是 0 到 1 的帧进度作为主状态。
- 每个 segment 预计算弧长表，使用弧长映射获得匀速运动。
- 位置由 `curve.getPointAt(u)` 计算，方向由切线 `curve.getTangentAt(u)` 计算。
- 对象朝向支持 `tangent`、`fixed`、`lookAt` 和 `none`。
- 车辆在坡面上需要独立的 up vector 或地面法线，避免转弯时翻滚。
- 曲线变更后必须重新计算长度、包围盒、采样表和占用区映射。

### 11.5 运行状态机

每个运动实例使用明确状态：

```text
Created -> Waiting -> Running -> Completed
                    │   │
                    │   ├-> Blocked -> Running
                    │   ├-> Paused  -> Running
                    │   └-> Faulted -> Waiting/Removed
                    └-> Removed
```

实例状态至少包含：

- `instanceId`、`objectTemplateId`。
- `routeId`、`segmentId`、`distanceMeters`。
- `speed`、`targetSpeed`、`acceleration`。
- `state`、`lastEventAt`、`sourceTimestamp`。
- `payload`：物料编码、批次、目的地等非敏感业务信息。

### 11.6 确定性运行循环

- RouteEngine 使用固定步长更新逻辑状态，例如 20 或 30 Hz。
- 渲染使用 `requestAnimationFrame` 对前后逻辑状态插值。
- 浏览器标签页失焦或卡顿后，不按累积大 delta 一次跳过多个传感器点。
- 真实模式下以 PLC/IoTSharp 事件为准，客户端预测只用于平滑显示。
- 收到传感器事件时对实例进行位置校正，避免长期漂移。
- 服务端时间戳和质量标识必须保留；过期数据进入 stale 状态。

### 11.7 分支、占用和防碰撞

- 分支选择由受控绑定或仿真策略返回下一个 segmentId。
- 进入占用区前申请容量，未获得容量时进入 Blocked。
- 同一段可配置最小跟车距离和最大实例数。
- 合流点按 FIFO、优先级或外部信号决定放行顺序。
- 首期防碰撞是逻辑占用，不是精确物理碰撞模拟。
- Cannon 等物理引擎只用于局部展示效果，不作为输送业务状态的真值来源。

## 12. 实时数据绑定

### 12.1 支持的数据源

- Device 遥测最新值。
- Device 属性最新值。
- Device 在线/离线和心跳状态。
- Alarm 创建、确认、恢复和严重度。
- 命令执行反馈。
- Asset 聚合状态。
- 仿真数据源。
- 常量和场景参数。

Product 只提供能力定义和默认绑定模板，不提供运行值。

### 12.2 支持的目标

- 对象显示/隐藏。
- 材质颜色、自发光、透明度和闪烁状态。
- 标签文本、数值和单位。
- 局部 position、rotation、scale。
- glTF 动画播放、速度和片段选择。
- 路线实例创建、暂停、分支、进度校正和完成。
- 相机聚焦、告警定位和面板数据。

### 12.3 转换器白名单

场景中不保存 JavaScript 表达式。首期提供以下转换器：

- `identity`
- `booleanVisibility`
- `booleanColor`
- `rangeColor`
- `numberScale`
- `numberRotation`
- `enumMap`
- `formatText`
- `alarmSeverityStyle`
- `booleanAnimation`
- `routeProgress`
- `routeEvent`

每个转换器有固定 JSON schema。需要新增逻辑时通过代码评审增加转换器类型，不能让用户在场景中提交任意函数。

### 12.4 更新链路

```text
MQTT/HTTP/CoAP/Gateway
        │
        ▼
IoTSharp 遥测、属性、告警和事件处理
        │
        ├── 持久化最新值/历史值
        │
        └── TwinRealtimeHub 场景订阅组
                    │
                    ▼
             TwinDataSource
                    │ 合并、去重、时间戳和质量
                    ▼
             BindingEngine
                    │ 白名单转换
                    ▼
              TwinRuntime
```

### 12.5 实时传输阶段

当前前端已有遥测 REST 接口，首期可以先实现批量最新值接口和定时刷新，确保功能闭环；随后增加 `TwinRealtimeHub`：

1. 客户端打开场景后提交 sceneId 和已发布 version。
2. 服务端解析该版本需要的 Device/key 集合，并再次执行租户和权限检查。
3. 连接加入 `tenant:{tenantId}:scene:{sceneId}` 组。
4. 服务端只推送场景所需键，按 50 至 200 ms 窗口合并高频更新。
5. 客户端按 `sourceTimestamp` 丢弃乱序旧值。
6. Hub 断线时切换到指数退避重连，并用批量快照补齐状态。

推荐消息合同：

```json
{
  "sceneId": "d5fa423e-08cc-4bdc-b91e-e47c360ad2bd",
  "serverTimestamp": "2026-08-24T08:30:00Z",
  "updates": [
    {
      "deviceId": "7bccd168-b8db-4ba9-8550-46930546fc12",
      "kind": "telemetry",
      "key": "running",
      "value": true,
      "sourceTimestamp": "2026-08-24T08:29:59.950Z",
      "quality": "good"
    }
  ]
}
```

### 12.6 数据质量与过期状态

- 每个绑定必须有 `staleAfterMs` 或使用系统默认值。
- `quality = bad` 时不能继续显示为正常运行状态。
- 超时后应用统一 stale 样式，例如灰色、斜纹或状态徽标，不应静默保持最后的绿色状态。
- 数据断线不等于设备停止；两种状态必须区分。
- 客户端本地时间不能覆盖设备或服务器时间。

## 13. 设备控制安全边界

数字孪生查看和动画默认只读。需要从三维对象发起 RPC/命令时，必须经过：

1. 对象节点绑定到明确的 Device 和命令定义。
2. 用户拥有 `iot.twin.control` 和现有设备命令权限。
3. UI 展示目标设备、命令、参数和风险说明。
4. 高风险命令要求再次确认，后续可接审批策略。
5. 请求发送到 IoTSharp 现有命令服务，不从浏览器直连 PLC、Gateway 或 MQTT Broker。
6. 记录请求人、场景、对象、设备、参数摘要、结果和时间。
7. 场景脚本、模型 userData 和外部标签不能触发命令。

## 14. REST API 设计

API 路由采用资源化风格，控制器必须 `[Authorize]`，并在查询条件中显式包含 TenantId 和 CustomerId。

### 14.1 场景 API

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/digital-twin/scenes` | `iot.twin.view` | 按 Asset、状态和名称分页查询。 |
| POST | `/api/digital-twin/scenes` | `iot.twin.edit` | 创建场景草稿。 |
| GET | `/api/digital-twin/scenes/{id}` | `iot.twin.view` | 获取基本信息和草稿元数据。 |
| PUT | `/api/digital-twin/scenes/{id}` | `iot.twin.edit` | 更新名称、说明等。 |
| PUT | `/api/digital-twin/scenes/{id}/draft` | `iot.twin.edit` | 带 revision 保存草稿。 |
| POST | `/api/digital-twin/scenes/{id}/validate` | `iot.twin.edit` | 校验草稿并返回诊断。 |
| POST | `/api/digital-twin/scenes/{id}/publish` | `iot.twin.publish` | 发布不可变版本。 |
| GET | `/api/digital-twin/scenes/{id}/versions` | `iot.twin.view` | 查询历史版本。 |
| POST | `/api/digital-twin/scenes/{id}/rollback/{version}` | `iot.twin.publish` | 回滚当前发布指针。 |
| GET | `/api/digital-twin/scenes/{id}/runtime-manifest` | `iot.twin.view` | 获取精简运行清单和 ETag。 |
| DELETE | `/api/digital-twin/scenes/{id}` | `iot.twin.admin` | 软删除未被锁定的场景。 |

### 14.2 模型资源 API

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| GET | `/api/digital-twin/model-resources` | `iot.twin.view` | 查询模型库。 |
| POST | `/api/digital-twin/model-resources/uploads` | `iot.twin.model.upload` | 创建上传会话。 |
| PUT | `/api/digital-twin/model-resources/{id}/content` | `iot.twin.model.upload` | 上传或分片上传。 |
| POST | `/api/digital-twin/model-resources/{id}/complete` | `iot.twin.model.upload` | 完成上传并进入处理。 |
| GET | `/api/digital-twin/model-resources/{id}` | `iot.twin.view` | 获取元数据和处理状态。 |
| GET | `/api/digital-twin/model-resources/{id}/content` | `iot.twin.view` | 授权读取运行文件，支持 Range。 |
| GET | `/api/digital-twin/model-resources/{id}/nodes` | `iot.twin.view` | 获取节点索引。 |
| PUT | `/api/digital-twin/model-resources/{id}/license` | `iot.twin.admin` | 更新授权信息。 |
| POST | `/api/digital-twin/model-resources/{id}/approve` | `iot.twin.admin` | 人工批准进入 Ready。 |
| DELETE | `/api/digital-twin/model-resources/{id}` | `iot.twin.admin` | 未被发布版本引用时软删除。 |

### 14.3 运行时 API

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/digital-twin/runtime/snapshot` | `iot.twin.view` | 批量读取场景绑定的最新状态。 |
| POST | `/api/digital-twin/runtime/routes/{routeId}/simulate` | `iot.twin.edit` | 使用测试输入运行确定性仿真。 |
| POST | `/api/digital-twin/runtime/commands/preview` | `iot.twin.control` | 预览命令目标和参数。 |
| POST | `/api/digital-twin/runtime/commands/execute` | `iot.twin.control` | 确认后调用现有命令能力。 |

### 14.4 并发和缓存

- 草稿保存携带 `revision` 或 `If-Match`，冲突返回明确的版本冲突诊断。
- 运行清单返回 `ETag = ManifestHash`，未变化时支持 304。
- 模型文件使用内容 Hash 作为不可变缓存标识。
- 已发布版本和模型内容允许长缓存；草稿接口不允许共享缓存。
- 上传、发布和回滚必须具备幂等键，防止重复提交。

## 15. 权限、租户和审计

### 15.1 权限建议

| 权限 | 说明 |
| --- | --- |
| `iot.twin.view` | 查看已授权 Asset 的三维场景。 |
| `iot.twin.edit` | 创建和修改草稿、路线和绑定。 |
| `iot.twin.publish` | 发布、回滚场景版本。 |
| `iot.twin.model.upload` | 上传模型和查看处理报告。 |
| `iot.twin.admin` | 模型授权批准、场景归档和资源治理。 |
| `iot.twin.control` | 从运行场景发起受控设备命令。 |

角色只是权限集合，服务端不能只依赖前端隐藏按钮。

### 15.2 审计事件

- `TwinSceneCreate`
- `TwinSceneDraftUpdate`
- `TwinScenePublish`
- `TwinSceneRollback`
- `TwinSceneDelete`
- `TwinModelUpload`
- `TwinModelApprove`
- `TwinModelDelete`
- `TwinBindingUpdate`
- `TwinRouteUpdate`
- `TwinCommandPreview`
- `TwinCommandExecute`

审计只保存必要摘要和 Hash，不把大型 Manifest、模型二进制或敏感命令参数完整复制到日志。

## 16. 后端项目结构

推荐按 IoTSharp 现有分层添加：

```text
IoTSharp.Contracts/
├─ DigitalTwinDtos.cs
├─ DigitalTwinSceneValidator.cs
├─ digital-twin-scene.v1.schema.json
└─ samples/digital-twin/

IoTSharp.Data/
├─ DigitalTwinScene.cs
├─ DigitalTwinSceneVersion.cs
├─ TwinModelResource.cs
├─ TwinObjectBinding.cs
├─ TwinRoute.cs
└─ Configurations/DigitalTwin*.cs

IoTSharp/
├─ Controllers/DigitalTwinScenesController.cs
├─ Controllers/TwinModelResourcesController.cs
├─ Controllers/TwinRuntimeController.cs
├─ Services/DigitalTwin/
│  ├─ DigitalTwinSceneService.cs
│  ├─ TwinManifestCompiler.cs
│  ├─ TwinModelResourceService.cs
│  ├─ TwinRouteValidationService.cs
│  └─ TwinRuntimeSnapshotService.cs
└─ Hubs/TwinRealtimeHub.cs

IoTSharp.Test/
└─ DigitalTwin/
```

业务逻辑应放在 Service 和 Validator，不把清单编译、路线校验、资源解析全部写入 Controller。

## 17. 前端项目结构

```text
ClientApp/src/
├─ api/digitalTwin/
│  ├─ scenes.ts
│  ├─ models.ts
│  └─ runtime.ts
├─ views/iot/digital-twin/
│  ├─ scene-list.vue
│  ├─ model-library.vue
│  ├─ editor/index.vue
│  └─ viewer/index.vue
├─ components/digital-twin/
│  ├─ editor/
│  ├─ route-editor/
│  ├─ property-panel/
│  ├─ binding-panel/
│  └─ model-preview/
├─ digital-twin/
│  ├─ contracts/
│  ├─ editor-adapter/
│  ├─ runtime/
│  ├─ routes/
│  ├─ bindings/
│  ├─ loaders/
│  ├─ materials/
│  └─ diagnostics/
└─ stores/digitalTwin.ts
```

### 17.1 运行时核心接口

```ts
export interface TwinRuntime {
  load(manifest: TwinSceneManifest): Promise<void>;
  applyUpdates(updates: TwinDataUpdate[]): void;
  focusObject(objectId: string): void;
  createRouteInstance(command: CreateRouteInstance): void;
  dispose(): Promise<void>;
}

export interface TwinDataSource {
  connect(sceneId: string, version: number): Promise<void>;
  snapshot(): Promise<TwinDataUpdate[]>;
  subscribe(handler: (updates: TwinDataUpdate[]) => void): () => void;
  disconnect(): Promise<void>;
}

export interface TwinRouteEngine {
  load(routes: TwinRouteDefinition[]): void;
  updateFixed(deltaSeconds: number): void;
  render(alpha: number): void;
  handleEvent(event: TwinRouteEvent): void;
  dispose(): void;
}
```

### 17.2 资源释放要求

离开页面或切换场景时必须：

- 取消 `requestAnimationFrame`、固定步长 timer 和 ResizeObserver。
- 断开 Hub/数据订阅。
- 移除 DOM、事件监听器、Controls 和后处理 composer。
- 遍历释放 geometry、material、texture、render target 和 decoder worker。
- 清空场景对象索引、绑定缓存、路线实例和标签 DOM。
- 对共享模型资源采用引用计数，不能释放仍被其他实例使用的资源。
- 开发模式提供资源计数诊断，检测重复进入页面后的内存增长。

## 18. threejs-editor 二次开发清单

### 18.1 保留能力

- 场景树和对象选择。
- TransformControls 移动、旋转和缩放。
- 相机、灯光、环境和基础材质配置。
- GLB/FBX 导入能力中的 GLB 主路径。
- 撤销、重做、复制、删除和快捷键。
- 组件注册和属性面板扩展机制。
- 场景预览和截图。

### 18.2 替换或禁用

- 用 IoTSharp API 替换 localStorage 场景保存。
- 用 `TwinModelResource` API 替换 IndexedDB 模型存储。
- 移除或封装 `window.threeEditor` 等全局对象。
- 禁止场景保存和执行任意 JavaScript 回调。
- 禁止直接引用外部 HTTP 模型和贴图 URL。
- 用 IoTSharp 稳定对象 ID 替换只依赖 Three.js UUID 的业务引用。
- 统一 toast、对话框、权限和主题到 IoTSharp Element Plus 体系。
- 为编辑器生命周期补齐 timer、worker、监听器和 WebGL 资源清理。

### 18.3 新增插件

- `IoTSharpScenePersistencePlugin`
- `IoTSharpModelLibraryPlugin`
- `IoTSharpAssetBindingPlugin`
- `IoTSharpDeviceBindingPlugin`
- `IoTSharpRouteEditorPlugin`
- `IoTSharpSceneValidationPlugin`
- `IoTSharpPublishPlugin`
- `IoTSharpPerformanceBudgetPlugin`

### 18.4 适配边界

创建 `ThreeJsEditorAdapter`，所有上游编辑器 API 通过该适配器进入 IoTSharp。业务面板不得到处直接调用上游全局对象。这样后续升级或替换编辑器时，只需维护适配层和清单编译器。

## 19. 编辑器页面设计

### 19.1 布局

```text
┌─────────────────────────────────────────────────────────┐
│ 返回 | 场景名 | 保存状态 | 校验 | 仿真 | 发布 | 版本       │
├────────────┬──────────────────────────┬─────────────────┤
│ 场景树     │                          │ 属性面板        │
│ 模型库     │       Three.js 画布      │ 变换/材质       │
│ Asset/设备 │                          │ 数据绑定/路线   │
│ 路线列表   │                          │ 性能诊断        │
├────────────┴──────────────────────────┴─────────────────┤
│ 错误、警告、资源加载、路线仿真和发布诊断                 │
└─────────────────────────────────────────────────────────┘
```

### 19.2 关键交互

- 自动保存只保存草稿，并显示最后成功时间和 revision。
- 发布按钮先执行校验；错误阻止发布，警告需要确认。
- 节点绑定时先选择场景对象，再选择 Asset、Device、点位和目标效果。
- 模型节点路径从 `NodeIndex` 选择，不要求用户手输。
- 路线编辑模式与对象变换模式互斥，避免误拖模型。
- 编辑器提供仿真/实时模式明显标识，仿真值不能写入真实遥测。
- 发布版本可以预览，但不可直接编辑；修改需要从版本创建新草稿。

## 20. 场景加载和渲染流程

1. 请求运行清单，校验 schemaVersion。
2. 根据资源分组加载首屏必要模型。
3. 初始化 Scene、Camera、Renderer、Controls 和必要后处理。
4. 建立 objectId 到 Object3D 的索引。
5. 加载模型并应用实例变换、节点可见性和材质覆盖。
6. 编译绑定，不启动任意脚本。
7. 构建路线曲线、弧长表、拓扑和占用区。
8. 获取一次运行时 snapshot，完成初始状态。
9. 建立实时连接并按时间戳应用增量。
10. 延迟加载非首屏资源和低优先级标签。
11. 显示加载错误，但尽量保持场景其他部分可用。

## 21. 性能设计

### 21.1 加载优化

- GLB 按空间和功能拆分。
- 使用 Meshopt/Draco 几何压缩和 KTX2/Basis 贴图压缩。
- 使用 HTTP Range 和长期内容缓存。
- 缩略图和元数据先于完整模型返回。
- 首屏资源、视野邻近资源和后台资源分三级队列。
- 重复物料、托盘、灯具和传感器使用 InstancedMesh。

### 21.2 渲染优化

- 限制 renderer pixelRatio，默认不超过 2。
- 阴影只用于关键灯光和关键物体，远距离关闭或降低分辨率。
- 高成本 SSR、SAO、Bloom 按场景和设备能力分级。
- 标签采用距离裁剪、聚合和最大数量限制。
- 静态对象合批需要保留选择和绑定映射；不能为了合批丢失业务定位能力。
- 高频遥测更新先合并，再在一帧内批量应用材质和变换。

### 21.3 性能降级

运行端根据 GPU 能力、帧率和内存进入 High、Medium、Low：

- 降低 pixelRatio。
- 禁用 SSR/SAO 和部分 Bloom。
- 降低阴影质量或关闭阴影。
- 提前切换 LOD。
- 降低标签数量和更新频率。
- 降低路线实例插值和非关键动画频率。

降级只影响视觉质量，不改变业务状态和路线拓扑。

## 22. 安全设计

- 上传文件校验文件头、大小、扩展、glTF URI 和压缩率。
- 禁止 GLB/glTF 引用 `file:`、`javascript:`、data URL 和未授权外部域名。
- 模型名称、节点名称、标签和场景文本统一进行输出编码。
- 禁止 `eval`、`new Function` 和从场景载荷执行脚本。
- 模型 `userData` 视为普通不可信 JSON，不映射到命令调用。
- 所有资源接口校验 TenantId、CustomerId 和 Asset 权限。
- 发布版本记录 Hash，运行端可以校验 Manifest 和文件完整性。
- 跨租户复制场景必须显式复制/重新授权模型资源，不能保留越权 resourceId。
- 控制命令使用现有 IoTSharp 授权和审计体系。
- CSP 应限制脚本、worker、模型和贴图来源。

## 23. 可观测性

### 23.1 客户端指标

- scene load total、manifest load、model load、first interactive。
- FPS、frame time P50/P95、long task 数量。
- 当前 geometry、texture、program、render target 数量。
- 可见三角形、draw calls、实例数和标签数。
- Hub RTT、重连次数、积压更新和丢弃旧消息数量。
- Binding 应用失败、缺失节点、未知转换器。
- RouteEngine 活动、Blocked、Faulted 实例数。

### 23.2 服务端指标

- 场景查询、保存、校验、发布耗时和失败率。
- 模型上传量、处理队列深度、转换耗时和失败原因。
- 场景发布资源总量和超预算次数。
- Hub 连接数、每场景订阅数、消息合并率和发送字节数。
- 跨租户拒绝、无权限访问和非法模型请求。

日志不得持续输出每帧、每个对象或每条高频遥测，以免形成日志风暴。

## 24. 测试策略

### 24.1 单元测试

- 场景合同 DTO 序列化和 schema 校验。
- Manifest 编译稳定性和 Hash 一致性。
- 资源引用、重复 ID 和 nodePath 校验。
- 路线长度、弧长映射、切线、分支和不可达节点。
- RouteEngine 固定步长、暂停、恢复、占用和传感器校正。
- Binding 白名单转换、过期状态、质量和乱序数据。
- 模型元数据和许可证策略校验。

### 24.2 集成测试

- 不同 Tenant/Customer 无法读取彼此场景和模型。
- 草稿 revision 冲突不会静默覆盖。
- 发布生成不可变版本并写审计。
- 删除被发布版本引用的模型会被阻止。
- 回滚只切换当前版本，不修改历史载荷。
- Range 下载、ETag 和模型内容 Hash 正常。
- Snapshot 与 Hub 增量衔接无状态缺口。

### 24.3 前端测试

- 创建场景、上传模型、放置对象、保存和重新打开。
- 绑定遥测后颜色、动画和标签正确更新。
- 绘制包含分支和占用区的输送路线并仿真。
- 刷新、切换场景和连续进入退出 20 次后资源数量不持续增长。
- Hub 断线、重连、乱序和过期数据展示正确。
- 普通查看用户无法打开编辑和发布操作。

### 24.4 性能基准场景

至少维护以下自动或半自动基准：

1. 单设备场景：检查功能和资源释放。
2. 输送线场景：代表性 40 至 50 MB 原始模型，经优化后验证加载和路线。
3. 重复物料场景：500、2000 个物料实例，验证 InstancedMesh 和路线更新。
4. 多设备状态场景：5000 个绑定点，验证消息合并和材质批量更新。
5. 大厂区分片场景：验证视距加载、LOD 和场景切换。

## 25. 验收标准

### 25.1 模型能力

- 可以上传 GLB 并获得明确的 Ready/Rejected 处理结果。
- 可以查看模型三角形、材质、贴图、节点和许可证信息。
- 可以从节点树选择活动部件并绑定状态。
- 模型发布后使用不可变 URL/Hash，历史场景不被新上传覆盖。
- 代表性输送线模型达到约定的加载和帧率预算。

### 25.2 路线能力

- 可以绘制、编辑和保存直线与曲线路线。
- 可以配置入口、出口、分支、传感器点和占用区。
- 相同输入事件和时间步得到相同仿真结果。
- 多物体运行不会穿越被占用区，停止/恢复和分支正确。
- 真实传感器事件可以校正物体位置，断线时显示 stale 而非伪造运行。

### 25.3 平台能力

- 场景归属 Asset，运行值来自 Device，不破坏现有领域边界。
- 场景具备草稿、校验、发布、版本和回滚。
- 查看、编辑、发布、上传和控制权限可独立配置。
- 关键操作有租户隔离和审计。
- 运行端不执行场景任意脚本。

## 26. 分阶段实施计划

### Phase 0：技术基线与真实模型 PoC，1 至 2 周

任务：

- Fork 并固定 `threejs-editor` 提交。
- 完成依赖和许可证清单。
- 在特性分支统一 Vue/Three.js 版本，确认只加载一个 Three.js。
- 导入一个真实设备和一个代表性输送线 GLB。
- 验证场景树、节点选择、对象变换、导出和资源释放。
- 用最小路线插件绘制控制点并让一个物料沿曲线运行。

退出条件：

- IoTSharp 前端可以按懒加载路由打开编辑器。
- 真实模型可加载、选择节点和清理资源。
- 路线 PoC 支持直线、曲线、方向和恒速预览。
- 没有不可接受的许可证或核心包来源问题。

### Phase 1：模型资源中心和场景 CRUD，2 至 3 周

任务：

- 建立 `TwinModelResource`、`DigitalTwinScene` 和 EF 配置/迁移。
- 建立租户安全的模型上传、下载、元数据和预览接口。
- 建立场景列表、创建、草稿保存和 revision 冲突处理。
- 定义场景合同 v1、DTO、JSON schema 和 validator。
- 将编辑器 localStorage/IndexedDB 替换为 IoTSharp API。

退出条件：

- 模型资源和场景均受租户/客户隔离。
- 草稿可以跨浏览器保存和恢复。
- 不存在依赖客户端物理文件路径的场景数据。

### Phase 2：编辑器适配和场景发布，3 至 4 周

任务：

- 完成 `ThreeJsEditorAdapter`。
- 接入模型库、Asset 选择和对象稳定 ID。
- 完成场景校验、发布、版本、预览和回滚。
- 移除任意场景脚本和外部资源 URL。
- 完成运行端精简加载器和资源释放。

退出条件：

- 编辑器私有结构能够编译成 IoTSharp Manifest。
- 已发布版本不可变且可以回滚。
- 普通查看端不下载编辑器代码。

### Phase 3：路线编辑器和 RouteEngine，3 至 4 周

任务：

- 实现路线节点、线段、曲线和弧长表。
- 实现路线编辑插件、方向、分支和传感器点。
- 实现固定步长状态机、占用区、暂停和恢复。
- 实现仿真数据源和基准场景。
- 对重复物料使用实例化渲染。

退出条件：

- 输送线分支和占用仿真通过确定性测试。
- 500 个物料达到目标性能，2000 个物料有明确降级策略。
- 路线拓扑错误在发布前可定位。

### Phase 4：设备绑定和实时数据，2 至 3 周

任务：

- 实现绑定编辑面板和白名单转换器。
- 首先实现批量 snapshot，再实现 `TwinRealtimeHub`。
- 接入遥测、属性、在线状态、告警和命令反馈。
- 实现 stale、质量、乱序和重连处理。
- 实现传感器事件到路线实例的校正。

退出条件：

- 真实设备状态可以稳定驱动模型和路线。
- 断线、重连和坏质量不会显示误导状态。
- 场景订阅不泄露未授权 Device 数据。

### Phase 5：生产加固，2 至 3 周

任务：

- 模型处理队列、病毒扫描、压缩、LOD 和 KTX2。
- 性能分级、可观测性和告警。
- 权限、审计、CSP 和命令确认。
- 全量兼容性、压力、内存和安全测试。
- 运维文档、模型制作规范和用户手册。

退出条件：

- 满足本文验收标准。
- 具备升级、回滚、备份和故障定位手册。
- 真实生产场景完成试运行。

## 27. 第一批开发任务拆分

### P0

- 依赖升级和单 Three.js 实例验证。
- `threejs-editor` Fork、许可证审计和适配层骨架。
- `digital-twin-scene.v1` 合同、DTO、schema、validator。
- `DigitalTwinScene`、`DigitalTwinSceneVersion`、`TwinModelResource` 数据模型。
- 模型安全上传和授权下载。
- 场景草稿保存、校验、发布和运行清单。
- 路线直线/曲线编辑和基础 RouteEngine。
- 遥测 snapshot、基础颜色/显示/动画绑定。
- 资源释放和内存回归测试。

### P1

- 分支、占用、传感器校正和实例化物料。
- TwinRealtimeHub、消息合并和重连补偿。
- LOD、Draco/Meshopt、KTX2 和模型处理队列。
- 告警定位、标签、相机书签和运行诊断。
- 场景版本差异和回滚 UI。

### P2

- AGV 路网和 A*。
- Product 默认模型/绑定模板。
- 多人编辑锁或协同能力。
- BIM/IFC 离线转换插件。
- 机械臂关节遥测驱动。
- 更完整的模型生成和 AI 辅助资产流水线。

## 28. 风险与缓解

| 风险 | 影响 | 缓解措施 |
| --- | --- | --- |
| threejs-editor 核心依赖来源或许可证不清 | 无法商用或升级困难 | 固定提交、SBOM、法律审查、适配层隔离，必要时只复用可确认源码。 |
| Vue/Three.js 升级影响现有页面 | 前端回归 | 独立分支、单元/E2E、懒加载模块、逐页回归和可回退构建。 |
| 模型过大或来源混乱 | 加载慢、侵权、崩溃 | 资源中心、授权元数据、预算门禁、处理流水线和发布阻断。 |
| 单图生成模型不准确 | 数字孪生失真 | 厂家 CAD 优先，多视图和尺寸输入，人工验收，生成模型只做补充。 |
| 路线只按动画时间运行 | 与真实 PLC 漂移 | 距离状态、固定步长、事件真值和传感器校正。 |
| 任意脚本进入场景 | XSS、越权控制 | 禁止脚本，使用白名单组件和转换器。 |
| 高频遥测压垮浏览器 | 卡顿和内存增长 | 服务端合并、客户端批处理、绑定索引、降采样和更新预算。 |
| 大量重复物体性能不足 | FPS 下降 | InstancedMesh、对象池、LOD、标签裁剪和固定步长。 |
| 场景 JSON 锁定第三方编辑器 | 无法升级替换 | IoTSharp 主合同 + Adapter + ManifestCompiler。 |
| 多租户资源 URL 泄露 | 数据越权 | 资源 ID 授权、租户路径隔离、短期签名或受控流式下载。 |

## 29. 待确认但不阻塞首期的事项

首期按以下默认值推进，后续可以通过配置调整：

- 对象坐标采用米、Y-up、+Z forward。
- 运行模型格式只支持 GLB。
- 场景归属一个根 Asset。
- 首期路线以 Conveyor 为主，AGV 放到 P2。
- 首期无任意脚本，绑定使用固定转换器。
- 首期先 REST snapshot，随后接 SignalR Hub。
- 首期模型转换可以人工/离线执行，生产加固阶段再服务化队列。

产品负责人仍需在 Phase 0 结束前确认：

- 第一条真实生产线和代表性模型。
- 需要展示的 PLC/Device 点位清单。
- 是否存在必须支持的 CAD/IFC 原格式。
- 模型是否允许上传到云端，还是只能在私有部署处理。
- 首期目标终端 GPU、屏幕分辨率和并发查看人数。
- 三维界面是否允许发起设备控制命令。

## 30. Definition of Done

一个数字孪生功能只有同时满足以下条件才算完成：

- 领域边界符合 Product、Asset、Device 和 SemanticPoint 定义。
- API、DTO、schema、数据库迁移、权限和审计齐全。
- Tenant/Customer 隔离有自动化测试。
- 编辑端保存的是 IoTSharp 草稿，运行端读取的是已发布 Manifest。
- 没有从场景载荷执行任意脚本。
- 模型有来源、Hash、元数据、处理状态和许可证记录。
- 路线有拓扑校验、确定性测试和异常状态处理。
- 实时绑定正确处理时间戳、质量、乱序、断线和 stale。
- 页面退出后渲染、订阅、timer、worker 和 GPU 资源已释放。
- 代表性场景通过功能、性能、内存、安全和浏览器兼容测试。
- 用户文档、模型制作规范和运维诊断说明同步更新。

## 31. 参考项目

- [threejs-editor](https://github.com/z2586300277/threejs-editor)：编辑器二次开发基线。
- [Three.js](https://github.com/mrdoob/three.js)：渲染和 glTF 工具链。
- [img2threejs](https://github.com/img2threejs/img2threejs)：程序化图片参考建模辅助。
- [Meteor3DEditor](https://github.com/nikonikoCW/Meteor3DEditor)：模型资产和场景编辑能力参考，不引入其业务后端。
- [Astral3D](https://github.com/mlt131220/Astral3D)：BIM/CAD 和低代码能力参考，首期不采用。

## 32. 推荐的下一步

从 Phase 0 开始，不先建立大量数据库表。第一项实现应创建一个隔离的数字孪生前端路由，完成以下垂直 PoC：

1. 加载一台真实设备 GLB 和一段代表性输送线。
2. 选择模型节点并绑定一条模拟 `running` 遥测。
3. 在场景中绘制一条带曲线的路线。
4. 让一个物料以米/秒沿路线运行，并支持暂停和传感器位置校正。
5. 保存为 IoTSharp 场景清单草稿，再重新加载。
6. 连续进入退出页面 20 次，确认没有持续 GPU/内存增长。

这个 PoC 同时验证模型、路线、编辑器适配、Three.js 版本和运行时边界。通过后再进入正式持久化和实时链路开发，可以最大限度降低错误选型和过早建模风险。
