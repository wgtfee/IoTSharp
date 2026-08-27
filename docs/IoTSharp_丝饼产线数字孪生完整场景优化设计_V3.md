# IoTSharp 丝饼产线数字孪生完整场景优化与分段运行改造设计 V3

> 用途：本文件用于直接交给 AI / Codex / 开发人员，对 IoTSharp `Develop` 分支当前数字孪生场景进行后续优化和实现。  
> 本文不是概念草案，而是基于当前已经存在的 `TwinMaterialFlowRuntime`、`TwinSectionManager`、`TwinJunctionManager`、`ProceduralPackagingLine` 等代码继续演进的实施设计。

---

# 1. 本次改造的核心目标

当前 IoTSharp 最新模拟场景已经新增：

```text
TwinSectionManager
TwinEntityManager
TwinJunctionManager
TwinMaterialFlowRuntime
Capacity
Occupancy
Reserved
Waiting
tryTransfer()
tryAdvanceAtJunction()
Simulation / PLC / Manual
```

这些分段运行基础已经存在。

但是当前 `ProceduralPackagingLine` 的 50 个托盘仍然采用：

```text
沿整条路线均匀铺开
+
distance += speed
+
循环运行
```

这与真实生产场景不一致。

同时，当前程序化包装线中如果使用了：

```text
纸箱
+
木托盘
```

作为输送物料，也需要整体替换。

真实场景应调整为：

```text
丝车
↓
丝车上存放多个丝饼
↓
旋转台带动丝车定位
↓
机器人从丝车抓取丝饼
↓
放到线体上的塑料托盘
↓
塑料托盘载着丝饼开始分段运行
↓
经过缓存段 / 岔口 / PLC 分流
↓
到达桁架码垛工位
↓
桁架从塑料托盘抓取丝饼
↓
完成码垛
↓
塑料托盘变为空托盘
↓
空托盘继续运行 / 回流
↓
重新到机器人上料工位
↓
机器人再次从丝车抓取新的丝饼
↓
进入下一循环
```

本次改造的最终目标是：

> 将当前数字孪生从“视觉包装线 Demo”升级为“丝饼生产物流数字孪生运行场景”。

---

# 2. 实物参考必须严格遵守

用户提供的实物照片明确了线体托盘和丝饼的真实外形关系。

照片中的主体结构应理解为：

```text
上部：
白色 / 浅色丝饼

下部：
绿色塑料托盘

托盘结构：
圆形底盘
+
中心立柱 / 中心筒
+
加强筋
```

必须明确：

```text
不是纸箱
不是木托盘
不是纸箱放到木托盘上输送
```

后续 AI 优化场景时，不允许再把运行实体画成：

```text
Brown Box
Wood Pallet
```

正确对象应该是：

```text
SilkCake
+
PlasticPallet
```

---

# 3. 真实工艺总览

整个数字孪生建议分成 6 个主要业务区域：

```text
A. 丝车供料区
B. 旋转台定位区
C. 机器人上料区
D. 分段输送 / 缓存 / 岔口区
E. 桁架码垛区
F. 空托盘回流区
```

完整流程：

```text
┌─────────────────┐
│    丝车供料区    │
│ SilkCart + 丝饼  │
└────────┬────────┘
         ↓
┌─────────────────┐
│      旋转台       │
│  丝车旋转 / 定位   │
└────────┬────────┘
         ↓
┌─────────────────┐
│    上料机器人区    │
│ Robot Pick Silk  │
│ Cake From Cart   │
└────────┬────────┘
         ↓
┌─────────────────┐
│   空塑料托盘到位   │
│ Empty Pallet     │
└────────┬────────┘
         ↓
       放置丝饼
         ↓
┌─────────────────┐
│ Loaded Pallet   │
│ 塑料托盘 + 丝饼   │
└────────┬────────┘
         ↓
┌─────────────────┐
│ 分段输送 / 缓存线 │
│ Section Runtime │
└────────┬────────┘
         ↓
        岔口
         ↓
  PLC / Simulation
       决定路线
         ↓
┌─────────────────┐
│   桁架码垛工位     │
│ Gantry Pick     │
│ + Stack         │
└────────┬────────┘
         ↓
      丝饼离开托盘
         ↓
┌─────────────────┐
│    空塑料托盘      │
│ Empty Pallet    │
└────────┬────────┘
         ↓
      空托盘回流
         ↓
   再次进入上料工位
```

---

# 4. 业务实体必须拆分

当前不能再把“托盘上的东西”作为一个简单 Three.js Mesh。

建议明确拆成以下业务实体：

```text
SilkCake
PlasticPallet
SilkCart
RotaryTable
LoadingRobot
GantryStacker
StackArea
TwinSection
TwinJunction
ProcessStation
```

---

# 5. SilkCake：丝饼实体

建议新增：

```ts
export interface SilkCakeEntity {
    silkCakeId: string;

    batchNo?: string;

    materialCode?: string;

    colorCode?: string;

    weightKg?: number;

    quality?: 'normal' | 'ng' | 'unknown';

    state:
        | 'on-cart'
        | 'robot-picking'
        | 'on-pallet'
        | 'conveying'
        | 'gantry-picking'
        | 'stacked'
        | 'completed'
        | 'fault';

    currentCarrierType?:
        | 'silk-cart'
        | 'plastic-pallet'
        | 'robot-gripper'
        | 'gantry-gripper'
        | 'stack-area';

    currentCarrierId?: string;

    currentSectionId?: string;

    stackPosition?: {
        layer: number;
        row: number;
        column: number;
    };
}
```

---

# 6. SilkCake 的状态生命周期

一个丝饼的生命周期：

```text
on-cart
↓
robot-picking
↓
on-pallet
↓
conveying
↓
gantry-picking
↓
stacked
↓
completed
```

例如：

```text
SilkCake-001

初始：
state = on-cart
currentCarrierId = Cart-01

机器人抓取：
state = robot-picking
currentCarrierId = Robot-01-Gripper

放到托盘：
state = on-pallet
currentCarrierId = Pallet-001

输送：
state = conveying

桁架抓取：
state = gantry-picking
currentCarrierId = Gantry-01-Gripper

码垛：
state = stacked
currentCarrierId = Stack-01
```

---

# 7. PlasticPallet：塑料托盘实体

必须替换当前木托盘视觉和业务概念。

建议：

```ts
export interface PlasticPalletEntity {
    palletId: string;

    currentSectionId?: string;

    nextSectionId?: string;

    sectionProgress: number;

    state:
        | 'queued'
        | 'empty'
        | 'waiting-load'
        | 'loading'
        | 'loaded'
        | 'moving'
        | 'waiting'
        | 'unloading'
        | 'empty-return'
        | 'completed'
        | 'fault';

    silkCakeId?: string;

    waitingReason?: TwinFlowWaitingReason;

    waitingForSectionId?: string;

    activeDecision?: TwinRouteDecision;

    cycleCount: number;
}
```

---

# 8. 塑料托盘必须区分 Empty / Loaded

核心状态：

```text
EMPTY
LOADED
```

空托盘：

```text
Pallet-001
state = empty
silkCakeId = null
```

有料托盘：

```text
Pallet-001
state = loaded
silkCakeId = SilkCake-031
```

Section Capacity 占用仍然只按：

```text
PlasticPallet
```

计数。

不要把：

```text
PlasticPallet + SilkCake
```

计算成两个 Section Occupancy。

---

# 9. 塑料托盘 3D 外观要求

参考用户实物照片，程序化塑料托盘至少应包含：

```text
圆形底盘
圆环
径向加强筋
中心圆筒 / 立柱
绿色塑料材质
```

建议：

```text
Base:
CylinderGeometry

Outer Ring:
TorusGeometry / Cylinder Ring

Center Column:
CylinderGeometry

Reinforcement:
BoxGeometry × N
```

颜色可按照实物：

```text
深绿色 / 工业绿色
```

后续如有真实 GLB，应优先使用模型资源库中的 GLB。

---

# 10. SilkCake 3D 外观要求

第一阶段可以程序化建模。

建议表现：

```text
白色 / 浅色
大直径
较扁圆柱
中央孔
轻微丝线层次感
```

基础结构可以：

```text
CylinderGeometry
+
中心孔模拟
+
轻量材质纹理
```

不需要为了纤维细节生成几十万根丝线。

重点：

```text
轮廓正确
尺寸比例正确
与塑料托盘关系正确
```

---

# 11. SilkCart：丝车

旋转台上放置的不是托盘，而是：

```text
丝车
```

丝车承载多个 SilkCake。

建议：

```ts
export interface SilkCartEntity {
    cartId: string;

    stationId?: string;

    state:
        | 'waiting'
        | 'positioning'
        | 'ready'
        | 'feeding'
        | 'empty'
        | 'replace-required'
        | 'completed'
        | 'fault';

    slotIds: string[];

    remainingCount: number;

    currentPickSlotId?: string;
}
```

---

# 12. SilkCartSlot：丝车挂点 / 存储位

丝车上的丝饼不能只视觉摆放。

必须有业务 Slot。

```ts
export interface SilkCartSlot {
    slotId: string;

    cartId: string;

    localPosition: [number, number, number];

    localRotation?: [number, number, number];

    silkCakeId?: string;

    state:
        | 'occupied'
        | 'reserved'
        | 'empty'
        | 'fault';
}
```

例如：

```text
Cart-01
├── Slot-01 → SilkCake-001
├── Slot-02 → SilkCake-002
├── Slot-03 → SilkCake-003
├── Slot-04 → SilkCake-004
└── Slot-05 → Empty
```

---

# 13. 机器人从 Slot 抓取

必须明确：

```text
Robot Pick
```

是：

```text
SilkCartSlot
↓
SilkCake
↓
RobotGripper
```

而不是：

```text
机器人随机从空气里生成一个丝饼
```

抓取成功后：

```text
slot.silkCakeId = null
slot.state = empty
cart.remainingCount--
```

---

# 14. RotaryTable：旋转台

用户明确：

> 旋转台上放的是丝车，丝车上放丝饼。

因此当前数字孪生中的旋转台需要按该功能改造。

结构：

```text
RotaryTable
└── SilkCart
    ├── SilkCake
    ├── SilkCake
    ├── SilkCake
    └── ...
```

---

# 15. RotaryTable 状态

建议：

```ts
export interface RotaryTableRuntime {
    tableId: string;

    currentCartId?: string;

    currentAngle: number;

    targetAngle: number;

    state:
        | 'idle'
        | 'positioning'
        | 'rotating'
        | 'ready'
        | 'locked'
        | 'fault';

    currentPickSlotId?: string;
}
```

---

# 16. 旋转台实际动作

每抓取一个丝饼后，需要决定：

```text
下一个可抓取 Slot
```

如果下一个 Slot 不在机器人抓取位：

```text
RotaryTable
↓
Rotate
↓
SilkCart 整体旋转
↓
Target Slot 到位
↓
Ready
```

机器人才能执行下一次抓取。

---

# 17. LoadingRobot：上料机器人

机器人的真实职责：

```text
从丝车抓丝饼
↓
放到空塑料托盘
```

机器人不应该无条件一直摆动。

机器人动作必须由：

```text
业务任务
```

驱动。

---

# 18. 上料工位触发条件

只有满足：

```text
Empty Pallet 已到位
AND
SilkCart 已到位
AND
SilkCart RemainingCount > 0
AND
RotaryTable Ready
AND
Robot Idle
```

才允许创建：

```text
RobotPickAndPlaceTask
```

---

# 19. LoadingStation 状态机

建议：

```text
Idle
↓
WaitingEmptyPallet
↓
PalletPositioned
↓
WaitingSilkCart
↓
RotaryPositioning
↓
ReadyForPick
↓
RobotPicking
↓
RobotTransferring
↓
RobotPlacing
↓
LoadCompleted
↓
ReleaseLoadedPallet
↓
WaitingEmptyPallet
```

---

# 20. RobotPickAndPlaceTask

建议新增：

```ts
export interface RobotPickAndPlaceTask {
    taskId: string;

    robotId: string;

    cartId: string;

    sourceSlotId: string;

    silkCakeId: string;

    targetPalletId: string;

    state:
        | 'pending'
        | 'approach-pick'
        | 'lower-pick'
        | 'grip'
        | 'lift'
        | 'transfer'
        | 'lower-place'
        | 'release'
        | 'return-home'
        | 'completed'
        | 'fault';

    progress: number;

    startedAt?: number;

    completedAt?: number;
}
```

---

# 21. Robot 动画不要再用永久 Sin 动画

如果当前 `ProceduralPackagingLine` 中机器人通过：

```ts
Math.sin(...)
```

持续摆动，应修改。

允许保留：

```text
关节插值
```

但驱动参数必须来自：

```text
RobotTask.progress
```

而不是：

```text
elapsedSeconds 永久循环
```

---

# 22. Robot Pick 动画建议

一个完整任务：

```text
0.00 ~ 0.15
移动到丝车 Slot 上方

0.15 ~ 0.25
下降

0.25
夹具闭合 / Attach SilkCake

0.25 ~ 0.40
提升

0.40 ~ 0.65
移动到塑料托盘上方

0.65 ~ 0.78
下降

0.78
释放 SilkCake

0.78 ~ 1.00
Robot Return Home
```

---

# 23. Robot 抓取时 Three.js Parent 必须切换

Pick 瞬间：

```text
Before:

SilkCart
└── SilkCake
```

抓取后：

```text
RobotGripper
└── SilkCake
```

Three.js 不能仅改变世界坐标。

建议使用：

```text
Object3D.attach()
```

保证世界坐标不跳变。

业务状态同时更新：

```text
SilkCake.state = robot-picking
SilkCake.currentCarrierId = RobotGripper
```

---

# 24. Robot Place 时 Parent 再切换

放料前：

```text
RobotGripper
└── SilkCake
```

放料后：

```text
PlasticPallet
└── SilkCake
```

业务：

```text
SilkCake.state = on-pallet
SilkCake.currentCarrierId = Pallet-001

Pallet.state = loaded
Pallet.silkCakeId = SilkCake-001
```

---

# 25. 托盘必须等机器人完成后才能运行

空托盘到 LoadingStation：

```text
必须停止
```

即使下游 Section 有位置也不能立即放行。

`CanRelease` 必须增加：

```text
ProcessCompleted
```

概念。

最终：

```text
CanRelease =
DownstreamCanAccept
AND
ProcessStationReady
AND
LoadingCompleted
AND
NoFault
```

---

# 26. ProcessStationManager

建议新增统一工位管理：

```text
ProcessStationManager
```

后续可复用给：

```text
机器人上料
桁架下料
扫码
检测
称重
人工工位
```

建议：

```ts
interface TwinProcessStationRuntime {
    stationId: string;

    sectionId: string;

    type:
        | 'robot-loading'
        | 'gantry-stacking'
        | 'scan'
        | 'inspection';

    state:
        | 'idle'
        | 'waiting'
        | 'processing'
        | 'completed'
        | 'fault';

    currentEntityId?: string;

    canRelease: boolean;
}
```

---

# 27. 分段输送仍使用 TwinSection

加载完成以后：

```text
PlasticPallet + SilkCake
```

开始进入线体。

但 Section 业务实体仍然是：

```text
PlasticPallet
```

结构：

```text
TwinSection
├── Capacity
├── Occupancy
├── Reserved
├── CanAccept
├── CanRelease
└── State
```

---

# 28. 当前 50 托盘持续循环问题仍必须改

上一版文档的核心结论继续保留。

当前：

```text
ProceduralPackagingLine.updateFixed()
```

不能再让所有托盘：

```text
distance += speed
```

无限循环。

必须改成：

```text
PalletFlowController
↓
currentSectionId
↓
sectionProgress
↓
Boundary
↓
tryTransfer()
```

---

# 29. PalletFlowController

建议新增：

```text
ClientApp/src/digital-twin/runtime/PalletFlowController.ts
```

负责：

```text
塑料托盘实体
SourceQueue
Empty / Loaded
SectionProgress
Section Transfer
Waiting
Resume
Junction
ProcessStation
EmptyReturn
Sink / Loop
```

---

# 30. PlasticPallet 的位置状态

不要再以：

```text
WholeRouteDistance
```

作为业务主状态。

改成：

```text
currentSectionId
+
sectionProgress
```

例如：

```text
Pallet-031

currentSectionId = Section-05
sectionProgress = 0.73
state = moving
silkCakeId = SilkCake-091
```

---

# 31. Section Geometry

建议新增：

```text
TwinSectionGeometryResolver
```

将：

```text
RouteEdge
```

转换为：

```text
Section Curve
```

示例：

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

# 32. Section 内运动

```text
sectionProgress +=
speed * dt / sectionLength
```

只有：

```text
sectionProgress < 1
```

时移动。

达到：

```text
1.0
```

必须执行 Section Boundary 判断。

---

# 33. 普通 Section 边界

```text
CurrentSection
↓
TargetSection
```

执行：

```text
tryTransfer()
```

如果：

```text
Target Capacity Available
```

则：

```text
Reserve
Enter
Leave Source
Resume
```

如果：

```text
Target Full
```

则：

```text
Waiting
```

---

# 34. 用户要求的 5 / 6 容量逻辑继续保持

例如：

```text
Section01 Capacity = 5
Section02 Capacity = 6
```

当：

```text
Section01 = 5 / 5
```

则：

```text
Section02 最前面的托盘不能进入 Section01
```

但 Section02 仍然允许：

```text
Occupancy < 6
```

直到：

```text
Section02 = 6 / 6
```

阻塞继续传播到上游。

---

# 35. Waiting / Resume

目标 Section 满：

```text
Pallet.state = waiting
```

托盘保持在当前 Section 末端。

目标释放：

```text
SectionAvailable
↓
Reserve
↓
Transfer
↓
Resume
```

不需要人工点运行。

---

# 36. Junction / PLC 分流继续保留

如果 Section 末端是：

```text
Junction
```

调用：

```text
TwinMaterialFlowRuntime.tryAdvanceAtJunction()
```

真实模式：

```text
PLC RouteCode
```

模拟：

```text
Simulation Rule
```

人工：

```text
Manual
```

---

# 37. PLC 决定去哪，Capacity 决定现在能不能去

核心原则继续保持：

```text
PLC:
WHERE

Twin Runtime:
WHEN
```

例如：

```text
PLC → Left
```

但 Left：

```text
5 / 5
```

则：

```text
Waiting
```

不能自动改走 Right。

---

# 38. GantryStacker：桁架码垛机构

用户要求增加：

```text
桁架抓取丝饼进行码垛
```

桁架与机器人角色不同。

Robot：

```text
SilkCart → PlasticPallet
```

Gantry：

```text
PlasticPallet → StackArea
```

---

# 39. Gantry 运动结构

建议程序化桁架包含：

```text
LeftColumn
RightColumn
CrossBeam
XCarriage
Y/Z Axis
LiftAxis
Gripper
```

主要运动：

```text
X 横移
Y / Z 纵移
Z 升降
Gripper 开合
```

不使用工业机器人关节臂模型代替。

---

# 40. GantryStackingStation 状态机

建议：

```text
Idle
↓
WaitingLoadedPallet
↓
PalletPositioned
↓
StackPositionAllocated
↓
GantryApproach
↓
GantryPick
↓
GantryLift
↓
GantryMoveToStack
↓
GantryPlace
↓
GantryRelease
↓
GantryReturn
↓
UnloadCompleted
↓
ReleaseEmptyPallet
```

---

# 41. GantryStackTask

建议：

```ts
export interface GantryStackTask {
    taskId: string;

    gantryId: string;

    palletId: string;

    silkCakeId: string;

    stackId: string;

    targetPosition: {
        layer: number;
        row: number;
        column: number;
    };

    state:
        | 'pending'
        | 'approach'
        | 'lower-pick'
        | 'grip'
        | 'lift'
        | 'move-x'
        | 'move-stack'
        | 'lower-place'
        | 'release'
        | 'return'
        | 'completed'
        | 'fault';

    progress: number;
}
```

---

# 42. Gantry Pick 时 Parent 切换

抓取前：

```text
PlasticPallet
└── SilkCake
```

抓取后：

```text
GantryGripper
└── SilkCake
```

业务：

```text
SilkCake.state =
on-pallet → gantry-picking
```

---

# 43. Gantry Place 时 Parent 切换

码垛完成：

```text
GantryGripper
└── SilkCake
```

切换为：

```text
StackArea
└── StackPosition
    └── SilkCake
```

业务：

```text
SilkCake.state = stacked

SilkCake.stackPosition =
{
    layer,
    row,
    column
}
```

---

# 44. StackArea：码垛区

建议新增：

```ts
export interface SilkCakeStackRuntime {
    stackId: string;

    name: string;

    rows: number;

    columns: number;

    maxLayers: number;

    occupied: number;

    capacity: number;

    silkCakeIds: string[];

    state:
        | 'available'
        | 'full'
        | 'completed'
        | 'fault';

    nextPosition?: {
        layer: number;
        row: number;
        column: number;
    };
}
```

---

# 45. 码垛规则

第一阶段可以：

```text
先行
后列
再层
```

例如：

```text
Layer 0:
[1][2][3]
[4][5][6]

Layer 1:
[7][8][9]
[10][11][12]
```

如果：

```text
StackArea Full
```

则桁架工位：

```text
CanRelease = false
```

并形成生产阻塞。

---

# 46. 托盘在桁架完成后必须变空

这是用户明确要求。

Gantry Place 成功之后：

```text
Pallet.silkCakeId = null
```

同时：

```text
Pallet.state:
unloading → empty-return
```

这时 Three.js 场景中：

```text
丝饼已经不再跟随托盘
```

只剩：

```text
绿色塑料托盘
```

在线体继续运行。

---

# 47. Empty Pallet Return

空托盘应该进入：

```text
Return Sections
```

形成：

```text
Gantry Station
↓
Empty Return
↓
Buffer
↓
Loading Station
```

再次等待机器人上料。

---

# 48. 托盘完整循环

一个塑料托盘的生命周期：

```text
Empty
↓
Waiting Load
↓
Loading
↓
Loaded
↓
Moving
↓
Waiting / Junction
↓
Moving
↓
Unloading
↓
Empty Return
↓
Moving
↓
Waiting Load
```

托盘是循环载具。

丝饼不是循环载具。

---

# 49. 丝饼完整生命周期与托盘分开

丝饼：

```text
SilkCart
↓
Robot
↓
PlasticPallet
↓
Conveyor
↓
Gantry
↓
StackArea
↓
完成
```

塑料托盘：

```text
LoadingStation
↓
Conveyor
↓
GantryStation
↓
EmptyReturn
↓
LoadingStation
```

这两个生命周期必须分离。

---

# 50. 50 托盘模拟的正确解释

如果用户设置：

```text
PalletCount = 50
```

表示：

```text
系统中最多创建 50 个塑料循环托盘
```

不是：

```text
50 个木托盘 + 50 个纸箱
```

也不是：

```text
50 个托盘平均铺满整条线
```

---

# 51. SourceQueue 继续保留

如果整线当前总容量小于：

```text
50
```

多余塑料托盘：

```text
SourceQueue
```

等待上线。

例如：

```text
总 Section Capacity = 24

PalletCount = 50
```

则：

```text
线上最多按容量流转
剩余托盘在 SourceQueue
```

---

# 52. 丝车也需要自己的补料逻辑

当：

```text
cart.remainingCount = 0
```

则：

```text
Cart.state = empty
```

应该触发：

```text
SilkCartEmpty
```

模拟模式可以：

```text
延时若干秒
↓
自动换入新丝车
```

真实模式：

```text
等待 PLC / 现场换车信号
```

---

# 53. Simulation 丝车换车

建议模拟参数：

```ts
simulation: {
    silkCartCount: number;
    silkCakesPerCart: number;
    cartChangeDelaySeconds: number;
}
```

例如：

```text
每辆丝车 24 个丝饼
空车换车延时 5 秒
```

---

# 54. Loading Robot 不能没有丝饼还继续工作

必须检查：

```text
Cart Remaining > 0
```

否则：

```text
LoadingStation WaitingSilkCart
```

机器人保持：

```text
Idle / Home
```

---

# 55. Gantry 不能抓空托盘

进入桁架工位时必须判断：

```text
Pallet.silkCakeId != null
```

否则：

```text
如果空托盘走错到码垛工位
→ Fault / Bypass
```

根据业务配置处理。

---

# 56. Process Guard

建议增加统一 Guard：

```ts
interface TwinProcessGuardResult {
    canRelease: boolean;

    reason?:
        | 'PROCESS_NOT_COMPLETED'
        | 'NO_SILK_CAKE'
        | 'NO_EMPTY_PALLET'
        | 'ROBOT_BUSY'
        | 'GANTRY_BUSY'
        | 'STACK_FULL'
        | 'CART_EMPTY'
        | 'DOWNSTREAM_FULL'
        | 'FAULT';
}
```

---

# 57. Section CanRelease 需要扩展

以前：

```text
CanRelease =
Downstream.CanAccept
```

现在工位 Section 应该：

```text
CanRelease =
Downstream.CanAccept
AND
ProcessGuard.CanRelease
```

例如 LoadingStation：

```text
Loaded 才放行
```

GantryStation：

```text
丝饼已经码垛
托盘已经变空
才放行
```

---

# 58. TwinMaterialFlowRuntime 不要重写

当前：

```text
TwinSectionManager
TwinEntityManager
TwinJunctionManager
```

继续复用。

本轮增加：

```text
ProcessStationManager
PalletFlowController
SilkMaterialRuntime
```

即可。

---

# 59. 建议新增 SilkMaterialRuntime

用于管理：

```text
SilkCake
SilkCart
SilkCartSlot
Robot Task
Gantry Task
StackArea
Carrier Relationship
```

建议：

```text
ClientApp/src/digital-twin/runtime/SilkMaterialRuntime.ts
```

---

# 60. SilkMaterialRuntime 职责

```text
Create SilkCake
Create SilkCart
Create SilkCartSlot

Attach SilkCake to Cart
Detach SilkCake

Attach to Robot
Attach to Pallet

Attach to Gantry
Attach to Stack

Track Lifecycle
```

---

# 61. 推荐最终 Runtime 架构

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
├── ProcessStationManager
│
├── SilkMaterialRuntime
│
├── RobotLoadingController
│
├── RotaryTableController
│
├── GantryStackController
│
├── StackAreaManager
│
├── TwinSectionGeometryResolver
│
└── ProceduralSilkCakeLine
```

---

# 62. ProceduralPackagingLine 建议改名

当前：

```text
ProceduralPackagingLine
```

已经越来越不符合真实业务。

建议逐步改成：

```text
ProceduralSilkCakeLine
```

或者：

```text
ProceduralSilkHandlingLine
```

为了兼容旧 Manifest，可以保留：

```text
preset = packaging-line
```

但内部代码逐步迁移。

最终建议增加新 preset：

```text
silk-cake-line
```

---

# 63. 新 Procedural Renderer 只负责显示

它只负责：

```text
输送辊道
塑料托盘
丝饼 Mesh
丝车
旋转台
机器人
桁架
码垛区
安全围栏
传感器
状态灯
```

不负责：

```text
Capacity
Reserve
Waiting
PLC Decision
Process State
Stack Allocation
```

---

# 64. TwinRuntime Fixed Tick 建议

从当前：

```ts
routeEngine.updateFixed()
packagingLine.updateFixed()
bindingEngine.tick()
```

改成：

```ts
bindingEngine.tick();

materialFlowRuntime.update();

rotaryTableController.updateFixed();

robotLoadingController.updateFixed();

gantryStackController.updateFixed();

palletFlowController.updateFixed();

renderer.updateVisuals();
```

具体顺序可根据现有代码调整，但原则：

```text
先状态
后动画
```

---

# 65. 一帧的推荐业务顺序

```text
1. 更新 PLC / Simulation 信号

2. 更新 Section 状态

3. 更新丝车 / 旋转台

4. 更新 Robot Task

5. 更新 Gantry Task

6. 更新 StackArea

7. 更新 Pallet Flow

8. 处理 Junction

9. 更新 Parent / Carrier Relationship

10. 更新 Three.js Pose
```

---

# 66. LoadingStation 完整模拟场景

假设：

```text
Pallet-001 空托盘进入
```

流程：

```text
Pallet-001
state = empty
↓
进入 LoadingSection
↓
Stop
↓
PalletPositioned

Cart-01
Remaining = 8
↓
RotaryTable
将 Slot-09 转到 PickPosition
↓
Ready

Robot-01
↓
Pick SilkCake-009
↓
Attach To Gripper
↓
Move
↓
Place To Pallet-001
↓
Attach To Pallet
↓
Pallet-001.state = loaded
↓
LoadingCompleted
↓
检查下游 Capacity
↓
Release Pallet
```

---

# 67. GantryStation 完整模拟场景

```text
Pallet-001 + SilkCake-009
↓
进入 GantrySection
↓
Stop
↓
StackArea.allocateNextPosition()
↓
Gantry Pick
↓
SilkCake Attach GantryGripper
↓
Move Stack Position
↓
Place
↓
SilkCake Attach StackArea
↓
SilkCake.state = stacked
↓
Pallet-001.silkCakeId = null
↓
Pallet-001.state = empty-return
↓
检查 ReturnSection Capacity
↓
Release
```

---

# 68. 码垛位置必须真实持久

不要仅仅把丝饼动画到：

```text
Stack X,Y,Z
```

然后删除。

应该保留在 Scene：

```text
StackArea
├── Layer0
│   ├── SilkCake001
│   ├── SilkCake002
│   └── ...
├── Layer1
└── ...
```

这样用户可以直观看到：

```text
码垛正在逐渐增加
```

---

# 69. Stack Full

如果：

```text
StackArea.capacity = 36
occupied = 36
```

则：

```text
StackArea.state = full
```

GantryStation：

```text
不能再完成下一托盘下料
```

应：

```text
Waiting / Alarm
```

形成真实生产阻塞。

---

# 70. 可选多码垛区

后续可支持：

```text
Stack-A
Stack-B
Stack-C
```

根据：

```text
批次
规格
颜色
质量
PLC StackCode
```

决定码垛位置。

与岔口一样：

```text
PLC 决定 Stack Target
Runtime 判断 Stack 是否可接收
```

---

# 71. PLC 数据建议

后续真实联动可预留：

## 旋转台

```text
RotaryTable.Run
RotaryTable.Position
RotaryTable.InPosition
RotaryTable.Fault
```

## 丝车

```text
CartPresent
CartEmpty
CurrentSlot
```

## Robot

```text
RobotBusy
RobotPickComplete
RobotPlaceComplete
RobotFault
```

## 托盘

```text
PalletPresent
PalletLoaded
PalletId
```

## Gantry

```text
GantryBusy
GantryPickComplete
GantryPlaceComplete
GantryFault
```

## Stack

```text
StackCode
StackFull
StackCount
```

---

# 72. Simulation 模式需要模拟这些信号

Simulation 不应该只是：

```text
托盘一直跑
```

而应该模拟：

```text
丝车
旋转台
Robot
塑料托盘
Section
Junction
Gantry
Stack
```

完整业务状态。

---

# 73. Simulation 参数建议

```ts
interface SilkLineSimulationOptions {
    palletCount: number;

    silkCakesPerCart: number;

    cartChangeDelaySeconds: number;

    robotCycleSeconds: number;

    gantryCycleSeconds: number;

    palletReleaseIntervalSeconds: number;

    loopEmptyPallets: boolean;

    autoReplaceSilkCart: boolean;

    stackRows: number;

    stackColumns: number;

    stackLayers: number;
}
```

---

# 74. 推荐默认模拟参数

例如：

```text
塑料托盘：
20

每辆丝车丝饼：
24

机器人抓取节拍：
4 秒 / 个

桁架码垛节拍：
5 秒 / 个

空丝车换车：
6 秒

Stack：
3 × 4 × 4 = 48 个丝饼

空托盘：
循环回流
```

这些只是默认值，页面可配置。

---

# 75. UI 建议增加“丝饼场景模拟参数”

```text
丝饼产线模拟

塑料托盘数：
[20]

每辆丝车丝饼数：
[24]

机器人节拍：
[4.0 s]

桁架节拍：
[5.0 s]

空车更换延时：
[6.0 s]

自动更换丝车：
[✓]

空托盘循环：
[✓]

码垛：
Rows [3]
Columns [4]
Layers [4]
```

---

# 76. 运行页面需要显示关键指标

建议：

```text
在线托盘：
16

Loaded：
8

Empty：
8

Waiting：
3

丝车剩余：
11

Robot：
RUNNING

Gantry：
WAITING

Stack：
27 / 48

Blocked Sections：
2
```

---

# 77. 点击丝饼显示

```text
SilkCake ID:
SC-001

Batch:
B20260827

State:
Conveying

Carrier:
Pallet-013

Current Section:
Section-06

Destination:
Stack-A
```

---

# 78. 点击塑料托盘显示

```text
Pallet ID:
P-013

State:
Loaded

SilkCake:
SC-001

Section:
Section-06

Progress:
71%

Next:
Section-07

Waiting:
No
```

---

# 79. 点击丝车显示

```text
Cart:
CART-01

Remaining:
11 / 24

Current Slot:
SLOT-14

Rotary:
Ready

Robot:
Waiting Pick
```

---

# 80. 点击 Stack 显示

```text
Stack:
STACK-A

Occupied:
27

Capacity:
48

Next:
Layer 2 / Row 1 / Col 3

State:
Available
```

---

# 81. MCP / AI 查询能力

这套场景非常适合接入 MCP。

建议新增查询：

```text
twin_get_pallet
twin_get_silk_cake
twin_get_silk_cart
twin_get_robot_state
twin_get_rotary_table_state
twin_get_gantry_state
twin_get_stack_state
twin_get_loading_station
twin_get_stacking_station
```

---

# 82. AI 查询示例

用户：

```text
为什么这块托盘不动？
```

AI：

```text
Pallet-013 当前位于 Section-06 末端。

目标 Section-07 当前：
Capacity = 5
Occupancy = 5

因此托盘处于 Waiting，
原因 TARGET_SECTION_FULL。
```

---

# 83. AI 查询上料问题

```text
为什么机器人没有抓丝饼？
```

可能：

```text
LoadingStation 当前没有空托盘到位。
```

或者：

```text
当前丝车已空，remainingCount = 0，
正在等待更换下一辆丝车。
```

或者：

```text
旋转台尚未完成目标 Slot 定位。
```

---

# 84. AI 查询桁架问题

```text
为什么桁架停了？
```

可能：

```text
Stack-A 已达到 48 / 48，
当前无可用码垛位置，
因此 GantryStackingStation 进入 Waiting。
```

---

# 85. 本轮主要文件改造

## 必改

```text
ClientApp/src/digital-twin/runtime/ProceduralPackagingLine.ts
```

职责调整：

```text
去掉纸箱
去掉木托盘
去掉无限循环业务运动
增加 PlasticPallet
增加 SilkCake
增加 SilkCart
调整 RotaryTable
增加 Gantry
增加 StackArea
```

后续建议迁移为：

```text
ProceduralSilkCakeLine.ts
```

---

# 86. 必改 TwinRuntime

```text
ClientApp/src/digital-twin/runtime/TwinRuntime.ts
```

接入：

```text
PalletFlowController
SilkMaterialRuntime
ProcessStationManager
RobotLoadingController
RotaryTableController
GantryStackController
StackAreaManager
```

---

# 87. 建议新增文件

```text
ClientApp/src/digital-twin/runtime/PalletFlowController.ts

ClientApp/src/digital-twin/runtime/SilkMaterialRuntime.ts

ClientApp/src/digital-twin/runtime/ProcessStationManager.ts

ClientApp/src/digital-twin/runtime/RobotLoadingController.ts

ClientApp/src/digital-twin/runtime/RotaryTableController.ts

ClientApp/src/digital-twin/runtime/GantryStackController.ts

ClientApp/src/digital-twin/runtime/StackAreaManager.ts

ClientApp/src/digital-twin/runtime/TwinSectionGeometryResolver.ts
```

---

# 88. Contracts 建议新增

在：

```text
ClientApp/src/digital-twin/contracts/index.ts
```

增加：

```text
SilkCakeDefinition
PlasticPalletDefinition
SilkCartDefinition
SilkCartSlotDefinition
ProcessStationDefinition
RobotLoadingDefinition
RotaryTableDefinition
GantryDefinition
StackAreaDefinition
SilkLineSimulationOptions
```

---

# 89. Manifest 建议扩展

例如：

```json
{
  "runtime": {
    "dataMode": "simulation",
    "maxPixelRatio": 2,
    "showGrid": true,
    "silkLineSimulation": {
      "palletCount": 20,
      "silkCakesPerCart": 24,
      "robotCycleSeconds": 4,
      "gantryCycleSeconds": 5,
      "cartChangeDelaySeconds": 6,
      "loopEmptyPallets": true,
      "autoReplaceSilkCart": true
    }
  }
}
```

如果不希望修改 `runtime` schema 太多，也可以增加：

```text
simulationProfiles
```

独立节点。

---

# 90. 场景对象建议

```text
objects:
- SilkCakeLine
- LoadingRobot
- RotaryTable
- SilkCart
- Gantry
- StackArea
```

但运行实体：

```text
Pallet
SilkCake
```

建议由 Runtime 动态生成，不需要全部写入静态 Manifest。

---

# 91. 开发 Phase 1：视觉对象修正

先完成：

```text
删除纸箱
删除木托盘

新增：
PlasticPallet
SilkCake
SilkCart
RotaryTable
LoadingRobot
Gantry
StackArea
```

要求场景视觉已经符合真实产线。

---

# 92. Phase 2：托盘分段运行

完成：

```text
PalletFlowController
currentSectionId
sectionProgress
SourceQueue
tryTransfer
Waiting
Resume
Blocked Propagation
```

---

# 93. Phase 3：Robot 上料

完成：

```text
EmptyPallet 到位
↓
Robot Pick
↓
SilkCake Parent 切换
↓
Robot Place
↓
Pallet Loaded
↓
Release
```

---

# 94. Phase 4：RotaryTable + SilkCart

完成：

```text
SilkCart Slots
剩余数量
旋转定位
Slot Empty
Cart Empty
Simulation 自动换车
```

---

# 95. Phase 5：Gantry 码垛

完成：

```text
LoadedPallet 到位
↓
Gantry Pick
↓
Stack Allocation
↓
Place
↓
Pallet Empty
↓
Release
```

---

# 96. Phase 6：Empty Pallet Return

完成：

```text
Empty Pallet
↓
Return Sections
↓
LoadingStation
↓
再次上料
```

形成闭环。

---

# 97. Phase 7：Junction / PLC

接入现有：

```text
tryAdvanceAtJunction()
```

支持：

```text
PLC
Simulation
Manual
```

不重写现有岔口逻辑。

---

# 98. Phase 8：运行 UI / MCP

增加：

```text
Pallet State
SilkCake State
Cart State
Robot Task
Gantry Task
Stack State
Section Snapshot
Waiting Reason
Blocking Chain
```

---

# 99. 验收场景 A：视觉

运行场景中不能再出现：

```text
纸箱
木托盘
```

运行载具必须为：

```text
绿色塑料托盘
```

物料必须为：

```text
丝饼
```

---

# 100. 验收场景 B：机器人上料

空托盘进入机器人站：

```text
机器人抓取丝车丝饼
↓
放到塑料托盘
↓
托盘 Loaded
↓
才允许离开
```

---

# 101. 验收场景 C：丝车减少

每完成一次 Pick：

```text
Cart Remaining
N → N-1
```

对应 Slot：

```text
occupied → empty
```

不能无限产生丝饼。

---

# 102. 验收场景 D：旋转定位

下一个可抓 SilkCake Slot 不在 Pick Position：

```text
RotaryTable 必须先旋转
```

到位后机器人才能 Pick。

---

# 103. 验收场景 E：Section Capacity

```text
Capacity = 5
```

则：

```text
Occupancy + Reserved
```

绝不能超过：

```text
5
```

---

# 104. 验收场景 F：阻塞传播

```text
Section01 5/5
↓
Section02 出口等待

Section02 6/6
↓
Section03 出口等待
```

必须真实体现在 Three.js 托盘位置上。

---

# 105. 验收场景 G：Gantry

Loaded Pallet：

```text
到位
↓
桁架抓走丝饼
↓
丝饼码入 Stack
↓
托盘变 Empty
```

---

# 106. 验收场景 H：码垛可见

每个丝饼完成 Gantry Place 后：

```text
必须留在 StackArea
```

可视化码垛数量逐渐增加。

---

# 107. 验收场景 I：空托盘回流

码垛完成后的：

```text
Empty Pallet
```

进入回流线并重新回到上料工位。

---

# 108. 验收场景 J：循环生产

最终应看到真实循环：

```text
丝车供料
↓
Robot 上料
↓
Loaded Pallet 运输
↓
Gantry 码垛
↓
Empty Pallet 回流
↓
Robot 再次上料
```

---

# 109. AI 实施时禁止的做法

AI 修改代码时不要：

```text
重新写一套 Section Capacity
重新写一套 Junction
重新写一套 Reservation
```

优先复用当前：

```text
TwinMaterialFlowRuntime
TwinSectionManager
TwinEntityManager
TwinJunctionManager
tryTransfer()
tryAdvanceAtJunction()
```

---

# 110. AI 实施时必须遵守的状态原则

## 原则一

```text
Three.js 不能自己决定业务状态
```

## 原则二

```text
业务 Runtime 决定状态
Three.js 根据状态显示
```

## 原则三

```text
Pallet 是 Section Occupancy 单位
SilkCake 不是 Section Occupancy 单位
```

## 原则四

```text
PLC 决定托盘去哪里
Capacity 决定现在能不能进入
```

## 原则五

```text
Process Station 未完成
即使下游有空间也不能放行
```

## 原则六

```text
丝饼、托盘、丝车必须有独立生命周期
```

---

# 111. AI 修改优先级

优先级 P0：

```text
PlasticPallet 替换木托盘
SilkCake 替换纸箱
PalletFlowController
分段运行
Waiting / Resume
Robot 上料
Gantry 码垛
Empty Pallet
```

P1：

```text
SilkCart Slots
RotaryTable 定位
StackArea
SourceQueue
ProcessStation
```

P2：

```text
PLC 真实信号
MCP
高级动画
UI Debug
```

P3：

```text
真实 GLB
复杂材质
物理碰撞
高级光照
```

---

# 112. 最终目标架构

```text
                    PLC / Simulation
                           │
                           ▼
                     BindingEngine
                           │
             ┌─────────────┴──────────────┐
             ▼                            ▼
   TwinMaterialFlowRuntime        SilkMaterialRuntime
             │                            │
     ┌───────┼────────┐          ┌────────┼─────────┐
     ▼       ▼        ▼          ▼        ▼         ▼
 Section  Entity   Junction   SilkCake  SilkCart   Stack
 Manager  Manager  Manager
     │                                  │
     └──────────────┬───────────────────┘
                    ▼
            ProcessStationManager
              │             │
              ▼             ▼
      RobotLoading       GantryStack
       Controller         Controller
              │             │
              └──────┬──────┘
                     ▼
            PalletFlowController
                     │
                     ▼
          ProceduralSilkCakeLine
                     │
                     ▼
                Three.js Scene
```

---

# 113. 最终业务闭环

最终 IoTSharp 模拟运行必须表现为：

```text
丝车上有多个丝饼
       ↓
旋转台定位目标丝饼
       ↓
机器人抓取
       ↓
空塑料托盘停站
       ↓
机器人放丝饼
       ↓
塑料托盘变 Loaded
       ↓
进入 Section
       ↓
按 Capacity 分段流转
       ↓
满位 Waiting
       ↓
释放后 Resume
       ↓
岔口按 PLC / Simulation 选择
       ↓
到达 GantryStation
       ↓
桁架抓取丝饼
       ↓
丝饼进入 StackArea
       ↓
托盘变 Empty
       ↓
空托盘回流
       ↓
重新回到 LoadingStation
       ↓
机器人再次抓丝饼
```

---

# 114. 最终结论

本次场景优化不能只把当前：

```text
50 托盘一直跑
```

改成：

```text
50 托盘分段跑
```

还必须同时把真实业务对象修正。

最终数字孪生的核心对象应是：

```text
SilkCake
PlasticPallet
SilkCart
RotaryTable
LoadingRobot
TwinSection
TwinJunction
GantryStacker
StackArea
```

并形成：

```text
SilkCart
→ Robot
→ PlasticPallet
→ Section Flow
→ Junction
→ Gantry
→ Stack
→ Empty Pallet Return
```

这才是符合真实丝饼产线的数字孪生模拟场景。

对于 AI 后续优化任务，优先保证：

```text
业务逻辑正确
>
状态一致
>
分段流转正确
>
设备动作正确
>
3D 外观精细度
```

不要为了视觉效果再次退化成“所有物料一直沿路线循环”的 Demo。
