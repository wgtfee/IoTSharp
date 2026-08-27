# IoTSharp 数字孪生分段缓存、阻塞传播与 PLC 岔口分流设计

## 1. 文档目标

本设计针对 IoTSharp 数字孪生中的：

- 输送线
- 滚筒线
- 长缓存格
- 托盘流转
- 分段缓存
- 岔口分流
- PLC 路由控制
- 上下游阻塞传播
- 自动恢复
- MCP / AI 状态查询

进行统一设计。

普通输送缓存场景不依赖“托盘碰撞后停车”作为主要业务控制，而是采用：

```text
TwinSection
+
Capacity
+
Occupancy
+
Reserved
+
CanAccept
+
CanRelease
+
Blocked Propagation
+
PLC Route Decision
+
Waiting
+
Automatic Resume
```

核心原则：

> PLC 决定托盘“往哪里走”，IoTSharp 数字孪生负责判断“现在能不能走”。

---

# 2. 当前整体目标

目标运行链：

```text
模型资源库
    ↓
拖出辊道 / 输送设备
    ↓
形成 TwinSection
    ↓
设置 Capacity
    ↓
多个 Section 拼成线体
    ↓
遇到岔口 TwinJunction
    ↓
PLC 给出 RouteCode
    ↓
锁定当前托盘目标路线
    ↓
检查目标 Section Capacity
    ↓
允许进入 / Waiting
    ↓
下游释放容量
    ↓
自动 Resume
```

---

# 3. IoTSharp 当前已有相关能力

| 能力 | 当前状态 | 说明 |
|---|---:|---|
| Three.js 场景 | ✅ | 已具备 |
| 数字孪生编辑器 | ✅ | 已具备 |
| 模型资源库 | ✅ | 已具备 |
| Route 路径 | ✅ | 已具备 |
| Route Point | ✅ | 已具备 |
| Diverter / Merger 节点 | ✅ | 已具备 |
| Route Edge | ✅ | 已具备 |
| Edge Capacity | ⚠️ | 已有配置和预览过滤；尚需 Reserve / Enter / Leave 事务语义 |
| Edge Occupancy Binding | ⚠️ | 已有绑定；原实现只参与选路过滤，尚未形成 Section 权威状态 |
| Edge Blocked Binding | ⚠️ | 已有绑定；原实现只把边从候选路径移除，容易造成错误改道 |
| 实时数据绑定 | ✅ | Snapshot → BindingEngine |
| PLC / 设备状态动画 | ✅ | 已具备 |
| 路径运行 / 暂停 | ⚠️ | 当前是单个演示物体；多实体、边界等待和恢复仍需运行层管理 |
| 分段缓存 TwinSection | ❌ | 本方案新增 |
| Section Occupancy | ❌ | 本方案新增 |
| Reservation | ❌ | 本方案新增 |
| 上游阻塞传播 | ❌ | 本方案新增 |
| 自动恢复 | ❌ | 本方案新增 |
| PLC 岔口路由锁存 | ❌ | 本方案新增 |
| MCP 堵塞 / 分流原因查询 | ❌ | 本方案新增 |
| 异常几何碰撞 | ❌ | 可选增强 |

> 2026-08-27 代码审查结论：原 `RouteEngine.resolveRoutePath` 会先排除满载或封锁边，再选另一条候选边。这不符合“PLC 决定去哪、Capacity 只决定现在能不能进入”的职责边界。实现时必须先锁存目标边，动态不可用只产生 Waiting，不能自动替换 PLC 决定。

---

# 4. 现有模型资源库继续复用

不新增第二套组件库。

现有模型资源库继续作为统一入口。

建议资源库以后区分：

```text
模型资源库
│
├── 普通模型
│   ├── 厂房
│   ├── 建筑
│   └── 装饰
│
└── 可运行模型
    ├── 辊道
    ├── 输送机
    ├── 转台
    ├── 提升机
    ├── 移载机
    └── AGV 接驳台
```

场景中拖出的辊道是：

```text
资源定义
   ↓
场景实例
   ↓
TwinSection 运行属性
```

同一个辊道资源可以重复拖出多次。

例如：

```text
辊道01 Capacity = 5
辊道02 Capacity = 6
辊道03 Capacity = 3
```

---

# 5. TwinSection

每一节输送区域定义成：

```text
TwinSection
```

包括：

- 一节辊道
- 一段输送线
- 一个长缓存格
- 一个缓存段
- 一个接驳段

例如：

```text
Section02  →  Section01  →  下游

Section01 Capacity = 5
Section02 Capacity = 6
```

---

# 6. TwinSection 数据模型

```csharp
public class TwinSection
{
    public string Id { get; set; }

    public string Name { get; set; }

    public string ObjectId { get; set; }

    /// <summary>
    /// 最大允许存放托盘数量
    /// </summary>
    public int Capacity { get; set; }

    /// <summary>
    /// 当前实际存在托盘数量
    /// </summary>
    public int Occupancy { get; set; }

    /// <summary>
    /// 已预约但尚未真正进入的数量
    /// </summary>
    public int Reserved { get; set; }

    public string? UpstreamSectionId { get; set; }

    public string? DownstreamSectionId { get; set; }

    /// <summary>
    /// 当前是否还能接收托盘
    /// </summary>
    public bool CanAccept { get; set; }

    /// <summary>
    /// 当前是否允许向下游出料
    /// </summary>
    public bool CanRelease { get; set; }

    public TwinSectionState State { get; set; }

    public string? OccupancyBindingId { get; set; }

    public string? FullBindingId { get; set; }

    public string? BlockedBindingId { get; set; }
}
```

状态：

```csharp
public enum TwinSectionState
{
    Available,
    Full,
    Blocked,
    Fault
}
```

---

# 7. Section 属性面板

选中一节辊道后，建议直接显示：

```text
运行属性

名称：
辊道01

类型：
TwinSection

最大托盘数量：
[ 5 ]

当前数量：
[自动]

上游：
[辊道02]

下游：
[辊道00]

CanAccept：
[自动]

CanRelease：
[自动]

PLC 数量绑定：
[可选]

PLC 满位绑定：
[可选]

PLC 故障绑定：
[可选]
```

用户主要设置：

```text
Capacity
上下游关系
PLC 可选绑定
```

运行状态自动计算。

---

# 8. Capacity 核心规则

判断：

```text
Occupancy + Reserved < Capacity
```

成立：

```text
CanAccept = true
```

否则：

```text
CanAccept = false
State = Full
```

例如：

```text
Capacity = 5
Occupancy = 4
Reserved = 1
```

有效占用：

```text
5 / 5
```

因此不能再接收新托盘。

---

# 9. Reserved 必须保留

场景：

```text
Capacity = 5
Occupancy = 4
```

如果两个托盘同时准备进入：

```text
P5
P6
```

如果只看：

```text
Occupancy < Capacity
```

两者都可能判断成功。

因此必须：

```text
Reserve
```

正确流程：

```text
P5
↓
Reserve Section01
↓
Reserved = 1
↓
有效占用达到 5
↓
P6 再申请
↓
失败
```

---

# 10. 两节输送线示例

```text
第二节  →  第一节  →  下游
```

配置：

```text
第一节 Capacity = 5
第二节 Capacity = 6
```

第一节：

```text
Occupancy = 5
Capacity = 5
```

则：

```text
第一节.CanAccept = false
第一节.State = Full
```

第二节：

```text
第二节.CanRelease = false
```

第二节最靠近第一节、准备进入第一节的托盘：

```text
Status = Waiting
Reason = DOWNSTREAM_FULL
```

---

# 11. 第二节不是整体冻结

第一节满位后：

```text
第二节.CanRelease = false
```

只表示：

> 第二节不能继续向第一节出料。

如果第二节：

```text
Capacity = 6
Occupancy = 4
```

仍然可以是：

```text
CanAccept = true
CanRelease = false
```

含义：

```text
还能存
但暂时不能往下游送
```

---

# 12. 上游阻塞传播

如果第一节长期满位：

```text
第一节 5 / 5
```

第二节逐渐达到：

```text
第二节 6 / 6
```

则：

```text
第二节.CanAccept = false
```

此时第三节：

```text
第三节.CanRelease = false
```

形成：

```text
第一节 Full
   ↓
第二节不能出料
   ↓
第二节 Full
   ↓
第三节不能出料
   ↓
第三节 Full
   ↓
继续向上游传播
```

这就是：

```text
Blocked Propagation
```

---

# 13. 自动恢复

第一节：

```text
5 / 5
```

下游取走一个：

```text
5 → 4
```

触发：

```text
SectionCapacityReleased
```

重新计算：

```text
第一节.CanAccept = true
```

第二节：

```text
CanRelease false → true
```

等待托盘：

```text
Waiting
↓
Reserve
↓
Resume
↓
进入第一节
```

不需要人工重新点击运行。

---

# 14. TwinSectionManager

建议新增：

```text
TwinSectionManager
```

负责：

```text
Section 注册
Capacity
Occupancy
Reserved
CanAccept
CanRelease
上下游关系
状态刷新
阻塞传播
自动恢复
```

---

# 15. TwinOccupancyManager

负责：

```text
Reserve
Enter
Leave
ReleaseReservation
Waiting
Resume
```

接口：

```ts
interface TwinOccupancyManager {

  canEnter(
    entityId: string,
    sectionId: string
  ): boolean;

  reserve(
    entityId: string,
    sectionId: string
  ): boolean;

  enter(
    entityId: string,
    sectionId: string
  ): void;

  leave(
    entityId: string,
    sectionId: string
  ): void;

  releaseReservation(
    entityId: string,
    sectionId: string
  ): void;
}
```

---

# 16. TwinEntity

托盘需要从普通 Three.js Object 升级成运行实体：

```ts
interface TwinEntity {

  id: string;

  type:
    | 'pallet'
    | 'agv'
    | 'material'
    | 'carrier';

  currentSectionId?: string;

  destinationSectionId?: string;

  status:
    | 'idle'
    | 'moving'
    | 'waiting'
    | 'blocked'
    | 'fault';

  waitingReason?:
    | 'DOWNSTREAM_FULL'
    | 'DOWNSTREAM_BLOCKED'
    | 'ROUTE_NOT_READY'
    | 'DIVERTER_NOT_READY'
    | 'RESERVATION_FAILED'
    | 'FAULT';

  routeDecision?: TwinRouteDecision;
}
```

---

# 17. 新增 TwinJunction

岔口正式定义为：

```text
TwinJunction
```

例如：

```text
                 ┌──→ Section-B
                 │
Section-A ──→ [J01]
                 │
                 └──→ Section-C
```

PLC 决定：

```text
当前托盘应该走 B 还是 C
```

---

# 18. TwinJunction 数据模型

建议：

```csharp
public class TwinJunction
{
    public string Id { get; set; }

    public string Name { get; set; }

    public string RoutePointId { get; set; }

    public TwinRouteDecisionMode DecisionMode { get; set; }

    /// <summary>
    /// PLC 路由结果绑定
    /// </summary>
    public string? RouteDecisionBindingId { get; set; }

    /// <summary>
    /// 分流机构实际位置 / 到位信号
    /// </summary>
    public string? PositionBindingId { get; set; }

    /// <summary>
    /// 托盘到达岔口信号
    /// </summary>
    public string? ArrivalBindingId { get; set; }

    public List<TwinRouteMapping> RouteMappings { get; set; }
}
```

---

# 19. 分流模式

```csharp
public enum TwinRouteDecisionMode
{
    Plc,
    Simulation,
    Manual
}
```

含义：

```text
PLC
→ 真实现场运行

Simulation
→ 没有 PLC 时的仿真

Manual
→ 调试时人工指定
```

---

# 20. PLC 路由映射

例如 PLC：

```text
DB10.RouteCode
```

约定：

```text
0 = 未决定
1 = 左线
2 = 右线
3 = NG线
```

映射：

```text
1 → Edge_Left
2 → Edge_Right
3 → Edge_NG
```

数据结构：

```csharp
public class TwinRouteMapping
{
    public string MatchValue { get; set; }

    public string EdgeId { get; set; }

    public string TargetSectionId { get; set; }
}
```

---

# 21. 岔口属性面板

选中岔口节点后：

```text
岔口属性

名称：
Junction01

分流模式：
[PLC ▼]

托盘到达信号：
[PLC.Sensor.J01]

分流结果：
[PLC.DB10.RouteCode]

分流机构到位：
[PLC.DB10.DiverterPosition]

────────────────

路由映射：

PLC值      目标路线       目标Section

1          左线           Section-B
2          右线           Section-C
3          NG线           Section-NG

[ + 添加映射 ]
```

---

# 22. PLC 决定“去哪”

IoTSharp 不应该在真实模式下自行猜测托盘方向。

例如：

```text
P001 到达 Junction01
```

PLC：

```text
RouteCode = 1
```

则：

```text
P001 → Left
```

IoTSharp 只负责执行和可视化。

---

# 23. RouteDecision 必须锁存到托盘

不能每一帧重新读取 PLC 值来改变已经开始运行的托盘。

错误情况：

```text
P001 到达
PLC = 1
→ P001 开始走左边

下一托盘 P002 到达前
PLC 改成 2

如果 P001 继续实时读取 PLC
→ P001 可能突然改走右边
```

因此每一个托盘必须锁存：

```text
TwinRouteDecision
```

---

# 24. TwinRouteDecision

```ts
interface TwinRouteDecision {

  junctionId: string;

  edgeId: string;

  targetSectionId: string;

  source:
    | 'plc'
    | 'simulation'
    | 'manual';

  rawValue:
    | string
    | number
    | boolean;

  locked: boolean;

  decidedAt: number;
}
```

示例：

```text
P001

Junction:
J01

PLC Value:
1

Target:
Edge_Left

TargetSection:
Section-B

Locked:
true
```

---

# 25. 路由决定生命周期

```text
托盘到达岔口前
↓
读取 PLC RouteCode
↓
查找 RouteMapping
↓
生成 TwinRouteDecision
↓
Locked = true
↓
托盘通过岔口
↓
进入目标 Section
↓
清除本次 Junction RouteDecision
```

---

# 26. PLC 路由与 Capacity 的职责边界

这是本方案最重要的规则之一。

## PLC

负责：

```text
托盘应该去哪
```

## IoTSharp Twin Runtime

负责：

```text
现在能不能去
```

例如：

```text
PLC RouteCode = Left
```

但是：

```text
左线 Section-B
Capacity = 5
Occupancy = 5
```

此时不能擅自改成右边。

正确行为：

```text
PLC 已决定左线
↓
RouteDecision Locked
↓
Section-B Full
↓
P001 Waiting
↓
等待 Section-B 释放容量
```

---

# 27. 左线满时的完整流程

```text
P001
↓
PLC RouteCode = 1
↓
映射 Edge_Left
↓
RouteDecision Locked
↓
检查 Section-B
↓
5 / 5
↓
CanAccept = false
↓
P001 Waiting
```

状态：

```text
Status:
Waiting

Reason:
TARGET_SECTION_FULL

Route:
Left

RouteDecision:
Locked
```

---

# 28. 目标段释放后自动继续

Section-B：

```text
5 / 5
```

有一个托盘离开：

```text
5 → 4
```

触发：

```text
SectionAvailable
```

然后：

```text
P001
↓
重新检查 Section-B
↓
CanAccept = true
↓
Reserve
↓
成功
↓
Resume
↓
继续沿 Edge_Left 行驶
```

路线不会重新选择。

---

# 29. 分流机构实际位置

建议不要只读取：

```text
RouteCode
```

最好同时读取：

```text
DiverterPosition
```

例如：

```text
RouteCode = 1
→ 当前托盘要求走左

DiverterPosition = 1
→ 分流机构实际已到左侧
```

只有：

```text
RouteDecision == DiverterPosition
```

才允许进入岔口。

---

# 30. 岔口等待条件

托盘到岔口后可能有三种主要等待原因：

```text
1. RouteCode 尚未产生
2. 分流机构尚未到位
3. 目标 Section 已满
```

因此状态：

```text
ROUTE_NOT_READY
DIVERTER_NOT_READY
TARGET_SECTION_FULL
```

应该分开记录。

---

# 31. 多路岔口

不限制左右两条。

例如：

```text
RouteCode

10 → 包装线A
20 → 包装线B
30 → 检测线
40 → NG线
50 → 人工处理
```

只需要配置：

```text
RouteMappings
```

即可支持 N 路分流。

---

# 32. 仿真模式

没有真实 PLC 时：

```text
DecisionMode = Simulation
```

可以使用：

- 固定方向
- 随机
- SKU
- 条码
- 托盘类型
- 绑定值
- 自定义规则

例如：

```text
SKU = A
→ 左线

SKU = B
→ 右线
```

这样离线也可以验证数字孪生运行逻辑。

---

# 33. 手动模式

调试时：

```text
DecisionMode = Manual
```

页面显示：

```text
[左线]
[右线]
[NG线]
```

人工点击后生成：

```text
TwinRouteDecision
```

运行流程与 PLC 模式保持一致。

---

# 34. TwinJunctionManager

建议新增：

```text
TwinJunctionManager
```

职责：

```text
Junction 注册
PLC RouteCode 读取
RouteMapping
RouteDecision 创建
RouteDecision 锁存
机构到位判断
目标 Section 判断
Decision 清理
```

---

# 35. 推荐 TwinRuntime 架构

```text
TwinRuntime
│
├── BindingEngine
│
├── RouteEngine
│
├── TwinEntityManager
│
├── TwinSectionManager
│
├── TwinOccupancyManager
│
├── TwinJunctionManager
│
├── TwinCollisionEngine
│
├── TwinEventBus
│
└── TwinPhysicsEngine
```

---

# 36. 各模块职责

```text
RouteEngine
→ 路径怎么走

TwinSectionManager
→ 这一节能不能接 / 能不能放

TwinOccupancyManager
→ 谁占了几个 / 谁预约了几个

TwinJunctionManager
→ 当前托盘应该走哪条路线

BindingEngine
→ PLC / IoT 数据怎么进入运行时

TwinCollisionEngine
→ 真正异常碰撞

TwinEventBus
→ 运行事件
```

---

# 37. 推荐运行事件

Section：

```text
SectionFull
SectionAvailable
SectionBlocked
SectionReleased
SectionReserved
SectionReservationReleased
```

Entity：

```text
EntityEnteredSection
EntityLeftSection
EntityWaiting
EntityResumed
```

Junction：

```text
RouteDecisionRequested
RouteDecisionReceived
RouteDecisionLocked
RouteDecisionReleased

DiverterWaiting
DiverterReady
```

阻塞：

```text
BlockedPropagationStarted
BlockedPropagationReleased
```

---

# 38. MCP Tool 建议

Section：

```text
twin_get_section

twin_get_section_capacity

twin_get_section_occupancy

twin_get_section_state

twin_get_blocked_sections
```

Entity：

```text
twin_get_entity

twin_get_waiting_entities

twin_get_entity_waiting_reason
```

Junction：

```text
twin_get_junction

twin_get_route_decision

twin_get_junction_route_mapping

twin_get_diverter_state
```

链路：

```text
twin_get_blocking_chain

twin_get_entity_route_trace
```

---

# 39. MCP 查询示例：为什么走左边

用户：

```text
P001 为什么走左边？
```

MCP 查询：

```text
P001.RouteDecision
Junction01.RouteMappings
```

AI：

```text
P001 到达 Junction01 时，
PLC RouteCode = 1。

Junction01 的映射规则为：

1 → LeftLine

因此 P001 的路线被锁定为左线。
```

---

# 40. MCP 查询示例：为什么不动

用户：

```text
P001 为什么停在岔口？
```

可能回答：

```text
P001 的 PLC 路由决定已经锁定为左线。

但左线 Section-B 当前容量为：

5 / 5

已满位。

因此 P001 当前状态为 Waiting，
等待 Section-B 释放容量后自动继续。
```

或者：

```text
P001 已被 PLC 指定走左线，
但当前 DiverterPosition 尚未到达 Left。

因此 P001 正等待分流机构到位。
```

---

# 41. MCP 查询示例：为什么上游也停

```text
为什么第四节也停了？
```

AI 可以沿阻塞链查询：

```text
Section01 5/5
↓
Section02 无法出料

Section02 6/6
↓
Section03 无法出料

Section03 满位
↓
Section04 无法继续出料
```

最终回答根因：

```text
第四节停止的根因是第一节下游容量未释放。
```

---

# 42. PLC / IoT Occupancy 模式

建议支持：

```text
Calculated
Simulation
Live
```

## Calculated

由：

```text
Reserve
Enter
Leave
```

自动计算。

## Simulation

纯数字孪生仿真。

## Live

读取 PLC / IoT 实时数量。

例如：

```json
{
  "sectionId": "section-01",
  "capacity": 5,
  "occupancyMode": "live",
  "occupancyBindingId": "PLC.DB10.Section01Count",
  "fullBindingId": "PLC.DB10.Section01Full"
}
```

---

# 43. 推荐 Manifest 结构（兼容现有场景合同）

## 43.1 唯一拓扑来源

当前 IoTSharp 已将每条路线的完整 JSON 保存到 SQL Server `TwinRoute.GraphPayload`，场景发布版本还保存不可变 Manifest。因此不应再在 Manifest 顶层增加一套与 `routes[].edges`、`routes[].points` 重复的 `sections`、`junctions` 拓扑。

本方案确定：

```text
routes[].edges[]  = TwinSection 的持久化定义
routes[].points[] = TwinJunction 的持久化定义
decisionRules[]   = RouteMappings
```

运行时的 Occupancy、Reserved、Waiting、RouteDecision 是实例状态，不属于场景草稿，不随每一帧写回 SQL Server。

旧场景继续使用 `iotsharp-twin-scene/v1`。加载时由 `normalizeTwinRoute` 补默认值；只有将来出现无法向后兼容的结构变化才升级 schemaVersion。

## 43.2 实际 `routes[]` 结构片段

以下省略场景的 `name`、`world`、`objects`、`bindings` 和 `runtime` 等既有字段：

```json
{
  "schemaVersion": "iotsharp-twin-scene/v1",
  "routes": [
    {
      "routeId": "packaging-line",
      "name": "包装分流线",
      "type": "conveyor",
      "curveKind": "line",
      "defaultSpeed": 1.2,
      "loop": false,
      "orientToPath": true,
      "routingMode": "automatic",
      "points": [
        {
          "pointId": "point-entry",
          "name": "入口",
          "kind": "buffer",
          "position": [0, 0.72, 0]
        },
        {
          "pointId": "point-j01",
          "name": "岔口01",
          "kind": "diverter",
          "position": [2, 0.72, 0],
          "decisionMode": "plc",
          "decisionTimeoutSeconds": 10,
          "actuatorBindingId": "binding-diverter-position",
          "sensorBindingId": "binding-junction-arrival"
        },
        {
          "pointId": "point-left-end",
          "name": "左线末端",
          "kind": "buffer",
          "position": [5, 0.72, -2]
        },
        {
          "pointId": "point-right-end",
          "name": "右线末端",
          "kind": "buffer",
          "position": [5, 0.72, 2]
        }
      ],
      "edges": [
        {
          "edgeId": "edge-entry",
          "fromPointId": "point-entry",
          "toPointId": "point-j01",
          "name": "入口缓存段",
          "bidirectional": false,
          "enabled": true,
          "capacity": 3,
          "occupancyMode": "calculated",
          "reservationTimeoutSeconds": 30
        },
        {
          "edgeId": "edge-left",
          "fromPointId": "point-j01",
          "toPointId": "point-left-end",
          "name": "左侧缓存段",
          "bidirectional": false,
          "enabled": true,
          "capacity": 5,
          "occupancyMode": "live",
          "reservationTimeoutSeconds": 30,
          "occupancyBindingId": "binding-left-count",
          "fullBindingId": "binding-left-full",
          "blockedBindingId": "binding-left-fault"
        },
        {
          "edgeId": "edge-right",
          "fromPointId": "point-j01",
          "toPointId": "point-right-end",
          "name": "右侧缓存段",
          "bidirectional": false,
          "enabled": true,
          "capacity": 6,
          "occupancyMode": "calculated",
          "reservationTimeoutSeconds": 30
        }
      ],
      "startPointId": "point-entry",
      "junctionDecisions": {
        "point-j01": "edge-left"
      },
      "decisionRules": [
        {
          "ruleId": "rule-left",
          "junctionPointId": "point-j01",
          "edgeId": "edge-left",
          "source": "binding",
          "bindingId": "binding-route-code",
          "operator": "equals",
          "matchValue": "1",
          "expectedActuatorValue": "Left",
          "priority": 100,
          "enabled": true
        },
        {
          "ruleId": "rule-right",
          "junctionPointId": "point-j01",
          "edgeId": "edge-right",
          "source": "binding",
          "bindingId": "binding-route-code",
          "operator": "equals",
          "matchValue": "2",
          "expectedActuatorValue": "Right",
          "priority": 100,
          "enabled": true
        }
      ]
    }
  ]
}
```

`edgeId` 同时作为默认 `sectionId`。如果将来一个物理 Section 必须横跨多条可视边，再新增显式 `sectionId` 聚合字段，但仍不复制上下游关系；关系永远由路线图推导。

---

# 44. 普通缓存与岔口的组合

最终完整场景：

```text
                   ┌→ Section-B Capacity=5
                   │
Section-A → Junction01
                   │
                   └→ Section-C Capacity=6
```

P001：

```text
PLC = Left
↓
锁定 Section-B
↓
Section-B = 5/5
↓
Waiting
```

P002：

```text
随后到达
↓
PLC = Right
↓
锁定 Section-C
↓
Section-C = 3/6
↓
Reserve 成功
↓
走右线
```

P001 不会因为 P002 的 PLC 值改变而改线。

---

# 45. 碰撞检测的新定位

普通缓存线、滚筒线、分段流转：

```text
不依赖几何碰撞停车
```

主要业务规则是：

```text
Capacity
Occupancy
Reservation
PLC Route Decision
Blocked Propagation
```

CollisionEngine 只用于：

```text
AGV ↔ AGV
AGV ↔ 设备
非法重叠
禁入区域
模型坐标异常
人工拖动穿模
```

---

# 46. 推荐开发优先级

| 优先级 | 功能 |
|---|---|
| P0 | TwinSection |
| P0 | Capacity |
| P0 | Occupancy |
| P0 | Reserved |
| P0 | CanAccept |
| P0 | CanRelease |
| P0 | 下游满位禁止出料 |
| P0 | 上游阻塞传播 |
| P0 | 自动恢复 |
| P0 | TwinJunction |
| P0 | PLC RouteDecision Binding |
| P0 | RouteMapping |
| P0 | 托盘 RouteDecision 锁存 |
| P1 | DiverterPosition 到位判断 |
| P1 | Simulation 分流 |
| P1 | Manual 分流 |
| P1 | MCP 堵塞原因 |
| P1 | MCP 分流原因 |
| P1 | PLC Occupancy / Full 联动 |
| P2 | 异常 Collision Detection |
| P3 | OBB |
| P3 | Cannon Physics |

---

# 47. 建议目录结构

```text
ClientApp/src/digital-twin/
│
├── runtime/
│   ├── TwinRuntime.ts
│   ├── TwinEntityManager.ts
│   ├── TwinSectionManager.ts
│   ├── TwinOccupancyManager.ts
│   ├── TwinJunctionManager.ts
│   ├── TwinCollisionEngine.ts
│   ├── TwinEventBus.ts
│   └── TwinPhysicsEngine.ts
│
├── routes/
│   └── RouteEngine.ts
│
├── bindings/
│   └── BindingEngine.ts
│
└── models/
    ├── TwinEntity.ts
    ├── TwinSection.ts
    ├── TwinJunction.ts
    ├── TwinRouteDecision.ts
    ├── TwinRouteMapping.ts
    └── TwinSectionState.ts
```

---

# 48. 最终运行逻辑

```text
托盘进入当前 Section
        ↓
接近 Junction
        ↓
读取 PLC RouteCode
        ↓
RouteMapping
        ↓
生成 RouteDecision
        ↓
锁定当前托盘路线
        ↓
检查 DiverterPosition
        ↓
检查目标 Section
        ↓
Capacity 是否可用？
        │
   ┌────┴────┐
   │         │
  Yes        No
   │         │
Reserve    Waiting
   │         │
进入岔口     等待容量释放
   │         │
进入目标段 ←─┘
   ↓
释放原 Section
   ↓
清除本次 Junction Decision
```

---

# 49. 最终职责划分

## PLC

负责：

```text
托盘应该往哪条线走
```

## IoTSharp Twin Runtime

负责：

```text
目标段现在有没有容量
目标段是否允许进入
当前是否需要 Waiting
什么时候 Resume
模型应该怎么运动
为什么当前停止
```

## MCP / AI

负责：

```text
查询
解释
诊断
追踪
```

例如：

```text
为什么走左边？
为什么停了？
哪一节满了？
阻塞是从哪里开始的？
什么时候能恢复？
```

---

# 50. 最终结论

IoTSharp 数字孪生运行层最终建议围绕：

```text
模型资源库
+
TwinSection
+
Capacity
+
Occupancy
+
Reserved
+
Blocked Propagation
+
TwinJunction
+
PLC Route Decision
+
RouteDecision Lock
+
Waiting
+
Automatic Resume
+
MCP
```

构建。

普通缓存线：

```text
Capacity 决定能不能进入
```

岔口：

```text
PLC 决定往哪里走
```

目标段：

```text
Capacity 决定现在能不能过去
```

如果目标段满：

```text
等待
```

而不是：

```text
数字孪生自己改道
```

如果目标段释放：

```text
自动 Resume
```

如果上游也逐渐满：

```text
Blocked Propagation
```

继续向更上游传播。

最终形成真正适合工业输送、WCS、PLC 联动场景的数字孪生运行模型。

---

# 51. 必须满足的运行不变量

以下规则不是界面提示，而是运行时必须保证的不变量：

```text
Occupancy >= 0
Reserved >= 0
Occupancy + Reserved <= Capacity
一个 Entity 在同一时刻最多处于一个当前 Section
一个 Entity 在同一 Junction 最多有一个有效 RouteDecision
进入目标 Section 成功后，才能释放源 Section
PLC 已锁存出口后，Capacity 变化只能 Waiting / Resume，不能改道
```

`Reserve`、`Enter`、`Leave` 必须由同一个同步临界区或服务端事务编排，不能由三个互不关联的异步 UI 调用拼接。重复的 Reserve / Enter / Leave 要按 `entityId + sectionId + operationId` 幂等处理。

Reservation 必须有租约：

```text
reservationTimeoutSeconds 默认 30 秒
```

租约到期而实体尚未进入时自动释放，并产生 `SectionReservationExpired`。进入 Live 段后，在 PLC Occupancy 回传确认之前，该实体继续占用 in-flight reservation，防止回传延迟造成超卖。

---

# 52. PLC 路由握手与实体关联

只读取一个全局 `RouteCode` 不足以支持连续托盘。必须能证明“这个值属于哪个托盘”，推荐 PLC 提供：

```text
EntityId / Barcode / CarrierId
RouteCode
RouteSequence
RouteValid
DiverterPosition
```

推荐握手：

```text
到达传感器上升沿
    ↓
读取 EntityId + RouteCode + RouteSequence + RouteValid
    ↓
同一采样快照内校验值稳定且 RouteSequence 未处理
    ↓
生成并锁存 TwinRouteDecision
    ↓
等待 DiverterPosition 和目标 Section
    ↓
实体进入目标段
    ↓
记录 RouteSequence 已完成
```

最低要求：

- `RouteSequence` 单调变化或每个实体唯一，避免旧 RouteCode 被下一托盘重复使用。
- RouteCode、EntityId、RouteSequence 必须来自同一设备快照；不能分别轮询后自行拼接。
- `RouteValid=false`、绑定 stale、未映射值或实体不一致时一律 `ROUTE_NOT_READY`，采用 fail-closed。
- 超时只报警，不允许回退到另一条可用线；改道必须由 PLC 产生新的、明确的决策序列。
- IoTSharp 若需要向 PLC 写 Ack，必须通过已有命令/任务执行链路，具备权限、审计、幂等键和反馈；浏览器不得直接写 PLC。

如果 PLC 暂时无法提供 EntityId，允许使用“到达传感器上升沿 + RouteSequence”关联，但这是降级方案，必须限制岔口一次只处理一个在途实体。

---

# 53. 权威来源与三种 Occupancy 模式

每个 Section 只能配置一个权威模式：

| 模式 | 权威来源 | 允许用途 | 重启恢复 |
|---|---|---|---|
| Calculated | Twin Runtime 的 Enter / Leave | 服务端仿真、确定性回放 | 从事件/快照恢复 |
| Simulation | 编辑器仿真器 | 离线设计验证 | 可重置 |
| Live | PLC / IoT Occupancy / Full | 生产只读映射 | 重新读取设备快照 |

禁止把 Live 计数与 Calculated 计数直接相加。Live 模式下本地 Reservation 只覆盖“已准入但 PLC 尚未确认”的短窗口，设备快照确认后必须消除对应 in-flight reservation。

当 `occupancyBindingId` 与 `fullBindingId` 冲突时，安全优先级为：

```text
stale / fault / blocked > fullBinding=true > occupancy >= capacity > available
```

冲突持续超过配置阈值时产生数据质量告警，MCP 回答必须同时给出原始信号和采用的安全结论。

---

# 54. 阻塞传播、汇流公平性与死锁

阻塞传播不能简单地把所有上游 Section 一次性标为 Blocked。正确语义是：

1. 目标段不可接收时，最前实体在边界 Waiting。
2. 当前段内部其他实体仍可在安全范围内移动。
3. 当前段逐渐满位后，才使它的上游实体无法进入。
4. 这个事实沿实际等待实体链逐级传播。

因此 `BlockedPropagation` 是从 Entity Waiting 关系推导的诊断链，不是永久写入每个 Edge 的布尔开关。

Merger 需要独立仲裁，至少提供：

- FIFO（按到达时间）
- RoundRobin（多支路轮询）
- PriorityWithAging（优先级 + 防饥饿老化）

两个以上实体互相持有当前段并等待对方目标段时形成环形等待。运行时应检测阻塞图中的环，产生 `DEADLOCK_DETECTED`，停止自动放行并交给 PLC/WCS 或人工处置；不得由数字孪生擅自释放真实占用。

---

# 55. 持久化、运行态投影与 MCP 前置条件

## 55.1 SQL Server 持久化边界

写入数据库：

```text
DigitalTwinScene.DraftPayload
DigitalTwinSceneVersion.Manifest
TwinRoute.GraphPayload
TwinObjectBinding
模型资源和发布版本
```

这些数据包含 Capacity、OccupancyMode、BindingId、ReservationTimeout、DecisionMode、RouteMappings 等配置。

不按帧写入数据库：

```text
模型坐标插值
实时 Occupancy
Reserved
Waiting
活动 RouteDecision
```

生产运行态建议放在服务端内存状态存储；多实例部署使用带租约/原子操作的分布式状态存储。SQL Server 仅按周期保存诊断快照和关键事件，不能作为 30 FPS 动画状态总线。

## 55.2 MCP 不能直接查询浏览器内存

当前 `TwinRuntime` 在浏览器内运行，后端 MCP 无法可靠读取某个用户标签页中的 Section/Entity 状态。因此 `twin_get_blocked_sections` 等工具上线前必须先完成以下二选一：

1. 推荐：服务端成为权威 Material Flow Runtime，前端只订阅状态并渲染。
2. 过渡：浏览器按 `sceneId + runtimeInstanceId + revision` 上报有 TTL 的只读运行快照，后端明确标记它为 simulation/non-authoritative。

MCP Tool 读取统一诊断投影：

```json
{
  "sceneId": "...",
  "runtimeInstanceId": "...",
  "manifestRevision": 12,
  "authority": "live|simulation",
  "capturedAt": "...",
  "sections": [],
  "entities": [],
  "junctions": [],
  "events": []
}
```

所有 MCP 查询必须校验租户、客户、场景权限，并返回 `capturedAt`、stale 状态和 authority。AI 只能查询、解释、诊断；不能绕过 IoTSharp 命令权限直接控制 PLC。

---

# 56. 重启、断线和配置切换

- 发布新 Manifest 时，运行实例必须固定旧 `manifestRevision` 直至安全停机或显式迁移，不能让在途实体中途切图。
- 浏览器刷新不代表物理托盘消失；Live 模式重连后先读取完整设备快照，再恢复渲染。
- PLC 绑定 stale 时保持已锁存 RouteDecision，但禁止进入受影响目标段；信号恢复并通过新鲜度校验后自动 Resume。
- 删除 Edge、Point 或 Binding 前必须检查是否存在活动 Entity、Reservation 或 Decision；生产实例存在引用时拒绝删除。
- 手动 Reset 只允许清空 Simulation 状态。Live 状态必须由设备快照重新对账，不能由前端按钮归零。

---

# 57. 验收测试矩阵

| 场景 | 期望结果 |
|---|---|
| 两个实体同时争抢最后一个空位 | 只有一个 Reserve 成功，另一个 Waiting |
| PLC=Left 且左线满、右线空 | 实体等待左线，不改走右线 |
| 等待期间 PLC 全局值变为 Right | 已锁存实体仍等待 Left；下一实体可锁存 Right |
| 左线释放一个位置 | 原等待实体自动 Resume，并原子转移 Section |
| DiverterPosition 未到位 | `DIVERTER_NOT_READY`，不消耗目标段 Occupancy |
| Occupancy/Full 信号 stale | fail-closed，状态为 `TARGET_SECTION_SIGNAL_STALE` |
| Reservation 超时 | 自动释放，记录 Expired 事件，可再次预占 |
| 重复 Enter / Leave 消息 | 幂等，Occupancy 不重复加减 |
| 汇流支路持续高优先级 | 低优先级通过 aging 最终获得放行，不能永久饥饿 |
| 阻塞图出现环 | 产生 Deadlock 告警，不擅自修改 PLC 路由或占用 |
| 发布新版本时仍有在途实体 | 旧实例保持旧 revision，拒绝热切换拓扑 |
| MCP 查询浏览器仿真 | 返回 simulation authority 和快照时间，不冒充生产实时状态 |

---

# 58. 2026-08-27 落地状态

本次审查已落地：

- `routes[].edges[]` 扩展 OccupancyMode、Full Binding、Reservation 租约，继续随 `TwinRoute.GraphPayload` 入 SQL Server。
- `routes[].points[]` 扩展 PLC / Simulation / Manual 决策模式和等待告警时间。
- RouteMapping 扩展机构到位期望值。
- 前后端 Manifest 校验同步支持新增字段，旧 v1 场景由 normalize 补默认值。
- `TwinMaterialFlowRuntime` 已提供 Section、Entity、Junction、Reservation、原子转移、事件和阻塞链核心管理器。
- `RouteEngine` 已改为锁定当前路径；动态满位/封锁只在分段边界 Waiting，解除后自动 Resume，不再因 Capacity 擅自改道。

仍需后续独立实施：

- 多实体 Three.js 实例池与传感器驱动的逐实体坐标推进。
- 服务端权威运行实例、分布式状态和运行态诊断投影。
- 内置只读 MCP twin 工具及其租户权限测试。
- PLC RouteSequence/Ack 的具体点位合同和端到端联调。
- Merger 公平仲裁、死锁检测和生产级故障演练。
