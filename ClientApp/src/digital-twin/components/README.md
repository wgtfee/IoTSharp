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

后端模型资源库可以直接使用 `builtInComponentResourceRegistrations` 作为 Seed / API Payload 来源。

## 推荐注册到现有模型资源库的字段

现有 ModelResource 建议增加：

```text
ResourceType
ComponentType
Generator
GeneratorVersion
Category
TagsJson
CapabilitiesJson
DefaultPropertiesJson
ComponentSchemaJson
```

普通 GLB：

```text
ResourceType = gltf-model
```

标准小辊道：

```text
ResourceType = procedural-component
ComponentType = roller-conveyor
Generator = roller-conveyor-v1
```

外检机：

```text
ResourceType = smart-model
ComponentType = external-inspection
Generator = external-inspection-v1
```

## 推荐后端 Seed 流程

启动 / Migration Seed 时按 `resourceKey` 做 Upsert：

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

不要每次启动重复插入；`resourceKey` 应设置唯一索引。

## 推荐 API

```http
POST /api/digital-twin/model-resources/components/seed-builtins
```

仅管理员可调用，服务端内部使用与 `BuiltInComponentCatalog` 对应的 Seed 数据进行 Upsert。

或者直接在数据库 Migration / Seed 中注册，不暴露 Seed API。

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

即可得到 Three.js `Group + Ports + Bounds`。

## 下一步接入 Workbench

1. 模型资源库列表同时展示 GLB 和 Component Resource。
2. 拖 `gltf-model` 时继续走现有 GLB Loader。
3. 拖 `procedural-component / smart-model` 时走 `ComponentTemplateFactory`。
4. 将实例属性保存到 Scene Manifest。
5. 点击组件时根据 `propertySchema` 动态生成属性编辑器。
6. 后续实现 Input/Output Port 的自动吸附和 Connection。
7. 再由 Connection 推导 TwinSection / Route。

## 迁移现有 ProceduralPackagingLine

目前 `ProceduralPackagingLine.addRollerLane()` 仍然存在。迁移时不要复制生成逻辑，而应逐步替换成 `RollerConveyorComponent`。

建议顺序：

```text
小直线辊道
→ 大直线辊道
→ 90°转弯
→ 分流
→ 汇流
→ 提升机
→ 旋转台
→ 外检机
→ 套袋机
```

最终 `ProceduralPackagingLine` 只作为丝饼产线示例模板组合器，而不再自行实现每种设备的 Three.js 几何。
