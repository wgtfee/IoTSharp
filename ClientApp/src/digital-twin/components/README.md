# IoTSharp 数字孪生组件模型

本目录是 V7 参数化智能模型底座。

## 已实现生成器

- `roller-conveyor-v1`：直线辊道，`BuiltInComponentCatalog` 中分别注册为“标准小辊道”和“标准大辊道”两个模板。
- `turn-conveyor-90-v1`：90° 转弯辊道。
- `diverter-conveyor-v1`：分流辊道，三端口（1 入 2 出）。
- `merger-conveyor-v1`：汇流辊道，三端口（2 入 1 出）。
- `lift-v1`：提升机，上下层进出口。
- `turntable-v1`：旋转台，带可旋转辊道平台。
- `external-inspection-v1`：外检机，内置辊道、半透明设备罩、标题和状态灯。
- `bagging-machine-v1`：套袋机，内置辊道、袋膜结构、标题和状态灯。

## 为什么小/大辊道共用生成器

小辊道和大辊道的拓扑相同，区别主要是默认宽度、辊面高度、滚筒规格、Capacity 和允许输送对象。因此统一由 `RollerConveyorComponent` 生成，资源库中注册为两个不同模板，避免复制两份几何代码。

## 前端内置模板

所有模板位于：

```text
BuiltInComponentCatalog.ts
```

模板注册数据位于：

```text
ComponentResourceRegistration.ts
```

Workbench 的“模型资源库”现在会直接显示这些内置模板；点击“放入场景”后创建 `kind=component` 实例，TwinRuntime 通过 `ComponentRegistry` 生成 Three.js 对象。

## 现有 ModelResource 数据库如何存组件

V7 不要求新增数据库列。参数化/智能组件继续复用 `TwinModelResources`：

```text
RuntimeFormat = application/vnd.iotsharp.twin-component+json
SourceType = ModelLibrary
ModelMetadata = 组件定义 JSON
FileSize = 0
StoragePath = 空
ProcessingStatus = Ready
```

组件定义 JSON 包含：

```text
resourceType
componentType
generator
generatorVersion
category
tags
capabilities
defaultProperties
componentSchema
ports
bindingSlots
```

普通 GLB 仍保持：

```text
RuntimeFormat = model/gltf-binary
```

## 注册 API

后端已提供：

```http
POST /api/digital-twin/model-resources/components/upsert
```

注册单个组件。

批量注册：

```http
POST /api/digital-twin/model-resources/components/batch
```

两者都要求：

```text
CustomerAdmin / TenantAdmin / SystemAdmin
```

按 `resourceKey` Upsert，所以重复调用不会重复插入。

## 内置 resourceKey

```text
builtin-small-roller-conveyor
builtin-large-roller-conveyor
builtin-turn-conveyor-90
builtin-diverter-conveyor
builtin-merger-conveyor
builtin-lift
builtin-turntable
builtin-external-inspection
builtin-bagging-machine
```

## 场景实例化

通过：

```ts
createComponentDefinitionFromTemplate(
  'builtin-small-roller-conveyor',
  {
    objectId: 'conveyor-001',
    properties: {
      length: 8,
      capacity: 5,
      transportUnitType: 'plastic-pallet'
    }
  }
)
```

然后：

```ts
defaultComponentRegistry.create(definition)
```

得到 Three.js `Group + Ports + Bounds`。

Workbench 已经封装了这一步：打开“模型资源库” → “内置参数化 / 智能模型” → 点击“放入场景”。

## 注册到数据库后的行为

如果某个内置模板已经通过 Component Resource API 注册进当前租户的模型资源库，Workbench 放入组件时会按 `resourceKey` 找到数据库资源，并同时写入：

```text
manifest.resources[].resourceId
object.resourceId
```

这样发布版本可以追踪到数据库模型资源记录。

如果尚未注册，Workbench 在放入组件或保存场景前会调用批量 Upsert；保存后的每个 Component Instance 必须持有真实数据库 `resourceId`，后端同时复核 resourceKey、Generator、版本、Port 与 Binding Slot 元数据。

## 当前已完成的 Workbench / Runtime 接入

- 模型资源库显示 9 个内置参数化/智能模板。
- 点击模板可直接放入场景。
- 组件实例随 Manifest 保存。
- TwinRuntime 可加载 `kind=component` 对象。
- 组件带 Input/Output Port 定义和 Bounds。
- Registry 严格按 `generator@generatorVersion` 加载，未知版本明确失败。
- 组件属性升级使用 `ComponentMigrationRegistry` 显式执行，Published Scene 不自动升级。
- 0.5m / 15° 自动吸附、输送对象与 small/large 规格兼容检查；普通辊道高差超过 0.15m 时禁止直连。
- Connection 持久化、移动/撤销后的失效连接清理。
- 一个场景可生成多个独立 Component Network，RouteId 按成员稳定计算。
- Connection 自动推导 Section / Route，自动路线只读。
- Smart Model 标准 PLC Binding Slot、Workbench 下拉配置与 Process Binding 继承；`ProcessStationManager` 共用 Simulation / Live 状态机，stale 信号强制阻塞。
- Port / Connection / Route / Bounds 工程辅助图层。
- Body Bounds 重叠与路线净空工程诊断。
- 丝饼固定辊道 V2 Migration：主线、桁架 A/B、木托及后处理辊道全部组件化。
- `TwinSectionGeometryResolver` 统一提供 `sectionId + progress` 世界位姿，木托盘后包装运动已按四段 Section Geometry 取位。
- `npm run verify:v7-components` 已作为 Develop CI Gate。
- GLB 上传/下载流程保持不变。

## V7 封版边界

V7 进入 Stable / Maintenance 后只维护组件化、工程编辑、Port、Connection、Network、Section、Route、版本与发布兼容。SubAssembly、通用 AGV/机器人规划、大型场景 LOD 与多生产线并行 Runtime 进入 V8，避免继续扩大 V7 的发布面。

## 迁移现有 ProceduralPackagingLine

`SilkV7ComponentMigration` 当前版本为 2。新草稿会把主塑料托输送、桁架 A/B、木托盘码垛线以及盖板/贴标/缠膜后的分段大辊道全部迁移为 V7 Component；程序化对象只保留机器人、丝车、桁架机构、托盘/丝饼实体和工艺动画。

旧 Published Scene 不会被隐式改写：只有迁移版本达到 2 时，Runtime 才关闭旧桁架与后处理辊道绘制，因此历史发布版本仍可按原语义重放。
