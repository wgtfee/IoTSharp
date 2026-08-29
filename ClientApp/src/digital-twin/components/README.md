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

如果尚未注册，内置模板仍能在 Draft/Runtime 中使用，因为生成器和完整实例参数都在前端 Component Registry / Manifest 中；正式生产建议先注册，再发布。

## 当前已完成的 Workbench / Runtime 接入

- 模型资源库显示 9 个内置参数化/智能模板。
- 点击模板可直接放入场景。
- 组件实例随 Manifest 保存。
- TwinRuntime 可加载 `kind=component` 对象。
- 组件带 Input/Output Port 定义和 Bounds。
- GLB 上传/下载流程保持不变。

## 后续增强

尚未在 V7 P0 中自动完成的能力：

1. Input/Output Port 可视化编辑。
2. 拖拽靠近后的自动 Snap。
3. Connection 写入 Manifest。
4. Connection 自动推导 TwinSection / Route。
5. 根据 `propertySchema` 自动生成完整动态属性面板。

这些属于 V7 后续拓扑编辑阶段，不影响当前模板生成、放置、保存和运行时显示。

## 迁移现有 ProceduralPackagingLine

当前丝饼 V6 示例场景中的旧 `addRollerLane()` 仍用于兼容已有模板。新场景应优先使用模型资源库中的组件；后续再逐步把示例模板内部辊道也替换为 `RollerConveyorComponent`。

最终 `ProceduralPackagingLine` 只作为丝饼产线示例模板组合器，而不再承担每个项目的真实设备几何实现。
