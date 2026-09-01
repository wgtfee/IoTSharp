# IoTSharp 2D 与 3D 数字孪生场景统一架构详细设计 V1

## 1. 文档目标

本文基于当前 `H:\code\Industrial.Platform\IoTSharp-master` 的实际代码结构，对现有 2D 场景与 3D 数字孪生场景进行对比，并给出一套“2D 与 3D 使用同一份场景、同一套业务模型、同一套运行数据，仅渲染方式不同”的详细改造方案。

目标不是把当前 2D SVG 页面简单做得更漂亮，而是将 2D 提升为与 3D 同级的数字孪生视图，使以下能力在 2D / 3D 中保持一致：

- 场景创建、保存、发布、版本与回滚
- 场景对象与设备绑定
- 实时遥测、属性、告警、在线状态驱动
- 运行 / 暂停 / 仿真 / 实时模式
- 路线、分流、合流、工位、缓冲区
- 物料、托盘、丝车、包装对象的实时运动
- 设备启停、状态颜色、告警高亮
- 场景对象选中、属性查看、设备状态查看
- 场景校验
- 多产线、多场景复用
- 后续与 MQTT、SignalR、PLC、WCS 的统一接入

最终目标：

```text
                TwinSceneManifest
                       │
           ┌───────────┴───────────┐
           │                       │
      TwinRuntimeCore         TwinStateStore
           │                       │
     Route / Binding /        Live / Simulation
     Process / Material             │
           │                       │
     ┌─────┴─────┐                 │
     │           │                 │
  3D Renderer  2D Renderer <───────┘
  Three.js      SVG/Canvas
```

2D 和 3D 不再是两个独立数字孪生系统，而是同一个数字孪生场景的两种 View。

---

# 2. 当前代码现状

## 2.1 3D 场景当前结构

当前三维场景入口：

```text
ClientApp/src/views/iot/digital-twin/workbench.vue
```

当前 3D 已经不是简单的 Three.js Demo，而是具备较完整的数字孪生编辑与运行能力。

主要模块包括：

```text
ClientApp/src/digital-twin/
├── contracts/
├── runtime/
├── routes/
├── bindings/
├── components/
├── editor-adapter/
└── vendor/three-editor-cores/
```

核心场景数据结构：

```text
TwinSceneManifest
```

核心能力已经包括：

- Scene / Object
- Transform
- Model Resource
- Component Resource
- Connection
- Route
- Route Point
- Route Edge
- Route Decision
- Runtime Definition
- Device Binding
- Process Definition
- Scene Version
- Draft / Published
- Runtime Snapshot

3D 运行时：

```text
TwinRuntime.ts
```

当前已经集成：

- Three.js Scene
- Camera
- WebGLRenderer
- OrbitControls
- TransformControls
- GLTFLoader
- Raycaster
- BindingEngine
- RouteEngine
- TwinMaterialFlowRuntime
- ProceduralPackagingLine
- V7 Component Registry

因此 3D 已经形成了比较清晰的数字孪生领域模型。

---

# 2.2 当前 2D 场景结构

入口：

```text
ClientApp/src/views/iot/digital-twin/2d-scene.vue
```

该页面目前只是包装：

```vue
<YtPack2dScene />
```

实际实现：

```text
ClientApp/src/views/iot/digital-twin/yt-pack-2d/index.vue
```

当前 2D 使用：

```text
SVG
```

页面已经支持：

- SVG 总览
- 滚轮缩放
- 中键拖动
- 设备点击
- 设备弹窗
- 亚特包装线固定布局

但当前数据主要是前端硬编码，例如：

```text
smallConveyerInfoList
robotInfoList
Line1
Line2
Line3
```

也就是说当前结构本质为：

```text
固定 SVG 模板
    ↓
Vue reactive 假数据
    ↓
设备弹窗
```

而不是：

```text
TwinSceneManifest
    ↓
Runtime
    ↓
Renderer
```

因此当前 2D 和 3D 的最大差异不是“2D 少几个功能”，而是**架构层级不同**。

---

# 3. 当前 2D 与 3D 能力差异

| 能力 | 3D | 当前 2D | 目标 2D |
|---|---|---|---|
| 场景 Manifest | 已有 | 无 | 共用 3D Manifest |
| 草稿保存 | 已有 | 无 | 支持 |
| 发布 | 已有 | 无 | 支持 |
| 版本 | 已有 | 无 | 支持 |
| 回滚 | 已有 | 无 | 支持 |
| 模型 / 组件对象 | 已有 | 固定 Vue 组件 | 映射为 2D Symbol |
| Device Binding | 已有 | 无 | 共用 |
| Telemetry | 已有 | 无正式接入 | 共用 |
| Attribute | 已有 | 无 | 共用 |
| Alarm | 已有 | 无 | 共用 |
| Connectivity | 已有 | 无 | 共用 |
| Route | 已有 | 静态布局 | 共用 |
| Route Edge | 已有 | 无 | 共用 |
| Junction | 已有 | 视觉固定 | 共用 |
| Diverter | 已有 | 视觉固定 | 共用 |
| Merger | 已有 | 视觉固定 | 共用 |
| Buffer | 已有 | 固定组件 | 共用 |
| ProcessStation | 已有 | 固定组件 | 共用 |
| 运行 / 暂停 | 已有 | 无统一运行时 | 支持 |
| 实时 / 仿真 | 已有 | 无 | 支持 |
| 物料运动 | 已有 | 无统一 Runtime | 支持 |
| 对象选中 | 已有 | 部分弹窗 | 完整支持 |
| 属性面板 | 已有 | 无 | 支持 |
| 状态颜色 | Binding 驱动 | 局部硬编码 | Binding 驱动 |
| 告警闪烁 | 可扩展 | 无 | 支持 |
| 碰撞 / 占用 | Route Runtime | 无统一模型 | 共用 Runtime |
| 场景校验 | 已有 | 无 | 共用 |

---

# 4. 设计原则

## 4.1 一个场景，两种渲染器

禁止继续维护：

```text
3D Scene JSON
2D Scene JSON
```

应改为：

```text
TwinSceneManifest
```

唯一场景事实源。

2D / 3D 的差异只能存在于：

```text
Presentation / Renderer
```

而不能存在于：

```text
业务运行逻辑
设备绑定
路线逻辑
物料流逻辑
告警逻辑
```

---

# 4.2 Runtime 与 Renderer 解耦

当前 `TwinRuntime.ts` 同时承担：

- Three.js 渲染
- Route Runtime
- Material Runtime
- Binding Runtime

后续建议拆分为：

```text
TwinRuntimeCore
Twin3DRenderer
Twin2DRenderer
```

其中：

```text
TwinRuntimeCore
```

负责：

- RouteEngine
- BindingEngine
- MaterialFlow
- Process Station
- State Machine
- Simulation
- Live Data
- Occupancy
- Collision / Spacing

而：

```text
Twin3DRenderer
```

只处理：

- Mesh
- GLB
- Camera
- Lighting
- Raycaster
- TransformControls

```text
Twin2DRenderer
```

只处理：

- SVG / Canvas
- Pan / Zoom
- 2D Symbol
- 2D Selection
- 2D Overlay

---

# 5. 推荐总体架构

```text
DigitalTwinWorkbench
        │
        ├── SceneRepository
        │       └── DigitalTwin API
        │
        ├── TwinRuntimeCore
        │       ├── BindingEngine
        │       ├── RouteEngine
        │       ├── MaterialFlowRuntime
        │       ├── ProcessStationManager
        │       ├── ComponentProcessStateMachine
        │       ├── CollisionEngine
        │       └── RuntimeStateStore
        │
        ├── TwinDataSource
        │       ├── Snapshot
        │       ├── SignalR
        │       └── Simulation
        │
        └── Renderer
                ├── TwinThreeRenderer
                └── TwinSvgRenderer
```

---

# 6. 新增 2D Runtime Adapter

建议新增：

```text
ClientApp/src/digital-twin/renderer-2d/
```

目录：

```text
renderer-2d/
├── Twin2DRenderer.ts
├── Twin2DSceneAdapter.ts
├── Twin2DProjection.ts
├── Twin2DSelection.ts
├── Twin2DSymbolRegistry.ts
├── Twin2DRouteRenderer.ts
├── Twin2DMaterialRenderer.ts
├── Twin2DAlarmOverlay.ts
├── Twin2DViewport.ts
└── symbols/
```

---

# 7. 2D 坐标设计

3D 当前使用：

```text
Y-up
position = [x, y, z]
```

2D 工厂平面图建议使用：

```text
X → SVG X
Z → SVG Y
Y → 高度信息隐藏或作为层级
```

即：

```text
screenX = worldX * scale + offsetX
screenY = -worldZ * scale + offsetY
```

这样同一个对象：

```json
position: [12.5, 0.72, -4.2]
```

可以同时出现在 3D 和 2D 中。

禁止为 2D 再单独维护一套设备坐标。

可以为特殊显示增加可选字段：

```ts
interface TwinPresentation2D {
    symbol?: string;
    width?: number;
    height?: number;
    rotateWithObject?: boolean;
    labelVisible?: boolean;
    labelOffset?: [number, number];
}
```

但该数据只能是显示配置，不能成为业务坐标。

---

# 8. 2D Symbol Registry

3D Component Registry 已经存在。

2D 应建立相同思想的 Symbol Registry：

```text
Twin2DSymbolRegistry
```

示例：

```ts
registry.register('small-roller-conveyor', SmallRollerSymbol)
registry.register('large-roller-conveyor', LargeRollerSymbol)
registry.register('turntable', TurntableSymbol)
registry.register('robot', RobotSymbol)
registry.register('external-inspection', InspectionSymbol)
registry.register('bagging', BaggingSymbol)
registry.register('gantry', GantrySymbol)
registry.register('buffer', BufferSymbol)
registry.register('warehouse-lift', LiftSymbol)
```

2D 不直接依赖 `Line1.vue / Line2.vue / Line3.vue` 这种整线组件。

应改为：

```text
Scene Objects
    ↓
Symbol Registry
    ↓
动态拼装整条线
```

这样以后增加另外一条产线，不需要重新写一个 `Line4.vue`。

---

# 9. 组件模型统一

对于 V7 Component：

```text
TwinV7SceneObjectDefinition
```

3D 根据 generator 生成 Three.js Geometry。

2D 根据同一个：

```text
componentType
properties
ports
```

生成 2D Symbol。

例如小辊道：

```text
Twin Component
componentType = conveyor.small
length = 3.0m
width = 0.8m
ports = input / output
```

3D：生成滚筒、机架。

2D：生成矩形 + 滚轮线 + 方向箭头。

两者共用：

- objectId
- transform
- sectionId
- capacity
- transportUnitType
- ports
- bindings
- connection

---

# 10. 2D 路线系统

当前 3D 已有：

```text
TwinRouteDefinition
TwinRoutePointDefinition
TwinRouteEdgeDefinition
RouteEngine
```

2D 应直接读取相同 Route。

2D Renderer 将：

```text
Route Point → SVG Point / Node
Route Edge  → SVG Path
```

状态映射：

```text
Running Edge     → 流动箭头
Blocked Edge     → 红色
Full Edge        → 橙色
Idle Edge        → 灰色
Unavailable Edge → 虚线
```

路线必须保持业务一致：

```text
3D 中被 Block
= 2D 中被 Block
= Runtime 中被 Block
```

不能再由 SVG 自己决定。

---

# 11. 物料运动

2D 物料运动不应重新写一套运动算法。

Runtime 输出：

```ts
interface TwinRuntimeEntityState {
    entityId: string
    entityType: string
    routeId: string
    edgeId: string
    progress: number
    state: string
    payload: Record<string, unknown>
}
```

3D：

```text
progress → THREE.Vector3
```

2D：

```text
progress → SVG path.getPointAtLength()
```

这样托盘在 2D / 3D 中的位置天然一致。

---

# 12. 启停效果

2D 要和 3D 一样支持：

```text
运行
暂停
故障
等待
阻塞
离线
```

建议统一状态：

```ts
type TwinEquipmentState =
    | 'idle'
    | 'running'
    | 'waiting'
    | 'blocked'
    | 'fault'
    | 'offline'
    | 'maintenance'
```

2D 表现：

```text
running     动态滚轮 / 流动箭头
idle        普通灰蓝
waiting     黄色
blocked     橙色
fault       红色闪烁
offline     灰色 + 透明
maintenance 紫色 / 工具图标
```

3D 仍然通过 material / emissive / animation 表现。

状态来源完全相同。

---

# 13. 碰撞与间距检测

这里要特别区分“视觉碰撞”和“工业物流碰撞”。

对于输送线数字孪生，核心不应该依赖 2D 或 Three.js Mesh 的物理碰撞。

推荐：

```text
Route Occupancy + Entity Spacing + Section Capacity
```

作为权威逻辑。

新增：

```text
TwinCollisionEngine
```

职责：

- 同一 Edge 最小间距
- Section 容量
- Junction 互斥
- Merger 抢占
- Diverter 出口冲突
- Buffer 容量
- Process Station 占用

示例：

```ts
canAdvance(entity, edge, distance)
reserveSection(entityId, sectionId)
releaseSection(entityId, sectionId)
checkSpacing(edgeId)
checkJunction(junctionId)
```

2D / 3D 都消费同一个结果。

因此：

```text
碰撞检测不属于 2D
碰撞检测也不属于 Three.js
碰撞检测属于 TwinRuntimeCore
```

Three.js 的 Box3 / Raycaster 只用于编辑器选择、拖放和辅助检测。

---

# 14. 实时数据统一

当前 API 已经存在：

```text
TwinRuntimeSnapshot
TwinDataUpdate
```

以及：

```text
BindingEngine
```

建议 2D 直接共用。

数据流：

```text
PLC
 ↓
IoTSharp Device / Telemetry
 ↓
Runtime Snapshot / SignalR
 ↓
TwinDataUpdate
 ↓
TwinStateStore
 ↓
BindingEngine
 ↓
TwinRuntimeCore
 ↓
┌───────────┬───────────┐
│           │           │
3D          2D        Dashboard
```

未来如果接 MQTT：

```text
MQTT 不直接驱动 SVG
MQTT 不直接驱动 Three.js
```

仍然先转换成标准：

```text
TwinDataUpdate
```

---

# 15. Binding 在 2D 中的表现

当前 Binding Target 已支持：

```text
visible
color
emissive
opacity
text
number
position
rotation
scale
animation
routeProgress
customProperty
```

2D 可直接映射：

| Binding Target | 3D | 2D |
|---|---|---|
| visible | mesh.visible | SVG visible |
| color | material.color | fill / stroke |
| emissive | emissive | glow/filter |
| opacity | material.opacity | opacity |
| text | CSS2D | SVG text |
| number | property | label/value |
| position | Mesh position | SVG transform |
| rotation | Mesh rotation | rotate() |
| scale | Mesh scale | scale() |
| animation | Mixer | CSS/SVG animation |
| routeProgress | 3D route position | SVG path position |

---

# 16. 2D 对象选中与属性面板

当前 2D 是点击设备弹独立 Dialog。

建议改为与 3D 一样：

```text
Scene Object Selection
        ↓
TwinSelectionInfo
        ↓
统一右侧属性面板
```

统一：

```ts
TwinSelectionInfo
```

因此 2D 点击设备后可看到：

- 对象名称
- objectId
- componentType
- assetId
- deviceId
- 在线状态
- 遥测
- 告警
- 当前工艺状态
- 当前占用
- 当前绑定

后续甚至可以将 2D 与 3D 共用 `TwinObjectInspector.vue`。

---

# 17. 编辑模式设计

2D 建议也分：

```text
编辑模式
运行模式
```

编辑模式：

- 拖动设备
- 旋转设备
- 吸附网格
- 端口连接
- 删除
- 复制
- 属性编辑
- 绑定设备
- 调整路线

运行模式：

- 禁止修改坐标
- 实时状态
- 物料运动
- 告警
- 启停
- 流程监控

2D / 3D 在 UI 上保持同样逻辑。

---

# 18. 2D 拖放与端口连接

V7 Component 已经有：

```text
ports
connection
snap
```

2D 应直接复用。

例如：

```text
小辊道 A.output
      ↓
小辊道 B.input
```

2D 拖动 B 靠近 A 后：

```text
findBestComponentSnap()
snapAndConnectNearestComponent()
```

仍调用现有 Component Connection Engine。

然后：

```text
upsertGeneratedComponentRoute()
```

自动生成路线。

这样 2D 编辑器与 3D 编辑器创建出来的场景结构完全一样。

---

# 19. 亚特包装线当前 SVG 的迁移方案

不建议删除现有 `yt-pack-2d`。

建议分三步迁移。

## 第一阶段

保留：

```text
yt-pack-2d
```

但移除硬编码状态数据。

让现有 SVG 设备通过：

```text
objectId
```

与 Manifest 对象绑定。

即：

```text
L2_XGD_001
```

不再只是字符串名称，而是对应：

```text
TwinSceneObject.objectId
```

这是最低风险过渡方案。

## 第二阶段

将：

```text
Line1.vue
Line2.vue
Line3.vue
```

内部组件拆成：

```text
symbols/
```

每个设备成为独立 Symbol。

## 第三阶段

取消整线硬编码位置，由 Manifest 动态创建整线。

最终：

```text
亚特包装线
丝饼线
仓储线
测试线
```

都使用同一个 2D Renderer。

---

# 20. 2D 场景页面建议

建议替换当前页面结构为：

```text
2DWorkbench.vue
```

布局与 3D workbench 尽量一致：

```text
┌────────────────────────────────────────────┐
│ 场景选择 │ 编辑/运行 │ 2D/3D │ 保存 │ 发布 │
├──────────┬─────────────────────┬───────────┤
│ 场景树   │                     │ 属性面板  │
│ 组件库   │      2D Canvas      │ 绑定      │
│ 路线     │                     │ 状态      │
│ 对象     │                     │ 告警      │
├──────────┴─────────────────────┴───────────┤
│ Route / Runtime / FPS / Live Status        │
└────────────────────────────────────────────┘
```

建议组件：

```text
TwinSceneToolbar.vue
TwinSceneTree.vue
TwinObjectInspector.vue
TwinBindingPanel.vue
TwinRuntimeStatusBar.vue
```

2D / 3D 共用。

---

# 21. 推荐实现接口

```ts
interface ITwinRenderer {
    loadManifest(manifest: TwinSceneManifest): Promise<void>
    updateScene(manifest: TwinSceneManifest): void
    applyRuntimeSnapshot(snapshot: TwinRuntimeState): void
    selectObject(objectId: string | null): void
    focusObject(objectId: string): void
    setMode(mode: 'editor' | 'runtime'): void
    resize(): void
    dispose(): void
}
```

3D：

```text
TwinThreeRenderer implements ITwinRenderer
```

2D：

```text
Twin2DRenderer implements ITwinRenderer
```

Workbench 不需要关心当前是 Three.js 还是 SVG。

---

# 22. 运行状态 Store

建议新增：

```text
TwinRuntimeStateStore.ts
```

保存：

```ts
interface TwinRuntimeState {
    sceneId: string
    running: boolean
    dataMode: 'simulation' | 'live'
    bindings: Record<string, TwinDataUpdate>
    equipment: Record<string, TwinEquipmentRuntimeState>
    entities: Record<string, TwinRuntimeEntityState>
    sections: Record<string, TwinSectionRuntimeState>
    processes: Record<string, TwinProcessRuntimeState>
    alarms: TwinAlarmState[]
}
```

Renderer 只订阅 Store。

这一步完成以后，切换 2D / 3D 不会丢失运行状态。

---

# 23. 2D / 3D 切换方式

当前是独立路由：

```text
/workbench
/2d-scene
```

短期可以保留。

长期建议统一入口：

```text
/iot/digital-twin/workbench
```

顶部：

```text
[2D] [3D]
```

切换只更换：

```text
Renderer
```

Scene / Manifest / Runtime 不重新加载。

也可以 URL 保留：

```text
?view=2d
?view=3d
```

方便分享链接。

---

# 24. 后端无需为 2D 再建一套 Scene 表

当前 3D 已经具备：

- Scene
- Draft
- Published Version
- Bindings
- Routes
- Model Resource
- Runtime Snapshot

2D 应直接共用。

数据库不要出现：

```text
Twin2DScene
Twin2DObject
Twin2DRoute
```

除非是纯 Presentation 配置，否则不应创建 2D 专属业务表。

推荐只在 Manifest 增加：

```ts
presentation?: {
    twoD?: {...}
    threeD?: {...}
}
```

---

# 25. 告警设计

统一告警数据：

```text
Alarm Binding
```

2D 状态示例：

```text
Warning  → 黄色边框
Major    → 橙色闪烁
Critical → 红色闪烁 + Alarm Icon
```

3D：

```text
emissive
outline
CSS label
```

同一个 Alarm 不能在 2D 显示 Critical、3D 却显示 Normal。

---

# 26. 性能设计

2D 场景可能比 3D 同时显示更多设备。

建议：

### SVG 模式

适合：

```text
< 1000 个场景对象
```

优势：

- 易编辑
- 文本清晰
- DOM 可交互
- 工业平面图适合

### Canvas / Pixi 模式

如果未来：

```text
> 2000 ~ 5000 动态对象
```

可切换 Canvas / WebGL 2D Renderer。

第一版建议继续 SVG，不需要立即换技术。

重点先统一 Runtime。

---

# 27. 2D 刷新策略

禁止每个遥测点更新就重渲染整个 SVG。

采用：

```text
Data Update
   ↓
State Store
   ↓
Dirty Object Set
   ↓
requestAnimationFrame
   ↓
局部刷新
```

例如：

```text
1000 个设备
只有 12 个状态变化
```

只刷新 12 个对象。

---

# 28. 实时数据建议

当前 workbench 主要通过 Snapshot 轮询。

目标：

```text
首次：Snapshot
后续：SignalR Incremental Update
异常：自动退回 Snapshot Polling
```

完整模式：

```text
GET snapshot
     ↓
建立 SignalR
     ↓
TwinDataUpdate
     ↓
State Store
     ↓
2D / 3D
```

这样 2D 与 3D 都不直接处理网络协议。

---

# 29. 推荐新增模块

```text
ClientApp/src/digital-twin/
├── core/
│   ├── TwinRuntimeCore.ts
│   ├── TwinRuntimeStateStore.ts
│   ├── TwinCollisionEngine.ts
│   ├── TwinEquipmentStateResolver.ts
│   └── TwinRuntimeEntity.ts
│
├── renderers/
│   ├── ITwinRenderer.ts
│   ├── three/
│   │   └── TwinThreeRenderer.ts
│   └── two-d/
│       ├── Twin2DRenderer.ts
│       ├── Twin2DViewport.ts
│       ├── Twin2DProjection.ts
│       ├── Twin2DSymbolRegistry.ts
│       ├── Twin2DRouteRenderer.ts
│       └── symbols/
│
├── bindings/
├── routes/
├── components/
└── contracts/
```

---

# 30. 开发阶段规划

## Phase 1：2D 接入 Manifest

目标：

```text
2D 不再维护独立设备状态数据
```

工作：

- 2D 加载 `DigitalTwinSceneDetail`
- 使用 `TwinSceneManifest`
- SVG 设备绑定 objectId
- 使用 TwinDataUpdate
- 支持状态颜色
- 支持设备点击统一属性

完成后：

```text
2D 数据已经和 3D 一样
```

但布局仍然是现有亚特 SVG。

---

## Phase 2：Runtime 共用

拆分：

```text
TwinRuntimeCore
```

将 Route / Binding / Material / Process 从 Three.js Render 中抽离。

2D 与 3D 同时消费 RuntimeState。

完成后：

- 启停一致
- 路线一致
- 物料一致
- 碰撞一致
- 分流一致

这是整个改造最关键阶段。

---

## Phase 3：2D Component Renderer

实现：

```text
Twin2DSymbolRegistry
```

支持 V7 组件。

第一批：

- 小辊道
- 大辊道
- 转盘
- 缓冲区
- Robot
- 外检
- 套袋
- Gantry

---

## Phase 4：2D 编辑器

实现：

- 拖放
- 移动
- 旋转
- 网格吸附
- Port
- Connection
- 自动路线
- 属性编辑
- 删除/复制

完成后 2D 可以独立搭建场景。

---

## Phase 5：2D / 3D 统一 Workbench

统一：

```text
Scene Tree
Inspector
Binding Panel
Runtime Status
Scene Save
Publish
Version
Validation
```

Renderer 可切换。

---

## Phase 6：实时与性能

实现：

- SignalR
- Snapshot fallback
- Dirty update
- Alarm overlay
- 大规模对象性能测试

---

# 31. 测试要求

## 31.1 Manifest 一致性

同一 Manifest：

```text
2D Object Count == 3D Object Count
Route Count == Route Count
Binding Count == Binding Count
```

## 31.2 坐标一致性

对象在 3D：

```text
[x, y, z]
```

2D 投影必须对应：

```text
[x, z]
```

## 31.3 Runtime 一致性

同一个托盘：

```text
entityId
edgeId
progress
```

2D 和 3D 必须一致。

## 31.4 状态一致性

PLC：

```text
MotorRunning = false
```

2D / 3D 同时停止动画。

PLC：

```text
Alarm = Critical
```

2D / 3D 同时进入 Critical 状态。

## 31.5 碰撞测试

测试：

- 同 Section 多托盘
- Junction 抢占
- Merger 两路同时进入
- Buffer 满
- ProcessStation Busy
- 下游 Blocked

必须保证 Runtime 只允许一个确定结果。

---

# 32. 验收标准

最终 2D 应达到：

1. 进入 2D 和 3D 看到的是同一个 Scene。
2. 3D 移动一个组件并保存后，2D 坐标同步变化。
3. 2D 移动一个组件并保存后，3D 坐标同步变化。
4. 3D 新增设备后，2D 自动出现对应 Symbol。
5. PLC 设备启动后，2D / 3D 同时显示 Running。
6. PLC 设备停止后，2D / 3D 同时停止动画。
7. PLC 告警后，2D / 3D 同时告警。
8. 托盘在 2D / 3D 中属于同一个 entityId。
9. 路线 Block 后，2D / 3D 中物料同时停止。
10. 场景发布后 2D / 3D 都可以读取同一个 Published Version。
11. 版本回滚后 2D / 3D 同时恢复旧场景。
12. 不存在独立的 2D 业务数据库结构。

---

# 33. 对当前 IoTSharp 的具体建议

基于当前代码，不建议重写 3D。

当前：

```text
TwinSceneManifest
BindingEngine
RouteEngine
TwinMaterialFlowRuntime
Component Registry
Scene Version
Runtime Snapshot
```

这些都应继续作为数字孪生主干。

真正需要做的是：

```text
把 TwinRuntime 中与 Three.js 无关的逻辑抽出来
```

然后新增：

```text
Twin2DRenderer
```

而不是再写一套 `2DRuntime`。

现有 `yt-pack-2d` 可以作为第一版 2D Renderer 的视觉模板继续利用，不需要推倒重做。

---

# 34. 最终推荐架构

```text
                     IoTSharp Backend
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
      Scene             Binding            Runtime
      API               Snapshot            Data
        │                  │                  │
        └──────────────────┼──────────────────┘
                           │
                    TwinSceneService
                           │
                    TwinRuntimeCore
          ┌────────────────┼────────────────┐
          │                │                │
    BindingEngine      RouteEngine     MaterialFlow
          │                │                │
          └────────────────┼────────────────┘
                           │
                    TwinRuntimeState
                           │
              ┌────────────┴────────────┐
              │                         │
       TwinThreeRenderer          Twin2DRenderer
              │                         │
          Three.js                    SVG
              │                         │
              └───────────┬─────────────┘
                          │
                  Unified Workbench
```

---

# 35. 结论

当前 IoTSharp 的 3D 数字孪生基础已经明显强于当前 2D。

当前 2D 最大问题不是 UI，而是：

```text
它目前还是一张独立的 SVG 工艺图
```

而 3D 已经是：

```text
数字孪生 Scene + Manifest + Runtime + Binding + Route + Version
```

因此正确方向不是“照着 3D 再开发一套 2D”，而是：

```text
共享 Scene
共享 Manifest
共享 Runtime
共享 Binding
共享 Route
共享 Process
共享 Material Flow
共享 Collision
共享 Version

仅 Renderer 不同
```

即：

```text
3D = Twin Runtime + Three.js Renderer
2D = Twin Runtime + SVG Renderer
```

这套结构完成后，IoTSharp 的 2D 与 3D 才真正属于同一个数字孪生系统，而不是两个互相独立的展示页面。
