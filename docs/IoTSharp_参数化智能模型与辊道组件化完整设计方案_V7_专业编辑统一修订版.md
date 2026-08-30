# IoTSharp 数字孪生参数化智能模型与辊道组件化完整设计方案 V7

> 仓库：`wgtfee/IoTSharp`  
> 分支：`Develop`  
> 设计基线：当前 V6 丝饼数字孪生场景  
> 目标：将目前写死在 `ProceduralPackagingLine.ts` 中的小辊道、大辊道及后续设备，逐步升级为可从现有模型资源库拖拽、复用、配置、连接、保存、发布的“参数化智能模型”。

---

# 1. 背景

当前 IoTSharp 数字孪生已经具备：

```text
模型资源库
场景编辑器
Three.js
TwinSceneManifest
TwinRouteEdge
TwinSection
Capacity
Occupancy
Reserved
PLC / Simulation
ProcessStation
外检
套袋
机器人
桁架
木托盘
塑料托盘
```

但是当前丝饼 V6 场景中的大量辊道仍然通过：

```text
ProceduralPackagingLine.ts
```

内部代码现场生成。

例如目前的核心方式：

```text
addRollerLane(
    parent,
    from,
    to,
    width,
    name,
    sectionId
)
```

函数内部：

```text
根据 from / to
↓
计算 length
↓
创建两条边梁
↓
按照 length / rollerPitch
循环创建滚筒
↓
加入 Scene
```

也就是说：

```text
场景代码
=
设备模型
+
设备位置
+
设备数量
+
设备长度
+
工艺布局
```

全部混在一起。

结果：

```text
换一个场景
↓
重新修改 TypeScript
↓
重新调整坐标
↓
重新编译
```

这与数字孪生编辑器“拖模型搭场景”的目标不一致。

---

# 2. 本次架构目标

目标从：

```text
ProceduralPackagingLine
↓
代码写死一整条线
```

升级为：

```text
模型资源库
↓
拖入标准辊道
↓
修改长度 / 宽度 / Capacity / 输送对象
↓
拖入第二段
↓
自动吸附
↓
自动连接
↓
自动生成 Section / Route
↓
保存 Manifest
↓
发布
```

最终：

> 不同项目、不同工厂、不同产线，不再因为辊道长度和布置不同而修改代码。

---

# 3. 为什么不推荐直接把辊道做成固定 GLB

最简单方案：

```text
当前小辊道
↓
导出 small-conveyor.glb
↓
上传模型资源库
```

这种方案只适合固定设备。

辊道存在：

```text
2m
3m
5m
8m
12m
20m
```

等大量长度变化。

如果直接拉伸 GLB：

```text
Scale X = 4
```

会导致：

```text
边梁拉长
滚筒也被拉长
滚筒间距变形
支腿变形
材质纹理拉伸
```

如果不拉伸，则需要：

```text
1米辊道.glb
2米辊道.glb
3米辊道.glb
4米辊道.glb
...
```

模型资源会迅速失控。

因此：

> 辊道不应该只是固定 GLB，而应该成为参数化智能模型。

---

# 4. 模型资源库只保留一个，不新增“组件库”

IoTSharp 已经存在：

```text
模型资源库
```

不建议另外创建：

```text
组件库
智能模型库
设备库
```

用户看到的仍然是：

```text
模型资源库
```

只是在资源内部区分类型：

```text
模型资源库
│
├─ 普通模型
│   ├─ 厂房.glb
│   ├─ 机器人.glb
│   ├─ 机床.glb
│   └─ 货架.glb
│
├─ 参数化智能模型
│   ├─ 标准小辊道
│   ├─ 标准大辊道
│   ├─ 90°转弯辊道
│   ├─ 分流辊道
│   └─ 汇流辊道
│
└─ 智能设备模型
    ├─ 旋转台
    ├─ 提升机
    ├─ 外检机
    ├─ 套袋机
    └─ 桁架
```

---

# 5. 资源类型

建议扩展模型资源类型：

```ts
export type TwinResourceType =
    | 'gltf-model'
    | 'procedural-component'
    | 'smart-model';
```

## gltf-model

普通：

```text
GLB / GLTF
```

例：

```text
机器人
厂房
货架
设备外壳
```

## procedural-component

通过参数动态生成几何。

例：

```text
小辊道
大辊道
直线滚筒线
皮带线
转弯辊道
```

## smart-model

模型 + 业务行为。

例：

```text
旋转台
提升机
岔口
桁架
外检机
套袋机
```

---

# 6. TwinModelResource 建议升级

当前资源模型已有：

```text
id
name
sourceType
runtimeFormat
nodeIndex
modelMetadata
...
```

建议增加：

```ts
export interface TwinModelResource {

    id: string;

    resourceKey: string;

    name: string;

    resourceType:
        | 'gltf-model'
        | 'procedural-component'
        | 'smart-model';

    componentType?: string;

    generator?: string;

    componentSchema?: TwinComponentSchema;

    defaultProperties?: Record<string, unknown>;

    ports?: TwinPortDefinition[];

    capabilities?: TwinComponentCapability[];

    sourceType?: string;

    runtimeFormat?: string;

    ...
}
```

---

# 7. 第一个参数化组件：RollerConveyorComponent

建议定义：

```text
componentType:
roller-conveyor
```

生成器：

```text
generator:
roller-conveyor-v1
```

---

# 8. RollerConveyor 参数模型

```ts
export interface RollerConveyorProperties {

    length: number;

    width: number;

    height: number;

    rollerDiameter: number;

    rollerPitch: number;

    frameHeight: number;

    supportSpacing: number;

    conveyorSizeClass:
        | 'small'
        | 'large';

    transportUnitType:
        | 'plastic-pallet'
        | 'wooden-pallet'
        | 'carton';

    capacity: number;

    speedLimit?: number;

    occupancyMode?:
        | 'calculated'
        | 'simulation'
        | 'live';
}
```

---

# 9. 标准小辊道资源

资源库中只存一个：

```text
标准小辊道
```

默认：

```json
{
  "length": 3,
  "width": 1.6,
  "height": 0.9,
  "rollerDiameter": 0.14,
  "rollerPitch": 0.55,
  "frameHeight": 0.16,
  "supportSpacing": 2.0,
  "conveyorSizeClass": "small",
  "transportUnitType": "plastic-pallet",
  "capacity": 2
}
```

---

# 10. 标准大辊道资源

```json
{
  "length": 4,
  "width": 2.4,
  "height": 0.8,
  "rollerDiameter": 0.18,
  "rollerPitch": 0.60,
  "conveyorSizeClass": "large",
  "transportUnitType": "wooden-pallet",
  "capacity": 1
}
```

---

# 11. 同一个资源创建多个独立实例

场景一：

```text
小辊道01
Length = 3m
Capacity = 2
PlasticPallet
```

场景二：

```text
小辊道02
Length = 8m
Capacity = 5
PlasticPallet
```

场景三：

```text
小辊道03
Length = 12m
Capacity = 8
Carton
```

它们都引用：

```text
resourceId = standard-small-roller
```

---

# 12. Scene Object 增加 component 类型

当前：

```ts
kind:
    | 'procedural'
    | 'model';
```

建议：

```ts
kind:
    | 'procedural'
    | 'model'
    | 'component';
```

---

# 13. component 场景实例

```ts
export interface TwinSceneComponentDefinition {

    objectId: string;

    name: string;

    kind: 'component';

    resourceId: string;

    componentType: string;

    properties: Record<string, unknown>;

    transform: TwinTransform;

    sectionId?: string;

    routeEdgeId?: string;

    ports?: TwinComponentPortInstance[];
}
```

---

# 14. 示例 Manifest

```json
{
  "objectId": "conveyor-001",
  "name": "上料缓存辊道01",
  "kind": "component",
  "resourceId": "standard-small-roller",
  "componentType": "roller-conveyor",
  "properties": {
    "length": 8,
    "width": 1.6,
    "capacity": 5,
    "conveyorSizeClass": "small",
    "transportUnitType": "plastic-pallet"
  },
  "transform": {
    "position": [5, 0, -3],
    "rotation": [0, 0, 0],
    "scale": [1, 1, 1]
  },
  "sectionId": "section-conveyor-001"
}
```

---

# 15. Component Factory

新增：

```text
ClientApp/src/digital-twin/components/
```

建议：

```text
components/
│
├─ ComponentRegistry.ts
├─ TwinComponentFactory.ts
│
├─ conveyor/
│   ├─ RollerConveyorComponent.ts
│   ├─ RollerConveyorGeometry.ts
│   ├─ RollerConveyorDefaults.ts
│   └─ RollerConveyorPorts.ts
│
├─ junction/
├─ lift/
└─ turntable/
```

---

# 16. ComponentRegistry

```ts
export class ComponentRegistry {

    private generators =
        new Map<string, TwinComponentGenerator>();

    register(
        type: string,
        generator: TwinComponentGenerator
    ) {
        this.generators.set(type, generator);
    }

    create(
        definition: TwinSceneComponentDefinition
    ) {
        return this.generators
            .get(definition.componentType)
            ?.create(definition);
    }
}
```

---

# 17. RollerConveyorComponent

当前：

```text
ProceduralPackagingLine.addRollerLane()
```

里的代码全部抽出去。

例如：

```ts
export class RollerConveyorComponent
    implements TwinComponentGenerator {

    create(
        definition: TwinSceneComponentDefinition
    ) {

        const props =
            resolveRollerConveyorProperties(
                definition
            );

        const root = new THREE.Group();

        createFrame(root, props);

        createRollers(root, props);

        createSupports(root, props);

        createPorts(root, props);

        root.userData = {
            twinObjectType: 'component',
            componentType: 'roller-conveyor',
            objectId: definition.objectId,
            sectionId: definition.sectionId
        };

        return root;
    }
}
```

---

# 18. 滚筒数量自动生成

```ts
const rollerCount = Math.max(
    2,
    Math.ceil(
        properties.length
        /
        properties.rollerPitch
    )
);
```

所以：

```text
长度改变
↓
滚筒数量自动变化
```

不会通过 Scale 拉伸滚筒。

---

# 19. 边梁只改变长度

边梁：

```text
BoxGeometry(
    length,
    frameHeight,
    frameThickness
)
```

滚筒：

```text
始终保持固定直径和宽度
```

因此：

```text
Length 3 → 12
```

不会产生模型畸变。

---

# 20. 支腿也自动增加

建议：

```ts
supportCount = Math.ceil(
    length
    /
    supportSpacing
);
```

例如：

```text
3m → 2组支腿
8m → 4组
15m → 8组
```

这样模型长度越长结构仍然合理。

---

# 21. 组件必须有 Input / Output Port

每个直线辊道：

```text
       Input                 Output
         ●=====================●
                 Roller
```

---

# 22. Port 数据模型

```ts
export interface TwinPortDefinition {

    portId: string;

    name: string;

    type:
        | 'material-input'
        | 'material-output';

    localPosition: TwinVector3;

    localDirection: TwinVector3;

    compatibility?: {
        componentTypes?: string[];
        conveyorSizeClass?: string[];
        transportUnitTypes?: string[];
    };
}
```

---

# 23. 直线辊道 Port

Input：

```text
localPosition:
[-length/2, height, 0]

direction:
[-1, 0, 0]
```

Output：

```text
localPosition:
[length/2, height, 0]

direction:
[1, 0, 0]
```

---

# 24. Port 世界坐标实时计算

不要存固定 World Position。

应该：

```text
Local Position
+
Object Transform
↓
World Position
```

这样移动 / 旋转模型后 Port 自动跟随。

---

# 25. 自动吸附

拖第二段辊道：

```text
Conveyor02.Input
```

靠近：

```text
Conveyor01.Output
```

距离：

```text
< SnapDistance
```

则自动吸附。

---

# 26. Snap 条件

建议：

```text
距离 < 0.5m
方向夹角 < 15°
Port Type Compatible
```

然后：

```text
Input ↔ Output
```

自动连接。

---

# 27. Snap 后自动生成 Connection

```ts
interface TwinComponentConnection {

    connectionId: string;

    sourceObjectId: string;

    sourcePortId: string;

    targetObjectId: string;

    targetPortId: string;
}
```

---

# 28. Connections 建议进入 Manifest

```ts
interface TwinSceneManifest {
    ...
    connections: TwinComponentConnection[];
}
```

---

# 29. Connection 自动生成 Route

这是最重要的能力之一。

例如：

```text
Conveyor01.Output
↓
Conveyor02.Input
```

自动建立：

```text
Section01
↓
Section02
```

甚至 Route Edge 可以直接由 Component Connections 推导。

---

# 30. 推荐 Route 与 Component 的关系

每一个 Conveyor Component：

```text
对应一个 TwinSection
```

即：

```text
Conveyor Component
        │
        └── Section
            ├─ Capacity
            ├─ Occupancy
            ├─ Reserved
            ├─ CanAccept
            ├─ CanRelease
            └─ State
```

---

# 31. Section ID

创建组件时自动生成：

```text
section-{objectId}
```

例如：

```text
objectId: conveyor-001
sectionId: section-conveyor-001
```

---

# 32. Route Edge 不再手工维护大量重复字段

目标可以逐渐变成：

```text
Component
↓
Connection
↓
Topology Resolver
↓
Route
```

而不是：

```text
用户拖完模型
↓
再画一次 Route
↓
再设置 Section
```

---

# 33. Topology Resolver

建议新增：

```text
TwinTopologyResolver.ts
```

职责：

```text
Component Connections
↓
Component Graph
↓
Route Points
↓
Route Edges
↓
Section Upstream / Downstream
```

---

# 34. 直线 Line 自动产生拓扑

例如：

```text
C1
↓
C2
↓
C3
```

自动：

```text
Section-C1
↓
Section-C2
↓
Section-C3
```

---

# 35. 分流 Component

以后：

```text
DiverterComponent
```

Port：

```text
Input
Output-A
Output-B
```

自动生成 Junction。

---

# 36. 汇流 Component

```text
Input-A
Input-B
Output
```

自动生成 Merger。

---

# 37. 90°转弯辊道

资源：

```text
90°转弯辊道
```

属性：

```text
radius
width
rollerPitch
direction: left / right
```

Port：

```text
Input
Output
```

仍然可以自动连接。

---

# 38. Component 属性分成三类

## Geometry

```text
Length
Width
Height
RollerPitch
```

## Runtime

```text
Capacity
SpeedLimit
OccupancyMode
TransportUnitType
```

## Connectivity

```text
Input
Output
Snap
Connection
```

---

# 39. Workbench 属性面板

选中辊道以后：

```text
━━━━━━━━━━━━━━━━━━
标准小辊道
━━━━━━━━━━━━━━━━━━

几何

长度
[ 8.00 m ]

宽度
[ 1.60 m ]

高度
[ 0.90 m ]

滚筒间距
[ 0.55 m ]

运行

规格
[ 小辊道 ]

输送对象
[ 塑料托盘 ]

Capacity
[ 5 ]

速度上限
[ 1.2 m/s ]

占用模式
[ Simulation ]

连接

Input
Connected: Conveyor-00

Output
Connected: Conveyor-02
```

---

# 40. 修改长度后立即重建模型

用户：

```text
8m → 12m
```

执行：

```text
Properties Changed
↓
Component Rebuild
↓
Geometry Dispose
↓
New Geometry
↓
Ports Recalculate
↓
Connections Revalidate
```

---

# 41. 不要 Scale 模型

长度属性：

```text
properties.length
```

不能用：

```text
transform.scale.x
```

两者职责不同。

---

# 42. Transform Scale 建议锁定

对于参数化 Conveyor：

```text
Scale = 1,1,1
```

必要时编辑器直接禁止非等比 Scale。

否则用户同时改 Length 和 Scale，会导致真实尺寸、Port、Bounds 混乱。

---

# 43. Resource Default vs Instance Override

模型资源库：

```text
Standard Small Conveyor
Length = 3
Capacity = 2
```

场景实例：

```text
Conveyor-05
Length = 8
Capacity = 5
```

关系：

```text
Resource Defaults
↓
Instance Overrides
```

---

# 44. 修改 Resource 默认值不能破坏已有场景

场景保存实际 Properties Snapshot。

所以资源以后默认值：

```text
Length 3 → 4
```

不能自动改变已经发布的场景。

---

# 45. Published Scene 必须固定 Component Version

建议增加：

```ts
resourceVersion?: number;
```

或：

```text
resourceRevision
```

Published V3：

```text
Standard Small Conveyor
ResourceRevision = 5
```

后续资源升级 Revision 6，不应改变已发布 V3。

---

# 46. Model Resource Version

长期建议：

```text
TwinModelResource
└─ Versions
    ├─ V1
    ├─ V2
    └─ V3
```

场景引用：

```text
ResourceId + ResourceVersion
```

---

# 47. 参数 Schema

资源需要告诉 Workbench 哪些属性可编辑。

建议：

```ts
interface TwinComponentSchema {

    properties: Array<{

        key: string;

        label: string;

        type:
            | 'number'
            | 'select'
            | 'boolean'
            | 'string';

        defaultValue: unknown;

        min?: number;
        max?: number;
        step?: number;

        options?: Array<{
            label: string;
            value: unknown;
        }>;

        category?:
            | 'geometry'
            | 'runtime'
            | 'connection';
    }>;
}
```

---

# 48. RollerConveyor Schema 示例

```json
{
  "properties": [
    {
      "key": "length",
      "label": "长度",
      "type": "number",
      "defaultValue": 3,
      "min": 0.5,
      "max": 100,
      "step": 0.1,
      "category": "geometry"
    },
    {
      "key": "capacity",
      "label": "容量",
      "type": "number",
      "defaultValue": 2,
      "min": 1,
      "max": 999,
      "category": "runtime"
    },
    {
      "key": "transportUnitType",
      "label": "输送对象",
      "type": "select",
      "options": [
        {
          "label": "塑料托盘",
          "value": "plastic-pallet"
        },
        {
          "label": "纸箱",
          "value": "carton"
        }
      ]
    }
  ]
}
```

Workbench 可以根据 Schema 自动生成属性面板。

---

# 49. 不要为每种 Component 手写 Vue 表单

错误方向：

```text
RollerConveyorProperties.vue
TurnConveyorProperties.vue
LiftProperties.vue
...
```

以后设备越来越多。

应该：

```text
Component Schema
↓
Dynamic Property Editor
```

统一生成。

---

# 50. DynamicComponentPropertyPanel

建议：

```text
components/DynamicComponentPropertyPanel.vue
```

根据：

```text
resource.componentSchema
```

自动生成：

```text
InputNumber
Select
Switch
Text
```

---

# 51. 模型资源库 UI

资源卡片：

```text
┌─────────────────────┐
│  标准小辊道          │
│                     │
│  参数化智能模型       │
│                     │
│  Small Conveyor     │
│                     │
│ [拖入场景]           │
└─────────────────────┘
```

---

# 52. 资源过滤

```text
全部
普通模型
输送设备
加工设备
机器人
存储设备
```

或者标签：

```text
Conveyor
Robot
Process
Storage
```

---

# 53. Drag & Drop

模型资源库：

```text
标准小辊道
```

拖入 Three.js Canvas：

```text
Create Scene Component Instance
↓
Generate ObjectId
↓
Apply Default Properties
↓
Create Section
↓
Render
```

---

# 54. 复制组件

用户 Ctrl+D：

```text
Conveyor-01
↓
Conveyor-02
```

必须：

```text
new objectId
new sectionId
new port instance IDs
Connections = empty
```

不能复制旧连接。

---

# 55. 模型资源库“保存为可复用模型”

目前用户已经在场景里手工创建的对象也应该支持：

```text
右键
↓
保存到模型资源库
```

但需要区分普通模型与参数化 Component。

---

# 56. 保存普通模型

GLB：

```text
Selected Object
↓
GLTFExporter
↓
GLB
↓
上传 ModelResource
```

---

# 57. 保存参数化 Component

如果对象：

```text
componentType = roller-conveyor
```

则不导 GLB。

保存：

```text
Component Definition
+
Default Properties
+
Schema
+
Ports
```

---

# 58. ComponentResource DTO

```ts
export interface TwinComponentResource {

    resourceId: string;

    name: string;

    componentType: string;

    generator: string;

    generatorVersion: number;

    defaultProperties:
        Record<string, unknown>;

    schema:
        TwinComponentSchema;

    ports:
        TwinPortDefinition[];

    previewImage?: string;

    category?: string;

    tags?: string[];
}
```

---

# 59. 后端资源表设计

可以继续复用现有 Model Resource 表。

建议增加字段：

```text
ResourceType
ComponentType
Generator
GeneratorVersion
ComponentSchemaJson
DefaultPropertiesJson
PortsJson
```

普通 GLB：

```text
ResourceType = gltf-model
```

辊道：

```text
ResourceType = procedural-component
```

---

# 60. 不建议新建完全独立的数据表

当前已有 Digital Twin Model Resources。

最好扩展现有资源表。

原因：

```text
权限
查询
资源库
版本
发布
审核
```

都可以复用。

---

# 61. Backend API

现有：

```text
GET /model-resources
POST /model-resources/upload
```

建议增加：

```text
POST
/api/digital-twin/model-resources/components
```

创建参数化组件。

---

# 62. Component Create API

```json
{
  "name": "标准小辊道",
  "resourceType": "procedural-component",
  "componentType": "roller-conveyor",
  "generator": "roller-conveyor-v1",
  "generatorVersion": 1,
  "defaultProperties": {
    "length": 3,
    "width": 1.6,
    "capacity": 2
  },
  "schema": {},
  "ports": []
}
```

---

# 63. 更新 Resource

```text
PUT
/api/digital-twin/model-resources/{id}/component
```

---

# 64. 获取 Resource

当前 `listModels()` 可以继续返回：

```text
GLB
+
Component
```

Workbench 根据：

```text
resourceType
```

决定：

```text
GLB Loader
or
Component Factory
```

---

# 65. Component Loader

TwinRuntime：

```text
object.kind === 'model'
↓
ModelResourceLoader

object.kind === 'component'
↓
TwinComponentFactory

object.kind === 'procedural'
↓
旧 Demo Preset Loader
```

---

# 66. 兼容现有场景

旧场景仍有：

```text
kind = procedural
preset = silk-cake-packaging-line
```

短期不删除。

---

# 67. V7 迁移策略

不要一次把整个 V6 场景全部重写。

先迁移：

```text
小直线辊道
```

---

# 68. Phase 1

抽出：

```text
RollerConveyorComponent
```

让 `ProceduralPackagingLine` 内部自己也调用：

```text
RollerConveyorComponent
```

而不是：

```text
addRollerLane()
```

这一步 UI 不变。

---

# 69. Phase 2

把：

```text
标准小辊道
```

注册到模型资源库。

实现拖入场景。

---

# 70. Phase 3

实现：

```text
Length
Width
Capacity
TransportUnit
```

动态属性。

---

# 71. Phase 4

实现：

```text
Input / Output Port
```

---

# 72. Phase 5

实现：

```text
Auto Snap
```

---

# 73. Phase 6

实现：

```text
Connections
↓
Auto Section
↓
Auto Route
```

---

# 74. Phase 7

把丝饼 V6 中的小辊道逐段替换成 Scene Component Instance。

---

# 75. Phase 8

再迁大辊道。

---

# 76. Phase 9

迁移：

```text
转弯辊道
分流
汇流
```

---

# 77. Phase 10

迁移：

```text
旋转台
提升机
外检机
套袋机
```

成为 Smart Model。

---

# 78. ProceduralPackagingLine 最终职责

未来它不再自己创建全部模型，而只是：

```text
Example Scene Builder
```

例如：

```text
创建“丝饼产线模板”
↓
从资源库实例化：
20 段小辊道
2 个分流器
1 个外检机
1 个套袋机
...
```

模板 = 组件组合，而不是手写 Three.js 代码。

---

# 79. Scene Template

长期可以增加：

```text
场景模板
```

例如：

```text
丝饼包装线
立体库入库线
纸箱包装线
托盘输送线
```

模板只是：

```text
Components
+
Connections
+
Properties
+
Bindings
```

---

# 80. 一个新场景的未来操作流程

用户：

```text
新建场景
```

然后：

```text
模型资源库
↓
拖“标准小辊道”
↓
Length = 6
↓
Capacity = 4

再拖一个
↓
Length = 8

靠近
↓
自动吸附

再拖分流辊道
↓
自动连接

再拖外检机
↓
连接
```

不需要写代码。

---

# 81. 设备 Runtime Capability

智能模型可以声明：

```ts
export type TwinComponentCapability =
    | 'material-flow'
    | 'capacity'
    | 'process-station'
    | 'junction'
    | 'merger'
    | 'rotation'
    | 'vertical-transfer'
    | 'plc-binding';
```

---

# 82. 小辊道 Capability

```text
material-flow
capacity
```

---

# 83. 分流辊道 Capability

```text
material-flow
capacity
junction
plc-binding
```

---

# 84. 外检机 Capability

```text
material-flow
capacity
process-station
plc-binding
```

---

# 85. 组件运行时

TwinRuntime 不应该判断：

```text
if small conveyor
```

而应该：

```text
if capability.includes('material-flow')
```

这样以后更容易扩展。

---

# 86. Component Instance 与 Binding

组件也可以绑定 PLC：

```text
Conveyor01
```

绑定：

```text
Running
Fault
Occupancy
Full
Blocked
```

---

# 87. Binding Target

例如：

```text
运行状态 → roller rotation
故障 → emissive red
blocked → status indicator
occupancy → TwinSection Occupancy
```

---

# 88. Roller 动画

当前滚筒可以由 Section Running 控制。

不要全场所有滚筒一直旋转。

---

# 89. 智能组件内部节点命名

Roller Component：

```text
Root
├─ Frame
├─ Rollers
│   ├─ Roller-001
│   ├─ Roller-002
│   └─ ...
├─ Supports
├─ InputPort
├─ OutputPort
└─ StatusLight
```

这样 Binding 可以用 `nodePath: Rollers` 控制动画。

---

# 90. 性能优化

如果 100 段辊道，每段 20 个 Rollers：

```text
2000 Mesh
```

建议使用：

```text
InstancedMesh
```

---

# 91. Roller Instancing

一个 Component 内：

```text
RollerGeometry
+
RollerMaterial
+
InstancedMesh
```

比每根滚筒一个 Mesh 性能好很多。

---

# 92. Frame Geometry

边梁 2~4 Mesh 即可。

---

# 93. Support Instancing

支腿也可以使用 InstancedMesh。

---

# 94. LOD

远距离：

```text
隐藏单根滚筒
显示简化辊道面
```

近距离显示完整滚筒。

后期可以加。

---

# 95. Collision Bounds

参数化 Component 很容易计算：

```text
Box3
```

因为 length / width / height 都已知。

---

# 96. 编辑器碰撞

拖模型时 Bounds 可以用于防止两个辊道完全重叠。

注意：这不是用于正常物流 Capacity。

---

# 97. Capacity 仍然是业务容量

之前原则保持：

```text
Capacity = 用户配置
```

不要运行时用 Length / PalletSize 实时推导。

---

# 98. Capacity 推荐值

可以根据 length 自动给 Recommended Capacity。

例如：

```text
8m → 推荐 5
```

但最终用户设置值为权威。

---

# 99. Component Validation

发布前验证：

```text
Length > 0
Width > 0
Capacity >= 1
Input / Output 正常
连接类型匹配
```

---

# 100. 类型兼容

V6 已有：

```text
small + plastic-pallet / carton
large + wooden-pallet / carton
```

Component 保存时继续验证。

---

# 101. Connection Compatibility

例如 Small Conveyor → Large Conveyor 不一定禁止。

但是 TransportUnitType 必须兼容。

---

# 102. Transport Unit 不兼容

```text
Plastic Pallet Section
↓
Wooden Pallet Only Section
```

禁止连接或发布警告。

---

# 103. 发布版本

Component Instance Properties 必须进入 Scene Manifest。

Published Version 冻结。

---

# 104. Draft 修改

用户：

```text
Length 8 → 10
```

只是 Draft。

直到 Publish 后，Published Viewer 才使用新版本。

---

# 105. 资源更新不能改变旧 Published Scene

这是生产数字孪生很重要的规则。

---

# 106. 推荐目录结构

```text
ClientApp/src/digital-twin/

components/
│
├─ ComponentRegistry.ts
├─ TwinComponentFactory.ts
│
├─ conveyor/
│   ├─ RollerConveyorComponent.ts
│   ├─ RollerConveyorGeometry.ts
│   ├─ RollerConveyorSchema.ts
│   └─ RollerConveyorPorts.ts
│
├─ junction/
├─ process/
└─ transfer/

runtime/
│
├─ TwinRuntime.ts
├─ TwinMaterialFlowRuntime.ts
├─ TwinTopologyResolver.ts
└─ ...

editor/
│
├─ ComponentDragService.ts
├─ ComponentSnapService.ts
├─ ComponentConnectionService.ts
└─ DynamicComponentPropertyPanel.vue
```

---

# 107. 后端建议目录

```text
DigitalTwin/
│
├─ ModelResources/
├─ Components/
│   ├─ ComponentResourceService
│   ├─ ComponentSchemaValidator
│   └─ ComponentVersionService
│
├─ Scenes/
└─ Versions/
```

---

# 108. 第一阶段最小实现

P0 不需要一次做完全部功能。

先完成：

```text
1. 抽离 addRollerLane
2. RollerConveyorComponent
3. 标准小辊道注册资源库
4. 拖入场景
5. Length 修改
6. Capacity 修改
7. TransportUnit 修改
8. 保存 Draft
9. 重新加载场景
10. 发布后 Viewer 正确显示
```

---

# 109. 第二阶段

```text
Input / Output Port
Snap
Connection
```

---

# 110. 第三阶段

```text
Auto Section
Auto Route
Auto Topology
```

---

# 111. 第四阶段

```text
大辊道
90°转弯
分流
汇流
```

---

# 112. 第五阶段

```text
旋转台
提升机
外检机
套袋机
桁架
```

---

# 113. P0 验收

资源库存在：

```text
标准小辊道
```

拖入三个：

```text
Conveyor01
Conveyor02
Conveyor03
```

分别设置不同：

```text
Length
Capacity
TransportUnit
```

保存 Draft，关闭页面重新进入仍然正确。

发布后 Published Viewer 仍然正确。

并且不修改 `ProceduralPackagingLine.ts` 即可搭建新的简单输送场景。

---

# 114. P1 验收

两个辊道：

```text
Output
靠近
Input
```

自动吸附。

连接后 Connections 写入 Manifest。

---

# 115. P2 验收

连接三个组件：

```text
C1 → C2 → C3
```

自动：

```text
Section1 → Section2 → Section3
```

运行时 Capacity / Waiting / Resume 正常。

---

# 116. P3 验收

换新场景时：

```text
不用写任何 TS
```

只通过：

```text
资源库
+
拖拽
+
属性
+
连接
```

即可完成大部分输送线。

---

# 117. 不推荐的方案

不推荐：

```text
所有长度都制作 GLB
```

不推荐：

```text
一个 GLB 用 Scale 拉伸
```

不推荐：

```text
继续在 ProceduralPackagingLine.ts 增加更多 addXXX()
```

不推荐：

```text
为智能模型单独再建一个组件库
```

继续使用现有模型资源库即可。

---

# 118. 最终目标架构

```text
                    模型资源库
                         │
        ┌────────────────┼───────────────┐
        │                │               │
        ▼                ▼               ▼
     GLB Model      Procedural       Smart Model
                   Component
                        │
                        ▼
                Roller Conveyor
                        │
                 Drag Into Scene
                        │
                        ▼
                Component Instance
                        │
        ┌───────────────┼────────────────┐
        │               │                │
        ▼               ▼                ▼
    Geometry         Runtime          Ports
    Length           Capacity       Input/Output
    Width            UnitType            │
    Pitch            Occupancy           ▼
                                      Snap
                                        │
                                        ▼
                                   Connection
                                        │
                                        ▼
                                Topology Resolver
                                        │
                                        ▼
                              Route / TwinSection
                                        │
                                        ▼
                              TwinMaterialFlowRuntime
```

---

# 119. 最终的用户体验

未来用户不需要知道：

```text
addRollerLane()
Three.js Geometry
RouteEngine
SectionManager
```

用户只需要：

```text
1. 打开模型资源库
2. 拖标准小辊道
3. 设置：长度 8m、容量 5、输送对象 塑料托盘
4. 再拖一段
5. 靠近
6. 自动吸附
7. 运行
```

---

# 120. 最终结论

对于 IoTSharp 当前架构：

> 最正确的方向不是把现在的小辊道简单导出成固定 GLB，而是把它升级为“模型资源库中的参数化智能模型”。

这样同时解决：

```text
换场景不用改代码
不同长度不用制作多个 GLB
滚筒不会因为 Scale 变形
Capacity 可以独立配置
Plastic Pallet / Carton 可以选择
Input / Output 可以自动吸附
Section 可以自动建立
Route 可以自动推导
PLC Binding 可以复用
场景 Draft / Publish 可以持久化
```

因此建议下一版优先实现：

```text
RollerConveyorComponent
+
Component Resource
+
Dynamic Properties
```

把它作为 IoTSharp 数字孪生第一个真正的可复用智能组件。

完成这个基础以后，再继续迁移：

```text
大辊道
转弯辊道
分流器
汇流器
旋转台
提升机
外检机
套袋机
```

最终 `ProceduralPackagingLine.ts` 只用于快速生成示例场景 / 模板，而不再承担每一个项目真实线体的硬编码实现。


---

# 121. V7 补充：专业编辑与路线编辑统一为同一 Three.js Scene

> 本节为 V7 实际开发后的重要架构修订。  
> 原 V7 文档中“组件、Connection、Route 自动生成”的方向保持不变，但编辑器的 Scene 归属进一步明确：
>
> **专业编辑是唯一的工程坐标场景。**
>
> 路线编辑不再使用一套脱离专业编辑器的独立 Three.js Scene。

---

# 122. 原来为什么会出现“路线运行能显示，专业编辑看不到路线”

此前 Workbench 实际存在两套 Three.js Scene：

```text
专业编辑
    ↓
ThreeJsEditorHost
    ↓
ThreeEditorCoreHost
    ↓
threejs-editor.viewer.scene
```

以及：

```text
路线运行 / Runtime
    ↓
ThreeJsEditorAdapter
    ↓
TwinRuntime
    ↓
TwinRuntime.scene
```

原 Route Point / Route Edge 的绘制代码主要存在于：

```text
TwinRuntime
```

所以产生：

```text
                Manifest
                    │
          ┌─────────┴─────────┐
          │                   │
   Professional Scene     Runtime Scene
          │                   │
GLB       ✅              GLB / Runtime ✅
V7组件    ✅              Component      ✅
Route     ❌              Route          ✅
```

表现为：

```text
路线运行：
能看到路线

专业编辑：
只能看到模型 / Component
看不到 Route
```

---

# 123. 这个架构为什么存在风险

如果：

```text
设备位置
```

在 Professional Scene 中编辑，

而：

```text
路线
```

在另一张 Runtime Scene 中编辑，

那么两个系统虽然都读取 Manifest，但仍然存在：

```text
相机不同
Scene 不同
对象生命周期不同
TransformControls 不同
坐标更新时机不同
```

最终可能出现：

```text
专业编辑：
Conveyor A 在 X = 10

路线 Scene：
Route 仍按照旧 X = 8 显示
```

甚至：

```text
Route 数据本身正确
但实际设备已经被用户移动
```

所以 V7 最终明确：

> **工程布局只能有一个权威 Scene。**

---

# 124. 最终 Scene 原则

正式架构：

```text
Professional Editor Scene
=
唯一工程坐标 Scene
```

里面同时包含：

```text
GLB Model
+
V7 Component
+
Port
+
Connection
+
TwinSection 可视辅助
+
Route Point
+
Route Edge
```

Runtime 不再承担工程位置编辑。

---

# 125. 两种视图重新定义

Workbench 两个模式重新定义为：

```text
专业编辑
```

和：

```text
运行预览
```

而不是原来的：

```text
专业编辑
路线运行
```

---

## 专业编辑

职责：

```text
模型位置
组件位置
组件尺寸
Port
Connection
Section
Route
路线控制点
分流布局
工位位置
```

所有：

```text
工程坐标
```

都以这里为权威。

---

## 运行预览

职责：

```text
Simulation
PLC
IoT
WCS
MaterialFlow
Animation
Waiting
Blocking
Occupancy
Alarm
Metrics
```

运行预览只消费：

```text
已保存的工程布局
+
Runtime State
```

不再作为权威工程布局编辑器。

---

# 126. 新增 ThreeEditorRouteOverlay

新增：

```text
ClientApp/src/digital-twin/editor-adapter/
    ThreeEditorRouteOverlay.ts
```

职责：

```text
TwinRouteDefinition
↓
Route Point Mesh
+
Route Edge Line
↓
直接加入：
threejs-editor.viewer.scene
```

也就是说：

```text
Route
```

和：

```text
GLB / V7 Component
```

使用完全相同的：

```text
Scene
Camera
World Matrix
World Coordinate
TransformControls
```

---

# 127. ThreeEditorRouteOverlay 结构

```text
IoTSharp Route Overlay
│
├─ Route Edges
│
└─ Route Points
```

Route Overlay 自己属于：

```text
Editor Helper
```

不会成为生产设备模型的一部分。

其 `userData` 标记：

```text
iotsharpTwinHelper = true
iotsharpRouteOverlay = true
```

避免编辑器把辅助对象误当正式业务对象。

---

# 128. Route Point 颜色约定

当前工程显示建议：

```text
普通 waypoint
    青蓝

Junction
    橙色

Diverter
    黄色 / 橙色

Merger
    紫色

Process Station
    粉紫

Sensor
    绿色

Buffer
    蓝色

Station
    青绿色
```

目的不是做 Runtime 状态颜色，而是让工程人员在专业编辑模式下快速识别节点类型。

---

# 129. Route Edge 绘制

Route Edge 根据：

```text
fromPointId
toPointId
```

从当前 `TwinRouteDefinition.points` 中获取世界坐标。

因此：

```text
Point Position Changed
↓
Overlay Rebuild
↓
Edge Geometry Rebuild
```

路线不会保存另一份独立坐标。

---

# 130. Route Point 可以直接在专业编辑场景选择

Route Point Mesh 写入：

```text
iotsharpRoutePointId
iotsharpRoutePointIndex
```

用户点击路线点：

```text
threejs-editor Raycast
↓
识别 Route Point
↓
selected.kind = route-point
```

专业编辑和模型选择仍然共用同一套场景鼠标事件。

---

# 131. Route Point 直接使用 TransformControls

选中路线点后：

```text
threejs-editor TransformControls
```

直接 Attach 到 Route Point Mesh。

用户拖动：

```text
Route Point Mesh
↓
Transform Changed
↓
同步 TwinRoutePointDefinition.position
↓
Route Overlay Rebuild
↓
Manifest 更新
```

不再切换到 Runtime Scene。

---

# 132. 拖动路线点的数据流

```text
用户拖 Route Point
        ↓
threejs-editor TransformControls
        ↓
Route Point Mesh.position
        ↓
ThreeEditorRouteOverlay.syncPointToRoute()
        ↓
TwinRoutePointDefinition.position
        ↓
onRouteChange()
        ↓
Workbench Manifest
        ↓
Draft
```

这保证：

> UI 显示位置和真正保存的 Route 坐标是同一份数据。

---

# 133. 专业编辑支持“路线编辑”模式

ThreeEditorCoreHost 新增：

```text
setRouteEditMode()
```

开启：

```text
Route Point 显示
Route Point 可选择
Route Point 可 Transform
```

关闭时：

```text
仍可显示路线
```

但减少误操作。

---

# 134. 专业编辑支持“连续绘制”

ThreeEditorCoreHost 新增：

```text
setRouteDrawMode()
```

开启以后：

```text
鼠标点击专业编辑场景地面
↓
Raycast Ground Plane
↓
得到同一 Scene 世界坐标
↓
新增 Route Point
↓
自动连接上一控制点
↓
Overlay Rebuild
```

所以用户不再：

```text
切到 Runtime
↓
再画路线
```

---

# 135. 路线绘制坐标必须来自专业场景

这是此次修改的核心要求。

错误：

```text
Runtime Camera Raycast
↓
得到 Runtime Scene 坐标
```

正确：

```text
Professional Editor Camera
+
Professional Editor Canvas
+
Professional Editor Ground Plane
↓
World Position
```

因此用户：

```text
看到设备在哪里
```

路线点击得到的坐标：

```text
就在哪里
```

---

# 136. Workbench 顶部“绘制路线”行为修改

原来：

```text
点击“绘制路线”
↓
自动切换 Runtime
↓
TwinRuntime Route Draw
```

现在：

```text
点击“绘制路线”
↓
自动切换“专业编辑”
↓
setRouteEditMode(true)
↓
setRouteDrawMode(true)
```

结束绘制：

```text
setRouteDrawMode(false)
```

仍停留在专业编辑。

---

# 137. 左侧路线面板也不再强制切 Runtime

以下操作：

```text
修改 Route Point X/Y/Z

新增 Route Point

删除 Route Point

新增 Edge

删除 Edge

修改 curveKind

修改 loop

修改 Process Station

修改 Diverter / Merger

修改 Capacity

修改 TransportUnitType
```

在：

```text
viewportMode = editor
```

时直接调用：

```text
professionalEditor
```

同步专业编辑里的 Route Overlay。

---

# 138. Route Graph 同步策略

现在：

```text
syncRouteGraph()
```

根据当前模式：

## Professional

```text
Manifest Route
↓
professionalEditor.setRoute()
↓
RouteOverlay.refresh()
```

## Runtime Preview

```text
Manifest Route
↓
TwinRuntime.setRoute()
```

因此：

```text
Manifest
```

仍然是共同的数据合同，

但：

```text
工程编辑
```

以 Professional Scene 为权威。

---

# 139. 模型移动以后路线如何保持一致

V7 Component 仍然支持：

```text
TransformControls Drag End
↓
syncTransformsToManifest()
```

如果组件发生：

```text
Port 自动吸附
```

则：

```text
snapAndConnectNearestComponent()
↓
Component Transform 更新
↓
Connection 更新
↓
upsertGeneratedComponentRoute()
↓
Route Overlay Rebuild
```

所以模型移动以后：

```text
Connection
Section
Route
```

会同步重新生成 / 刷新。

---

# 140. 自动吸附与专业路线显示

现在推荐完整链路：

```text
Conveyor01
     │
 Output
     ●

        用户拖 Conveyor02

         ●
       Input
         │
Conveyor02
```

靠近：

```text
Snap
↓
Component02 Transform 修正
↓
Connection Created
↓
Section Graph Updated
↓
Generated Route Updated
↓
Professional Route Overlay Updated
```

用户不需要切换页面验证 Route 是否正确。

---

# 141. Connection、Section 和 Route 的工程关系

最终推荐：

```text
Component
│
├─ Port
│
├─ Section
│
└─ Transform

Component Connection
        ↓
Topology Resolver
        ↓
Generated Route
        ↓
ThreeEditorRouteOverlay
```

因此 Route 不是另一张 Scene 中的独立几何。

---

# 142. 专业编辑里的完整工程图

V7 最终专业编辑 Scene：

```text
threejs-editor.viewer.scene
│
├─ Factory / GLB
│
├─ Robot
│
├─ Gantry
│
├─ Small Conveyor Component
│
├─ Large Conveyor Component
│
├─ Diverter
│
├─ Merger
│
├─ Lift
│
├─ Turntable
│
├─ External Inspection
│
├─ Bagging Machine
│
│
├─ Component Port Helper
├─ Connection Helper
├─ Section Helper
│
└─ IoTSharp Route Overlay
    ├─ Route Points
    └─ Route Edges
```

这才是一张真正的数字孪生工程编辑 Scene。

---

# 143. 为什么 Runtime Scene 仍然保留

Runtime Scene 不是删除。

它仍然非常有价值。

职责：

```text
Pallet Animation
SilkCake Animation
Robot Animation
Gantry Animation
Material Flow
Section Occupancy
PLC Signal
Waiting
Block Propagation
Alarm
Metrics
```

但其身份变成：

```text
Runtime Projection
```

而不是：

```text
Engineering Authoring Scene
```

---

# 144. 工程数据权威关系

最终：

```text
Scene Manifest
        │
        ├── Object Transform
        ├── Component
        ├── Connection
        ├── Section
        └── Route
                │
                ▼
     Professional Editor
          AUTHORING
                │
                ▼
              Save
                │
                ▼
             Draft
                │
                ▼
            Published
                │
                ▼
         Runtime Preview
```

---

# 145. 不允许 Runtime 覆盖专业编辑坐标

Runtime 可以：

```text
移动 Pallet
移动 Cake
移动 Robot Arm
移动 Gantry
```

但不能把：

```text
Conveyor
Process Station
Route Point
Static Equipment
```

的工程位置反写到 Manifest。

工程位置只能由：

```text
Professional Editor
```

写入。

---

# 146. Workbench 文案调整

原：

```text
专业编辑
路线运行
```

调整：

```text
专业编辑
运行预览
```

页面底部提示：

## Professional

```text
专业编辑是唯一工程坐标场景：
模型、V7组件、Port、Connection、Section 与 Route 同图编辑；
路线点可直接选择和拖动。
```

## Runtime

```text
运行预览只负责仿真/实时状态；
工程位置以专业编辑场景为准。
```

---

# 147. 保存 Draft 时的路线来源

保存：

```text
Professional Editor
↓
captureManifest()
```

在保存前同步：

```text
Object Transform
Route Point Position
Component Properties
Connections
```

所以：

```text
Draft Manifest
```

保存的是专业编辑里用户实际看到的布局。

---

# 148. Published Scene 的坐标来源

Publish：

```text
Draft
↓
Validation
↓
Immutable Published Version
```

Published Viewer 读取的：

```text
Object Transform
Route
Section
Connection
```

全部来自同一份 Manifest。

因此不会存在：

```text
专业编辑一套坐标
发布 Runtime 又一套坐标
```

---

# 149. Route Overlay 不应该被序列化为正式 Object

需要明确：

```text
ThreeEditorRouteOverlay
```

只是：

```text
Editor Visualization Helper
```

真正持久化的是：

```text
TwinRouteDefinition
```

不是：

```text
THREE.Line
THREE.Mesh
```

否则编辑器 JSON 会产生大量无意义辅助 Mesh。

---

# 150. threejs-editor Snapshot 与 IoTSharp Manifest 的边界

专业编辑器自己的 Snapshot：

```text
editorExtension.threeEditor
```

主要保存：

```text
Camera
Lighting
Post Processing
GLB Editor Data
```

而 IoTSharp 业务数据：

```text
Objects
Components
Connections
Routes
Sections
Bindings
```

仍然保存在：

```text
TwinSceneManifest
```

Route Overlay 每次从 Manifest 重建。

---

# 151. Route Point 与 ThreeEditor Snapshot 的关系

Route Point 不需要进入：

```text
threeEditor.modelParams
```

因为权威数据已经存在：

```text
manifest.routes[].points[]
```

这样：

```text
Route
```

不会同时存在两套持久化来源。

---

# 152. Professional Editor Route API

ThreeEditorCoreHost 最终提供：

```ts
setRoute(route)

getRoute()

refreshRouteOverlay()

setRouteVisible(visible)

setRouteEditMode(enabled)

setRouteDrawMode(enabled)

selectRoutePoint(pointId)

addRoutePoint()

removeRoutePoint(index)

updateRoutePoint(
    index,
    position
)
```

Workbench 通过这套 API 操作路线。

---

# 153. Component Property 修改后 Route 更新

例如：

```text
Small Conveyor
Length:
3m
→
8m
```

执行：

```text
Component Property Changed
↓
Component Rebuild
↓
Port Local Position Recalculate
↓
World Port Recalculate
↓
Connection Revalidate
↓
Generated Route Rebuild
↓
Professional Route Overlay Rebuild
```

因此用户改辊道长度时能立即看到路线变化。

---

# 154. Route 与手工路线的关系

未来场景可能存在两类 Route：

```text
Generated Route
```

来自：

```text
Component Connection
```

和：

```text
Manual Route
```

由用户手动画。

二者都显示在：

```text
Professional Scene
```

但建议使用不同 Metadata：

```ts
route.source:
    'generated'
    | 'manual'
```

这可以作为下一阶段增强。

---

# 155. 自动生成 Route 的编辑限制建议

对于：

```text
Generated Route
```

不建议用户直接拖中间 Route Point 破坏拓扑。

应该提示：

```text
此路线由组件连接自动生成。
请移动设备或修改 Port / Connection。
```

对于：

```text
Manual Route
```

则允许自由拖动控制点。

这样可以防止：

```text
模型在 A
Port 在 A
但用户把 Generated Route 拖到 B
```

重新制造数据不一致。

---

# 156. Section 可视化建议

后续可以在 Professional Scene 增加：

```text
Section Overlay
```

例如：

```text
半透明包围框
```

显示：

```text
Section ID
Capacity
TransportUnit
```

但 Section 仍然是业务数据，不是 Mesh 权威数据。

---

# 157. Port 可视化建议

Professional Scene：

```text
未连接 Input
黄色

未连接 Output
橙色

已连接
绿色

不兼容
红色
```

用户拖模型时才显示 Port，可减少场景杂乱。

---

# 158. Connection 可视化建议

Connection 可以绘制：

```text
Port → Port
```

辅助线。

与 Route 区分：

```text
Connection
=
设备拓扑连接

Route
=
物料运行路线
```

两者通常一致，但语义不同。

---

# 159. 专业编辑的工程显示层级开关

长期建议增加：

```text
显示
├─ Model
├─ Component
├─ Port
├─ Connection
├─ Section
└─ Route
```

这样大型工厂场景可以关闭不需要的辅助层。

---

# 160. 本次已经落地的修改

截至 V7 本次补充，已实际落地：

```text
ThreeEditorRouteOverlay                    ✅

Route 进入 Professional Scene             ✅

Route Point 显示                           ✅

Route Edge 显示                            ✅

Route Point 选择                           ✅

Route Point TransformControls 拖动         ✅

专业编辑路线 Edit Mode                     ✅

专业编辑连续 Draw Mode                     ✅

专业编辑地面 Raycast 新增控制点             ✅

Workbench 路线修改不再强制进入 Runtime      ✅

顶部“绘制路线”改为进入专业编辑              ✅

Runtime 模式改名“运行预览”                  ✅

Route Change 回写 Workbench Manifest       ✅

Component Snap 后刷新专业路线               ✅

正式 ClientApp Production Build            ✅
```

---

# 161. V7 当前最终开发状态

## 参数化组件

```text
小辊道       ✅
大辊道       ✅
90°转弯      ✅
分流         ✅
汇流         ✅
提升机       ✅
旋转台       ✅
外检机       ✅
套袋机       ✅
```

## 资源库

```text
Built-in Component Catalog   ✅

模型资源库展示                ✅

放入场景                      ✅

数据库注册 API                ✅
```

## 编辑器

```text
Component 编辑               ✅

动态 Schema 属性             ✅

Input / Output Port          ✅

自动 Snap                    ✅

Connection                   ✅

Connection 持久化            ✅

自动 Section                 ✅

自动 Route                   ✅

专业编辑显示 Route            ✅

专业编辑直接编辑 Route        ✅
```

## Runtime

```text
Component Runtime Loading    ✅

TwinMaterialFlow             ✅

Simulation Preview           ✅

工程布局读取 Manifest         ✅
```

---

# 162. V7 现在的最终原则

最终不再是：

```text
专业编辑
+
另一套独立路线编辑 Scene
```

而是：

```text
                   TwinSceneManifest
                          │
                          ▼
              Professional Editor
                 唯一工程 Scene
                          │
      ┌───────────────────┼────────────────────┐
      │                   │                    │
      ▼                   ▼                    ▼
    Model              Component              Route
      │                   │                    │
      ▼                   ▼                    ▼
 Transform            Port/Section       Route Overlay
      └───────────────────┬────────────────────┘
                          │
                          ▼
                    Save / Publish
                          │
                          ▼
                    Runtime Preview
```

---

# 163. 对后续场景搭建的影响

未来创建新场景时：

```text
拖小辊道
↓
改 Length

拖转弯
↓
自动 Snap

拖分流器
↓
自动 Connection

拖外检机
↓
连接

打开路线显示
↓
直接在同一专业场景看到路线

需要人工补线
↓
直接在同一场景绘制
```

整个过程不再需要：

```text
编辑设备
↓
切换另一个 Scene
↓
再猜路线是否和设备对齐
```

---

# 164. V7 修订后的最终结论

V7 最终应理解成两部分：

## 第一部分：组件化

```text
固定场景代码
↓
参数化智能 Component
```

解决：

```text
换场景需要改 TypeScript
```

的问题。

## 第二部分：统一工程坐标

```text
Professional Scene
+
Route Editing
+
Component Editing
+
Topology Editing
```

统一在：

```text
threejs-editor.viewer.scene
```

解决：

```text
模型和路线可能对不上
```

的问题。

最终目标：

> **用户在专业编辑器里看到什么，保存和发布的工程坐标就是什么；运行预览只是运行这份工程布局，而不是重新定义另一套布局。**

这才是 IoTSharp 数字孪生从“程序化示例场景”升级到“真正可配置工业三维场景编辑平台”的完整 V7 架构。
