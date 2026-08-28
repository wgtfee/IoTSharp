# IoTSharp 丝饼产线完整工艺数字孪生优化设计 V4

> 用途：直接交给 AI / Codex / 开发人员，对 IoTSharp `Develop` 分支数字孪生场景继续优化。  
> 当前 GitHub `Develop` 可见 HEAD 仍为 `c0c5eb1ce12dfa8e75c0055b0cb70a523cfa2b64`（“新增模拟运行场景”）。本设计在当前 `TwinMaterialFlowRuntime`、`TwinSectionManager`、`TwinEntityManager`、`TwinJunctionManager`、`RouteEngine` 等基础上继续演进，不重写已有 Capacity / Reserved / Waiting / PLC 分流能力。

---

## 1. 本轮真实工艺目标

当前场景需要从普通“包装线 Demo”升级成真实丝饼包装与入库产线：

```text
双面丝车供料
↓
机器人一次抓一整行 6 个丝饼
↓
线体上 6 个空塑料托盘同时等待
↓
6 个丝饼分别放到 6 个塑料托盘
↓
塑料托盘分段输送
↓
进入桁架码垛区域
↓
两条塑料托盘辊道各等待 3 个托盘
↓
形成 2 × 3 共 6 个丝饼
↓
桁架 2 × 3 夹具一次抓取 6 个丝饼
↓
第三条辊道上的木托盘接收一层 6 个丝饼
↓
重复 8 层
↓
一个木托盘共 48 个丝饼
↓
盖板桁架放盖
↓
贴标
↓
缠膜
↓
立体库入库
```

同时：

```text
桁架取走丝饼后的塑料托盘
↓
全部变为空托盘
↓
进入空托盘回流
↓
重新回到机器人上料区
↓
再次组成 6 个空托盘等待组
```

---

## 2. 工艺关键数字

### 2.1 丝车

每辆丝车：

```text
A 面 + B 面
```

每面：

```text
3 行 × 6 列 = 18 个丝饼
```

整车：

```text
2 × 3 × 6 = 36 个丝饼
```

### 2.2 上料机器人

机器人夹具：

```text
1 × 6
```

每次抓：

```text
一整行 = 6 个丝饼
```

A 面：

```text
3 行 → 3 次抓取
```

B 面：

```text
3 行 → 3 次抓取
```

整车：

```text
6 次抓取循环 → 36 个丝饼
```

### 2.3 桁架

桁架夹具：

```text
2 × 3 = 6 个抓取位
```

一次抓：

```text
6 个丝饼
```

木托盘：

```text
每层 2 × 3 = 6 个丝饼
8 层
总计 48 个丝饼
```

---

## 3. 丝车建模

建议：

```ts
export interface SilkCartEntity {
    cartId: string;

    activeSide: 'A' | 'B';

    state:
        | 'waiting'
        | 'ready'
        | 'feeding-a'
        | 'turning'
        | 'feeding-b'
        | 'empty'
        | 'replace-required'
        | 'fault';

    sides: {
        A: SilkCartSide;
        B: SilkCartSide;
    };

    remainingCount: number;
}
```

每面：

```ts
export interface SilkCartSide {
    side: 'A' | 'B';
    rows: SilkCartRow[];
    state: 'ready' | 'feeding' | 'empty';
}
```

每面固定：

```text
3 Rows
6 Columns
```

每行：

```ts
export interface SilkCartRow {
    rowIndex: 0 | 1 | 2;
    slots: SilkCartSlot[];
    state: 'full' | 'reserved' | 'picked' | 'empty';
}
```

每个 Slot：

```ts
export interface SilkCartSlot {
    slotId: string;
    side: 'A' | 'B';
    row: number;
    column: number;
    localPosition: [number, number, number];
    silkCakeId?: string;
    state: 'occupied' | 'reserved' | 'picked' | 'empty';
}
```

满车结构：

```text
Cart-01

A 面
Row 1: A11 A12 A13 A14 A15 A16
Row 2: A21 A22 A23 A24 A25 A26
Row 3: A31 A32 A33 A34 A35 A36

B 面
Row 1: B11 B12 B13 B14 B15 B16
Row 2: B21 B22 B23 B24 B25 B26
Row 3: B31 B32 B33 B34 B35 B36
```

---

## 4. A/B 面抓取顺序

默认 Simulation 流程：

```text
A Row 1
↓
A Row 2
↓
A Row 3
↓
A 面 Empty
↓
旋转台换面
↓
B Row 1
↓
B Row 2
↓
B Row 3
↓
整车 Empty
↓
换丝车
```

真实模式如果 PLC 提供当前行号 / 当前面，则以 PLC 为准。

---

## 5. 旋转台

旋转台上放：

```text
SilkCart
```

主要职责：

```text
A 面工作
↓
A 面 3 行抓完
↓
旋转 180°
↓
B 面进入机器人抓取侧
```

建议：

```ts
export interface RotaryTableRuntime {
    tableId: string;
    currentCartId?: string;
    visibleSide: 'A' | 'B';
    currentAngle: number;
    targetAngle: number;

    state:
        | 'ready-a'
        | 'feeding-a'
        | 'turning-to-b'
        | 'ready-b'
        | 'feeding-b'
        | 'empty'
        | 'fault';
}
```

---

## 6. 上料机器人必须是 1×6 行夹具

视觉结构：

```text
Robot Arm
└── RowGripper
    ├── Gripper-1
    ├── Gripper-2
    ├── Gripper-3
    ├── Gripper-4
    ├── Gripper-5
    └── Gripper-6
```

一次抓取时：

```text
6 个 SilkCake 同时 Attach 到 Robot Gripper
```

不再是单件抓取。

---

## 7. 机器人任务

```ts
export interface RobotRowPickTask {
    taskId: string;
    robotId: string;
    cartId: string;
    side: 'A' | 'B';
    rowIndex: number;

    sourceSlotIds: string[];
    silkCakeIds: string[];
    targetPalletIds: string[];

    state:
        | 'waiting-six-empty-pallets'
        | 'approach-row'
        | 'lower'
        | 'grip-six'
        | 'lift'
        | 'transfer'
        | 'place-six'
        | 'release'
        | 'return'
        | 'completed'
        | 'fault';

    progress: number;
}
```

必须保证：

```text
sourceSlotIds = 6
silkCakeIds = 6
targetPalletIds = 6
```

---

## 8. 线体上必须有 6 个空塑料托盘等待

机器人启动条件不是“有一个空托盘”。

必须：

```text
6 个空塑料托盘全部到位
```

建议：

```ts
export interface RobotLoadingBuffer {
    bufferId: string;
    palletPositionIds: string[];
    palletIds: string[];
    requiredCount: 6;

    state:
        | 'collecting'
        | 'ready'
        | 'loading'
        | 'release'
        | 'fault';
}
```

视觉：

```text
[P1][P2][P3][P4][P5][P6]
```

---

## 9. 上料完整条件

只有满足：

```text
Robot Idle
AND
RotaryTable Ready
AND
当前 SilkCart Row 有 6 个丝饼
AND
6 个 Empty Plastic Pallet Ready
AND
No Fault
```

才允许开始一次：

```text
RobotRowPickTask
```

---

## 10. 一次上料完整流程

```text
6 个空托盘到位
↓
LoadingBuffer Ready
↓
确认当前丝车目标行有 6 个丝饼
↓
Robot 1×6 Gripper 抓取整行
↓
6 个 SilkCake Parent → RobotGripper
↓
Robot 移动到 6 个塑料托盘上方
↓
分别放置
SC1 → P1
SC2 → P2
SC3 → P3
SC4 → P4
SC5 → P5
SC6 → P6
↓
6 个 Plastic Pallet 全部 Loaded
↓
当前 SilkCart Row → Empty
↓
6 个 Loaded Pallet 才允许离开
```

---

## 11. 批次概念必须增加

真实工艺里：

```text
必须凑齐 6 个
设备才能动作
```

所以在现有 Section 逻辑之上增加：

```text
TwinTransferBatch
TwinBatchBarrier
```

不要把 Batch 和 Capacity 混为一谈。

### Capacity

```text
这一段最多允许存在多少托盘
```

### Batch Barrier

```text
这个工位必须凑齐多少托盘才能动作
```

---

## 12. TwinTransferBatch

```ts
export interface TwinTransferBatch {
    batchId: string;

    type:
        | 'robot-load-six'
        | 'gantry-pick-six'
        | 'wood-pallet-layer';

    entityIds: string[];
    requiredCount: number;

    state:
        | 'collecting'
        | 'ready'
        | 'processing'
        | 'completed'
        | 'cancelled';
}
```

---

## 13. PlasticPallet

塑料托盘仍然是单丝饼循环载具：

```ts
export interface PlasticPalletEntity {
    palletId: string;

    state:
        | 'empty'
        | 'waiting-load'
        | 'loading'
        | 'loaded'
        | 'moving'
        | 'waiting'
        | 'gantry-buffer'
        | 'unloading'
        | 'empty-return'
        | 'fault';

    silkCakeId?: string;

    currentSectionId?: string;
    sectionProgress: number;

    originLoadBatchId?: string;

    waitingReason?: string;
}
```

每个 Plastic Pallet：

```text
最多承载 1 个 SilkCake
```

---

## 14. Plastic Pallet 进入普通输送后继续使用现有 Section 逻辑

上料完成后，6 个托盘可以按输送节拍逐个运行。

底层仍然：

```text
TwinSection
Capacity
Occupancy
Reserved
tryTransfer()
Waiting
Resume
Blocked Propagation
```

不要因为 6 件一批就绕开 Section Capacity。

---

## 15. 岔口继续复用现有逻辑

如果中间存在：

```text
TwinJunction
```

继续：

```text
PLC 决定托盘去哪
Capacity 决定现在能不能进去
```

目标满：

```text
Waiting
```

不能自动换到另一条路线。

---

## 16. 桁架码垛区的真实布局

桁架下方必须是：

```text
3 条平行辊道
```

其中：

```text
Lane A：Plastic Pallet
Lane B：Plastic Pallet
Lane C：Wooden Pallet
```

建议：

```text
                        Gantry 2×3
                  ┌───────────────────┐
                  │ G11  G12  G13     │
                  │ G21  G22  G23     │
                  └───────────────────┘

Plastic Lane A → [P1] [P2] [P3]

Plastic Lane B → [P4] [P5] [P6]

Wood Lane      →       [WOOD]
```

---

## 17. 两条塑料托盘辊道各等待 3 个

Lane A：

```text
Position A1
Position A2
Position A3
```

Lane B：

```text
Position B1
Position B2
Position B3
```

全部必须：

```text
Loaded
```

才允许桁架动作。

总计：

```text
3 + 3 = 6 个 Loaded Plastic Pallet
```

---

## 18. GantryInputBuffer

```ts
export interface GantryInputBuffer {
    laneA: [string?, string?, string?];
    laneB: [string?, string?, string?];

    requiredLoadedPallets: 6;

    state:
        | 'collecting'
        | 'ready'
        | 'gantry-picking'
        | 'release-empty-pallets'
        | 'fault';
}
```

---

## 19. 桁架夹具必须是 2×3

视觉：

```text
GantryGripper
├── G11
├── G12
├── G13
├── G21
├── G22
└── G23
```

一次：

```text
抓取 6 个 SilkCake
```

---

## 20. 桁架启动条件

必须：

```text
Lane A = 3 Loaded Pallets
AND
Lane B = 3 Loaded Pallets
AND
Wooden Pallet 已到位
AND
Gantry Idle
AND
No Fault
```

才创建：

```text
GantryPickLayerTask
```

---

## 21. GantryPickLayerTask

```ts
export interface GantryPickLayerTask {
    taskId: string;
    gantryId: string;

    sourcePalletIds: string[];
    silkCakeIds: string[];

    woodenPalletId: string;
    targetLayer: number;

    state:
        | 'waiting-six-loaded'
        | 'approach'
        | 'lower-pick'
        | 'grip-six'
        | 'lift'
        | 'move-to-wood-pallet'
        | 'lower-place'
        | 'release-six'
        | 'return'
        | 'completed'
        | 'fault';

    progress: number;
}
```

---

## 22. 一次桁架动作 = 木托盘一层

一次放置：

```text
2 行 × 3 列
```

例如：

```text
Layer N

SC1 SC2 SC3
SC4 SC5 SC6
```

所以：

```text
1 Layer = 6 SilkCake
```

---

## 23. WoodenPallet

```ts
export interface WoodenPalletEntity {
    woodenPalletId: string;

    state:
        | 'empty'
        | 'stacking'
        | 'full'
        | 'waiting-cover'
        | 'covered'
        | 'waiting-label'
        | 'labeled'
        | 'waiting-wrap'
        | 'wrapped'
        | 'warehouse-inbound'
        | 'stored'
        | 'fault';

    currentLayer: number;
    maxLayers: 8;

    silkCakeIds: string[];

    currentSectionId?: string;

    packageId?: string;
}
```

---

## 24. 木托盘固定 8 层

用户工艺明确：

```text
8 Layers
```

每层：

```text
6 SilkCake
```

最终：

```text
8 × 6 = 48 SilkCake / WoodenPallet
```

这是硬工艺参数，不能只写成视觉常量。

---

## 25. Wooden Pallet Stack Layout

固定：

```text
Rows = 2
Columns = 3
Layers = 8
```

总 Position：

```text
48
```

```ts
export interface StackPosition {
    layer: number;
    row: number;
    column: number;
    silkCakeId?: string;
}
```

---

## 26. 每完成一层后的状态变化

桁架抓走：

```text
6 个 Plastic Pallet 上的 SilkCake
```

然后：

```text
6 PlasticPallet.silkCakeId = null
6 PlasticPallet.state = empty-return
```

SilkCake Carrier：

```text
PlasticPallet
→
GantryGripper
→
WoodenPallet
```

WoodenPallet：

```text
currentLayer += 1
```

---

## 27. 塑料托盘必须立即回流

每完成一层：

```text
6 个 Plastic Pallet
↓
Empty
↓
离开 Lane A/B
↓
Empty Pallet Return Line
↓
重新返回 Robot Loading Buffer
```

这形成循环载具闭环。

---

## 28. 木托盘没满 8 层不能离开

如果：

```text
currentLayer < 8
```

则：

```text
WoodenPallet 继续留在第三条 Lane
```

等待下一组 6 个 SilkCake。

如果：

```text
currentLayer == 8
```

则：

```text
state = full
```

才允许进入盖板工位。

---

## 29. 木托盘来源

第三条辊道需要：

```text
Empty Wood Pallet Source
```

建议：

```text
WoodPalletSourceQueue
```

当一个满托离开码垛工位：

```text
新的 Empty Wooden Pallet
↓
进入 Gantry Wood Lane
```

---

## 30. 后处理工艺顺序

满 8 层后必须：

```text
Stack Full
↓
Cover
↓
Label
↓
Wrapping
↓
AS/RS Inbound
```

顺序不能跳站。

---

## 31. Cover Station

下一工位为：

```text
盖板桁架
```

流程：

```text
满载 Wooden Pallet 到位
↓
Cover Gantry 从盖板料仓取盖板
↓
移动到木托盘上方
↓
Place Cover
↓
Cover Complete
↓
允许出站
```

---

## 32. CoverPlacementTask

```ts
export interface CoverPlacementTask {
    taskId: string;
    woodenPalletId: string;
    coverId: string;

    state:
        | 'waiting'
        | 'pick-cover'
        | 'lift'
        | 'move'
        | 'place-cover'
        | 'release'
        | 'return'
        | 'completed'
        | 'fault';

    progress: number;
}
```

---

## 33. 盖板实体

```ts
export interface PalletCoverEntity {
    coverId: string;

    state:
        | 'in-magazine'
        | 'gantry-picking'
        | 'on-load'
        | 'completed';

    woodenPalletId?: string;
}
```

盖板完成：

```text
WoodenPallet.state:
waiting-cover
→
covered
```

---

## 34. Label Station

盖板之后：

```text
贴标
```

流程：

```text
Covered Pallet 到位
↓
读取 Package / Batch
↓
生成 Label
↓
执行贴标
↓
LabelApplied = true
↓
允许放行
```

---

## 35. Label 数据

```ts
export interface PalletLabel {
    labelId: string;
    packageId: string;

    batchNo?: string;
    materialCode?: string;

    quantity: 48;

    applied: boolean;
}
```

贴标必须有业务状态，不只是视觉贴纸。

---

## 36. Wrapping Station

下一站：

```text
缠膜
```

流程：

```text
Labeled Pallet 到位
↓
Wrapper Start
↓
Film Wrap Progress
↓
Wrap Complete
↓
允许出站
```

---

## 37. WrappingTask

```ts
export interface WrappingTask {
    taskId: string;
    woodenPalletId: string;

    turns: number;
    progress: number;

    state:
        | 'waiting'
        | 'wrapping'
        | 'cutting'
        | 'completed'
        | 'fault';
}
```

---

## 38. 成品包装单元

建议：

```ts
export interface FinishedPackageUnit {
    packageId: string;

    woodenPalletId: string;

    silkCakeIds: string[];
    silkCakeCount: 48;

    layerCount: 8;

    coverId?: string;
    labelId?: string;

    wrapped: boolean;

    state:
        | 'stacking'
        | 'covering'
        | 'labeling'
        | 'wrapping'
        | 'ready-inbound'
        | 'inbound'
        | 'stored';
}
```

---

## 39. 入立体库条件

必须全部满足：

```text
Layers == 8
SilkCakeCount == 48
CoverApplied == true
LabelApplied == true
Wrapped == true
```

才：

```text
ReadyInbound
```

---

## 40. Warehouse Inbound

流程：

```text
Wrapped Package
↓
Inbound Conveyor
↓
入库申请
↓
等待 WCS / PLC 分配
↓
进入立体库入口
↓
存储设备执行
↓
Stored
```

第一阶段数字孪生至少模拟：

```text
ReadyInbound
→ Inbound
→ Stored
```

---

## 41. WCS / PLC 边界

真实模式：

```text
PLC
→ 设备状态、到位、路线

WCS
→ 入库任务、目标库位
```

IoTSharp Twin Runtime 负责：

```text
展示
状态跟踪
阻塞
Waiting
Resume
动作可视化
```

不自行代替 WCS 决定真实库位。

---

## 42. WarehouseInboundTask

```ts
export interface WarehouseInboundTask {
    taskId: string;
    packageId: string;

    destination?: {
        warehouse?: string;
        aisle?: string;
        location?: string;
    };

    state:
        | 'requested'
        | 'assigned'
        | 'moving-to-inbound'
        | 'waiting-storage'
        | 'storing'
        | 'completed'
        | 'fault';
}
```

---

## 43. 两类托盘必须彻底区分

### Plastic Pallet

用途：

```text
一托一丝饼
循环使用
```

生命周期：

```text
Empty
→ Load
→ Loaded
→ Convey
→ Gantry
→ Empty
→ Return
→ Load
```

### Wooden Pallet

用途：

```text
最终成品码垛
```

生命周期：

```text
Empty
→ 1~8 Layer
→ Full
→ Cover
→ Label
→ Wrap
→ Warehouse
```

---

## 44. Carrier 类型

```ts
export type TwinCarrierType =
    | 'plastic-pallet'
    | 'wooden-pallet'
    | 'silk-cart'
    | 'robot-gripper'
    | 'gantry-gripper'
    | 'cover-gripper';
```

---

## 45. ProcessStation 扩展

建议统一：

```text
RobotLoadingStation
GantryStackingStation
CoverStation
LabelStation
WrappingStation
WarehouseInboundStation
```

```ts
export interface TwinProcessStationRuntime {
    stationId: string;

    type:
        | 'robot-loading'
        | 'gantry-stacking'
        | 'covering'
        | 'labeling'
        | 'wrapping'
        | 'warehouse-inbound';

    state:
        | 'idle'
        | 'waiting-material'
        | 'waiting-carrier'
        | 'processing'
        | 'completed'
        | 'blocked'
        | 'fault';

    canRelease: boolean;

    currentTaskId?: string;
}
```

---

## 46. Process Guard

Section 出站不能只判断：

```text
Downstream Capacity
```

还要：

```text
ProcessCompleted
```

例如：

### Robot Loading Station

```text
6 个 Plastic Pallet 全部 Loaded
```

才允许放行。

### Gantry Station

```text
6 个 SilkCake 全部抓走
6 个 Plastic Pallet 全部变 Empty
```

才允许空托盘离开。

### Wooden Pallet Lane

```text
Layer == 8
```

才允许满托离开。

---

## 47. Batch Barrier

建议：

```ts
export interface TwinBatchBarrier {
    barrierId: string;

    requiredCount: number;

    readyEntityIds: string[];

    releasePolicy:
        | 'all-ready'
        | 'sequential-after-ready';

    state:
        | 'collecting'
        | 'ready'
        | 'releasing';
}
```

---

## 48. Robot Loading Barrier

```text
requiredCount = 6
```

流程：

```text
6 Empty Ready
↓
Robot Pick 6
↓
6 Loaded
↓
Barrier Ready
↓
开始放行
```

---

## 49. Gantry Barrier

```text
requiredCount = 6
```

流程：

```text
LaneA = 3
LaneB = 3
↓
6 Loaded Ready
↓
Wood Pallet Ready
↓
Gantry Pick
↓
6 Plastic Pallet Empty
↓
Barrier Release
```

---

## 50. Capacity 与 Batch 必须同时存在

```text
Capacity
=
物理段最多容纳多少托盘
```

```text
Batch
=
工艺上凑齐多少个才能动作
```

Batch 不允许突破 Capacity。

---

## 51. 推荐 Runtime 架构

```text
TwinRuntime
│
├── BindingEngine
├── RouteEngine
├── TwinMaterialFlowRuntime
│   ├── TwinSectionManager
│   ├── TwinEntityManager
│   └── TwinJunctionManager
│
├── PalletFlowController
├── BatchFlowController
├── SilkCartController
├── RotaryTableController
├── RobotRowLoadingController
├── GantryStackController
├── WoodPalletController
├── CoverGantryController
├── LabelStationController
├── WrappingStationController
├── WarehouseInboundController
├── ProcessStationManager
└── ProceduralSilkCakeLine
```

---

## 52. 控制器职责

### SilkCartController

```text
A/B Side
3×6
Current Row
Row Reserve
Row Picked
A→B
Cart Empty
Replace Cart
```

### RobotRowLoadingController

```text
等6空托盘
等当前行
1×6 Pick
6 SilkCake Attach
6 Pallet Loaded
```

### GantryStackController

```text
LaneA 3
LaneB 3
WoodPallet
2×3 Pick
Layer +1
6 Empty Pallets
```

### WoodPalletController

```text
Empty Wood Pallet
Layer Count
48 SilkCake
Full
Release
```

### CoverGantryController

```text
Cover Magazine
Pick
Place
Covered
```

### LabelStationController

```text
Generate Label
Apply
Labeled
```

### WrappingStationController

```text
Wrap
Progress
Complete
```

### WarehouseInboundController

```text
ReadyInbound
WCS/PLC Assignment
Inbound
Stored
```

---

## 53. Simulation 模式必须模拟完整生产过程

Simulation 不再是：

```text
所有对象一直跑
```

而是：

```text
丝车 A/B
↓
等6空托盘
↓
Robot 1×6 Pick
↓
6 Loaded
↓
Section Flow
↓
LaneA 3 + LaneB 3
↓
Gantry 2×3
↓
Wood Pallet Layer +1
↓
重复8层
↓
Cover
↓
Label
↓
Wrap
↓
Warehouse
```

---

## 54. Simulation 参数

```ts
export interface SilkLineSimulationOptions {
    plasticPalletCount: number;

    silkCartSideRows: 3;
    silkCartColumns: 6;
    silkCartSides: 2;

    robotPickCount: 6;

    gantryRows: 2;
    gantryColumns: 3;

    woodenPalletLayers: 8;

    robotCycleSeconds: number;
    gantryCycleSeconds: number;
    coverCycleSeconds: number;
    labelCycleSeconds: number;
    wrappingCycleSeconds: number;

    cartReplaceDelaySeconds: number;
    emptyWoodPalletFeedSeconds: number;

    loopPlasticPallets: boolean;
    autoReplaceSilkCart: boolean;
    autoFeedWoodPallet: boolean;
}
```

---

## 55. 推荐默认值

```text
Plastic Pallets: 24

SilkCart:
A/B
3×6 / Side
36 SilkCake

Robot:
1×6
Cycle 5 sec

Gantry:
2×3
Cycle 5 sec

Wooden Pallet:
8 Layers
48 SilkCake

Cover:
3 sec

Label:
2 sec

Wrap:
8 sec

Auto Cart Replace:
ON

Plastic Pallet Loop:
ON
```

---

## 56. 运行 UI 指标

建议显示：

```text
丝车：
A 面 / Row 2
剩余 24 / 36

机器人：
Load Batch 003
6 / 6

空塑料托盘：
6 / 6

Loaded Pallets：
12

Gantry Buffer：
Lane A 3 / 3
Lane B 2 / 3

木托盘：
Layer 5 / 8
SilkCake 30 / 48

盖板：
Waiting

贴标：
Idle

缠膜：
Idle

入库：
0 Waiting
```

---

## 57. 点击 SilkCart

显示：

```text
Cart ID
Active Side
Current Row
A Remaining
B Remaining
Total Remaining
Rotary State
Robot State
```

---

## 58. 点击 Plastic Pallet

显示：

```text
Pallet ID
Empty / Loaded
SilkCake ID
Section
Progress
Waiting Reason
Load Batch ID
```

---

## 59. 点击 Wooden Pallet

显示：

```text
Wooden Pallet ID
Layer 5 / 8
SilkCake 30 / 48
Covered: No
Labeled: No
Wrapped: No
Package ID
```

---

## 60. 点击 Gantry

显示：

```text
Gantry State
Lane A 3 / 3
Lane B 3 / 3
Wood Pallet Ready
Current Layer
Current Batch
```

---

## 61. Three.js 视觉要求：丝车

必须明显表现：

```text
A/B 两面
每面 3 行 × 6 列
```

不能只在一个面随便摆几个丝饼。

---

## 62. Three.js 视觉要求：Robot

夹具必须：

```text
1×6
```

抓取时：

```text
6 个 SilkCake 同时移动
```

---

## 63. Three.js 视觉要求：Gantry

必须：

```text
2×3 Gripper
```

并清楚展示下方：

```text
3 条平行辊道
```

两条：

```text
Plastic Pallet Lane
```

一条：

```text
Wooden Pallet Lane
```

---

## 64. Three.js 视觉要求：木托盘码垛

每一层真实增加：

```text
2×3 SilkCake
```

逐层显示：

```text
Layer1
...
Layer8
```

不能只把 `currentLayer` 数字加一而不显示物料。

---

## 65. Three.js 视觉要求：盖板

第 8 层完成后：

```text
盖板桁架
```

真实移动 Cover 并放到顶部。

---

## 66. Three.js 视觉要求：贴标

完成后至少显示：

```text
Label Plane
```

贴在包装单元侧面 / 指定面。

---

## 67. Three.js 视觉要求：缠膜

Wrap 过程中应表现：

```text
透明膜层逐渐包覆
```

第一阶段可以用透明材质 Mesh 模拟。

---

## 68. Three.js 视觉要求：立体库

第一阶段至少：

```text
Inbound Conveyor
Warehouse Gate
Rack Placeholder
```

后续再接：

```text
堆垛机
四向车
穿梭车
```

---

## 69. 建议重命名 Procedural 场景

当前：

```text
ProceduralPackagingLine
```

逐步迁移为：

```text
ProceduralSilkCakeLine
```

可新增：

```text
preset = silk-cake-packaging-line
```

旧 `packaging-line` 保持兼容。

---

## 70. 推荐新增 Contracts

```text
SilkCakeEntity
SilkCartEntity
SilkCartSide
SilkCartRow
SilkCartSlot

PlasticPalletEntity
WoodenPalletEntity

RobotRowPickTask
GantryPickLayerTask
CoverPlacementTask
WrappingTask
WarehouseInboundTask

TwinTransferBatch
TwinBatchBarrier

FinishedPackageUnit
```

---

## 71. 推荐新增文件

```text
ClientApp/src/digital-twin/runtime/
├── PalletFlowController.ts
├── BatchFlowController.ts
├── SilkCartController.ts
├── RotaryTableController.ts
├── RobotRowLoadingController.ts
├── GantryStackController.ts
├── WoodPalletController.ts
├── CoverGantryController.ts
├── LabelStationController.ts
├── WrappingStationController.ts
├── WarehouseInboundController.ts
├── ProcessStationManager.ts
├── TwinSectionGeometryResolver.ts
└── ProceduralSilkCakeLine.ts
```

---

## 72. 继续复用现有能力

不要重写：

```text
TwinMaterialFlowRuntime
TwinSectionManager
TwinEntityManager
TwinJunctionManager
RouteEngine
```

继续复用：

```text
Capacity
Occupancy
Reserved
tryTransfer()
tryAdvanceAtJunction()
Waiting
Resume
PLC Decision
Simulation Decision
```

---

## 73. 开发阶段

### Phase 1：真实视觉纠正

```text
SilkCart A/B
3×6 / Side
Robot 1×6 Gripper
6 Empty Plastic Pallets
Gantry 2×3
3 Parallel Conveyor Lanes
Wooden Pallet
```

### Phase 2：Robot 六件批量上料

```text
6 Empty Barrier
↓
Pick one Cart Row
↓
6 SilkCake Attach
↓
Place 6
↓
6 Pallet Loaded
```

### Phase 3：A/B 丝车控制

```text
A1
A2
A3
Rotate
B1
B2
B3
Empty
Replace
```

### Phase 4：Plastic Pallet Section Flow

```text
Capacity
Waiting
Resume
Blocked Propagation
Junction
```

### Phase 5：Gantry 2×3

```text
LaneA 3
LaneB 3
Wood Pallet Ready
↓
Pick 6
↓
Place Layer
↓
6 Empty Pallets
```

### Phase 6：8层

```text
Layer 1 ... Layer 8
48 SilkCake
```

### Phase 7：Cover

```text
Full
→ Cover
```

### Phase 8：Label

```text
Covered
→ Labeled
```

### Phase 9：Wrapping

```text
Labeled
→ Wrapped
```

### Phase 10：AS/RS Inbound

```text
Wrapped
→ ReadyInbound
→ Stored
```

### Phase 11：UI / MCP

增加：

```text
SilkCart
Robot Batch
Plastic Pallet
Gantry Buffer
Wood Pallet Layer
Cover
Label
Wrap
Warehouse Task
```

---

## 74. 验收标准

### 丝车

```text
A 面 3×6
B 面 3×6
总 36
```

### Robot

```text
一次 Pick 6
不是 Pick 1
```

### 顺序

Simulation 默认：

```text
A1 → A2 → A3 → B1 → B2 → B3
```

### 上料托盘

不足 6 个空托盘：

```text
Robot 不得启动
```

### Plastic Pallet

```text
一托最多一丝饼
```

### Gantry Buffer

```text
LaneA 3
LaneB 3
```

才允许 Gantry Pick。

### Gantry

```text
2×3
一次 6 个
```

### Wooden Pallet

```text
6 / Layer
8 Layers
48 SilkCake
```

### Plastic Pallet Empty

Gantry Pick 后：

```text
6 个 Plastic Pallet
Loaded → Empty
```

并回流。

### Wood Pallet Release

```text
Layer < 8
```

不得离开码垛站。

### 后处理顺序

必须：

```text
Stack
→ Cover
→ Label
→ Wrap
→ Warehouse
```

### 入库条件

必须：

```text
48 SilkCake
+ 8 Layers
+ Cover
+ Label
+ Wrapped
```

全部完成。

### Section

即使存在批量工艺：

```text
Occupancy + Reserved
```

仍不得超过 Capacity。

---

## 75. AI 实现原则

### 原则一

```text
Runtime State > Three.js Animation
```

### 原则二

抓取时对象 Parent 必须真实切换：

```text
SilkCart
→ RobotGripper
→ PlasticPallet
→ GantryGripper
→ WoodenPallet
```

### 原则三

```text
Plastic Pallet = 循环载具
Wooden Pallet = 成品包装载具
```

### 原则四

```text
Capacity = 物理容量
Batch Barrier = 工艺同步条件
```

二者同时存在。

### 原则五

真实模式：

```text
PLC = 路线 / 到位 / 设备状态
WCS = 入库任务 / 库位
```

Simulation 只模拟这些业务信号。

---

## 76. 最终完整工艺闭环

```text
SilkCart A 面 3×6
↓
Robot Pick A Row 1：6个
↓
6 Empty Plastic Pallet
↓
6 Loaded
↓
Section Flow

Robot Pick A Row 2
Robot Pick A Row 3

↓
A Empty
↓
Rotary → B

Robot Pick B Row 1
Robot Pick B Row 2
Robot Pick B Row 3

↓
Cart Empty
↓
换丝车

--------------------------------

Loaded Plastic Pallets
↓
Lane A：3个
Lane B：3个
↓
6 Ready

Wooden Pallet Lane
↓
Empty Wood Pallet Ready

↓
Gantry 2×3 Pick
↓
Wood Pallet Layer +1

重复 8 次
↓
48 SilkCake
↓
Wood Pallet Full

↓
Cover Gantry
↓
Cover

↓
Label
↓
Labeled

↓
Wrapping
↓
Wrapped

↓
AS/RS Inbound
↓
Stored

--------------------------------

每次 Gantry Pick 后：

6 个 Plastic Pallet
↓
Empty
↓
Return Line
↓
重新进入 Robot Loading Buffer
```

---

## 77. 最终结论

这套场景不应再按普通“包装线”理解，而应定义成：

```text
丝车 A/B 双面批量供料
+
机器人 1×6 批量上料
+
6 空塑料托盘同步等待
+
塑料托盘循环输送
+
Section 分段容量与堵塞传播
+
PLC 岔口分流
+
双塑料托盘线 3+3 集料
+
桁架 2×3 批量码垛
+
木托盘 8 层 × 6 = 48 件
+
盖板
+
贴标
+
缠膜
+
立体库入库
```

后续 AI 优化优先级：

```text
真实工艺准确
>
Batch 同步准确
>
Section Capacity 准确
>
设备状态准确
>
丝饼 / 托盘 Parent 关系准确
>
PLC / WCS 联动准确
>
Three.js 视觉精度
```

禁止再次退化成：

```text
所有托盘一直跑
所有机器人一直摆
没有凑批条件
没有工位等待
没有状态依赖
```

的视觉 Demo。
