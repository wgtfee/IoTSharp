# IoTSharp V7 参数化工业数字孪生封版收口详细设计方案

> 仓库：`wgtfee/IoTSharp`
> 分支：`Develop`
> 当前基线：`be3e5a7b11732f7250f9d0071f3b7c277fefce00`
> 当前提交：`feat: 完善 V7 参数化数字孪生组件`
> 文档定位：V7 封版前最后一轮生产化收口方案

---

## 1. 目标

V7 已经完成参数化组件、专业编辑与路线编辑统一、Port、Connection、自动 Section/Route、数据库组件注册、动态属性面板、自动吸附、丝饼线基础设施迁移等主链。当前主架构已经形成：

```text
Model Resource
    ↓
Component Template
    ↓
Component Instance
    ↓
Port
    ↓
Connection
    ↓
Component Network
    ↓
Route
    ↓
Section
    ↓
TwinMaterialFlowRuntime
```

V7 后续不应继续无限增加模型类型，而应完成生产化收口。本方案定义 5 个核心任务：

```text
P0-1  V7 Smoke Test 正式接入 CI
P0-2  Component Generator 真正版本化
P0-3  一个 Scene 支持多个独立 Component Network / Route
P0-4  Smart Model 标准 PLC Binding Slot
P1-1  丝饼线剩余固定辊道完全迁移为 V7 Component
```

建议同步完成：

```text
P1-2  工程空间/布局校验
P1-3  Port / Connection / Section / Route 图层管理
P2-1  SubAssembly 组合模板
P2-2  大场景性能优化
P2-3  README / V7 文档同步
```

前 5 项完成后，V7 可以正式封版并进入 Stable / Maintenance。

---

## 2. 当前 V7 已完成能力

### 2.1 内置参数化/智能组件

当前已有 9 个内置模板：

1. 标准小辊道
2. 标准大辊道
3. 90° 转弯辊道
4. 分流辊道
5. 汇流辊道
6. 提升机
7. 旋转台
8. 外检机
9. 套袋机

组件由 `BuiltInComponentCatalog.ts` 定义，由 `ComponentRegistry.ts` 统一生成。

### 2.2 TransportUnitType

当前核心输送对象：

```text
plastic-pallet
wooden-pallet
carton
```

推荐约束保持：

```text
小辊道：plastic-pallet / carton
大辊道：wooden-pallet / carton
```

Connection 吸附时继续校验 TransportUnitType，避免不兼容输送对象被自动连接。

### 2.3 Port / Connection

当前已经具备：

```text
默认 Snap 距离：0.5m
默认方向容差：15°
端口必须相向
TransportUnitType 必须兼容
同一个 Port 不能被多个 Connection 重复占用
组件移动后重校验 Connection
失效 Connection 自动清理
```

### 2.4 自动 Route / Section

当前自动路线由组件连接推导：

```text
Component
  ↓
Ports
  ↓
Connections
  ↓
buildComponentGraphRoute()
  ↓
TwinRouteDefinition
```

自动生成路线应继续带：

```text
generatedBy = component-connections
```

并保持只读：用户不能直接拖动自动 Route Point，只能通过移动组件或改变 Connection 调整拓扑。

### 2.5 专业编辑统一

GLB、V7 Component、Route Point、Route Edge 已统一到：

```text
threejs-editor.viewer.scene
```

路线由 `ThreeEditorRouteOverlay` 叠加，因此专业编辑应继续作为唯一工程坐标 Scene。

---

# 3. P0-1：V7 Smoke Test 正式接入 CI

## 3.1 当前问题

项目已经有：

```json
"verify:v7-components": "node scripts/run-v7-components-smoke.mjs"
```

Smoke Test 已覆盖：

```text
9 个模板可生成
Three.js Geometry 存在
Port 坐标合法
数据库注册元数据存在
0.5m / 15° Snap
TransportUnitType 不兼容禁止连接
Connection 持久化
Section / Route 自动生成
Connection 失效清理
Scale 锁定
```

但 `develop-digital-twin-build.yml` 目前只执行：

```text
npm install
npm run build
```

所以组件测试还不是 CI Gate。

## 3.2 推荐 CI

```yaml
name: Develop Digital Twin Build

on:
  push:
    branches: [Develop]
    paths:
      - 'ClientApp/**'
      - '.github/workflows/develop-digital-twin-build.yml'
  pull_request:
    branches: [Develop]
    paths:
      - 'ClientApp/**'

jobs:
  build-client:
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      - uses: actions/checkout@v5

      - name: Use Node.js 22
        uses: actions/setup-node@v4
        with:
          node-version: 22.x

      - name: Install dependencies
        working-directory: ClientApp
        run: npm install --legacy-peer-deps --no-audit --no-fund

      - name: Verify V7 Components
        working-directory: ClientApp
        run: npm run verify:v7-components

      - name: Build ClientApp
        working-directory: ClientApp
        run: npm run build
```

## 3.3 Smoke Test 继续增加

新增以下用例：

### Case A：Generator Version

```text
roller-conveyor-v1@1 → 必须加载 V1
roller-conveyor-v1@2 → 必须加载 V2
不存在版本 → Validation Error
```

### Case B：Multiple Network

```text
A1 → A2 → A3
B1 → B2
```

必须生成两条自动 Route，而不是一条包含两个断开的图。

### Case C：Binding Slot

外检机绑定：

```text
ready
busy
complete
result
fault
```

生成 RoutePoint 后必须继承对应 BindingId。

### Case D：发布兼容

旧 Generator 版本必须可重新打开并生成完全相同的 Port / Geometry / Bounds。

## 3.4 验收

```text
[ ] npm run verify:v7-components 成功
[ ] npm run build 成功
[ ] GitHub Develop Digital Twin Build 成功
[ ] 破坏组件基础规则时 CI 必须失败
```

---

# 4. P0-2：Component Generator 真正版本化

## 4.1 当前风险

当前 Registry 主要按 `componentType` 选择生成器。虽然 Manifest 保存了：

```text
generator
generatorVersion
```

但实例化没有严格按 `generator + generatorVersion` 选实现。

风险是：Published Scene 保存的是 V1，半年后修改了 `RollerConveyorComponent.ts`，旧 Published Scene 再打开时也会执行新代码，从而破坏“已发布版本不可变”。

## 4.2 正确 Generator Key

建议：

```text
GeneratorKey = generator + "@" + generatorVersion
```

例如：

```text
roller-conveyor-v1@1
roller-conveyor-v1@2
turntable-v1@1
external-inspection-v1@1
```

## 4.3 Registry 改造

建议：

```ts
interface TwinComponentGeneratorDescriptor {
    componentType: TwinComponentType;
    generator: string;
    generatorVersion: number;
    implementation: TwinComponentGenerator;
}

class ComponentRegistry {
    private readonly generators = new Map<string, TwinComponentGeneratorDescriptor>();

    private key(generator: string, version: number) {
        return `${generator}@${version}`;
    }

    register(
        generator: string,
        generatorVersion: number,
        implementation: TwinComponentGenerator
    ) {
        this.generators.set(this.key(generator, generatorVersion), {
            componentType: implementation.componentType,
            generator,
            generatorVersion,
            implementation
        });
        return this;
    }

    create(definition: TwinComponentDefinition) {
        const key = this.key(definition.generator, definition.generatorVersion);
        const descriptor = this.generators.get(key);
        if (!descriptor) throw new Error(`未注册组件生成器 ${key}`);
        if (descriptor.componentType !== definition.componentType) {
            throw new Error(`组件类型与 Generator 不匹配：${key}`);
        }
        return descriptor.implementation.create({ definition });
    }
}
```

## 4.4 TwinComponentDefinition 必须完整携带

```ts
interface TwinComponentDefinition {
    objectId: string;
    name: string;
    resourceId?: string;
    resourceKey: string;
    componentType: TwinComponentType;
    generator: string;
    generatorVersion: number;
    properties: Record<string, unknown>;
    transform: TwinTransform;
    sectionId?: string;
    routeEdgeId?: string;
}
```

## 4.5 版本规则

以下修改通常不升级：

```text
性能优化
dispose 修复
材质缓存
无语义变化的重构
```

以下修改必须升级 GeneratorVersion：

```text
几何算法变化
Port 数量/ID/位置变化
Bounds 变化
业务语义变化
运行能力变化
```

原则：

```text
旧 Generator 一旦进入 Published Scene，就不再改变其输出语义。
```

## 4.6 Component Migration

建议新增：

```text
ComponentMigrationRegistry.ts
```

```ts
interface TwinComponentMigration {
    generator: string;
    fromVersion: number;
    toVersion: number;
    migrate(properties: Record<string, unknown>): Record<string, unknown>;
}
```

用户主动升级组件时：

```text
Properties V1
   ↓
Migration
   ↓
Properties V2
```

Published Scene 永远不自动升级。

## 4.7 改动文件

```text
ComponentRegistry.ts
types.ts
ComponentManifestValidator.ts
ComponentTemplateFactory.ts
ThreeEditorCoreHost.ts
TwinRuntime.ts
verify-v7-components.ts
```

建议新增：

```text
ComponentMigrationRegistry.ts
```

---

# 5. P0-3：多个 Component Network / Route

## 5.1 当前问题

当前所有 Component 最终倾向形成一个 `component-auto-route`。单条线没问题，但真实工厂可能同时有：

```text
包装线 A
包装线 B
纸箱输送线
空托盘回流线
木托盘线
```

它们可能完全不连通。

## 5.2 正确模型

```text
Scene
├─ ComponentNetwork-A
│   └─ Route-A
│       └─ Sections
├─ ComponentNetwork-B
│   └─ Route-B
│       └─ Sections
└─ ComponentNetwork-C
    └─ Route-C
        └─ Sections
```

## 5.3 Network 识别

使用 Connection Graph：

```text
Component = Vertex
Connection = Edge
```

通过 DFS/BFS/Union-Find 找 Connected Components。

例如：

```text
A → B → C
D → E
F
```

得到：

```text
Network 1 = A,B,C
Network 2 = D,E
Network 3 = F
```

独立但没有 Connection 的单设备是否单独生成 Route，可根据“组件是否具备内部流向”判断。

## 5.4 稳定 Network ID

不要使用数组序号。建议：

```text
component-network-{stableHash(sortedObjectIds)}
component-route-{stableHash(sortedObjectIds)}
```

只要网络成员不变，RouteId 就保持稳定。

## 5.5 API 改造

将：

```text
buildComponentGraphRoute()
```

升级为：

```text
buildComponentGraphRoutes()
```

```ts
interface TwinComponentNetworkBuildResult {
    networkId: string;
    route: TwinRouteDefinition;
    componentObjectIds: string[];
    connectionCount: number;
}
```

返回：

```ts
TwinComponentNetworkBuildResult[]
```

## 5.6 Manifest 可选扩展

```ts
interface TwinComponentNetworkDefinition {
    networkId: string;
    name?: string;
    objectIds: string[];
    routeId: string;
    transportUnitType?: string;
    lineCode?: string;
    metadata?: Record<string, unknown>;
}
```

第一阶段 Network 可自动推导，不要求持久化；第二阶段允许用户命名为“包装主线”“空托回流”等。

## 5.7 Runtime 演进

当前 Runtime 不应长期依赖：

```text
manifest.routes[0]
```

建议后续增加：

```text
TwinRouteRuntimeManager
```

内部：

```text
Map<RouteId, RouteEngine>
Map<RouteId, TwinMaterialFlowRuntime>
```

V7 收口阶段可以先做到：

```text
多 Route 正确生成 + 正确保存 + 正确显示
```

V8 再推进所有 Route 真正并行运行。

## 5.8 验收

```text
[ ] 一个 Scene 可存在两条互不连接的产线
[ ] 自动生成两个 Route
[ ] RouteId 稳定
[ ] 修改 A 网络不影响 B 网络
[ ] 删除 A Connection 不清理 B Route
```

---

# 6. P0-4：Smart Model 标准 PLC Binding Slot

## 6.1 Smart Model 最终定义

Smart Model 不应只是“Three.js + 属性”，而应该是：

```text
Smart Model
=
Geometry
+ Port
+ Runtime Semantics
+ Binding Slots
+ Process Contract
+ Diagnostics
```

## 6.2 Binding Slot 类型

建议：

```ts
export type TwinBindingSlotDataType = 'bool' | 'int' | 'float' | 'string';
export type TwinBindingSlotDirection = 'input' | 'output';

export interface TwinComponentBindingSlot {
    slotId: string;
    name: string;
    description?: string;
    direction: TwinBindingSlotDirection;
    dataType: TwinBindingSlotDataType;
    required?: boolean;
    semantic:
        | 'ready'
        | 'busy'
        | 'complete'
        | 'fault'
        | 'result'
        | 'route-code'
        | 'target-position'
        | 'actual-position'
        | 'in-position'
        | 'sensor'
        | 'command'
        | 'custom';
}
```

## 6.3 Component Instance 保存绑定

```ts
interface TwinSceneComponentDefinition {
    ...
    bindings?: Record<string, string>;
}
```

示例：

```json
{
  "component": {
    "resourceKey": "builtin-external-inspection",
    "bindings": {
      "ready": "binding-plc1-db10-x0",
      "busy": "binding-plc1-db10-x1",
      "complete": "binding-plc1-db10-x2",
      "result": "binding-plc1-db10-dbw4",
      "fault": "binding-plc1-db10-x5"
    }
  }
}
```

## 6.4 Workbench 属性面板

`ComponentPropertyPanel.vue` 建议形成：

```text
几何参数
运行参数
工艺参数
PLC / 数据绑定
端口连接
```

例如外检机：

```text
设备就绪      [ PLC1.DB10.X0 ▼ ]
检测中        [ PLC1.DB10.X1 ▼ ]
检测完成      [ PLC1.DB10.X2 ▼ ]
检测结果      [ PLC1.DB10.DBW4 ▼ ]
设备故障      [ PLC1.DB10.X5 ▼ ]
```

下拉直接来源于 `manifest.bindings`。

## 6.5 各 Smart Model 标准 Slot

### 外检机

```text
Ready
Busy
Complete
Result
Fault
Heartbeat（可选）
```

### 套袋机

```text
Ready
Busy
Complete
Fault
BagPresent（可选）
```

### 分流

```text
RouteCode
CommandPosition
ActualPosition
InPosition
Fault
```

严格保持工业规则：

```text
PLC decides WHERE
Runtime decides WHETHER
```

PLC RouteCode 决定目标；Runtime 只检查目标 Section Capacity、信号有效性和执行器是否到位。目标满时等待，不能为了绕开阻塞自动选另一条路。

### 提升机

```text
Ready
Busy
TargetFloor
CurrentFloor
InPosition
Fault
```

可选：

```text
AtLower
AtUpper
```

### 旋转台

```text
Ready
Busy
CommandAngle
ActualAngle
InPosition
Fault
```

## 6.6 Route / Process 自动继承

外检机自动生成的 RoutePoint：

```ts
point.process = {
    type: 'external-inspection',
    cycleSeconds: 2,
    readyBindingId: component.bindings?.ready,
    busyBindingId: component.bindings?.busy,
    completeBindingId: component.bindings?.complete,
    resultBindingId: component.bindings?.result,
    faultBindingId: component.bindings?.fault
};
```

建议统一：

```ts
interface TwinProcessStationDefinition {
    type: string;
    cycleSeconds?: number;
    readyBindingId?: string;
    busyBindingId?: string;
    completeBindingId?: string;
    resultBindingId?: string;
    faultBindingId?: string;
    timeoutSeconds?: number;
}
```

## 6.7 Simulation 与 Live 共用状态机

不要写两套工艺流程。

统一：

```text
Idle
 ↓
WaitingReady
 ↓
Processing
 ↓
WaitingComplete
 ↓
Completed
```

Simulation 用 `cycleSeconds` 触发完成；Live 用 PLC `CompleteBinding` 触发完成。

如果信号 stale：

```text
PROCESS_SIGNAL_STALE
```

必须等待/报警，不能假定完成。

## 6.8 改动文件

```text
types.ts
BuiltInComponentCatalog.ts
ComponentPropertyPanel.vue
ComponentManifestValidator.ts
ComponentConnectionEngine.ts
contracts/index.ts
bindings/*
ProcessStationManager.ts
```

建议新增：

```text
ComponentBindingResolver.ts
```

---

# 7. P1-1：丝饼线剩余硬编码辊道完全组件化

## 7.1 当前状态

V7 Migration 已经可以迁移主塑料托盘输送基础设施，并通过 `silkV7Infrastructure=true` 告诉 Runtime 不再重复绘制旧主线。

但 `ProceduralPackagingLine.ts` 仍存在硬编码：

```text
Gantry Lane A
Gantry Lane B
Gantry Wood Pallet Lane
木托盘后包装辊道
```

这些仍由 `addRollerLane()` 生成。

## 7.2 最终目标

`ProceduralPackagingLine` 最终只保留动态对象和机械动作：

```text
Silk Cart
Robot
Robot Gripper
Plastic Pallet Runtime Entity
Silk Cake Runtime Entity
Gantry Frame / Carriage / Gripper
Wood Pallet Runtime Entity
盖板动画
贴标动画
缠膜动画
工艺状态机
```

不再负责：

```text
固定辊道
固定输送设备
固定场景布线
```

## 7.3 迁移对象

### Gantry Lane A

```text
Template: builtin-small-roller-conveyor
TransportUnitType: plastic-pallet
Capacity: 3
```

### Gantry Lane B

同上。

### Wood Gantry Lane

```text
Template: builtin-large-roller-conveyor
TransportUnitType: wooden-pallet
Capacity: 1
```

### Post Process Conveyor

建议拆成：

```text
Stack → Cover
Cover → Label
Label → Wrap
Wrap → Inbound
```

每段使用大辊道组件，每段自然形成独立 Section，不建议使用一个超长辊道覆盖全部后处理。

## 7.4 盖板/贴标/缠膜是否 V7 组件化

V7 封版前可以不强制做成通用 Smart Model。当前重点是把固定输送基础设施从 Procedural Runtime 中剥离。

V8 再新增：

```text
CoverStationComponent
LabelStationComponent
WrappingStationComponent
```

## 7.5 Migration Version

建议：

```ts
const SILK_V7_MIGRATION_VERSION = 2;
```

Manifest 记录：

```text
silkV7InfrastructureVersion = 2
```

避免以后无法判断某个旧场景到底迁到了哪一阶段。

---

# 8. TwinSectionGeometryResolver：彻底消除布局硬编码

如果只把 Mesh 改成 Component，但托盘运动路径仍用 `SilkLineLayout.ts` 固定坐标，那么换场景仍然要改 Runtime。

因此建议增加：

```text
TwinSectionGeometryResolver.ts
```

定义：

```ts
interface TwinSectionGeometry {
    sectionId: string;
    start: THREE.Vector3;
    end: THREE.Vector3;
    length: number;
    sample(progress: number): THREE.Vector3;
    tangent(progress: number): THREE.Vector3;
}
```

Runtime 位置来源：

```text
Pallet
 ↓
sectionId
 ↓
progress
 ↓
TwinSectionGeometryResolver
 ↓
World Position / Direction
```

这样以后：

```text
移动辊道
改变长度
重新吸附
换项目场景
```

都不需要重新修改 `ProceduralPackagingLine.ts` 的 XYZ 坐标。

这是 V7 “模型化而不是写死代码”真正完成的关键一步。

---

# 9. P1-2：工程空间/布局校验

建议新增：

```text
EngineeringLayoutValidator.ts
```

## 9.1 Body Bounds Overlap

检测两个设备主体严重重叠。

注意 Port 接口附近轻微交叠是允许的，所以建议区分：

```text
BodyBounds
PortClearanceBounds
```

## 9.2 Height Mismatch

例如：

```text
Conveyor A = 0.90m
Conveyor B = 1.40m
```

即使 XY/XZ 距离够近，也不允许普通辊道直接吸附，除非中间是 Lift / 高差适配设备。

## 9.3 Conveyor Size Class

当前 `small / large` 建议也进入 Connection 兼容规则。

默认：

```text
Small → Small 允许
Large → Large 允许
Small → Large 警告或要求 Adapter
```

不能只看 TransportUnitType。

## 9.4 Transport Path Clearance

检查 Route/Section 是否穿过其它设备主体，用于发现：

```text
辊道穿设备
路线穿墙
路线穿机架
```

---

# 10. P1-3：工程辅助图层管理

大型场景里不能永久显示所有辅助对象。建议新增：

```text
EngineeringOverlayManager
```

管理：

```text
Models
Components
Ports
Connections
Sections
Routes
Bindings
Bounds
Diagnostics
Selection
```

UI：

```text
工程图层
☑ 模型
☑ 组件
☐ Port
☑ Connection
☑ Route
☐ Section
☐ Bounds
☐ Binding
☐ Diagnostics
```

现有 `ThreeEditorRouteOverlay` 可以演进为：

```text
ThreeEditorRouteOverlay
ThreeEditorPortOverlay
ThreeEditorConnectionOverlay
ThreeEditorSectionOverlay
ThreeEditorDiagnosticOverlay
```

全部由 `EngineeringOverlayManager` 管理。

---

# 11. P2-1：SubAssembly 组合模板

单设备组件化之后，下一阶段最有价值的是“组合单元”。

例如：

```text
Inspection Cell
Small Conveyor
  ↓
External Inspection
  ↓
Small Conveyor
```

以及：

```text
Gantry Stack Cell
Plastic Lane A
Plastic Lane B
Wood Lane
Gantry
```

建议结构：

```ts
interface TwinSubAssemblyTemplate {
    assemblyId: string;
    name: string;
    objects: TwinV7SceneObjectDefinition[];
    connections: TwinComponentConnectionDefinition[];
    exposedPorts: Array<{
        assemblyPortId: string;
        objectId: string;
        portId: string;
    }>;
}
```

拖入场景时：

```text
重新生成 ObjectId
重新生成 ConnectionId
保持内部相对 Transform
暴露 Assembly Port
```

---

# 12. P2-2：大场景性能优化

## 12.1 InstancedMesh

优先对象：

```text
滚筒
支腿
螺栓
重复托盘
```

例如 100 条辊道 × 每条 20 滚筒，如果每个都是 Mesh，会产生大量 Draw Calls；应尽量合并为 InstancedMesh。

## 12.2 Geometry Cache

建议：

```text
ComponentGeometryCache
```

Key：

```text
generator
generatorVersion
geometryPropertiesHash
```

相同几何参数直接共享 BufferGeometry / Material。

## 12.3 LOD

```text
近距离：真实滚筒
中距离：简化框架
远距离：Box / Line
```

## 12.4 编辑态与运行态分开

```text
EditorRenderProfile
RuntimeRenderProfile
```

编辑态重视 Port/Bounds/Selection；运行态重视 FPS。

---

# 13. README / 文档同步

`ClientApp/src/digital-twin/components/README.md` 中如果仍写着 Snap、Connection、自动 Route、属性面板“尚未完成”，必须更新。

建议状态：

```text
[√] 9 个参数化/智能组件
[√] Component Registry
[√] Component Resource 数据库注册
[√] Component Property Panel
[√] Port
[√] 0.5m 自动吸附
[√] 15° 方向容差
[√] TransportUnitType 兼容
[√] Connection 持久化
[√] Connection 重校验
[√] Connection → Section → Route
[√] Generated Route 只读
[√] 专业编辑共用 Scene
[√] Route Overlay
[√] 丝饼基础设施 V7 Migration

[ ] Smoke Test CI Gate
[ ] Generator Version
[ ] Multiple Component Networks
[ ] Smart Model Binding Slot
[ ] Silk Line Remaining Conveyor Migration
```

---

# 14. 推荐开发顺序

```text
Phase 1  Smoke Test → CI
Phase 2  Generator Version
Phase 3  Multiple Component Networks
Phase 4  Smart Model Binding Slot
Phase 5  Silk Line Full Component Migration
Phase 6  Engineering Validators / Overlay
Phase 7  Documentation / Freeze
```

预计工作量：

| 阶段 | 预计 | 风险 |
|---|---:|---|
| CI Gate | 0.5 天 | 低 |
| Generator Version | 1–2 天 | 中 |
| Multiple Network | 2–4 天 | 中高 |
| Binding Slot | 3–5 天 | 中 |
| Silk Runtime 解耦 | 3–5 天 | 中高 |
| Validator / Overlay | 2–4 天 | 中 |

AI/Codex 辅助且现有测试可复用时，P0 + 核心 P1 约 6–10 个有效开发日；单开发者按常规节奏约 2–3 周。

---

# 15. V7 Final 验收标准

## Component

```text
[ ] Registry 严格按 generator + generatorVersion
[ ] 旧 Generator 可重放旧 Published Scene
[ ] 不存在 GeneratorVersion 时明确报错
[ ] 参数化组件 Scale 永远锁定 1,1,1
```

## Editor

```text
[ ] GLB / Component / Route 共用专业 Scene
[ ] 自动 Route 只读
[ ] Port Snap 正常
[ ] Connection 保存/删除正常
[ ] Component Transform 改变后 Connection 重校验
```

## Network

```text
[ ] 一个 Scene 支持多个独立 Component Network
[ ] 每个 Network 独立 Route
[ ] RouteId 稳定
[ ] 网络互不污染
```

## Runtime

```text
[ ] 每条 Route 正确生成 Section
[ ] Capacity / Occupancy / Reserved 正确
[ ] Waiting 正确
[ ] PLC 目标已选定后 Capacity 不得改路线
```

## Smart Model

```text
[ ] Binding Slot 可声明
[ ] Workbench 可配置 Binding
[ ] Generated Process 自动继承 BindingId
[ ] stale 信号会阻止错误动作
```

## Silk Line

```text
[ ] 主线固定辊道不再由 ProceduralPackagingLine 绘制
[ ] Gantry A/B 辊道组件化
[ ] Wood Gantry Lane 组件化
[ ] Post Process Conveyor 组件化
[ ] Runtime 通过 Section Geometry 决定实体位置
```

## CI

```text
[ ] npm run verify:v7-components
[ ] npm run build
[ ] Develop Digital Twin Build
```

全部成功。

---

# 16. V7 封版后的边界

V7 封版以后不建议继续塞入：

```text
AR
3D 空间定位
通用 AGV 系统
通用机器人运动规划
BIM
大型仓库编辑器
AI Agent
大量新工业设备
```

这些进入 V8+。

V7 的最终职责：

```text
组件化
模型化
工程编辑
Port
Connection
Network
Section
Route
版本
发布
基础 Runtime
```

V8 再负责：

```text
通用工业场景搭建器
SubAssembly
更丰富 Smart Model
真实 PLC/WCS 深度运行
大型场景
多生产线并行 Runtime
```

---

# 17. 推荐提交拆分

```text
feat(v7): run component smoke tests in CI

feat(v7): version component generators

feat(v7): support multiple component networks

feat(v7): add smart-model binding slots

refactor(twin): migrate remaining silk conveyors to V7 components

test(v7): extend multi-network and binding tests

docs(v7): finalize component architecture documentation
```

不要把全部内容塞进一个超大 Commit。

---

# 18. AI/Codex 开发硬约束

后续 AI 直接开发时必须遵守：

```text
1. 不删除旧 Published 版本兼容逻辑
2. 已发布 Generator V1 不改变输出语义
3. 新功能优先新增字段，不破坏旧 Manifest
4. 自动 Route 始终由 Component/Connection 决定
5. Runtime 不反向修改工程坐标
6. PLC decides WHERE
7. Runtime decides WHETHER
8. Capacity 不允许改路线
9. Generated Route 禁止人工拖点
10. V7 Component 禁止 Scale
11. 几何尺寸只通过 Properties 修改
12. 每阶段必须补 Smoke Test
13. 每阶段必须执行 npm run build
14. 不允许把固定布局重新塞回 ProceduralPackagingLine
15. Runtime 运动位置优先从 Section Geometry 获取
```

---

# 19. 推荐最终目录

```text
ClientApp/src/digital-twin/

components/
├── ComponentRegistry.ts
├── ComponentMigrationRegistry.ts
├── ComponentNetworkBuilder.ts
├── ComponentConnectionEngine.ts
├── ComponentBindingResolver.ts
├── ComponentManifestValidator.ts
├── ComponentPropertyPanel.vue
├── ComponentResourceRegistration.ts
├── BuiltInComponentCatalog.ts
├── generators/
│   ├── roller/
│   │   ├── RollerConveyorV1.ts
│   │   └── RollerConveyorV2.ts
│   ├── turntable/
│   ├── lift/
│   ├── inspection/
│   └── bagging/
└── migration/
    └── SilkV7ComponentMigration.ts

editor-adapter/
├── ThreeEditorCoreHost.ts
├── ThreeEditorRouteOverlay.ts
├── ThreeEditorPortOverlay.ts
├── ThreeEditorConnectionOverlay.ts
└── EngineeringOverlayManager.ts

runtime/
├── TwinRuntime.ts
├── TwinMaterialFlowRuntime.ts
├── TwinSectionGeometryResolver.ts
├── ProcessStationManager.ts
└── ProceduralPackagingLine.ts

contracts/
├── index.ts
└── v7-components.ts
```

---

# 20. 最终结论

V7 现在已经具备工业数字孪生编辑底座的核心结构。后续最重要的不是继续增加几十个模型，而是把以下 5 个基础能力彻底完成：

```text
1. V7 Smoke Test 接入 CI
2. Generator 真正版本化
3. Multiple Component Network / Route
4. Smart Model PLC Binding Slot
5. Silk Line 剩余固定输送设施完全组件化
```

完成后可定义：

```text
V7 = Stable Industrial Component Foundation
```

此后 V7 进入维护状态，新增大能力转入 V8。

---

# 21. 实施与验收记录（2026-08-30）

本轮已按封版门槛完成查漏补缺，结果如下。

## 21.1 核心封版门槛

```text
[√] P0-1  Develop CI 执行 npm run verify:v7-components 后再执行 npm run build
[√] P0-2  Registry 严格按 generator@generatorVersion 注册与加载
[√] P0-3  不连通 Component Network 独立生成稳定 RouteId / Section
[√] P0-4  Binding Slot 声明、Workbench 配置、Manifest 入库、后端校验、Process 继承
[√] P1-1  主线、桁架 A/B、木托线、后包装四段辊道全部迁移为 V7 Component
```

## 21.2 运行与工程收口

```text
[√] ProcessStationManager 正式接入 Simulation / Live 共用状态机
[√] Live stale / fault 信号不允许错误放行
[√] 木托盘 Stack→Cover→Label→Wrap→Inbound 按 Section Geometry 取位
[√] 普通辊道高差 > 0.15m 禁止直接吸附，Lift 作为高差转换设备
[√] small / large 规格进入 Port 兼容性校验
[√] Body Bounds 重叠与 Route 穿越设备主体诊断
[√] 专业编辑 Scene 支持 Port / Connection / Route / Bounds 图层开关
```

## 21.3 回归结果

```text
npm run verify:v7-components           PASS
node scripts/run-packaging-line-smoke.mjs  PASS
npm run build                          PASS（4114 modules）
dotnet build IoTSharp                  PASS（0 errors）
DigitalTwin tests                      PASS（15 / 15）
```

## 21.4 封版边界

`SubAssembly`、`InstancedMesh / Geometry Cache / LOD`、通用 AGV/机器人运动规划不属于上述五项 V7 封版门槛，保持在 V8 路线，避免封版阶段继续扩大发布面。
