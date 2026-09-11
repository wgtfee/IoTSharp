# IoTSharp 3D 场景设计器工业数字孪生编排平台 V2.0 设计方案

## 1. V2.0 定位

V1 已经完成：

- Generated Route
- Manual Route
- Generated → Manual
- RouteAuthoringCompiler
- RouteAuthoringValidator
- Endpoint Merge
- Section
- SourceMap
- Runtime Route Overlay
- 单路线 / 分流 / 合流调试
- Generated + Manual → Unified RouteGraph
- Unified RouteGraph → 现有 RouteEngine
- V19 外检后空托独立回流迁移
- 保存 / 发布 / 回滚兼容

因此 V2.0 不再重新建设 Route Runtime。

V2.0 的核心目标变为：

> **场景设计器不仅能够描述“物料走哪里”，还能够描述“设备什么时候动、怎么动、由什么信号驱动、和谁互锁、物料什么时候被抓起和放下”。**

最终形成四个统一层：

```text
              IoTSharp Digital Twin Designer V2
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
   Route Authoring      Action Authoring      Motion Binding
        │                    │                    │
        └──────────────┬─────┴──────┬─────────────┘
                       │            │
                 Twin Runtime State
                       │
             ┌─────────┴──────────┐
             │                    │
        RouteEngine          Action Engine
             │                    │
             └─────────┬──────────┘
                       │
                Three.js Scene
                       │
              设备 / 物料实时运动
```

其中：

**RouteEngine 继续使用 V1 已有实现。**

V2 只在现有基础上增加动作、状态、运动、联锁和调试能力，不建立第二套路由系统。

---

## 2. V2.0 最重要的设计思想

V2 必须彻底分清四种东西。

### 2.1 Route —— 物料从哪里走

负责：

- 小托盘
- 木托
- 纸箱
- 丝锭物流位置
- 输送线
- 分流
- 合流
- 回流
- 缓存
- Section
- PLC 放行

例如：

```text
外检出口
   ↓
EmptyReturnAfterInspection
   ↓
空托回流
   ↓
Gantry Merge
```

仍然由：

```text
RouteGraph
   ↓
RouteEngine
```

控制。

### 2.2 Motion —— 一个设备本身怎么运动

例如：

#### 辊道

```text
Roller01.rotation
Roller02.rotation
Roller03.rotation
```

#### 气缸

```text
Cylinder.position
0 → 120mm
```

#### 桁架

```text
X Axis
Y Axis
Z Axis
Gripper
```

#### 六轴机器人

```text
J1
J2
J3
J4
J5
J6
Gripper
```

Motion 只描述：

> **设备自身具有什么运动能力。**

不负责工艺顺序。

---

## 3. Component Designer V2

Component Designer 负责建设设备本身。

例如建立：

```text
丝锭桁架
```

内部定义：

```text
Component
├─ Mesh
├─ Ports
├─ Internal Route
├─ Motion
│  ├─ AxisX
│  ├─ AxisY
│  ├─ AxisZ
│  └─ Gripper
├─ Actions
│  ├─ MoveX
│  ├─ MoveY
│  ├─ MoveZ
│  ├─ Grip
│  └─ Release
└─ Signals
   ├─ XPosition
   ├─ YPosition
   ├─ ZPosition
   ├─ ClampOpen
   └─ ClampClosed
```

Component Designer 主要负责：

> **“这个设备能够干什么。”**

Scene Designer 负责：

> **“这个设备在整个生产线里什么时候干。”**

这是 V2 最重要的边界。

---

## 4. Motion Definition

V2 建议增加统一：

```text
MotionDefinition
```

数据结构概念：

```json
{
  "id": "axis-z",
  "type": "LinearAxis",
  "target": "gantry-z-axis",
  "axis": "Y",
  "min": 0,
  "max": 3.2,
  "unit": "m",
  "home": 0,
  "speed": 0.6
}
```

支持：

```text
LinearAxis
RotationAxis
RobotJoint
Cylinder
Roller
Servo
Gripper
CustomAnimation
```

这样以后任何设备都不需要单独写 Three.js 动画代码。

---

## 5. Motion Binding

这是 V2 **优先级最高的功能之一**。

目前最需要实现的是：

> PLC / 遥测数据上来以后，3D 模型真正运动。

因此建议增加：

```text
Motion Binding
```

例如：

```text
遥测：
{
    "X": 1250,
    "Y": 800,
    "Z": 450
}
```

设计器配置：

```text
设备：丝锭桁架

AxisX
Source      = Telemetry
Key         = X
Scale       = 0.001
Unit        = mm → m
Min         = 0
Max         = 8

AxisY
Source      = Telemetry
Key         = Y

AxisZ
Source      = Telemetry
Key         = Z
```

最终：

```text
Telemetry
     ↓
TwinStateStore
     ↓
MotionBindingResolver
     ↓
MotionDefinition
     ↓
Three.js Transform
```

PLC 位置值变化：

```text
1250
↓
1.25m
↓
模型移动到 X=1.25
```

不需要编写：

```typescript
robot.position.x = ...
```

这种业务硬代码。

---

## 6. 三种 Motion 模式

V2 应该统一支持：

### Simulation

设计器自己产生运动。

例如：

```text
0m → 2m
速度 0.5m/s
```

### Live

完全跟随遥测。

例如：

```text
PLC X = 1560mm
↓
模型 X = 1.56m
```

Live 模式不自己推算位置。

### Hybrid

设备位置跟 PLC，但一些 PLC 没有提供的数据通过数字孪生推导。

例如：

```text
机器人轴位置 → PLC

丝锭是否跟随夹具
    ↓
数字孪生推导
```

这种模式特别适合包装线。

---

## 7. Action Graph

V2 第二个核心是：

```text
Action Graph
```

例如机器人上料：

```text
等待托盘到位
       ↓
等待上料允许
       ↓
机器人移动到 A 面
       ↓
抓取 12 锭
       ↓
移动
       ↓
放置 12 锭
       ↓
机器人返回
       ↓
再次抓取
       ↓
抓取 6 锭
       ↓
放置 6 锭
```

以后不写成一个巨大：

```typescript
async function robotProcess()
```

而是在设计器里面配置。

---

## 8. Action Node

建议 V2 第一批提供以下节点。

### Motion

```text
Move Axis
Move Robot Pose
Rotate
Cylinder Extend
Cylinder Retract
```

### Gripper

```text
Grip
Release
Attach Object
Detach Object
```

### Logic

```text
Wait
Delay
Condition
Branch
Parallel
Join
Repeat
```

### Signal

```text
Wait Signal
Set Simulation Signal
Compare Signal
Edge Trigger
```

### Route

```text
Wait Object Arrived
Release Object
Block Route
Open Diverter
Select Branch
```

### Twin

```text
Create Object
Destroy Object
Attach
Detach
Set Property
Set Status
```

---

## 9. Action 与 Route 联动

不能让：

```text
RouteEngine
```

和：

```text
ActionGraph
```

互相不知道。

应该形成事件联动。

例如：

```text
小托盘
   ↓
RouteEngine
   ↓
到达 RobotPickupPoint
   ↓
ObjectArrived
   ↓
ActionGraph
   ↓
机器人抓取
   ↓
Attach Yarn
   ↓
机器人动作完成
   ↓
ReleasePermit
   ↓
RouteEngine 继续
```

因此 V2 建议加入：

```text
TwinEventBus
```

但它只是内部事件协调机制，不是新的 Route Runtime。

---

## 10. Attach / Detach 正式模型

现在工业数字孪生中非常重要的一点：

> 被抓起来的丝锭不能继续属于辊道。

因此 V2 正式建立：

```text
Object Attachment
```

例如：

```text
Yarn001
Parent =
SmallPallet001
```

机器人抓取：

```text
Yarn001
Parent =
Robot.Gripper.Anchor01
```

放下：

```text
Yarn001
Parent =
SmallPallet009
```

这样就能彻底解决：

- 抓起来还跟着辊道走
- 丝锭位置漂移
- 夹具上丝锭放大缩小
- 12 个丝锭间距变化
- detach 后位置错误

---

## 11. Gripper Anchor

`2×6` 机器人夹具应该正式变成：

```text
Gripper
├─ Anchor A1
├─ Anchor A2
├─ Anchor A3
├─ Anchor A4
├─ Anchor A5
├─ Anchor A6
├─ Anchor B1
├─ Anchor B2
├─ Anchor B3
├─ Anchor B4
├─ Anchor B5
└─ Anchor B6
```

第一次：

```text
12 Active Anchors
```

第二次：

```text
6 Active Anchors
6 Empty Anchors
```

Attach 后：

```text
丝锭 LocalTransform 固定
```

因此夹具移动、旋转、缩放过程中：

```text
12 个丝锭保持 2×6 固定排列。
```

---

## 12. Robot Pose 系统

机器人不能让用户直接编六个关节每一步的位置。

建议支持：

```text
Robot Pose
```

例如：

```text
Home
Pickup-A
Pickup-B
Place-A
Place-B
Safe-01
Safe-02
```

每个 Pose 内部保存：

```text
J1
J2
J3
J4
J5
J6
```

Action Graph 只需要：

```text
MoveToPose(Pickup-A)
```

而不是：

```text
J1 = 15
J2 = -30
J3 = ...
```

---

## 13. Gantry Position 系统

桁架采用：

```text
Named Position
```

例如：

```text
Home
SmallRollerPickup
WoodPalletPlace
SeparatorPickup
SeparatorPlace
TopCoverPickup
TopCoverPlace
```

最终：

```text
Move Gantry
Target = WoodPalletPlace
```

设计器自动转换成：

```text
X
Y
Z
```

---

## 14. Teach Mode

V2 应该增加非常实用的：

```text
示教位置
```

用户：

1. 选中机器人 / 桁架
2. 手动把轴移动到需要位置
3. 点击 `记录当前位置`
4. 输入 `丝锭抓取位`
5. 自动生成 Pose / NamedPosition

类似工业机器人示教器。

这比手填 XYZ 实用很多。

---

## 15. Runtime State Store

V2 建议形成统一：

```text
TwinStateStore
```

管理：

```text
Device State
Signal State
Object State
Route State
Action State
Alarm State
Binding State
```

例如：

```text
Robot01
  Running
  CurrentAction
  CurrentPose
  Joint1~6

Pallet001
  Route
  Edge
  Progress
  Contents

Gantry01
  X
  Y
  Z
  Gripper
```

Three.js 本身不保存业务真相。

它只是：

> TwinStateStore 的显示层。

---

## 16. Telemetry Binding V2

继续坚持当前原则：

> **统一遥测，不另外建设一套 SignalR 数字孪生控制链。**

建议 Binding 页面升级成：

```text
数据源
设备
Telemetry Key
数据类型
转换公式
比例
偏移
单位
死区
最小值
最大值
更新模式
失联超时
```

例如：

```text
Source:
PLC01

Telemetry Key:
Gantry_X

Transform:
value / 1000

Target:
Gantry.AxisX.Position
```

---

## 17. Telemetry Mapping Formula

增加简单转换：

```text
value / 1000
value * -1
value - 125
(value - min) / range
```

解决 PLC 坐标和 Three.js 世界坐标不同的问题。

---

## 18. Coordinate Calibration

V2 建议加入：

```text
坐标标定
```

例如 PLC：

```text
X=0
```

实际模型：

```text
X=-4.8m
```

则：

```text
ScenePosition =
PLCPosition × Scale + Offset
```

进一步可以支持：

```text
Axis Mapping

PLC X → Scene Z
PLC Y → Scene X
PLC Z → Scene Y
```

工业项目里这个非常重要。

---

## 19. Route Template

V1 已经解决 Manual Route。

V2 可以正式增加：

```text
Route Template
```

例如：

```text
直线
90°弯道
U 型
双排辊道
一分二
二合一
回流
机器人绕行
缓存段
```

拖入以后生成 RouteGraph Authoring 数据。

仍然：

```text
Template
   ↓
RouteAuthoring
   ↓
Compiler
   ↓
统一 RouteGraph
```

绝不能 Template 自己运行。

---

## 20. Component Generated Route V2

辊道继续支持：

```text
自带 Route
```

例如：

```text
双排小辊道
├── Lane A
└── Lane B
```

组件拖进去以后自动：

```text
Port + Generated Route
```

普通地方基本不用画线。

复杂区域：

```text
Manual Route
```

这样继续保持“双方式建路线”。

---

## 21. Auto Connect

V2 增加：

```text
入口连接
出口连接
```

选择：

```text
出口：
Roller01.Out

入口：
Inspection01.In
```

点击连接：

自动：

```text
Port Snap
+
Route Endpoint Merge
+
Route Validation
```

不强迫每次用鼠标吸附。

---

## 22. Route Auto Repair

组件移动后：

Generated Route：

```text
自动重新生成。
```

Manual Route：

```text
Attachment Endpoint 跟着设备移动
中间控制点保持。
```

例如：

```text
A─────●─────●─────B
```

B 设备移动：

```text
A─────●─────●────────B
```

而不是路线断掉。

---

## 23. Route Constraint

路线可以配置：

```text
Horizontal
Vertical
Fixed Height
Orthogonal
Follow Surface
Keep Clearance
```

工业辊道主要使用：

```text
Horizontal + Orthogonal
```

降低乱线。

---

## 24. Runtime Dynamic Routing

V1 已经可以：

```text
分流
合流
Priority
Manual Decision
```

V2 可以升级：

```text
Routing Rule
```

例如：

```text
IF Left.Ready
    → Left
ELSE IF Right.Ready
    → Right
ELSE
    → Wait
```

或者：

```text
Simulation:
6 : 6 Weight

Live:
ReleasePermit
Ready
Blocked
Full
```

严格保持已经确定的规则：

```text
Live 不使用模拟权重。
```

---

## 25. Route Policy Designer

增加可视化：

```text
Routing Policy
```

例如：

```text
       Ready?
       /   \
     YES   NO
      ↓     ↓
   Left   Check Right
```

用于：

- 交叉口
- 分流
- 合流
- 空托回流
- 满托流转

---

## 26. Section Runtime

V1 已有 Section。

V2 将 Section 真正提升成运行管理单元：

```text
Section
├─ Status
├─ Occupancy
├─ Ready
├─ Blocked
├─ Full
├─ Alarm
├─ Capacity
└─ PLC Binding
```

以后用户点击：

```text
EmptyReturnAfterInspection
```

直接看到：

```text
状态：Running
空托：3
阻塞：False
入口允许：True
出口允许：True
```

---

## 27. Runtime Overlay V2

V1 已有颜色。

V2 增加：

```text
动画流向
占用动画
箭头
速度
Object Count
Capacity
Waiting Reason
```

例如：

```text
外检空托回流
━━━━━━━━━━━━━━▶
Occupied: 3/6
```

---

## 28. Safety Envelope

V2 必须正式建立：

```text
Safety Envelope
```

尤其：

- 机器人
- 桁架
- 夹具
- 输送物料

定义：

```text
Physical Bounds
Safety Bounds
Pickup Bounds
Place Bounds
```

第一阶段不用一开始做非常复杂的真实机械碰撞。

先做：

```text
AABB / OBB Safety Envelope
```

---

## 29. Route Safety

现有规则继续作为硬约束：

```text
Small Pallet Safety Distance >= 1.50m
```

不得被：

```text
UI
Template
Simulation
Debug
Runtime
```

任何地方覆盖为更小值。

建议统一形成：

```text
RouteSafetyPolicy
```

而不是多个地方各写一次 `1.5`。

---

## 30. Motion Interlock

动作节点支持：

```text
Precondition
Interlock
Timeout
Failure
```

例如：

```text
RobotMoveToPickup

Preconditions:
✓ ConveyorStopped
✓ PalletInPosition
✓ SafetyDoorClosed
✓ RobotReady
```

不满足：

```text
Waiting
```

而不是硬执行。

---

## 31. Action State Machine

每一个动作运行时状态统一：

```text
Idle
Waiting
Ready
Running
Completed
Failed
Cancelled
Timeout
```

这非常重要，否则后面调试机器人会非常困难。

---

## 32. Action Runtime Debugger

V2 增加底部调试面板：

```text
Action Timeline
```

例如：

```text
12:01:02 Wait Pallet       Completed
12:01:03 Move Robot        Completed
12:01:08 Grip              Completed
12:01:09 Move Place        Running
12:01:11 Release           Waiting
```

点击某一步显示：

```text
输入
输出
使用信号
当前值
等待原因
持续时间
```

---

## 33. 单步执行

增加：

```text
Run
Pause
Step
Continue
Stop
Reset
```

Action Graph 可以一节点一节点执行。

特别适合调：

- 机器人
- 桁架
- 抓取
- 放置
- 分流
- 合流

---

## 34. Breakpoint

Action 节点增加：

```text
Breakpoint
```

例如：

```text
MoveToPickup
↓
Grip        ● breakpoint
↓
MovePlace
```

运行到抓取前暂停。

---

## 35. Simulation Inspector

运行模拟时选中对象：

```text
SmallPallet_012
```

显示：

```text
Object ID
Route
Section
Current Edge
Progress
Speed
Contents
Attached To
Previous Node
Next Node
Waiting Reason
```

---

## 36. Runtime Inspector

Live 模式点击设备：

```text
丝锭桁架
```

显示：

```text
Signal
Value
Timestamp
Quality

XPosition    1850     12:05:03 GOOD
YPosition     320     12:05:03 GOOD
ZPosition     680     12:05:03 GOOD
ClampClosed     1     12:05:03 GOOD
```

同时显示：

```text
Action
Route
Interlock
Alarm
```

---

## 37. Telemetry Stale

统一失联逻辑：

```text
Good
Stale
Bad
Missing
```

例如超过：

```text
3 sec
```

没有更新：

```text
Stale
```

模型不应该瞬间回零。

建议：

```text
Freeze Last Value
+
显示 Stale
```

---

## 38. Replay

V2 后期建议支持：

```text
Telemetry Replay
```

把某一时间段的遥测重新播放。

例如：

```text
14:10:00
↓
14:25:00
```

3D 场景重新演示设备过程。

用于：

- 故障分析
- 设备卡顿分析
- 物流异常分析
- 领导回看

---

## 39. Scene Runtime Modes

最终场景统一四个运行入口：

```text
Edit
Simulation
Live
Replay
```

### Edit

编辑设备 / Route / Action。

### Simulation

设计器自运行。

### Live

完全使用现场遥测。

### Replay

历史数据回放。

---

## 40. Scene Designer 页面布局 V2

保留当前页面基本结构，不推翻已有功能。

建议：

```text
┌──────────────────────────────────────────────┐
│ 工具栏                                        │
├─────────┬───────────────────────────┬────────┤
│ 左侧    │                           │ 右侧   │
│         │         3D Canvas         │        │
│ Scene   │                           │ 属性   │
│ Model   │                           │ Binding│
│ Route   │                           │ Action │
│ Action  │                           │ Signal │
│ Signal  │                           │ Safety │
│         │                           │        │
├─────────┴───────────────────────────┴────────┤
│ Runtime / Timeline / Debugger                │
└──────────────────────────────────────────────┘
```

---

## 41. 左侧模式

建议：

```text
场景
模型库
路线
动作
信号
```

互不混淆。

---

## 42. 顶部模式

增加：

```text
编辑
模拟
实时
回放
```

以及：

```text
▶ Run
Ⅱ Pause
■ Stop
>| Step
```

---

## 43. Scene Tree V2

场景树支持：

```text
Scene
├── Equipment
├── Materials
├── Routes
├── ActionGraphs
├── Signals
└── Safety
```

但不能破坏当前已有 Scene Tree 操作。

仍然支持：

- 重命名
- 删除
- 多选
- 显示隐藏
- 定位
- 属性
- 父子关系

---

## 44. 设计对象命名

运行时不能再依赖：

```text
mesh name
```

判断业务。

每个对象使用：

```text
objectId
componentId
instanceId
role
```

名称只是：

```text
displayName
```

这样在场景树修改名称不会破坏运行。

---

## 45. Twin Capability

建议设备定义能力：

```text
Capabilities
```

例如机器人：

```text
Motion
Robot
Gripper
Pick
Place
Telemetry
```

辊道：

```text
Conveyor
RouteProvider
RollerAnimation
Telemetry
```

桁架：

```text
Motion
Gantry
Gripper
Pick
Place
```

Action Designer 根据 Capability 自动决定这个对象允许出现哪些动作。

---

## 46. 模板复用

Component 可以导出为：

```text
Component Template
```

Action 可以保存：

```text
Action Template
```

Route 可以保存：

```text
Route Template
```

例如：

```text
机器人12锭抓取模板
外检空托回流模板
双排辊道模板
一分二模板
二合一模板
桁架抓取模板
```

以后拖进去直接配置变量。

---

## 47. 参数化模板

例如：

```text
Robot Pick Template
```

参数：

```text
Robot
PickupPoint
PlacePoint
AnchorLayout
Count
ReadySignal
CompleteSignal
```

不是复制后全部重新配置。

---

## 48. V19 在 V2 中的最终目标

V19 不应该再是：

> “开发人员知道这个场景怎么跑。”

而应该成为：

> **“场景 JSON 本身就完整描述怎么跑。”**

最终：

```text
V19 Scene
│
├─ Components
│
├─ Route Authoring
│
├─ RouteGraph
│
├─ MotionDefinitions
│
├─ PoseDefinitions
│
├─ ActionGraphs
│
├─ SignalBindings
│
├─ Interlocks
│
└─ RuntimePolicies
```

加载 V19：

```text
不用再进入代码增加 V19 特殊逻辑。
```

---

## 49. V2 第一条完整业务链

建议不要一开始全面铺开。

首先拿：

```text
小托盘 → 上料机器人
```

作为 V2 第一条完整链。

流程：

```text
小托盘到位
    ↓
RouteEngine 停止
    ↓
ActionGraph 收到 Arrived
    ↓
机器人 MoveToPickup
    ↓
Grip
    ↓
12 Yarn Attach
    ↓
MoveToPlace
    ↓
12 Yarn Detach
    ↓
Robot Home
    ↓
Route Release
```

先彻底打通：

```text
Route
+
Action
+
Motion
+
Attach
+
Telemetry
```

---

## 50. 第二条完整链

完成机器人后：

```text
丝锭桁架
```

打通：

```text
Axis X/Y/Z
↓
PLC Telemetry
↓
3D Motion

丝锭夹具
↓
Grab
↓
Attach
↓
Move
↓
Detach

隔板夹具
↓
Grab Separator
↓
Place Separator
```

这样 Action Engine 的通用性基本就能验证。

---

## 51. 第三条完整链

再做：

```text
外检机
```

因为属于固定设备。

它主要验证：

```text
Component Internal Animation
+
Telemetry Binding
+
Route Interlock
```

例如：

```text
托盘进入
↓
Stop
↓
InspectionRunning
↓
机器内部动作
↓
InspectionComplete
↓
Result
↓
Route Decision
```

---

## 52. 第四条完整链

再完成：

```text
空托独立回流
```

验证：

```text
Route Policy
+
分流
+
合流
+
互锁
+
Section
```

这样 V19 就已经覆盖四类核心运行模型。

---

## 53. V2 开发阶段

建议从 V1 Phase 7 后继续编号。

### Phase 8 —— Motion Framework

实现：

```text
MotionDefinition
Motion Binding
Linear Axis
Rotation Axis
Roller
Cylinder
Gripper
Simulation / Live / Hybrid
Coordinate Mapping
```

验收：

PLC 遥测改变：

```text
模型实时移动。
```

这是整个 V2 应该第一个完成的阶段。

---

## 54. Phase 9 —— Pose / Teach

实现：

```text
Named Position
Robot Pose
Gantry Position
Teach Mode
Motion Test
```

验收：

用户无需代码即可：

```text
记录抓取位
记录放置位
点击 Run
模型运行
```

---

## 55. Phase 10 —— Action Graph

实现：

```text
ActionGraph
ActionNode
Condition
Wait
Parallel
Branch
Motion
Signal
Route
Attach
Detach
```

验收：

可以在设计器完成：

```text
机器人抓丝 → 移动 → 放丝
```

全过程。

---

## 56. Phase 11 —— Object Attachment

实现：

```text
Anchor
Attach
Detach
Payload
Parent Transform
```

严格验证：

```text
2×6 夹具
12 锭
6 锭
```

抓取过程中位置不变化。

---

## 57. Phase 12 —— Telemetry Runtime

实现：

```text
TwinStateStore
TelemetryBindingResolver
Signal Quality
Stale
Transform Formula
Coordinate Calibration
```

验收：

模拟数据和真实遥测都可以使用同一套模型。

---

## 58. Phase 13 —— Route / Action Coordination

建立：

```text
ObjectArrived
ObjectReleased
RouteBlocked
ActionStarted
ActionCompleted
```

等统一事件。

完成：

```text
Route → Robot → Route
```

闭环。

---

## 59. Phase 14 —— Safety / Interlock

实现：

```text
SafetyEnvelope
MotionInterlock
RouteSafetyPolicy
Action Preconditions
Timeout
```

小托盘：

```text
>=1.50m
```

继续作为不可降低硬限制。

---

## 60. Phase 15 —— Debugger

实现：

```text
Run
Pause
Step
Breakpoint
Timeline
Signal Inspector
Action Inspector
Route Inspector
```

达到：

> 单个组件、单个 Action、单条 Route、完整场景都可以分别测试。

---

## 61. Phase 16 —— V19 Designer Migration

将 V19 中剩余业务逻辑迁入：

```text
Route
Action
Motion
Binding
Policy
```

最终目标：

```text
V19 运行不依赖 V19 专用运动代码。
```

---

## 62. Phase 17 —— Replay / Diagnosis

实现：

```text
Telemetry Recording
Replay
Timeline
Runtime Snapshot
Fault Diagnosis
```

这一阶段可以放 V2 后半段。

---

## 63. V2.0 数据模型建议

V1：

```text
TwinSceneManifest
├─ objects
├─ routes
└─ routeGraph
```

V2：

```text
TwinSceneManifest
│
├─ objects
├─ routes
├─ routeGraph
│
├─ motions
├─ poses
├─ actionGraphs
├─ signalBindings
├─ safetyPolicies
├─ runtimePolicies
└─ metadata
```

仍然只是一份 Scene Manifest。

保存、发布、版本、回滚都跟着场景统一处理。

---

## 64. 发布机制

V2 发布时需要增加：

```text
SceneValidator
RouteValidator
ActionValidator
BindingValidator
SafetyValidator
```

编译：

```text
Authoring Manifest
       ↓
Validation
       ↓
Compilation
       ↓
Published Runtime Manifest
```

Runtime 只读取：

```text
Published Runtime Manifest
```

不在现场重新编译场景。

---

## 65. V2 Publish Gate

存在以下错误不能发布：

```text
Route 断裂
重复普通输入
Action 引用不存在对象
Motion 引用不存在 Mesh
Pose 超过轴范围
Binding Key 不存在
Attach Anchor 不存在
循环 Action 无退出条件
关键安全互锁缺失
```

Warnings 可以发布，但必须提示。

---

## 66. Version Diff

V2 建议增加：

```text
Version Diff
```

例如：

```text
V19 → V20

Route
+ edge xxx

Action
RobotLoading:
  PickupPose changed

Binding
Gantry_X:
  offset -3.2 → -3.4
```

工业现场非常有价值。

---

## 67. V2.0 核心原则

V2 开发过程中必须长期保持以下规则。

### 规则一

不建立第二套 Route Runtime。

### 规则二

Component Generated Route 和 Manual Route 最终仍进入统一 RouteGraph。

### 规则三

Component Designer 描述：

```text
设备能力。
```

Scene Designer 描述：

```text
生产协同。
```

### 规则四

业务动作不得继续硬编码到某个 V19 / V20 页面。

### 规则五

Three.js Mesh 只是表现层，不作为业务状态来源。

### 规则六

Live 模式以遥测状态为准。

### 规则七

Simulation 和 Live 尽量共用：

```text
Route
Action
Motion
State
```

区别主要在数据源。

### 规则八

任何升级不得删除现有 3D 场景设计器功能。

### 规则九

保存 / 发布 / 回滚必须保存完整 Authoring 信息。

### 规则十

现有 V19 严格回归测试长期保留。

---

## 68. V2.0 最终验收标准

只有同时满足以下条件，V2 才算完成：

1. PLC 遥测可以直接驱动普通轴模型运动。
2. 桁架 XYZ 可以完全通过设计器绑定。
3. 六轴机器人 Pose 可以通过设计器定义。
4. Component 可以定义自身 Motion。
5. Scene 可以配置设备间 ActionGraph。
6. Route 与 Action 可以互相等待和通知。
7. 支持 Attach / Detach。
8. 2×6 十二锭抓取过程中排列保持不变。
9. 第二次 6 锭抓取剩余 6 Anchor 为空。
10. Generated + Manual Route 继续共用 RouteEngine。
11. 外检后空托独立回流继续正常。
12. Live 分流使用 PLC 互锁，不使用模拟权重。
13. Simulation 支持 6:6 权重。
14. 小托盘安全距离不得低于 1.50m。
15. 单个 Motion 可以测试。
16. 单个 Action 可以测试。
17. 单条 Route 可以测试。
18. 完整场景可以测试。
19. 支持 Pause / Step / Breakpoint。
20. Runtime 可以查看等待原因。
21. Telemetry Stale 可以识别。
22. 保存后 Authoring 不丢失。
23. 发布后 Runtime Manifest 完整。
24. 回滚后 Motion / Action / Route / Binding 不丢失。
25. 旧场景可以继续加载。
26. 原有 3D 设计器功能全部保留。
27. V19 严格回归继续通过。
28. 至少连续两轮完整 Build + Regression PASS。

---

## 69. V1 与 V2 的关系

最终架构不是：

```text
V1 Route Designer
+
另一套 V2
```

而是：

```text
V1
路线编辑平台
       ↓
V2
工业数字孪生编排平台
```

其中 V1 的：

```text
Port
Generated Route
Manual Route
Section
RouteGraph
RouteEngine
Runtime Overlay
```

全部继续保留。

V2 在上面增加：

```text
Motion
Pose
Telemetry Binding
ActionGraph
Attachment
Interlock
Safety
Debugger
Replay
```

---

## 70. 最终目标

V2 完成以后，一个新的包装线项目应该可以这样开发：

```text
1. 从模型库拖设备
2. 连接设备 Port
3. 自动产生普通 Route
4. 手工补复杂 Route
5. 建立 Robot / Gantry Pose
6. 配置 Motion
7. 配置 PLC Telemetry
8. 拖 Action 节点
9. 建立抓取 / 放置 / 联锁
10. 单步模拟
11. 完整模拟
12. 发布
13. 切换 Live
14. PLC 数据直接驱动数字孪生
```

而不是：

```text
每增加一个机器人
↓
程序员重新写 TypeScript

每增加一个桁架
↓
重新写运动路径

每增加一条回流线
↓
重新修改 Runtime
```

这才是 IoTSharp 3D Scene Designer 从“3D 场景编辑器”真正升级为：

# Industrial Digital Twin Orchestration Platform

的 V2.0。

---

## 71. 建议的实际实施优先级

V2 不应该先做更漂亮的路线编辑，而应该第一阶段直接攻克：

```text
Motion Framework
+
Telemetry Binding
```

因为当前最需要看到的实际效果就是 PLC / 遥测值变化以后，桁架、机器人轴、辊道、气缸真正跟着动起来。

随后第二阶段把已经验证过的 `2×6` 上料机器人做成第一条完全由：

```text
Route
+
Motion
+
Action
+
Attach / Detach
```

驱动的完整业务流程。

一旦这条链路跑通，后续丝锭桁架、隔板夹具、天盖桁架、外检机等设备应优先复用同一套能力模型，而不是继续采用一台设备一套硬编码逻辑。