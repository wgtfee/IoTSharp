# IoTSharp 50托盘模拟器分段运行改造设计

## 1. 改造目标

当前 IoTSharp `Develop` 分支已经具备：

- `TwinSectionManager`
- `TwinEntityManager`
- `TwinJunctionManager`
- `TwinMaterialFlowRuntime`
- `Capacity`
- `Occupancy`
- `Reserved`
- `Waiting`
- `tryTransfer()`
- `tryAdvanceAtJunction()`
- PLC / Simulation / Manual 分流基础

但是当前新增的 `ProceduralPackagingLine` 中，50 个托盘仍然是按照整条路线持续循环运动，并没有真正按 Section 分段占用和流转。

本轮改造目标是：

> 让 `TwinMaterialFlowRuntime` 成为托盘业务状态的唯一权威，Three.js 只负责根据业务状态显示托盘位置和动画。

最终运行链：

```text
SourceQueue
↓
进入 Section
↓
Section 内运动
↓
到达 Section 边界
↓
检查目标 Section Capacity
↓
Reserve
↓
成功则 Transfer
失败则 Waiting
↓
下游释放
↓
Resume
↓
遇到岔口时按 PLC / Simulation / Manual 决策
↓
进入目标 Section
```

---

# 2. 当前最新代码状态

当前 `Develop` 最新提交：

```text
c0c5eb1ce12dfa8e75c0055b0cb70a523cfa2b64
```

提交说明：

```text
新增模拟运行场景
```

当前新增了：

```text
ClientApp/src/digital-twin/runtime/ProceduralPackagingLine.ts
ClientApp/src/digital-twin/runtime/TwinMaterialFlowRuntime.ts
```

并修改了：

```text
TwinRuntime.ts
RouteEngine.ts
contracts/index.ts
workbench.vue
```

---

# 3. 当前已经完成的基础能力

## 3.1 Section Capacity

当前 Edge 已经具备：

```text
capacity
occupancyMode
reservationTimeoutSeconds
occupancyBindingId
fullBindingId
blockedBindingId
```

其中：

```text
Route Edge = 物理缓存段 / Section
```

这是正确方向。

## 3.2 Occupancy

当前已经支持：

```text
calculated
simulation
live
```

三种模式。

`calculated / simulation` 由实体集合计算占用；`live` 以 PLC / IoT 实时数量为权威。

## 3.3 Reserved

当前已经支持 Reservation。

判断：

```text
Occupancy + Reserved >= Capacity
```

则 Section 满位。

这样可以避免两个托盘同时抢占最后一个空位。

## 3.4 tryTransfer()

当前已经实现：

```text
Reserve Target
↓
Enter Target
↓
Leave Source
```

并且只有目标段真正成功进入后，才释放源段。

该设计应保留。

## 3.5 Waiting

当前已经存在：

```text
TARGET_SECTION_FULL
TARGET_SECTION_BLOCKED
TARGET_SECTION_SIGNAL_STALE
ROUTE_NOT_READY
DIVERTER_NOT_READY
```

这些 Waiting Reason 可以继续复用。

## 3.6 Junction

当前已经具备：

```text
PLC
Simulation
Manual
```

三种岔口模式。

并已经存在：

```text
tryAdvanceAtJunction()
```

可以完成：

```text
RouteDecision
↓
机构到位
↓
目标 Section 校验
↓
Transfer / Waiting
```

---

# 4. 当前真正的问题

当前：

```text
TwinMaterialFlowRuntime
```

已经有业务运行规则。

但是：

```text
ProceduralPackagingLine
```

里的 50 个托盘并没有使用这些规则。

现在实际上是两套并行逻辑：

```text
TwinMaterialFlowRuntime
↓
Capacity / Reserved / Waiting
↓
只产生运行状态
```

另一边：

```text
ProceduralPackagingLine
↓
50个托盘
↓
distance += speed
↓
无限循环
```

两者没有真正连接。

因此：

> Section 已经满位，业务层知道“不能进”，但 Three.js 托盘仍然继续往前跑。

---

# 5. 当前 ProceduralPackagingLine 的问题

目前 PalletEntity 的核心状态类似：

```ts
interface PalletEntity {
    root: any;
    path: 'A' | 'B';
    distance: number;
    initialDistance: number;
}
```

它只知道：

```text
A 路 / B 路
整条路线 Distance
```

不知道：

```text
currentSectionId
nextSectionId
sectionProgress
state
waitingReason
waitingForSectionId
activeDecision
```

因此无法执行真正的 Section 运行规则。

---

# 6. 当前运动算法必须取消

当前核心逻辑类似：

```ts
for (const pallet of this.pallets) {
    const path = this.paths[pallet.path];

    pallet.distance =
        (pallet.distance + this.speed * deltaSeconds)
        % path.length;
}
```

该逻辑必须从“业务运动”中移除。

因为它意味着：

```text
整条路径连续前进
↓
超过总长度
↓
取模
↓
重新开始
```

完全不会经过：

```text
Reserve
CanAccept
Enter
Leave
Waiting
Resume
```

---

# 7. 50托盘初始化方式也必须修改

当前 50 个托盘按照整条 A/B 路径均匀分布。

这种方式只能用于：

```text
视觉 Demo
```

不能用于：

```text
真实物流规则模拟
```

因为无法保证：

```text
Section01 Capacity = 5
```

就最多只有 5 个托盘。

---

# 8. 新的核心架构

建议变成：

```text
TwinMaterialFlowRuntime
        ↓
     业务状态
        ↓
PalletFlowController
        ↓
  Three.js Pose
        ↓
ProceduralPackagingLine
```

职责：

```text
TwinMaterialFlowRuntime
→ 决定能不能流转

PalletFlowController
→ 负责托盘如何在 Section 中运行

ProceduralPackagingLine
→ 只负责模型和动画显示
```

---

# 9. 新增 PalletFlowController

建议新增：

```text
ClientApp/src/digital-twin/runtime/PalletFlowController.ts
```

职责：

- 创建模拟托盘
- SourceQueue
- Section 内进度
- Section Boundary
- 调用 `tryTransfer()`
- 调用 `tryAdvanceAtJunction()`
- Waiting
- Resume
- Sink
- Loop
- 将业务位置转换成 Three.js Pose

---

# 10. PalletEntity 改造

建议改成：

```ts
interface PalletEntity {
    entityId: string;

    root: any;

    payload?: Record<string, unknown>;

    currentSectionId?: string;

    nextSectionId?: string;

    sectionProgress: number;

    state:
        | 'queued'
        | 'moving'
        | 'waiting'
        | 'completed';

    waitingReason?: string;

    waitingForSectionId?: string;

    activeDecision?: TwinRouteDecision;
}
```

不再把：

```text
distance
```

作为主要业务状态。

---

# 11. 使用 Section Progress

托盘业务位置应该表示为：

```text
currentSectionId = Section02
sectionProgress = 0.65
```

含义：

```text
当前位于 Section02
已经运行到该 Section 的 65%
```

而不是：

```text
整条路线已经走了 37.8 米
```

---

# 12. 新增 Section Geometry Resolver

建议新增：

```text
ClientApp/src/digital-twin/runtime/TwinSectionGeometryResolver.ts
```

负责把：

```text
Route Edge
```

转换成：

```text
Section Geometry
```

例如：

```ts
interface TwinSectionGeometry {
    sectionId: string;
    edgeId: string;

    fromPointId: string;
    toPointId: string;

    curve: THREE.Curve<THREE.Vector3>;

    length: number;
}
```

---

# 13. Section 内运动

每个 Tick：

```text
state = moving
↓
获取当前 Section Geometry
↓
sectionProgress += speed × dt / sectionLength
```

如果：

```text
sectionProgress < 1
```

继续运动。

如果：

```text
sectionProgress >= 1
```

必须停在 Section 边界进行业务判断。

不能直接跨入下一节。

---

# 14. 普通 Section Boundary

例如：

```text
Section02 → Section01
```

P001 已经运行到 Section02 末端：

```text
sectionProgress = 1
```

执行：

```text
flowRuntime.sections.tryTransfer(
    P001,
    Section02,
    Section01
)
```

---

# 15. Transfer 成功

如果 Section01：

```text
Capacity = 5
Occupancy = 4
Reserved = 0
```

则：

```text
Reserve
↓
成功
↓
Enter Section01
↓
Leave Section02
```

然后：

```text
P001.currentSectionId = Section01
P001.sectionProgress = 0
P001.state = moving
```

Three.js 开始在 Section01 内继续移动。

---

# 16. Transfer 失败

如果：

```text
Section01
Capacity = 5
Occupancy = 5
```

则：

```text
P001.state = waiting
P001.sectionProgress = 1
P001.waitingForSectionId = Section01
P001.waitingReason = TARGET_SECTION_FULL
```

Three.js 模型保持在：

```text
Section02 末端
```

不再移动。

---

# 17. Waiting / Resume

Waiting 托盘需要持续等待目标 Section。

第一阶段可以每个 Fixed Tick 重试：

```text
Waiting
↓
检查目标 Section
↓
CanAccept?
```

如果成功：

```text
Reserve
↓
Transfer
↓
Resume
```

后续可以改成事件驱动：

```text
SectionAvailable
↓
唤醒 Waiting Queue
```

---

# 18. 两节容量示例

配置：

```text
Section02 → Section01

Section01 Capacity = 5
Section02 Capacity = 6
```

第一节满：

```text
Section01
5 / 5
```

结果：

```text
Section02 最前面的托盘
↓
Waiting
```

第二节内部仍然允许继续存在托盘，直到：

```text
Section02
6 / 6
```

之后更上游停止进入。

---

# 19. 阻塞传播

最终效果：

```text
Section01
[P][P][P][P][P]
5 / 5 FULL

↑
禁止进入

Section02
[P][P][P][P][P][P]
6 / 6 FULL

↑
禁止进入

Section03
Pallet Waiting
```

这就是正常的：

```text
Blocked Propagation
```

不需要托盘距离碰撞。

---

# 20. 岔口必须在 Section Boundary 处理

如果当前 Section 终点是：

```text
junction
diverter
```

则不能直接：

```text
tryTransfer()
```

而应调用：

```text
tryAdvanceAtJunction()
```

---

# 21. Simulation 岔口

例如：

```text
SKU A → Left
SKU B → Right
```

P001：

```text
payload.sku = A
```

到岔口：

```text
tryAdvanceAtJunction()
↓
Simulation Rule
↓
EdgeLeft
↓
RouteDecision Locked
```

---

# 22. PLC 岔口

真实模式：

```text
PLC RouteCode = 2
```

映射：

```text
2 → EdgeRight
```

当前托盘：

```text
P001 → Right
```

RouteDecision 必须锁存。

后续 PLC 为下一个托盘切换成：

```text
RouteCode = 1
```

不得改变 P001。

---

# 23. 目标分支满位

例如 PLC 已经指定：

```text
P001 → Left
```

但是：

```text
LeftSection
5 / 5
```

那么：

```text
P001 Waiting
```

不能改去 Right。

等待：

```text
LeftSection
5 → 4
```

以后：

```text
Resume
```

继续走 Left。

---

# 24. Diverter Position

如果配置了执行器到位信号：

```text
RouteDecision = Left
```

还需要：

```text
DiverterPosition = Left
```

才允许进入目标 Section。

否则：

```text
WaitingReason = DIVERTER_NOT_READY
```

---

# 25. SourceQueue 必须新增

当前：

```text
palletCount = 50
```

不能再理解为：

```text
一次把50个全部铺在线上
```

应该理解为：

```text
总共需要模拟50个托盘
```

然后进入：

```text
SourceQueue
```

---

# 26. SourceQueue 数据结构

建议：

```ts
interface TwinSourceQueue {
    queueId: string;

    entrySectionId: string;

    waitingEntityIds: string[];

    releaseMode:
        | 'continuous'
        | 'interval'
        | 'manual';

    releaseIntervalSeconds?: number;
}
```

---

# 27. 正确的 50 托盘初始化

例如：

```text
Section01 Capacity = 5
Section02 Capacity = 6
Section03 Capacity = 4
Section04 Capacity = 3
```

整线逻辑容量：

```text
18
```

模拟：

```text
PalletCount = 50
```

那么：

```text
线上最多按照容量运行
剩余托盘留在 SourceQueue
```

不能再均匀铺在整条路线。

---

# 28. SourceQueue 投放逻辑

入口 Section：

```text
CanAccept = true
```

则：

```text
SourceQueue
↓
取第一个托盘
↓
Reserve EntrySection
↓
Enter
↓
state = moving
```

入口满：

```text
继续在 SourceQueue 等
```

---

# 29. Sink

没有下游的终点应该定义为：

```text
Sink
```

托盘达到 Sink：

```text
Leave CurrentSection
↓
state = completed
```

如果模拟设置：

```text
loopEntities = true
```

则：

```text
completed
↓
重新加入 SourceQueue
```

这样还能做长时间压力测试。

---

# 30. ProceduralPackagingLine 职责调整

当前它同时负责：

```text
线体生成
托盘生成
托盘业务运动
设备动画
```

改造后：

```text
ProceduralPackagingLine
```

只负责：

- Three.js 输送线几何
- 辊筒
- 桁架
- 转台
- 机器人
- 托盘 Mesh
- 托盘 Pose
- 纯视觉动画

不负责：

```text
Capacity
Reserved
Waiting
RouteDecision
Blocked Propagation
```

---

# 31. ProceduralPackagingLine 建议新接口

```ts
createPallet(
    entityId: string,
    payload?: Record<string, unknown>
): void;

setPalletPose(
    entityId: string,
    position: THREE.Vector3,
    direction: THREE.Vector3
): void;

setPalletState(
    entityId: string,
    state: 'moving' | 'waiting'
): void;

removePallet(
    entityId: string
): void;
```

---

# 32. TwinRuntime 改造

当前动画循环：

```ts
while (this.accumulator >= this.fixedStep) {

    this.routeEngine.updateFixed(
        this.fixedStep
    );

    this.packagingLine?.updateFixed(
        this.fixedStep
    );

    this.bindingEngine.tick(
        this.fixedStep
    );

    this.accumulator -= this.fixedStep;
}
```

建议改为：

```ts
while (this.accumulator >= this.fixedStep) {

    this.routeEngine.updateFixed(
        this.fixedStep
    );

    this.palletFlowController?.updateFixed(
        this.fixedStep,
        this.routingContext
    );

    this.bindingEngine.tick(
        this.fixedStep
    );

    this.accumulator -= this.fixedStep;
}
```

不再由：

```text
ProceduralPackagingLine.updateFixed()
```

直接推进托盘业务位置。

---

# 33. 推荐最终运行结构

```text
TwinRuntime
│
├── BindingEngine
│
├── RouteEngine
│
├── TwinMaterialFlowRuntime
│   ├── TwinSectionManager
│   ├── TwinEntityManager
│   └── TwinJunctionManager
│
├── PalletFlowController
│
├── TwinSectionGeometryResolver
│
└── ProceduralPackagingLine
```

---

# 34. PalletFlowController 接口建议

```ts
class PalletFlowController {

    constructor(
        route: TwinRouteDefinition,
        flowRuntime: TwinMaterialFlowRuntime,
        renderer: ProceduralPackagingLine
    ) {}

    initialize(
        palletCount: number
    ): void;

    setRunning(
        running: boolean
    ): void;

    updateFixed(
        deltaSeconds: number,
        context: TwinRouteRoutingContext
    ): void;

    reset(): void;

    getSnapshot(): TwinPalletFlowSnapshot;
}
```

---

# 35. Section Position 计算

Section：

```text
sectionProgress = 0.65
```

计算：

```ts
const position =
    section.curve.getPointAt(
        sectionProgress
    );

const tangent =
    section.curve.getTangentAt(
        sectionProgress
    );
```

然后：

```text
PalletFlowController
↓
ProceduralPackagingLine.setPalletPose()
```

---

# 36. Waiting 视觉表现

Waiting 时：

```text
sectionProgress
```

保持不变。

建议页面可显示：

```text
P018

WAITING

TARGET_SECTION_FULL
```

第一阶段先保证运行逻辑正确即可。

---

# 37. Section Debug Overlay

建议运行页面增加：

```text
显示 Section 状态
```

例如：

```text
入口段
3 / 5
AVAILABLE
```

```text
包装段
5 / 5
FULL
```

```text
汇流段
2 / 4
RESERVED 1
```

---

# 38. Pallet 调试信息

点击托盘显示：

```text
Entity ID:
P001

SKU:
A

Current Section:
Section02

Progress:
100%

State:
Waiting

Waiting For:
Section01

Reason:
TARGET_SECTION_FULL

Route Decision:
Left
```

---

# 39. reset() 必须完整重置

以后 Reset 不只是：

```text
distance = 0
```

还要重置：

```text
Section Occupancy
Reservation
InFlight
Entity State
Waiting
RouteDecision
SourceQueue
CompletedQueue
sectionProgress
```

---

# 40. setRoute() 必须同步重建

Route 修改以后：

```text
normalizeRoute
↓
TwinMaterialFlowRuntime.setRoute()
↓
重建 Section Geometry
↓
PalletFlowController.setRoute()
↓
ProceduralPackagingLine 更新几何
```

三层必须同步。

---

# 41. Live 模式

Live 模式继续保持：

```text
PLC Occupancy 为权威
```

对于：

```text
occupancyMode = live
```

不能使用模拟实体数量覆盖 PLC。

模拟对象可以继续显示，但 Capacity 判断以 PLC 信号为准。

---

# 42. Simulation 模式

Simulation 的 Occupancy 由运行实体集合计算。

这正适合当前 50 托盘模拟器。

因此不需要另外再写一套 Simulation Capacity 逻辑，直接复用：

```text
TwinSectionManager
```

即可。

---

# 43. 本轮不要优先做碰撞检测

暂时不要把开发重点放到：

```text
Box3
OBB
Cannon
```

当前最大的问题不是物理碰撞，而是：

> 已经存在的业务运行状态没有控制 50 个 Three.js 托盘。

本轮应该先把业务流真正跑通。

---

# 44. 开发阶段建议

## Phase 1：托盘接入 Runtime

完成：

```text
50 个托盘
↓
TwinEntityManager
```

增加 SourceQueue，取消整条路径平均铺开。

## Phase 2：Section 内运行

实现：

```text
currentSectionId
sectionProgress
Section Geometry
```

## Phase 3：普通 Section Transfer

实现：

```text
到达 Section 末端
↓
tryTransfer()
```

支持：

```text
Full
Waiting
Resume
```

## Phase 4：阻塞传播

验证：

```text
第一节 5/5
↓
第二节不能出料

第二节 6/6
↓
第三节不能出料
```

## Phase 5：Junction

接入：

```text
tryAdvanceAtJunction()
```

支持：

```text
Simulation
PLC
Manual
```

## Phase 6：Source / Sink / Loop

支持：

```text
50托盘逐步上线
出口完成
重新循环
```

## Phase 7：运行调试 UI

增加：

```text
Section Snapshot
Entity Snapshot
WaitingReason
RouteDecision
BlockingChain
```

---

# 45. 验收场景一：容量

配置：

```text
Section01 Capacity = 5
```

无论模拟多少托盘，`Occupancy + Reserved` 不得超过 5。

---

# 46. 验收场景二：两节缓存

配置：

```text
Section02 → Section01

Section01 Capacity = 5
Section02 Capacity = 6
```

当：

```text
Section01 = 5 / 5
```

要求：

```text
Section02 最前方托盘 Waiting
```

但 Section02 本身仍然最多可以存在 6 个托盘。

---

# 47. 验收场景三：自动恢复

第一节：

```text
5 / 5
```

变成：

```text
4 / 5
```

要求：

```text
等待托盘自动 Reserve
↓
Resume
↓
进入第一节
```

不需要人工再点运行。

---

# 48. 验收场景四：阻塞传播

当：

```text
Section01 = 5 / 5
Section02 = 6 / 6
```

则 Section03 不能继续向 Section02 放料。

---

# 49. 验收场景五：Simulation 岔口

规则：

```text
SKU-A → Left
SKU-B → Right
```

要求：

```text
A 托盘走 Left
B 托盘走 Right
```

当前托盘 RouteDecision 必须锁存。

---

# 50. 验收场景六：目标分支满位

P001 已经决定：

```text
Left
```

但：

```text
LeftSection = Full
```

要求：

```text
P001 Waiting
```

不能自动改去 Right。

---

# 51. 验收场景七：PLC 岔口

PLC：

```text
RouteCode = 2
```

映射：

```text
2 → Right
```

要求当前托盘 `RouteDecision = Right`，PLC 后续改变不能修改已经锁定的托盘。

---

# 52. 验收场景八：50托盘

整条线当前总 Capacity：

```text
18
```

模拟：

```text
50
```

要求：

```text
线上运行实体不能无视 Section Capacity
剩余托盘留在 SourceQueue
```

不能再把 50 个托盘平均铺在整条路径。

---

# 53. 主要修改文件

## 必改

```text
ClientApp/src/digital-twin/runtime/ProceduralPackagingLine.ts
```

目标：

```text
从业务运动控制器
改成 Three.js 渲染器
```

## 必改

```text
ClientApp/src/digital-twin/runtime/TwinRuntime.ts
```

增加：

```text
PalletFlowController
```

并修改 Fixed Tick。

## 建议新增

```text
ClientApp/src/digital-twin/runtime/PalletFlowController.ts
```

这是本轮最核心的新文件。

## 建议新增

```text
ClientApp/src/digital-twin/runtime/TwinSectionGeometryResolver.ts
```

负责：

```text
RouteEdge → Section Curve
```

## 继续复用

```text
ClientApp/src/digital-twin/runtime/TwinMaterialFlowRuntime.ts
```

不重新实现：

```text
Capacity
Occupancy
Reserved
Waiting
Junction
```

## 继续复用

```text
ClientApp/src/digital-twin/routes/RouteEngine.ts
```

继续负责：

```text
路由拓扑
路径解析
Route Decision 基础
单物料路径运行
```

---

# 54. 不要重复开发的内容

当前已经存在，不建议推翻：

```text
TwinSectionManager
TwinEntityManager
TwinJunctionManager
Capacity
Occupancy
Reserved
tryTransfer()
tryAdvanceAtJunction()
WaitingReason
BlockingChain
PLC / Simulation / Manual
```

本轮开发重点是：

> 把这些已经实现的规则真正接到 50 个 Three.js 托盘上。

---

# 55. 最终架构

```text
                  PLC / Simulation / Manual
                            │
                            ▼
                       BindingEngine
                            │
                            ▼
                 TwinMaterialFlowRuntime
                 │          │           │
                 ▼          ▼           ▼
          SectionManager EntityManager JunctionManager
                 │
                 └──────────┬───────────┘
                            ▼
                  PalletFlowController
                            │
                ┌───────────┴───────────┐
                ▼                       ▼
          Section State            Entity State
                │                       │
                └───────────┬───────────┘
                            ▼
               ProceduralPackagingLine
                            │
                            ▼
                      Three.js Scene
```

---

# 56. 最终结论

当前 IoTSharp 最新代码已经有：

```text
Capacity
Occupancy
Reserved
Waiting
Junction
PLC / Simulation / Manual
```

这些核心运行规则基础。

真正缺少的是：

```text
ProceduralPackagingLine
        ↓
接入
        ↓
TwinMaterialFlowRuntime
```

因此本轮不应该重新设计一套 Capacity 系统。

应该围绕：

```text
PalletFlowController
```

完成桥接。

最终从当前：

```text
50 个托盘沿整条路线无限循环
```

升级为：

```text
SourceQueue
↓
Section
↓
SectionProgress
↓
Boundary
↓
Reserve
↓
Transfer
↓
Waiting
↓
Resume
↓
Junction Decision
↓
Target Section
↓
Sink / Loop
```

完成以后，IoTSharp 的模拟模式才真正变成：

> 分段存储、分段流转、容量受控、岔口可决策、阻塞可传播的工业物流数字孪生模拟器。
