# IoTSharp 3D 场景设计器双路线建设与统一 RouteGraph 详细设计方案 V1

> 文档目标：在完全保留 IoTSharp 现有 3D 场景设计器、组件设计器、组件端口、internalFlows、路线运行时、托盘数组、PLC 遥测绑定、Behavior、Action Flow、发布/回滚等既有能力的前提下，将当前“主要依赖组件自动生成路线”的设计方式升级为“组件自带路线 + 自由编辑路线”双建设模式，并通过统一 RouteCompiler 编译成一套标准 Route Graph，最终仍由现有 RouteEngine / RouteSlotArrayRuntime / PLC 联动运行时执行。
>
> 本文特别针对复杂工业包装线场景设计：双排小辊道、机器人上料、旋转台、外检机、套袋机、分流、合流、空托独立回流、桁架抓取、U 型回路、长距离跨组件连接等。
>
> 核心原则：**路线有两种设计来源，但运行时永远只有一套路由模型。**

---

# 1. 背景与当前问题

当前 IoTSharp 3D 场景设计器已经具备以下基础能力：

- 组件模型库；
- 组件端口 Port；
- 组件内部 internalFlows；
- 组件自动生成 Route；
- Component Connection；
- RoutePoint / RouteEdge；
- RouteEngine；
- RouteSlotArrayRuntime；
- 小托盘 / 木托 / 纸箱等运输单元；
- PLC / Telemetry Binding；
- ReleasePermit / Ready / Blocked / Full 等路线联锁；
- 组件吸附；
- 路线自动连接；
- 一分二、二合一、直角汇流等复杂输送组件；
- 场景发布与运行时；
- Behavior / Action Flow 动作编排。

这些能力已经足以覆盖大多数标准输送段。

但是当前路线建设方式仍偏向：

```text
摆放一个输送组件
    ↓
组件提供 Port + internalFlows
    ↓
自动生成 Route
    ↓
组件之间端口连接
    ↓
Route 自动连通
```

对于标准直线辊道、双排辊道、弯道、提升机、链条机、RGV 等，这种方式很好用。

问题出现在复杂区域。

例如用户当前包装线中存在：

- 外检后的独立空托回流；
- 外检有料托继续进入套袋；
- A/B 双套袋环路；
- 多段 U 型回流；
- 机器人后双排合流；
- 桁架前后复杂回流；
- 空托回流经过多个物理辊道但逻辑上仍是一条路线；
- 同一物理组件可能承载多个逻辑方向；
- 路线需要跨越多个组件；
- 某些位置只想调整物流路径，不想修改物理辊道模型。

如果所有路径都必须依赖组件 internalFlows 自动生成，就会出现：

1. 为了改路线，被迫修改物理组件；
2. 为了多拐一个弯，被迫增加很多专用组件；
3. 复杂回流需要不断增加特殊 merger/diverter；
4. 一个普通辊道可能被迫承担本不属于它的“逻辑汇流”；
5. 组件移动与路线调整纠缠在一起；
6. 容易出现两个 Connection 抢同一个 input；
7. 场景拓扑越来越难维护；
8. Runtime 逻辑和物理建模耦合。

因此需要把“物理输送设备”和“物流路线”正式解耦。

---

# 2. V1 总体目标

V1 的目标不是推翻现有 Route，而是在现有架构上增加第二种路线创作方式。

最终设计为：

```text
┌─────────────────────────┐
│       路线设计来源       │
├─────────────────────────┤
│ ① Component Generated   │
│    Port + internalFlows │
│                         │
│ ② Manual Route Editor   │
│    RoutePoint + Edge    │
└────────────┬────────────┘
             │
             ▼
      Route Authoring Layer
             │
             ▼
         RouteCompiler
             │
             ▼
       Unified Route Graph
             │
      ┌──────┼─────────┐
      ▼      ▼         ▼
 RouteEngine SlotRuntime PLC Binding
```

必须满足：

- 组件路线继续存在；
- 手工路线可以独立存在；
- 二者可以连接；
- 二者可以组成同一个 Route；
- Runtime 不区分二者来源；
- 现有 PLC Binding 不需要重做；
- 现有托盘运行逻辑不需要重做；
- 现有场景发布格式保持向后兼容；
- 旧场景自动迁移；
- 设计器允许复杂线路像 CAD 一样编辑。

---

# 3. 最重要的架构原则

## 3.1 物理组件不等于物流路线

以后明确：

```text
Component = 物理设备
Route     = 物流逻辑
```

例如一个普通辊道：

```text
物理对象：Conveyor-01
```

它可以提供：

```text
input
output
internalFlow: input -> output
```

但物流路线可能是：

```text
外检空托回流路线
    ├─ Conveyor-01
    ├─ Conveyor-02
    ├─ 手工路线段
    ├─ Merger
    └─ Conveyor-03
```

因此：

> 组件只提供“可连接能力”和“推荐内部路径”，Route 才是物流网络本体。

---

## 3.2 两种路线创作来源，统一运行时

禁止出现：

```text
ComponentRouteEngine
ManualRouteEngine
```

两个 Runtime。

正确结构必须是：

```text
Component internalFlows ─┐
                         ├── RouteCompiler ── Unified Graph
Manual Route ────────────┘
```

统一 Graph 仍使用当前：

- TwinRouteDefinition；
- TwinRoutePointDefinition；
- TwinRouteEdgeDefinition；
- RouteEngine；
- RouteSlotArrayRuntime。

---

## 3.3 手工路线不是“另一种模型”，只是另一种 Authoring Source

运行时 Edge 仍然是 Edge。

只是设计期增加来源元数据：

```ts
interface TwinRouteAuthoringInfo {
  mode: 'generated' | 'manual';
  sourceObjectId?: string;
  sourcePortId?: string;
  sourceInternalFlowId?: string;
  detachedFromGenerated?: boolean;
}
```

运行时可以忽略这些字段。

---

# 4. 路线建设模式设计

3D 场景设计器新增“路线建设模式”。

建议不是简单二选一，而是三种模式：

```text
自动路线
编辑路线
混合路线（默认）
```

## 4.1 自动路线

适用：

- 标准直线辊道；
- 双排直线辊道；
- 普通弯道；
- 单一一分二；
- 单一二合一；
- RGV；
- 链条机；
- 提升机；
- 规则固定的设备内部流道。

行为：

```text
组件拖入
  ↓
读取 Port
  ↓
读取 internalFlows
  ↓
生成 RoutePoint / Edge
  ↓
组件移动时 Route 自动更新
```

此模式下自动 Edge 默认锁定编辑。

如果用户尝试拖动中间节点：

```text
提示：该路线由组件生成。
[转换为编辑路线] [取消]
```

---

## 4.2 编辑路线

适用：

- 空托独立回流；
- 跨多个组件的长路线；
- U 型回路；
- 多转角区域；
- 外检后复杂分流；
- 套袋 A/B 大环路；
- 桁架前后回流；
- 非标准现场布局。

用户可以直接在场景中：

```text
点击 → 点击 → 点击 → 点击
```

形成：

```text
●────────●
         │
         │
         ●────────●
```

生成普通 RoutePoint / RouteEdge。

---

## 4.3 混合路线

这是默认模式。

原则：

```text
标准区域 → 自动路线
复杂区域 → 手工路线
```

二者可以在 Port 处连接。

这最适合当前包装线。

---

# 5. 当前包装线推荐划分方式

针对用户提供的红色物流路径图，建议如下。

## 5.1 机器人下方双排长直线

建议：组件自动路线。

原因：

- 两排平行；
- 间距固定；
- 路径简单；
- 组件移动时路线应同步移动。

```text
A lane ───────────────────────
B lane ───────────────────────
```

---

## 5.2 机器人后双排二合一

建议：标准“二合一组件 + internalFlows”。

```text
A ────┐
      ├──── output
B ────┘
```

不要再通过两条 Connection 同时接普通辊道 input。

---

## 5.3 外检前长距离输送

标准直线段使用组件自动路线。

---

## 5.4 外检机内部

使用 Component internalFlows。

外检组件可以定义：

```text
input
output-loaded
output-empty
```

或者：

```text
input
output
```

然后由外部 Diverter/Route Rule 判断。

具体取决于外检机实际机械结构。

---

## 5.5 外检后空托独立回流

这是手工路线重点区域。

推荐：

```text
外检 Empty Output
       ↓
Manual Route
       ↓
独立空托回流
       ↓
桁架后公共回流
       ↓
机器人入口
```

不要强迫所有折线都由专用辊道组件 internalFlows 描述。

---

## 5.6 套袋 A/B 环路

建议：

- 机器内部路径：internalFlows；
- 机器之间的大范围环路：Manual Route；
- 入口/出口吸附到设备 Port。

---

## 5.7 桁架区域

建议：

```text
输送组件内部 → 自动 Route
桁架后空托公共回流 → Manual Route
```

这样桁架动作和输送 Route 不强耦合。

---

# 6. 数据模型修改建议

## 6.1 RoutePoint 增加 Authoring Metadata

建议：

```ts
export interface TwinRoutePointAuthoringDefinition {
  mode: 'generated' | 'manual';
  sourceObjectId?: string;
  sourcePortId?: string;
  generatedKey?: string;
  locked?: boolean;
}
```

RoutePoint：

```ts
export interface TwinRoutePointDefinition {
  pointId: string;
  position: TwinVector3;
  // existing fields...
  authoring?: TwinRoutePointAuthoringDefinition;
}
```

---

## 6.2 RouteEdge 增加 Authoring Metadata

```ts
export interface TwinRouteEdgeAuthoringDefinition {
  mode: 'generated' | 'manual';
  sourceObjectId?: string;
  sourceInternalFlowId?: string;
  generatedKey?: string;
  locked?: boolean;
  convertedFromGenerated?: boolean;
}
```

运行时不依赖该字段。

---

## 6.3 Port Attachment

手工 Route 端点可以吸附组件 Port。

建议增加：

```ts
interface TwinRouteEndpointAttachment {
  objectId: string;
  portId: string;
  role: 'entry' | 'exit';
  snapMode: 'hard' | 'soft';
}
```

RoutePoint：

```text
manual point
   ↓
attachedToPort
```

组件移动时：

- hard：端点严格跟随 Port；
- soft：只在重新吸附时更新。

V1 建议只实现 hard。

---

# 7. 自动路线生成规则

现有组件路线生成继续保留。

建议 RouteCompiler 明确生成步骤：

```text
Component
   ↓
resolveComponentPorts()
   ↓
internalFlows
   ↓
generated points
   ↓
generated edges
```

生成 ID 必须稳定。

例如：

```text
route-point:{objectId}:{portId}
route-edge:{objectId}:{internalFlowId}
```

禁止每次刷新随机生成，否则：

- Binding 会丢；
- PLC Edge 绑定会失效；
- Action Flow 引用会失效；
- RouteSection 会变化。

---

# 8. 手工路线编辑器设计

## 8.1 工具栏

建议新增：

```text
选择
画路线
增加节点
删除节点
拆分
合并
反向
直角
圆角
设置方向
吸附端口
断开端口
转为编辑路线
重新自动生成
显示方向
显示端口
路线校验
```

---

## 8.2 画路线

用户点击“画路线”后：

```text
第一次点击：创建 start point
第二次点击：创建 edge
第三次点击：继续 edge
...
双击/Enter：结束
Esc：取消
```

---

## 8.3 Shift / Ctrl 辅助

建议：

- Shift：锁定水平/垂直；
- Ctrl：临时关闭吸附；
- Alt：快速插入节点；
- Delete：删除选中节点/边。

---

## 8.4 直角模式

工业输送线大量是 90°。

建议默认提供：

```text
路线转角方式：
○ 自由
● 正交
○ 自动
```

正交模式：

```text
A ●─────────┐
            │
            ● B
```

系统自动选择 X/Z 中间拐点。

---

## 8.5 圆角模式

视觉显示可圆角。

但是底层 Graph 仍建议使用折线点。

```text
物理逻辑：Point A → Corner → Point B
渲染显示：圆角曲线
```

不要让曲线采样影响逻辑距离。

---

# 9. 端口吸附设计

## 9.1 规则

Route Endpoint 可以吸附：

```text
input
output
branch
merge
```

兼容规则：

```text
Route Exit  → Component Input
Component Output → Route Entry
```

---

## 9.2 自动吸附

当手工 RoutePoint 距 Port 小于：

```text
snapDistance
```

并且方向匹配：

```text
angleTolerance
```

则显示：

```text
绿色高亮
“吸附到：外检机.EmptyOutput”
```

松开后建立 Attachment。

---

## 9.3 Port 下拉选择

保留用户之前要求的“不只靠拖动吸附”。

右侧属性：

```text
端点连接
[选择组件 ▼]
[选择端口 ▼]
[自动吸附]
```

这样复杂场景可以精准连接。

---

# 10. 组件路线转为编辑路线

这是本方案的关键功能。

右键 Generated Route：

```text
转换为编辑路线
```

执行：

1. 克隆当前 generated Point；
2. 克隆当前 generated Edge；
3. 保持原 position；
4. 保持原方向；
5. 保持绑定；
6. authoring.mode 改为 manual；
7. convertedFromGenerated=true；
8. 解除组件自动更新。

转换后：

```text
组件移动 ≠ 整条 Route 跟随
```

只有吸附到该组件 Port 的 Endpoint 跟随。

---

# 11. 转换后的组件移动规则

例如：

```text
Manual Route
●────────────●
             ↑
        Conveyor.Output
```

Conveyor 向右移动 1m：

```text
最后一个 Point 跟随 Output
前面的手工节点不动
```

避免整条复杂路线变形。

---

# 12. 自动路线与手工路线连接

组合关系必须支持：

```text
Generated → Generated
Generated → Manual
Manual → Generated
Manual → Manual
```

最终 RouteCompiler 将它们全部编译为标准 Edge。

---

# 13. RouteCompiler 设计

建议新增独立层：

```text
RouteAuthoringCompiler
```

职责：

1. 读取组件自动路线；
2. 读取手工路线；
3. 解析 Port Attachment；
4. 合并重复端点；
5. 生成统一 Graph；
6. 校验方向；
7. 校验孤立边；
8. 校验重复连接；
9. 校验循环；
10. 生成 Runtime RouteDefinition。

---

## 13.1 编译阶段

```text
Stage 1: Component Route Extraction
Stage 2: Manual Route Extraction
Stage 3: Endpoint Attachment Resolution
Stage 4: Graph Merge
Stage 5: Connectivity Validation
Stage 6: Direction Validation
Stage 7: Runtime Normalization
```

---

# 14. Graph 合并规则

## 14.1 Port Point 归一化

如果：

```text
GeneratedPoint = Conveyor.Output
ManualPoint attached to Conveyor.Output
```

编译时不能变成两个 Runtime Point。

应该合并为一个逻辑 Point。

---

## 14.2 重复 Edge

如果两条来源生成相同：

```text
fromPointId
→ toPointId
```

必须报错或去重。

默认建议报错，避免静默产生错误拓扑。

---

# 15. 方向系统

RouteEdge 必须明确：

```text
from → to
```

设计器增加方向箭头。

建议三个显示级别：

```text
隐藏
选中显示
全部显示
```

复杂现场建议默认“全部显示”。

---

# 16. 反向功能

选中 Route：

```text
反向
```

执行：

- Edge from/to 交换；
- 箭头反向；
- Port Attachment entry/exit 重新校验；
- 与单向设备冲突时禁止。

---

# 17. RouteSection 设计

复杂路线应该允许用户将多个 Edge 组合为一个语义 Section。

例如：

```text
Section: EmptyReturnAfterInspection
Section: BaggingA
Section: BaggingB
Section: RobotLoadingA
Section: RobotLoadingB
Section: GantryEmptyReturn
```

这非常重要，因为 PLC 常常不是按每根辊道控制，而是按工艺区段控制。

---

# 18. PLC Binding 不重做

当前已有：

```text
ReleasePermit
Ready
Blocked
Full
Occupancy
```

继续绑定 Runtime Edge / Section。

建议将 Binding 优先绑定到语义 Section，而不是每个物理小 Edge。

例如：

```text
RobotCross.A.ReleasePermit
```

对应：

```text
Section: RobotCross-A
```

然后 RouteCompiler 将该状态传播到区段中的 Edge。

---

# 19. 托盘数组继续复用

当前小托盘实时初始化：

```text
PLC JSON / Int16 array
```

例如：

```text
[12, 23, 0, 0, 0, 0]
```

仍由 RouteSlotArrayRuntime 使用。

双路线建设不改变该机制。

只需要保证最终 Runtime Route 的 Edge IDs / Section IDs 稳定。

---

# 20. Simulation / Live 规则

## Simulation

Route Graph 使用模拟参数。

例如：

```text
模拟托盘数量
6:6 权重
自动 Release
```

## Live

使用：

```text
ReleasePermit
Ready
Blocked
Full
Occupancy
PLC pallet array
```

手工 Route 和组件 Route 在 Live 下行为完全一致。

---

# 21. 路线视觉层设计

新增路线显示层。

建议：

```text
☑ 显示物理设备
☑ 显示物流路线
☑ 显示方向箭头
☑ 显示 Port
☑ 显示 Section
☑ 显示实时状态
```

---

# 22. Runtime 路线颜色

建议：

```text
正常       绿色
占用       黄色
阻塞       红色
未就绪     橙色
禁用       灰色
缺失遥测   紫灰
选中       蓝色
```

注意：

运行态颜色属于 Route Overlay，不直接修改物理辊道材质。

---

# 23. 设计态与运行态严格分离

编辑态：

```text
可以拖 Point
可以改 Edge
可以吸附 Port
可以转换路线
```

运行态：

```text
禁止拖路线
只显示状态
点击查看属性
```

保持用户之前要求的只读发布运行时。

---

# 24. 路线属性面板

选中 RoutePoint：

```text
名称
位置 X/Y/Z
作者模式 generated/manual
吸附对象
吸附 Port
高度锁定
Section
```

选中 Edge：

```text
名称
方向
长度
速度限制
中心间距
Section
Conveyor Object
ReleasePermit Binding
Ready Binding
Blocked Binding
Full Binding
Occupancy Binding
```

---

# 25. 路线名称可编辑

路线节点和 Edge 必须支持用户命名。

例如：

```text
外检空托回流-01
套袋A入口
机器人A排
桁架空托合流
```

Runtime 点击时优先显示用户名称。

---

# 26. 路线分组

建议左侧“场景 / 路线”增加：

```text
路线
├─ 主小托盘闭环
│  ├─ 机器人上料 A
│  ├─ 机器人上料 B
│  ├─ 外检
│  ├─ 空托回流
│  ├─ 套袋 A
│  ├─ 套袋 B
│  └─ 桁架回流
└─ 木托包装线
```

---

# 27. 复杂分流设计

不要要求所有分流都由“一个特殊 Route 组件”承担。

正确结构：

```text
Diverter Component
      ↓
提供 Port / internalFlow
      ↓
Manual / Generated Route
```

例如外检后：

```text
                 ┌→ EmptyReturn
Inspection Out ──┤
                 └→ LoadedToBagging
```

Route Rule 决定走哪一条 Edge。

---

# 28. 复杂合流设计

如果现场存在真正物理合流器：

```text
使用 Merger Component
```

如果只是逻辑路线汇合到同一后续区段：

可以：

```text
Manual A ──┐
           ├─ MergePoint ── downstream
Manual B ──┘
```

但是必须有 MergePoint，禁止两个 Connection 同时占用同一个普通 input。

---

# 29. 同平面规则

用户之前要求：新加入的路线和辊道应保持同一水平面。

建议：

```text
RoutePlaneLock
```

默认：

```text
Y = 当前连接 Port 的世界 Y
```

正交绘制时新 Point 自动继承。

如需提升机：

用户显式切换“允许高度变化”。

---

# 30. 高度变化

手工路线可以：

```text
锁定 Y
```

或者：

```text
自由 Y
```

默认输送线锁定 Y。

提升机 / 斜坡才允许变化。

---

# 31. 自动描线功能

这是 V1 推荐增加的效率功能。

用户多选若干辊道：

```text
[沿组件生成路线]
```

系统：

1. 读取 Port；
2. 读取 internalFlows；
3. 根据 Connection 排序；
4. 生成完整 Route；
5. 用户可继续保持 generated；
6. 或转换为 manual。

---

# 32. 从物理辊道提取中心线

对于没有标准 internalFlows 的模型组件：

可支持用户指定：

```text
入口点
出口点
```

生成一条中心线。

V1 不做复杂 Mesh 自动识别。

---

# 33. 路线吸附到辊道中心线

拖 Manual Point 时，可以：

```text
吸附 Port
吸附 Route
吸附 Conveyor Centerline
```

建议优先级：

```text
Port > RoutePoint > Edge > Centerline > Grid
```

---

# 34. Edge 拆分

选中 Edge 双击：

```text
A────────────B
```

变：

```text
A────C────B
```

C 是新的 Manual Point。

Generated Edge 必须先转换。

---

# 35. Edge 合并

如果中间 Point：

- 只有 1 入；
- 只有 1 出；
- 没有 Binding；
- 没有 Attachment；
- 没有 Section 边界；

则允许合并。

---

# 36. 路线校验器

新增 Authoring Validator。

必须检测：

```text
孤立 Point
孤立 Edge
断开的 Endpoint
Port 重复占用
输入接输入
输出接输出
同一 input 被多个 Connection 占用
反向 Edge
无出口循环
重复 Edge
零长度 Edge
过短 Edge
自交
不合理陡坡
不同高度直接连接
```

---

# 37. Port 占用规则

默认：

```text
普通 input：最多 1 条外部进入连接
普通 output：最多 1 条外部离开连接
```

需要多路时必须通过：

```text
Diverter / Merger / Junction
```

或者显式声明 Port：

```text
allowMultipleConnections=true
```

---

# 38. 手工 MergePoint

如果不使用实体 Merger，可以提供逻辑节点：

```text
Route Junction
```

类型：

```text
merge
split
crossing
```

它不是 3D 设备，仅是 Route Graph 节点。

---

# 39. Crossing 与 Merge 区分

两个路线空间交叉不代表逻辑连接。

例如：

```text
─────
  │
  │
```

只有用户显式选择：

```text
连接为 Junction
```

才合并 Graph。

否则只是几何交叉。

这对机器人下方交叉区域非常重要。

---

# 40. 路线方向自动推断

如果起点吸附 Output，终点吸附 Input：

```text
自动方向 = Output → Input
```

如果两端都没有 Port：

采用用户绘制顺序。

---

# 41. Route ID 稳定性

生成路线 ID 必须稳定。

Manual Route 新建后 ID 永久保存。

不要保存时重新编号。

否则会破坏：

- PLC Binding；
- Action Flow；
- Simulation Config；
- Runtime Snapshot；
- 报警定位。

---

# 42. Section ID 稳定性

同样必须稳定。

用户改 Section Name 不改变 Section ID。

---

# 43. Component ID 稳定性

组件换名不改变 objectId。

Route Attachment 绑定 objectId + portId，不绑定显示名称。

---

# 44. Route Point 与 Component Transform

Generated RoutePoint：

```text
position = component.transform × port.localPosition
```

Manual Attachment Point：

同样计算。

Manual 普通 Point：

保存世界坐标。

---

# 45. 组件旋转

组件旋转后：

Generated Route 全部重新计算。

Manual Route：

仅 Attached Endpoint 跟随。

---

# 46. 组件缩放

对于参数化工业组件，优先通过 properties 调整尺寸。

不建议依赖 Three.js 非均匀 scale。

如果 scale 改变：

Port 世界坐标重新计算。

---

# 47. 删除组件

如果删除 Component：

Generated Route：

```text
随组件删除
```

Manual Attachment：

```text
Attachment 失效
RoutePoint 保留
标红诊断
```

不要自动删除整条手工路线。

---

# 48. 删除 Route

删除 Manual Route 不删除物理组件。

删除 Generated Route：

提示：

```text
自动路线不能直接删除。
可以：
1. 禁用组件路线
2. 转为编辑路线
```

---

# 49. 禁用组件 internalFlow

部分复杂组件可能有多个 internalFlow。

属性中允许：

```text
启用/禁用某个 internalFlow
```

用于非标准设备连接。

---

# 50. InternalFlow 与 RouteRule

internalFlow 只描述物理可能路径。

RouteRule 决定是否允许通过。

例如：

```text
input → outputA
input → outputB
```

两个都存在。

实际选择：

```text
SelectRoute / decisionRules
```

---

# 51. Manual Route 与 Action Flow

Action Flow 不直接控制路线几何。

它只引用：

```text
routeId
sectionId
edgeId
```

所以双路线建设对 Action Flow 完全透明。

---

# 52. Manual Route 与 Behavior

Behavior 同样不区分来源。

---

# 53. Manual Route 与 Telemetry

Binding 仍然：

```text
bindingId
→ route / section / edge
```

RouteCompiler 输出稳定 ID 即可。

---

# 54. Runtime Overlay

建议在运行态绘制细线覆盖层，而不是把辊道 Mesh 变色。

这样：

- 物理模型保持原材质；
- Route 状态独立；
- 诊断清晰。

---

# 55. 实时方向箭头

运输单元运行时可以显示：

```text
→ → → →
```

或者沿 Edge 动态流动纹理。

V1 只做静态箭头即可。

---

# 56. 路线速度显示

运行态点击 Edge：

```text
Section
当前占用
允许通过
速度
阻塞原因
PLC Ready
PLC Full
PLC Blocked
```

---

# 57. 设计器 UI 布局建议

左侧：

```text
场景树
路线树
模型库
```

中间：

```text
3D Scene
```

右侧：

```text
对象属性 / Route 属性 / Port 属性
```

顶部：

```text
选择 | 移动 | 旋转 | 缩放 | 画路线 | 节点 | 拆分 | 合并 | 方向 | 吸附
```

---

# 58. 路线模式切换

建议工具栏显示：

```text
路线：混合 ▼
```

下拉：

```text
自动路线
编辑路线
混合路线
```

默认：混合。

---

# 59. Route Layer

增加图层：

```text
Route Overlay
```

渲染优先级高于地面，但低于选中辅助框。

---

# 60. Route Z-Fighting

路线显示 Y 默认：

```text
Conveyor surface + 0.03m
```

避免和辊道表面闪烁。

---

# 61. 双排辊道支持

双排组件应该生成两套内部 Flow：

```text
input-a → output-a
input-b → output-b
```

禁止把双排简化成一条中心线。

---

# 62. 双排 2×6 上料区域

机器人上料区域路线应保持：

```text
A lane
B lane
```

独立 Edge / Section。

不能因为后面合流就共享历史 lane 标识。

---

# 63. Merge 后 lane 语义

合流以后：

```text
physicalLane
```

只能作为历史信息。

Runtime 当前 Edge 才是物理位置真值。

这一点必须保持当前 V18/V19 回归中已经验证过的规则。

---

# 64. Empty Return 语义

外检后的空托必须：

```text
有料 → 套袋/后续
空托 → 独立回流
```

这条独立回流可以使用 Manual Route。

但运行时仍是同一个 Route Graph。

---

# 65. 外检后独立空托支路

建议在 Route Tree 中作为明确 Section：

```text
EmptyReturnAfterInspection
```

这样 PLC、诊断和 UI 都能直接定位。

---

# 66. 桁架空托回流

桁架抓走丝锭以后的小托：

```text
进入 GantryEmptyReturn
```

然后和外检空托路线在后段合流。

不能在合流点形成方向对冲。

RouteCompiler 应检测：

```text
相邻 Edge 方向反转 > 150°
```

并发出 warning。

---

# 67. U 型路线

U 型本身合法。

但以下情况需要警告：

```text
Edge A → Point X
Edge B 从 Point X 向回接近 Edge A
```

如果中心间距小于运输单元碰撞安全距离，则提示潜在迎头冲突。

---

# 68. 几何冲突预检查

发布前可扫描：

- 平行逆向 Edge；
- 过近 Edge；
- 180° 回头；
- 合流口太短；
- 托盘安全间距不足。

但不要因此禁止所有复杂路线。

---

# 69. 路线编辑 Undo / Redo

所有 Route 操作必须进入现有 Workbench History：

```text
新增节点
移动节点
删除节点
拆分
合并
反向
吸附
转换为编辑路线
```

Ctrl+Z / Ctrl+Y 必须生效。

---

# 70. 多选路线

框选模式下支持：

```text
多个 RoutePoint
多个 Edge
```

一起移动。

但吸附 Endpoint 默认不允许整体脱离，除非按 Ctrl。

---

# 71. Route Group Move

如果选中一整段 Manual Route：

可以整体平移。

吸附端点：

```text
固定
```

或提示用户：

```text
是否解除端口吸附？
```

---

# 72. Route Lock

支持：

```text
锁定路线
```

防止误拖。

---

# 73. Route Visibility

可单独隐藏某条 Route。

不影响 Runtime Graph。

---

# 74. 设计辅助网格

Manual Route 编辑时建议网格：

```text
0.1m
0.25m
0.5m
1m
```

用户可切换。

---

# 75. 精确数值编辑

右侧属性直接输入：

```text
X
Y
Z
```

支持复制粘贴。

---

# 76. Route Distance

Runtime Edge 长度必须由最终世界坐标重新计算。

不要使用组件初始长度缓存。

---

# 77. Curved Display 与 Runtime Distance

如果圆角只用于显示：

Runtime 仍按照折线长度。

未来 V2 可以支持真实 Curve Length。

---

# 78. Route Speed Limit

Manual Edge 也可以有：

```text
speedLimit
```

自动 Edge 继承组件 conveyorSpeed。

---

# 79. Transport Unit Type 限制

Edge 可声明：

```text
allowedTransportUnitTypes
```

例如：

```text
小辊道 → plastic-pallet
大辊道 → wood-pallet / carton
```

继续防止小辊道出现纸箱。

---

# 80. Route Compatibility Validator

发布前：

```text
plastic-pallet route
```

如果连接到只允许 wood-pallet 的 Edge，报错。

---

# 81. 手工 Route 创建时类型继承

从一个小辊道 output 开始画：

默认继承：

```text
plastic-pallet
```

从大辊道开始：

继承：

```text
wood-pallet
```

---

# 82. Route Name 自动生成

默认：

```text
手工路线 1
手工路线 2
```

用户可以修改。

不要用 UUID 作为主要显示名称。

---

# 83. Port Name 显示

显示：

```text
组件名.PortName
```

例如：

```text
外检机.EmptyOutput
二合一.InputB
机器人底部双排.OutputA
```

---

# 84. Connection 与 Route Attachment 的关系

现有 ComponentConnection 继续用于物理组件连接。

Manual Route Attachment 是另一类关系。

不要把所有 Manual Route 连接都写成 ComponentConnection。

建议：

```text
Connection = Component ↔ Component
Attachment = RoutePoint ↔ Component Port
```

---

# 85. 两种关系的可视化

Component Connection：

```text
端口连线
```

Route Attachment：

```text
端点吸附标记
```

视觉上区分。

---

# 86. RouteCompiler 输入

建议：

```ts
compileRouteGraph({
  manifest,
  componentRoutes,
  manualRoutes,
  connections,
  attachments
})
```

---

# 87. RouteCompiler 输出

```ts
{
  routes: TwinRouteDefinition[],
  diagnostics: TwinRouteDiagnostic[],
  sourceMap: RouteSourceMap
}
```

SourceMap 用于点击 Runtime Edge 定位到：

```text
组件 internalFlow
或者
Manual Edge
```

---

# 88. SourceMap

建议：

```ts
interface RouteSourceMapEntry {
  runtimeEdgeId: string;
  authoringMode: 'generated' | 'manual';
  objectId?: string;
  internalFlowId?: string;
  manualEdgeId?: string;
}
```

---

# 89. 发布行为

保存草稿：

保存完整 Authoring 数据。

发布：

1. RouteCompiler；
2. Validate；
3. 固化 Unified Route Graph；
4. 保存 source map；
5. Runtime 使用发布后的 Graph。

---

# 90. 运行态不重新编译

发布运行态禁止临时根据 Component 重建 Route。

必须使用发布版本中的不可变 Graph。

避免组件库升级影响已发布场景。

---

# 91. 旧场景兼容

旧场景没有 authoring 字段：

自动视为：

```text
generated
```

如果 Edge 无法映射组件 internalFlow：

视为：

```text
manual
```

---

# 92. 旧 V19 场景迁移

迁移时：

1. 根据 objectId / nodePath / port 判断 generated；
2. 无对应来源的 Edge 标记 manual；
3. 不修改 Edge ID；
4. 不修改 Binding ID；
5. 不修改 PLC Section。

---

# 93. 现有功能必须保留

本功能不得破坏：

- 3D 模型库；
- 组件拖放；
- Scene Tree；
- 属性编辑；
- Transform Gizmo；
- 框选多选；
- Undo / Redo；
- 删除；
- Port 自动吸附；
- Component Designer；
- 组件预览；
- Component run；
- RouteSlotArrayRuntime；
- 小托盘；
- 木托；
- 纸箱；
- 托盘点击信息；
- PLC telemetry；
- Behavior；
- Action Flow；
- Simulation / Live；
- 发布；
- 回滚；
- Runtime 只读；
- 报警定位。

这是硬性兼容规则。

---

# 94. 目录结构建议

建议新增：

```text
ClientApp/src/digital-twin/routes/
├─ RouteAuthoringCompiler.ts
├─ RouteAuthoringValidator.ts
├─ RouteSourceMap.ts
├─ ManualRouteEditor.ts
├─ RouteSnapEngine.ts
├─ RouteOverlayRenderer.ts
└─ RouteAuthoringMigration.ts
```

现有：

```text
RouteEngine.ts
```

继续保留运行时职责。

---

# 95. contracts 建议修改

`contracts/index.ts` 增加：

```text
TwinRouteAuthoringMode
TwinRoutePointAuthoringDefinition
TwinRouteEdgeAuthoringDefinition
TwinRouteEndpointAttachment
TwinRouteSectionDefinition
```

保持字段 optional，确保旧 JSON 可读。

---

# 96. Workbench 修改

`workbench.vue` 增加：

```text
routeAuthoringMode
routeDrawingState
routeSelection
routeSnapSettings
routeOverlaySettings
```

---

# 97. ThreeJsEditorHost 修改

增加：

```text
RoutePoint helper
RouteEdge helper
Attachment helper
Direction arrow
Section label
```

不要把这些工具节点保存成普通业务 object。

---

# 98. Scene Tree 修改

路线树与对象树分开。

例如：

```text
场景
路线
模型库
```

保持当前用户要求的 Tab 结构。

---

# 99. Inspector 修改

根据 SelectionKind 显示：

```text
object
component-port
route-point
route-edge
route-section
```

---

# 100. 路线编辑状态机

建议：

```text
Idle
Drawing
MovingPoint
ConnectingPort
Splitting
MultiSelecting
```

禁止在多个编辑状态同时响应鼠标。

---

# 101. 与相机旋转冲突

当前默认左键拖动用于 3D 旋转。

路线编辑时：

```text
点击“画路线”按钮
```

才进入绘图。

退出后恢复相机控制。

符合当前框选模式设计原则。

---

# 102. 快捷键

建议：

```text
R  画路线
Esc 退出绘图
Enter 完成
Delete 删除
Ctrl+Z 撤销
Ctrl+Y 重做
Shift 正交
Ctrl 暂停吸附
```

---

# 103. 路线复制

Manual Route 支持复制。

但 Port Attachment 默认清除，避免复制后多个路线抢同一端口。

---

# 104. 路线镜像

V1 非必需。

后续可以支持 A/B 对称线快速镜像。

---

# 105. 设计器性能

大量 RouteEdge 不应每帧重建 Geometry。

仅在：

```text
节点移动
组件变换
路线改变
```

时更新。

---

# 106. Runtime 性能

Runtime 不读取 Authoring Editor 状态。

只使用 Unified Graph。

所以双路线建设不会增加运行时复杂度。

---

# 107. 路线安全距离

继续保留当前：

```text
小托盘中心距 >= 1.50m
```

路线编辑功能绝不能通过降低安全距离解决几何问题。

---

# 108. Route Geometry Check

Manual Route 保存时可提示：

```text
该合流段有效长度不足 1.50m × 队列数量
```

属于 warning，不一定禁止保存。

---

# 109. 托盘方向

Manual Route Edge 必须提供 tangent。

托盘 yaw 根据 tangent 计算。

弯道处平滑旋转。

---

# 110. 木托路线

同样支持 Manual Route。

但大辊道与小辊道必须通过 allowedTransportUnitTypes 校验隔离。

---

# 111. 纸箱路线

纸箱只能走大辊道/指定输送组件。

保持用户现有要求。

---

# 112. RGV 路线

RGV 更适合组件自动 Route。

轨迹由 RGV 组件自己定义。

不要让用户手画车体内部轨迹。

---

# 113. 机器人动作与 Route 解耦

机器人 Behavior / Action Flow 只关心：

```text
WorkPoint
MaterialSlot
Actuator
```

Route 只负责托盘送到正确位置。

双路线建设不会改变机器人动作结构。

---

# 114. 桁架动作与 Route 解耦

同理。

Route Section 提供：

```text
gantry-pick-ready
```

Behavior 读取工位到位状态。

---

# 115. Component Designer 职责

Component Designer 继续负责：

- 组件内部 Mesh；
- Port；
- internalFlows；
- actuator；
- tool frame；
- material slot；
- fixed machine animation。

不负责整条产线 Manual Route。

---

# 116. Scene Designer 职责

Scene Designer 负责：

- 摆组件；
- 组件连接；
- 复杂 Manual Route；
- 物流 Section；
- 跨组件动作编排；
- PLC Binding。

---

# 117. 路线调试模式

建议增加：

```text
路线调试
```

可以生成一个虚拟托盘沿选中 Route 运行。

用于验证：

- 方向；
- 拐角；
- 高度；
- 合流；
- 分流。

---

# 118. 单路线 Run

与 Component “run” 类似。

选中 Route：

```text
测试运行
```

虚拟托盘只在该 Route 上运行。

不启动整线。

---

# 119. 分流调试

可以手动选择：

```text
走 A
走 B
```

用于测试 Diverter。

---

# 120. 合流调试

生成 A/B 两个虚拟托盘，验证：

- 优先级；
- 互锁；
- 安全距离。

---

# 121. Live Route Debug

Live 状态下显示：

```text
ReleasePermit
Ready
Blocked
Full
```

但禁止用户修改物理 Route。

---

# 122. 发布校验

发布必须阻止：

- 断路；
- 重复 input；
- 非法方向；
- 找不到 Port；
- 找不到 Binding；
- 找不到 Section；
- 手工路线悬空且被主流程引用。

---

# 123. Warning 不阻止发布的情况

例如：

- 路线过近；
- 急转弯；
- Edge 很短；
- 大量 U 型折返。

由用户确认。

---

# 124. Runtime SourceMap 诊断

如果 Runtime 出现：

```text
Pallet blocked on edge X
```

UI 能定位到：

```text
手工路线：外检空托回流 / Edge 7
```

或者：

```text
组件：二合一 / internalFlow input-b-to-output
```

---

# 125. 数据保存格式

建议 SceneManifest 保存：

```text
objects
connections
routes
routeAuthoring
bindings
actuators
behaviors
actionFlows
```

如果不想新增顶层 `routeAuthoring`，也可以先把 authoring metadata 放在 point/edge。

V1 推荐先放 point/edge，减少 schema 扰动。

---

# 126. 数据库

如果当前数据库以 SceneManifest JSON 为主，V1 不强制新增独立 RouteAuthoring 表。

优先：

```text
随 SceneManifest 保存
```

后续如需多人协作再拆表。

---

# 127. 版本控制

发布版本必须保存完整 Manual Route。

回滚后路线恢复到当时版本。

---

# 128. 组件升级

如果组件 Resource Version 更新：

Generated Route 可以更新。

Manual Route 不自动重写。

Attachment Port 不存在时提示迁移。

---

# 129. Port Rename

Port ID 稳定时，改显示名不影响 Attachment。

---

# 130. Port 删除

Port 被删除：

Manual Attachment 进入 invalid 状态。

设计器标红。

---

# 131. 路线模板

后续可以增加：

```text
U 型回流
双排环线
矩形环线
空托回流
A/B 双环
```

但 V1 不是必须。

---

# 132. 当前红线路线的落地建议

按照用户提供图纸，建议先不一次重建整个场景。

按区域逐段迁移：

```text
Phase A
机器人底部双排：Generated

Phase B
外检输入：Generated

Phase C
外检后空托支路：Manual

Phase D
套袋 A/B：Manual + Component Port

Phase E
桁架后空托回流：Manual

Phase F
合流点：Merger/Junction
```

每个区域完成后单独 Run。

---

# 133. Phase 1 开发内容

目标：最小双路线能力。

实现：

1. RoutePoint authoring mode；
2. RouteEdge authoring mode；
3. 画路线；
4. RoutePoint 拖动；
5. 方向箭头；
6. Undo/Redo；
7. Manual Route 保存；
8. Runtime 正常读取。

---

# 134. Phase 1 验收

创建一个空白场景：

```text
Conveyor A
Manual Route
Conveyor B
```

要求：

```text
A.Output → Manual → B.Input
```

虚拟托盘能完整通过。

---

# 135. Phase 2 开发内容

端口吸附。

实现：

- 鼠标吸附；
- Port 下拉；
- Endpoint Attachment；
- 组件移动跟随；
- Component → Manual；
- Manual → Component。

---

# 136. Phase 2 验收

移动 Conveyor B 1m。

要求：

- Manual 最后端点跟随；
- 中间节点不动；
- Route 仍连通。

---

# 137. Phase 3 开发内容

Generated → Manual 转换。

实现：

```text
转换为编辑路线
```

---

# 138. Phase 3 验收

转换标准辊道 Route 后：

- 可以拖中间 Point；
- 组件移动只影响 Attached Endpoint；
- Binding 不丢；
- ID 不变化或有稳定迁移映射。

---

# 139. Phase 4 开发内容

RouteCompiler / Validator。

实现：

- Graph Merge；
- Endpoint Merge；
- 重复 input 检查；
- 方向检查；
- Section。

---

# 140. Phase 5 开发内容

复杂包装线迁移。

优先迁移：

```text
外检后空托独立回流
```

因为这一段最能体现 Manual Route 的价值。

---

# 141. Phase 5 验收

要求：

- 外检空托不进套袋；
- 空托走独立回流；
- 后段与桁架空托合流；
- 无迎头对冲；
- 中心距 >= 1.50m；
- 6 个尾批空托都能回机器人；
- 有料托盘仍正常进入桁架/后续。

---

# 142. Phase 6 开发内容

运行态 Route Overlay。

显示：

```text
Ready
Blocked
Full
Occupied
```

---

# 143. Phase 7 开发内容

路线单独 Run / 调试。

---

# 144. 需要修改的主要前端文件

预计：

```text
ClientApp/src/views/iot/digital-twin/workbench.vue
ClientApp/src/digital-twin/contracts/index.ts
ClientApp/src/digital-twin/routes/RouteEngine.ts
ClientApp/src/digital-twin/components/ThreeJsEditorHost.vue
ClientApp/src/digital-twin/components/ComponentConnectionEngine.ts
ClientApp/src/digital-twin/components/ComponentBindingResolver.ts
```

新增：

```text
RouteAuthoringCompiler.ts
RouteAuthoringValidator.ts
ManualRouteEditor.ts
RouteSnapEngine.ts
RouteOverlayRenderer.ts
RouteAuthoringMigration.ts
```

---

# 145. 后端修改范围

V1 后端改动应尽量少。

主要确认：

- SceneManifest 可以保存新增字段；
- 发布版本完整保存；
- 校验 DTO 不丢 authoring metadata；
- Snapshot 不需要改；
- Binding 不需要改。

---

# 146. SQL Server

继续只使用 SQL Server。

V1 不引入 SQLite。

如果 Manifest JSON 字段无需 schema change，则不新增迁移。

---

# 147. 测试体系

新增自动测试：

```text
manual-route-create
manual-route-save-load
manual-route-port-attach
manual-route-component-move
manual-route-generated-convert
route-compiler-merge
route-validator-duplicate-input
route-validator-direction
route-section-binding
```

---

# 148. 现有 V19 回归必须继续跑

不能因为双路线功能而删除/弱化：

```text
verify:v7-components
```

现有严格物理回归继续作为底线。

---

# 149. 回归重点

特别检查：

- 2×6 机器人夹具；
- 12 + 6 上料；
- 尾批 6 空位；
- 小托盘 >=1.50m；
- 外检空托独立回流；
- 桁架不抓空托；
- 48 锭木托；
- 隔板；
- 天盖；
- 缠膜；
- 贴标；
- 3 成品；
- PLC live interlock。

---

# 150. 发布前验收矩阵

| 场景 | Route 来源 | 必须通过 |
|---|---|---|
| 标准直线辊道 | Generated | 是 |
| 双排辊道 | Generated | 是 |
| Generated → Generated | 混合 | 是 |
| Generated → Manual | 混合 | 是 |
| Manual → Generated | 混合 | 是 |
| Manual → Manual | Manual | 是 |
| 空托回流 | Manual | 是 |
| A/B 环路 | Manual/Generated | 是 |
| Port 移动跟随 | Manual Attachment | 是 |
| 转为编辑路线 | Converted | 是 |
| PLC ReleasePermit | Unified Graph | 是 |
| PLC 托盘数组 | Unified Graph | 是 |

---

# 151. 不允许的实现方式

严禁：

1. 创建第二套 Route Runtime；
2. Manual Route 用完全不同的数据结构运行；
3. 为每个复杂拐角硬编码业务逻辑；
4. 为了路线问题降低 1.50m 安全距离；
5. 使用 pallet ID 特判；
6. 把外检空托再次接进错误 merger；
7. 让普通辊道 input 接多条 Connection；
8. 删除现有 Component Port/InternalFlow 能力；
9. 修改旧场景导致原 3D 功能消失；
10. 把路线编辑逻辑塞进 BehaviorRuntime。

---

# 152. 推荐的最终架构

```text
                       3D Scene Designer
                              │
             ┌────────────────┴────────────────┐
             │                                 │
             ▼                                 ▼
     Component Authoring                 Manual Route Authoring
             │                                 │
     Port + internalFlows              Point + Edge + Attachment
             │                                 │
             └────────────────┬────────────────┘
                              ▼
                    RouteAuthoringCompiler
                              │
                    Unified Route Graph
                              │
          ┌───────────────────┼────────────────────┐
          ▼                   ▼                    ▼
      RouteEngine       RouteSlotArrayRuntime   Route Overlay
          │                   │                    │
          └─────────────┬─────┘                    │
                        ▼                          │
                 Transport Units                  │
                        │                          │
               ┌────────┴────────┐                 │
               ▼                 ▼                 │
          Simulation           Live                │
               │                 │                 │
               │          PLC Telemetry            │
               │                 │                 │
               └────────┬────────┘                 │
                        ▼                          │
                  Runtime State ───────────────────┘
```

---

# 153. 最终用户体验

未来用户建设复杂产线的流程应该变成：

```text
1. 从模型库拖入物理组件
2. 标准辊道自动生成 Route
3. 自动吸附相邻 Port
4. 复杂区域点击“画路线”
5. 沿现场工艺方向绘制
6. Endpoint 吸附组件 Port
7. 必要时将某段自动 Route 转为编辑路线
8. 设置 Route Section
9. 绑定 PLC Ready / Blocked / Full / ReleasePermit
10. 点击“路线校验”
11. 单路线测试运行
12. 保存草稿
13. 发布
14. Runtime 使用统一 Route Graph
```

用户不再需要为了复杂物流路径去不断创造新的特殊辊道组件。

---

# 154. 对当前项目的直接价值

这个方案解决的是当前 IoTSharp 3D 场景设计器已经实际遇到的结构性问题，而不是单纯增加一个编辑工具。

它能够解决：

- 当前复杂空托回流难以完全用组件自动生成的问题；
- A/B 环路过度依赖特殊组件的问题；
- 组件连接与物流路线耦合的问题；
- 多条 Connection 抢一个 input 的问题；
- 修改物流路径必须修改物理模型的问题；
- 后续更多不同客户现场布局难以复用的问题。

同时保留当前最有价值的能力：

- 标准组件一拖即用；
- Port 自动吸附；
- internalFlows 自动生成；
- RouteEngine 统一运行；
- PLC 绑定统一运行；
- 托盘数组统一运行。

---

# 155. 开发优先级建议

建议按以下顺序实施：

```text
P0  Manual Route 基础数据模型
P0  画路线 / 拖节点
P0  Port Attachment
P0  RouteCompiler
P0  Route Validator
P1  Generated → Manual
P1  外检空托回流迁移
P1  Route Section
P1  Runtime Overlay
P2  自动描线
P2  单路线 Run
P2  高级圆角 / 模板 / 镜像
```

不要先做大量高级 UI，再补底层 Compiler。

---

# 156. V1 最小闭环标准

V1 只有满足以下条件才算完成：

1. 用户可以手动画一条路线；
2. 路线可以保存/加载；
3. Endpoint 可以吸附组件 Port；
4. 组件移动后 Attached Endpoint 跟随；
5. Generated 与 Manual 可以互连；
6. Runtime 使用统一 Route Graph；
7. 托盘可以跨 Generated + Manual Edge 连续运行；
8. PLC Binding 可以作用于 Manual Route；
9. 外检后的空托独立回流可以使用 Manual Route 实现；
10. 旧场景完全兼容；
11. 原 3D 场景设计器功能全部保留；
12. 完整 V19 回归不退化。

---

# 157. 结论

IoTSharp 3D 场景设计器后续不应该继续走“所有物流路线都必须依赖输送组件自动生成”的单一路线创作模式。

正确方向是：

```text
标准区域：组件自带路线
复杂区域：自由编辑路线
```

但二者不是两套 Runtime，而是：

```text
两种 Authoring Source
        ↓
统一 RouteCompiler
        ↓
统一 Route Graph
        ↓
统一 RouteEngine
```

这既保留了组件化快速建模的效率，又解决了复杂工业现场布局下路线难以表达的问题。

对于当前包装线，最适合先落地的 Manual Route 区域就是：

```text
外检后的独立空托回流
```

这一区域一旦用新的双路线体系真正跑通，就可以逐步迁移套袋 A/B 环路、桁架后回流以及其它复杂路径，而不需要继续通过增加特殊辊道组件或 Runtime 特判来修补拓扑。

该方案应作为后续 3D 场景设计器路线能力升级的正式 V1 架构基线。
