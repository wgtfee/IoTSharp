# IoTSharp 2D 数字孪生场景设计器详细设计 V1

## 1. 文档目标

本文面向当前 `H:\code\Industrial.Platform\IoTSharp-master` 项目，设计一套与现有 3D 数字孪生工作台能力等级一致、但页面与渲染实现完全独立的 2D 数字孪生场景设计器。

本方案遵循以下已经确定的原则：

1. 2D 与 3D 保持两个独立页面，不做同一页面内模式切换。
2. 2D 与 3D 共用数字孪生业务数据模型，但各自拥有独立编辑器和独立 Renderer。
3. 生产实时数据统一来源于 IoTSharp Telemetry，不引入 SignalR。
4. 2D 不是静态工艺图，而是完整的数字孪生设计器和运行态页面。
5. 2D 必须具备模型库、拖拽、选中、属性、设备绑定、状态动画、路线、碰撞/占用、草稿、校验、发布、版本、回滚等能力。
6. 2D 页面不直接控制 PLC，也不把前端动画状态当成设备真实状态；设备真实状态以 Telemetry 为准。
7. 2D 页面可以单独维护视觉布局，但不能产生一套与 3D 不一致的设备、路线和绑定业务模型。

---

## 2. 当前代码现状

当前 2D 入口：

```text
ClientApp/src/views/iot/digital-twin/2d-scene.vue
```

其主体实际位于：

```text
ClientApp/src/views/iot/digital-twin/yt-pack-2d/index.vue
```

当前 2D 已具备：

- SVG 场景展示
- `viewBox` 缩放
- 画布拖动
- Line1 / Line2 / Line3 工艺区域
- 小辊道、大辊道、机器人、旋转台、缓存区、桁架等 SVG 组件
- 点击设备弹窗
- 部分固定设备数据

但是当前模式仍然属于“固定产线 SVG 页面”，主要问题包括：

- 设备布局硬编码
- 设备列表硬编码
- 组件和实际 `TwinSceneManifest` 尚未统一
- 没有统一场景中心
- 没有场景新建/复制
- 没有通用 2D 模型库
- 没有通用属性编辑器
- 没有设备/遥测 Binding 设计器
- 没有保存草稿
- 没有发布
- 没有版本管理和回滚
- 没有统一场景校验
- 没有路线图形化编辑
- 没有通用 Runtime State
- 运行时状态与 3D 不完全一致

现有 3D 已经具备较完整基础：

```text
TwinSceneManifest
BindingEngine
RouteEngine
TwinMaterialFlowRuntime
TwinRuntime
ThreeJsEditorAdapter
ThreeJsEditorHost
DigitalTwinScene API
Scene Version
Publish / Rollback
Model Resource Library
Telemetry Snapshot
```

因此 2D 的正确方向不是重新建立一个平行的数字孪生业务栈，而是建设一套独立的 2D Editor / Renderer，并复用上述场景业务基础设施。

---

# 3. 产品定位

2D 数字孪生设计器定位为：

> 面向工业设备、产线、仓储物流、包装线、输送线、工位、机器人、AGV、立库等场景的可视化 2D 组态设计器与数字孪生运行平台。

其功能等级应与 3D Workbench 对齐，但强调：

- 更低 GPU 负载
- 更高信息密度
- 更适合大屏和生产调度
- 更适合工艺总览
- 更适合操作员快速定位设备
- 适合数百至数千个设备节点同时显示

---

# 4. 页面与路由

## 4.1 独立页面

继续保留：

```text
/iot/digital-twin/2d-scene
```

3D 保持：

```text
/iot/digital-twin/workbench
```

场景中心建议继续复用：

```text
/iot/digital-twin/scenes
```

只读 2D 运行态后续可增加：

```text
/iot/digital-twin/2d-viewer
```

## 4.2 页面职责

### 2D Scene Designer

负责：

- 设计
- 编辑
- 属性配置
- 模型/组件拖拽
- 路线设计
- Binding 配置
- 保存草稿
- 校验
- 发布
- 版本回滚
- 运行预览

### 2D Viewer

负责：

- 发布版本只读加载
- Telemetry 状态显示
- 设备运行状态
- 告警可视化
- 工艺物流运行
- 页面全屏
- 性能指标

---

# 5. 总体架构

```text
                         IoT Device / PLC
                               │
                               ▼
                     IoTEdge / IoTGateway
                               │
                               ▼
                        IoTSharp Telemetry
                               │
                               ▼
                    Current Telemetry Storage
                               │
                               ▼
                  TwinRuntimeSnapshotService
                               │
                               ▼
                         TwinDataUpdate[]
                               │
                               ▼
                     Shared Digital Twin Core
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
        BindingEngine      RouteEngine    RuntimeStateStore
              │                │                │
              └────────────────┼────────────────┘
                               │
                      Twin2DRuntimeAdapter
                               │
                 ┌─────────────┼─────────────┐
                 │             │             │
                 ▼             ▼             ▼
          Twin2DRenderer   2D Interaction  2D Animation
                 │
                 ▼
             SVG Canvas
```

3D 依然保持自己的：

```text
TwinRuntime / Three.js / ThreeJsEditor
```

2D 与 3D 页面层互不依赖。

---

# 6. 建议目录结构

建议把当前 `yt-pack-2d` 从“具体项目页面”逐步升级成通用 2D 场景设计器。

建议目录：

```text
ClientApp/src/digital-twin-2d/
├─ contracts/
│  ├─ Twin2DViewDefinition.ts
│  ├─ Twin2DSymbolDefinition.ts
│  └─ Twin2DEditorState.ts
│
├─ components/
│  ├─ Twin2DCanvas.vue
│  ├─ Twin2DToolbar.vue
│  ├─ Twin2DModelLibrary.vue
│  ├─ Twin2DSceneTree.vue
│  ├─ Twin2DPropertyPanel.vue
│  ├─ Twin2DBindingPanel.vue
│  ├─ Twin2DRoutePanel.vue
│  ├─ Twin2DVersionDrawer.vue
│  ├─ Twin2DValidationDrawer.vue
│  └─ Twin2DStatusBar.vue
│
├─ renderer/
│  ├─ Twin2DRenderer.ts
│  ├─ Twin2DSceneGraph.ts
│  ├─ Twin2DTransformRenderer.ts
│  ├─ Twin2DRouteRenderer.ts
│  ├─ Twin2DSelectionRenderer.ts
│  └─ Twin2DOverlayRenderer.ts
│
├─ runtime/
│  ├─ Twin2DRuntime.ts
│  ├─ Twin2DRuntimeStateStore.ts
│  ├─ Twin2DAnimationEngine.ts
│  └─ Twin2DTelemetryRuntime.ts
│
├─ interaction/
│  ├─ Twin2DSelectionManager.ts
│  ├─ Twin2DTransformManager.ts
│  ├─ Twin2DSnapManager.ts
│  ├─ Twin2DConnectionManager.ts
│  └─ Twin2DKeyboardManager.ts
│
├─ symbols/
│  ├─ SymbolRegistry.ts
│  ├─ conveyor/
│  ├─ robot/
│  ├─ turntable/
│  ├─ gantry/
│  ├─ buffer/
│  ├─ station/
│  ├─ agv/
│  └─ common/
│
├─ library/
│  ├─ Twin2DLibraryRegistry.ts
│  ├─ BuiltIn2DResources.ts
│  └─ Resource2DMapper.ts
│
└─ editor/
   ├─ Twin2DEditor.ts
   ├─ Twin2DEditorCommands.ts
   ├─ Twin2DUndoRedo.ts
   └─ Twin2DClipboard.ts
```

页面：

```text
ClientApp/src/views/iot/digital-twin/2d-scene.vue
```

只作为工作台 Shell。

现有：

```text
yt-pack-2d/
```

逐步迁移成一个“亚特包装线 2D 模板”，而不是整个 2D 引擎本体。

---

# 7. 2D 设计器 UI 总体布局

推荐采用工业设计软件常见的四区域布局。

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ 场景名称  状态 Draft r18     [运行预览] [保存草稿] [发布] [更多▼]       │
├───────────────┬───────────────────────────────────────┬───────────────────┤
│               │                                       │                   │
│ 模型库 /      │                                       │ 属性面板          │
│ 场景树        │              2D SVG CANVAS            │                   │
│               │                                       │ 基础              │
│ 设备          │                                       │ 外观              │
│ 输送          │                                       │ 设备绑定          │
│ 机器人        │                                       │ 动画              │
│ 工位          │                                       │ 路线              │
│ 图形          │                                       │ 高级              │
│               │                                       │                   │
├───────────────┴───────────────────────────────────────┴───────────────────┤
│ Telemetry: 132 bindings | 128 good | 4 stale | Zoom 85% | Objects 346    │
└───────────────────────────────────────────────────────────────────────────┘
```

---

# 8. 顶部工具栏

建议包含：

```text
场景选择器
场景状态
草稿 Revision
撤销
重做
复制
粘贴
删除
对齐
吸附
网格
运行预览
保存草稿
发布
更多
```

更多菜单：

```text
场景中心
场景校验
版本与回滚
复制场景
导出 Manifest
导入 Manifest
全屏
```

与 3D 的发布操作保持体验一致。

---

# 9. 2D 模型库设计

## 9.1 定义

2D 中不要使用“SVG 文件库”作为核心概念，而应使用：

> Twin 2D Resource / Twin 2D Component

每一个 2D 模型资源包含：

- ResourceKey
- Name
- Category
- ComponentType
- 默认 SVG Symbol
- 默认宽高
- 设备类型
- 连接端口
- 支持的 Binding Slot
- 默认属性 Schema
- 动画能力
- 是否可旋转
- 是否支持路线生成
- 是否支持占用
- 是否支持容量

## 9.2 模型库分类

建议：

```text
全部
最近使用
收藏

输送设备
 ├─ 小辊道
 ├─ 大辊道
 ├─ 皮带线
 ├─ 链板线
 ├─ 转弯机
 ├─ 顶升移载
 ├─ 移载机
 └─ 合流/分流机

物流设备
 ├─ AGV
 ├─ AMR
 ├─ RGV
 ├─ 堆垛机
 ├─ 穿梭车
 └─ 提升机

机器人
 ├─ 工业机器人
 ├─ 装箱机器人
 ├─ 码垛机器人
 └─ 桁架机械手

包装设备
 ├─ 外检机
 ├─ 套袋机
 ├─ 贴标机
 ├─ 缠膜机
 ├─ 封箱机
 └─ 码垛工位

仓储
 ├─ 货架
 ├─ 库位
 ├─ 暂存区
 ├─ 缓存区
 └─ 装卸口

通用图形
 ├─ 矩形
 ├─ 圆形
 ├─ 文本
 ├─ 图片
 ├─ 箭头
 ├─ 区域
 ├─ 标签
 └─ 状态灯
```

---

# 10. 2D Component 与 3D Component 的关系

2D 和 3D 不要求视觉资源相同，但建议同一个逻辑设备使用相同 `componentType`。

例如：

```text
componentType = conveyor.small.roller
```

3D：

```text
Three.js Procedural Component
```

2D：

```text
SVG Symbol Component
```

Manifest 中对象仍然可以共用：

```json
{
  "objectId": "CV001",
  "name": "小辊道001",
  "kind": "component",
  "component": {
    "componentType": "conveyor.small.roller"
  }
}
```

2D 再通过 `view2d.objects` 定义视觉位置。

---

# 11. 2D View Definition

不建议把 SVG x/y 直接塞进 3D `transform.position`。

建议增加专用 2D View 配置：

```ts
export interface Twin2DViewDefinition {
    canvas: {
        width: number;
        height: number;
        background: string;
        gridSize: number;
        showGrid: boolean;
        snapToGrid: boolean;
    };

    objects: Record<string, Twin2DObjectView>;

    viewport?: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
}

export interface Twin2DObjectView {
    x: number;
    y: number;
    width: number;
    height: number;
    rotation: number;
    zIndex: number;
    symbolKey?: string;
    hidden?: boolean;
    locked?: boolean;
}
```

这样：

```text
TwinSceneManifest
```

负责业务对象。

```text
view2d
```

只负责 2D 布局。

3D transform 不被 2D 编辑器污染。

---

# 12. 左侧模型库

## 12.1 卡片

模型卡片：

```text
┌─────────────────────┐
│   [ SVG PREVIEW ]   │
│                     │
│ 小型辊道             │
│ conveyor             │
│ 4 binding slots      │
└─────────────────────┘
```

支持：

- 点击添加
- 拖入画布
- 搜索
- 分类
- 收藏
- 最近使用

## 12.2 拖入画布

过程：

```text
ModelLibrary
    ↓ drag
Canvas
    ↓
Create Scene Object
    ↓
Create 2D View Definition
    ↓
Select Object
    ↓
Show Property Panel
```

---

# 13. 场景树

左侧可以在“模型库 / 场景树”之间切换。

场景树：

```text
包装线一号
├─ 输送系统
│  ├─ CV001
│  ├─ CV002
│  ├─ CV003
│  └─ Turntable01
│
├─ 机器人系统
│  ├─ Robot01
│  └─ Gantry01
│
├─ 检测
│  └─ Inspection01
│
└─ 包装
   ├─ Bagging01
   └─ Wrapper01
```

能力：

- 点击定位
- 重命名
- 锁定
- 隐藏
- 删除
- 多选
- 分组
- 图层顺序

---

# 14. 画布能力

## 14.1 基础操作

必须支持：

- 鼠标滚轮缩放
- 中键拖动画布
- 空格 + 左键拖动画布
- 单击选中
- Ctrl 多选
- 框选
- Delete 删除
- Ctrl+C / Ctrl+V
- Ctrl+Z / Ctrl+Y
- 方向键微调
- Shift + 方向键快速移动
- Ctrl+S 保存草稿

## 14.2 网格

建议：

```text
1px = 1cm 或场景逻辑单位
```

提供：

- 显示/隐藏
- 10/20/50 单位切换
- 自动吸附

## 14.3 对齐辅助线

拖动对象时显示：

- 左对齐
- 右对齐
- 顶对齐
- 底对齐
- 中心线
- 等间距

---

# 15. Transform 编辑

选中对象出现 2D Transform Box：

```text
     ○ rotate
     │
□────────────□
│            │
│  CV001     │
│            │
□────────────□
```

支持：

- Move
- Resize
- Rotate
- Duplicate

属性面板同步显示：

```text
X
Y
Width
Height
Rotation
ZIndex
```

---

# 16. 右侧属性面板

属性面板是本设计的核心功能之一。

建议 Tabs：

```text
基础
外观
设备
数据绑定
动画
路线
高级
```

---

# 17. 基础属性

```text
对象 ID
对象名称
组件类型
所属资产
所属分组
X
Y
宽度
高度
旋转角度
层级
锁定
可见
```

对象 ID 默认不可随意修改。

---

# 18. 外观属性

通用属性：

```text
填充颜色
边框颜色
边框宽度
透明度
字体
字号
文字颜色
状态标签显示
设备名显示
告警图标显示
```

组件特有属性通过 Component Schema 动态生成。

例如 Conveyor：

```text
方向
辊筒数量
箭头显示
箭头方向
空闲颜色
运行颜色
故障颜色
```

---

# 19. 设备绑定

## 19.1 一个场景对象绑定一个 Device

右侧：

```text
设备

Asset:      包装线01
Device:     CV001
```

对象本身绑定：

```text
assetId
deviceId
```

之后 Binding 可以默认继承 Device。

---

# 20. Telemetry Binding 设计器

生产实时数据统一来源：

```text
Telemetry
```

建议 UI：

```text
数据绑定

+ 新建绑定

[Running]
Source
  Device: CV001
  Telemetry: Running

Target
  Property: animation.running

Transform
  Boolean

Stale After
  3000 ms
```

---

# 21. Binding 类型

常见 Binding：

## 21.1 状态颜色

```text
Telemetry: Status

0 -> 灰
1 -> 绿
2 -> 黄
3 -> 红
```

## 21.2 运行动画

```text
Telemetry: Running
true  -> animation.play
false -> animation.stop
```

## 21.3 可见性

```text
Telemetry: Present
```

## 21.4 数值文本

```text
Telemetry: Current
Target: label.current
Format: {0:0.0} A
```

## 21.5 告警

建议告警也通过 Telemetry 字段进入 2D：

```text
AlarmActive
AlarmSeverity
AlarmCode
```

2D 不直接依赖独立 SignalR 告警事件。

---

# 22. 2D 动画系统

建议单独实现：

```text
Twin2DAnimationEngine
```

由 Runtime State 驱动，而不是 Vue 组件自行 setInterval。

内置动画：

```text
Flow
Rotate
Blink
Pulse
Move
Lift
RobotArm
Transfer
FlashAlarm
Progress
```

---

# 23. Conveyor 动画

例如运行状态：

```text
CV001.Running = true
```

2D：

```text
>>>>>>>>>>
```

输送箭头持续移动。

停止：

```text
----------
```

故障：

```text
红色 + 闪烁
```

---

# 24. Robot 动画

2D Robot 可支持：

```text
Idle
Running
Picking
Placing
Fault
Offline
```

使用：

- 图标切换
- 简化机械臂旋转
- 状态颜色
- 动态文字

2D 不需要模拟完整 Three.js 机械结构。

---

# 25. 托盘 / 物料运行

2D 与 3D 应共用同一个：

```text
RouteEngine
MaterialFlowRuntime
```

2D Renderer 根据 Runtime Snapshot 显示：

```text
Pallet01
Carton01
SilkCake01
WoodPallet01
```

不要在 2D 自己写一套 progress 规则。

---

# 26. 路线编辑器

2D 实际上更适合做路线设计。

工具栏提供：

```text
选择
连线
路线节点
分流点
合流点
工位
传感器
```

---

# 27. Route Node

节点：

```text
Waypoint
Junction
Diverter
Merger
Buffer
ProcessStation
Sensor
```

选中节点属性：

```text
名称
节点类型
停留时间
决策模式
执行器 Binding
传感器 Binding
工艺定义
```

直接复用 `TwinRoutePointDefinition`。

---

# 28. Route Edge

连线属性：

```text
From
To
Bidirectional
Enabled
Blocked
Priority
Speed Limit
Capacity
Occupancy Mode
Reservation Timeout
Transport Unit Type
Conveyor Object
Occupancy Binding
Full Binding
Blocked Binding
```

直接复用 `TwinRouteEdgeDefinition`。

---

# 29. 组件端口

2D Model Library 中的设备可定义端口：

```text
IN
OUT
LEFT
RIGHT
```

例如辊道：

```text
[IN] ========= [OUT]
```

拖动两个设备靠近时：

```text
Snap
 ↓
Connect
 ↓
Create Connection
 ↓
Generate Route
```

这可以与现有 V7 Component Connection 思路保持一致。

---

# 30. 自动吸附

建议 2D 吸附条件：

```text
Port Distance <= 20 px
Angle Difference <= 15°
Compatible Transport Type
```

吸附后：

- 自动对齐
- 自动创建 Connection
- 自动更新 Route

---

# 31. 碰撞检测

需要区分两个概念。

## 31.1 编辑器视觉碰撞

设计器中：

- 防止设备意外完全重叠
- 提示区域越界
- 提示端口错位

这是编辑辅助。

## 31.2 运行时业务碰撞

真实运行不能使用 SVG BoundingBox 作为权威。

必须使用共享 Runtime：

```text
Section Occupancy
Capacity
Reservation
Junction Mutual Exclusion
Blocked Downstream
Process Station Occupancy
```

因此 2D 和 3D 运行结果一致。

---

# 32. 设备占用状态

例如：

```text
CV001.Occupied = true
```

2D：

- 设备内部显示托盘
- 状态角标
- 占用颜色

如果：

```text
CV001.Full = true
```

显示：

```text
FULL
```

---

# 33. 状态颜色规范

建议统一：

```text
Offline        Gray
Idle           Blue/Gray
Running        Green
Waiting        Cyan
Blocked        Orange
Warning        Yellow
Fault          Red
Stale          Purple/Gray
```

2D / 3D 的语义必须一致。

---

# 34. Telemetry 获取机制

由于明确不使用 SignalR，建议：

```text
Twin2DTelemetryRuntime
```

周期调用：

```text
digitalTwinApi.snapshot(sceneId)
```

返回：

```text
TwinRuntimeSnapshot
 └─ TwinDataUpdate[]
```

推荐周期：

```text
500ms ~ 1000ms
```

支持配置。

---

# 35. 批量获取原则

禁止：

```text
一个 Conveyor 一个 HTTP 请求
```

必须：

```text
Scene
  ↓
一次 Snapshot
  ↓
所有 Binding Updates
  ↓
BindingEngine
```

---

# 36. Stale 机制

每个 Binding 已有：

```text
staleAfterMs
```

2D 必须显示：

```text
Good
Stale
Missing
Bad
```

例如设备 3 秒没收到新的 Telemetry：

```text
设备变灰
显示 STALE
停止使用旧值继续驱动关键动画
```

---

# 37. Runtime State Store

建议不要让 SVG Component 直接读取 HTTP 返回。

链路：

```text
Telemetry Snapshot
     ↓
BindingEngine
     ↓
RuntimeStateStore
     ↓
Twin2DRenderer
```

组件只接收已经计算好的 Runtime State。

---

# 38. 运行预览

2D Designer 提供：

```text
[设计模式]
[运行预览]
```

注意：这不是 2D / 3D 切换。

运行预览只是在 2D 页面内部关闭编辑句柄并启动：

- Telemetry Polling
- Runtime Animation
- Material Flow
- Status Rendering

---

# 39. 设计模式

设计模式：

- 可拖动
- 可缩放对象
- 可修改属性
- 可创建 Binding
- 可连线
- 不以真实 Telemetry 强制覆盖设计属性

---

# 40. 运行模式

运行模式：

- 禁止布局修改
- Telemetry 生效
- 动画生效
- 告警生效
- 物流对象运动
- 点击查看设备详情

---

# 41. 设备详情弹窗

点击设备建议显示统一详情：

```text
设备名称
DeviceId
设备状态
连接状态
最后更新时间
当前 Telemetry
当前告警
当前占用
绑定数量
```

按钮：

```text
查看完整遥测
打开设备管理
配置数据绑定
```

---

# 42. 属性面板动态 Schema

不同 Component 的属性不同，不要在 Vue 中硬编码所有表单。

资源定义：

```ts
componentSchema: {
    properties: [
        {
            key: 'rollerCount',
            label: '辊筒数量',
            type: 'number',
            min: 1,
            max: 100
        }
    ]
}
```

2D Property Panel 自动生成控件。

---

# 43. Binding Slot

组件可定义：

```text
running
fault
occupied
speed
alarmSeverity
current
```

放入场景后，Binding Panel 可以提示：

```text
未绑定：Running
未绑定：Fault
已绑定：Occupied -> CV001.Occupied
```

---

# 44. 模型资源入库

2D Resource 建议也进入资源系统，而不是所有 SVG 写死在代码。

资源类型可以增加：

```text
application/vnd.iotsharp.twin-2d-component+json
```

内容：

- SymbolKey
- SVG Template
- Property Schema
- Binding Slots
- Ports
- Default Size
- Category
- Version

---

# 45. 内置组件与数据库组件

内置组件：

```text
代码内 Registry
```

用户自定义组件：

```text
数据库资源库
```

资源库页面统一显示。

---

# 46. 自定义 SVG 模型

后续允许：

```text
上传 SVG
```

上传后必须做：

- SVG 安全清洗
- 禁止 script
- 禁止外部 URL
- 限制复杂度
- 生成 Preview
- 定义 Anchor
- 定义 Ports
- 定义 Binding Slots

---

# 47. 自定义组件设计器（后续）

可以增加：

```text
2D Component Designer
```

用于：

- 导入 SVG
- 设置端口
- 设置属性
- 设置状态区域
- 设置动画 Target
- 注册到 Model Library

作为 V2 功能。

---

# 48. 场景创建

与 3D 类似：

```text
新建场景
```

字段：

```text
场景名称
场景 Key
描述
Root Asset
2D Template
```

模板：

```text
空白
包装线
输送线
立体仓库
亚特包装线
```

---

# 49. Scene Manifest

2D 不单独创建第二套 Scene Entity。

仍然使用：

```text
DigitalTwinScene
TwinSceneManifest
```

增加 2D 扩展：

```ts
interface TwinSceneManifest {
    ...
    view2d?: Twin2DViewDefinition;
}
```

---

# 50. 保存草稿

顶部：

```text
保存草稿
```

流程：

```text
2D Editor
   ↓
Serialize TwinSceneManifest
   ↓
validate
   ↓
PUT Scene Draft
   ↓
Revision + 1
```

建议继续使用现有：

```text
digitalTwinApi.saveDraft
```

---

# 51. 自动保存

第一期不建议直接自动覆盖服务器草稿。

可以做：

```text
本地自动备份
```

例如：

```text
IndexedDB
```

正式服务器保存仍由用户点击。

---

# 52. Dirty State

修改后显示：

```text
Draft r18 · 未保存
```

保存后：

```text
Draft r19 · 已保存
```

离开页面提醒。

---

# 53. 场景校验

发布前必须运行：

```text
validateTwinSceneManifest
validate2DScene
```

校验包括：

## 53.1 基础

- SceneId
- Name
- RootAsset
- ObjectId 唯一

## 53.2 2D View

- 所有业务对象有对应 View 或明确 Hidden
- X/Y 有效
- Width/Height > 0
- Symbol 存在

## 53.3 Binding

- Device 存在
- Telemetry Key 存在或允许待上线
- BindingId 唯一
- Target 可用

## 53.4 Route

- Route 连通
- Point 存在
- Edge 引用正确
- Diverter 出口合法

## 53.5 Connection

- Port 存在
- Transport Type 兼容

---

# 54. 校验级别

```text
Error
Warning
Info
```

`Error` 阻止发布。

`Warning` 用户确认后可以发布。

---

# 55. 发布流程

2D 发布能力应与 3D 同等级。

按钮：

```text
发布
```

流程：

```text
保存草稿
   ↓
前端校验
   ↓
后端校验
   ↓
生成 immutable SceneVersion
   ↓
PublishedVersion + 1
   ↓
状态 = Published
```

---

# 56. 发布版本

发布后：

```text
v1
v2
v3
```

每个版本记录：

```text
Version
SourceDraftRevision
ManifestHash
ChangeSummary
ValidationReport
CreatedBy
CreatedAt
```

继续复用现有 3D Scene Version 基础设施。

---

# 57. 发布与 2D / 3D 的关系

由于 2D 和 3D 共用 Scene Manifest，因此一次发布发布的是整个数字孪生场景业务定义。

但可以在 Manifest 中独立存储：

```text
view2d
view3d/editorExtension
```

如果用户只调整 2D 布局：

```text
Revision 增加
```

发布后仍然形成新的 SceneVersion。

---

# 58. 版本与回滚

2D 页面提供：

```text
版本与回滚
```

Drawer：

```text
v8 当前版本
v7
v6
v5
```

可：

- 查看变化摘要
- 预览旧版本
- 回滚

---

# 59. 回滚原则

回滚不是删除新版本。

而是：

```text
将选定旧版本恢复为当前发布状态
```

保留审计轨迹。

---

# 60. 2D 只读 Viewer

建议新增：

```text
2d-viewer.vue
```

只加载 Published Manifest。

功能：

- Telemetry Polling
- 运行动画
- 告警
- 点击设备
- 全屏
- 缩放平移

禁止：

- 编辑
- 保存
- 删除
- 修改 Binding

---

# 61. 权限设计

建议权限：

```text
DigitalTwin.Scene.Read
DigitalTwin.Scene.Create
DigitalTwin.Scene.Edit
DigitalTwin.Scene.Publish
DigitalTwin.Scene.Rollback
DigitalTwin.Binding.Edit
DigitalTwin.Resource.Read
DigitalTwin.Resource.Create
DigitalTwin.Resource.Delete
```

2D 和 3D 共用权限域。

页面按钮按权限控制。

---

# 62. Undo / Redo

设计器必须实现 Command Pattern。

命令：

```text
AddObjectCommand
RemoveObjectCommand
MoveObjectCommand
ResizeObjectCommand
RotateObjectCommand
UpdatePropertyCommand
CreateConnectionCommand
RemoveConnectionCommand
CreateBindingCommand
UpdateBindingCommand
```

这样才能稳定支持：

```text
Ctrl+Z
Ctrl+Y
```

---

# 63. Clipboard

支持：

```text
Ctrl+C
Ctrl+V
Ctrl+D
```

复制时：

- 新 ObjectId
- 复制 2D View
- 可选择是否复制 Binding
- 不复制真实 DeviceId 或弹出确认

建议默认不自动复制 Device Binding，避免两个对象绑定同一设备。

---

# 64. 多选

支持：

- Ctrl 逐个选择
- 框选
- 全选

多选属性：

```text
对齐
等宽
等高
水平分布
垂直分布
锁定
删除
```

---

# 65. 图层系统

建议支持 Group / Layer。

例如：

```text
Background
ProductionLine
MaterialFlow
Labels
Alarms
Overlay
```

对象属性：

```text
zIndex
layerId
```

---

# 66. 背景图

2D 场景可支持：

- PNG
- JPG
- SVG
- CAD 转换图（后续）

用途：

- 厂房平面图
- 车间布局

背景图只作为 View 资源，不参与运行逻辑。

---

# 67. Minimap

大型 2D 场景建议支持右下角 MiniMap。

```text
┌──────────┐
│          │
│  ▣       │
│          │
└──────────┘
```

可快速移动 viewport。

---

# 68. 搜索定位

顶部提供：

```text
搜索设备 / 对象 / DeviceId
```

结果：

```text
CV001
Robot01
Inspection01
```

点击自动：

- 移动画布
- 放大
- 高亮

---

# 69. Runtime Metrics

底部状态栏显示：

```text
Objects: 350
Bindings: 720
Telemetry Good: 700
Stale: 15
Bad: 5
FPS: 60
DOM/SVG Nodes: 1850
Zoom: 82%
```

---

# 70. 性能目标

建议第一阶段目标：

```text
500 scene objects
1000 telemetry bindings
60 FPS 基础浏览
500~1000ms telemetry polling
```

大型场景目标：

```text
2000+ objects
```

需要：

- SVG 分层
- Runtime State Diff
- 避免整个 Vue Tree 重渲染
- requestAnimationFrame 合并更新
- 只更新发生变化的 SVG Element

---

# 71. Vue 性能原则

不要：

```text
1000 个组件每次 Snapshot 全部触发 computed 更新
```

建议：

```text
Twin2DRenderer
```

维护 objectId -> SVG Element 映射。

收到 Runtime Diff 时直接更新必要属性。

Vue 负责 UI Shell 和属性面板。

---

# 72. Renderer 建议

第一阶段继续使用 SVG，而不是 Canvas。

原因：

- 当前已有大量 SVG 组件
- 工业图形易维护
- 文字和状态标签清晰
- 点击区域容易
- DOM 可调试
- 可复用现有资产

当对象数量超过 SVG 适用范围后，再评估 PixiJS/WebGL 2D Renderer。

---

# 73. SVG Symbol Registry

建议不要继续把所有模型直接写成 Vue 文件。

建立：

```text
SymbolRegistry
```

例如：

```ts
register({
  symbolKey: 'conveyor.small.roller',
  componentType: 'conveyor.small.roller',
  defaultSize: [240, 80],
  render: SmallRollerSymbol,
  ports: [...],
  bindingSlots: [...]
});
```

---

# 74. 现有 Line1 / Line2 / Line3 的迁移

不要删除现有布局。

第一阶段：

```text
Line1 / Line2 / Line3
```

保留作为“亚特包装线模板”。

第二阶段将其中设备逐步转换成：

```text
TwinSceneObject
+
Twin2DObjectView
```

第三阶段 Line1/2/3 本身消失，场景由 Manifest 动态生成。

---

# 75. 亚特包装线模板

建议生成：

```text
createYtPackaging2DTemplate()
```

其内容包含：

- 所有设备 Object
- 2D 坐标
- Route
- Connection
- 默认 Binding Slot

以后新建场景选择：

```text
亚特包装线
```

即可生成。

---

# 76. 2D 与 3D 不同步布局

必须明确：

```text
2D x/y
```

不强制等于：

```text
3D x/z
```

因为 2D 工艺图可能为了可读性做非真实比例布局。

因此二者只共用：

- ObjectId
- DeviceId
- AssetId
- Route
- Connection
- Binding
- Runtime State

不共用视觉坐标。

---

# 77. 2D 与 3D 的对象对应

例如：

```text
ObjectId = CV001
```

2D：

```text
view2d.objects.CV001
```

3D：

```text
object.transform
```

二者业务身份相同。

---

# 78. 设备属性共用与视图属性分离

共用：

```text
name
assetId
deviceId
componentType
route
bindings
process
```

2D 独有：

```text
x
y
width
height
rotation
symbolKey
zIndex
```

3D 独有：

```text
position XYZ
rotation XYZ
scale XYZ
GLB
material
camera
lighting
```

---

# 79. 2D 状态灯

可内置通用状态灯：

```text
● Online
● Running
● Fault
● Alarm
```

每一个都可以 Binding。

---

# 80. 动态文本

例如：

```text
速度: 1.2m/s
电流: 8.4A
托盘: 3/6
```

Binding：

```text
Target = text
```

支持 Format。

---

# 81. 告警可视化

告警显示：

- 红色边框
- 闪烁
- Warning Icon
- Alarm Badge

点击弹出：

```text
AlarmCode
AlarmSeverity
AlarmText
Timestamp
```

输入仍来自 Telemetry / 当前状态服务。

---

# 82. Offline

如果设备离线：

```text
opacity: 0.45
color: gray
badge: OFFLINE
```

---

# 83. Stale

Stale 与 Offline 不同。

Stale：

```text
数据过期
```

应该显示：

```text
STALE
```

避免把旧数据误认为当前状态。

---

# 84. Process Station

2D Process Station 显示：

```text
Idle
Waiting
Processing 65%
Completed
Fault
```

共用 `TwinProcessDefinition`。

---

# 85. 分流器

Diverter 可显示：

```text
───────┬────
       └────
```

执行器状态由 Telemetry Binding 决定。

路线选择由 RouteEngine 决定。

---

# 86. Buffer

Buffer 可显示容量：

```text
Buffer A
[●][●][●][ ][ ]
3 / 5
```

---

# 87. Warehouse Slot

后续支持库位：

```text
A01-01
Occupied
SKU001
```

2D 非常适合仓储可视化。

---

# 88. 运行态与编辑态状态隔离

编辑器内部维护：

```text
EditorState
RuntimeState
```

不能把 Runtime Telemetry 写回 Manifest。

例如：

```text
Running = true
```

只存在 Runtime，不保存到场景草稿。

---

# 89. 设计器状态

```ts
interface Twin2DEditorState {
  selectedObjectIds: string[];
  activeTool: string;
  dirty: boolean;
  zoom: number;
  viewport: ...;
  clipboard: ...;
}
```

不进入服务器 Manifest。

---

# 90. Scene API

优先继续复用现有：

```text
GET scenes
GET scene
POST scene
PUT scene draft
POST publish
GET versions
POST rollback
GET snapshot
```

不为 2D 再建立另一套 Scene API。

---

# 91. 2D Resource API

若 2D Resource 与现有 Model Resource 统一，则可以扩展：

```text
TwinModelResource.runtimeFormat
```

支持：

```text
model/gltf-binary
application/vnd.iotsharp.twin-component+json
application/vnd.iotsharp.twin-2d-component+json
```

---

# 92. 数据库

第一阶段尽量不新增大量表。

2D View 优先作为：

```text
TwinSceneManifest.view2d
```

随 SceneVersion 一起版本化。

Resource 使用现有 Resource 表扩展格式。

---

# 93. 发布不可变性

Published Version 中：

```text
view2d
```

也是不可变快照。

这样可以保证历史生产大屏可还原。

---

# 94. 导入导出

支持：

```text
Export Manifest
Import Manifest
```

导出必须包含：

- Objects
- Bindings
- Routes
- Connections
- View2D

资源文件只引用 ResourceId，不直接塞 Base64。

---

# 95. 键盘快捷键

建议：

```text
Ctrl+S       Save
Ctrl+Z       Undo
Ctrl+Y       Redo
Ctrl+C       Copy
Ctrl+V       Paste
Ctrl+D       Duplicate
Delete       Remove
Ctrl+A       Select All
F            Focus Selected
Space        Pan
G            Toggle Grid
```

---

# 96. UI 风格

与 3D Workbench 保持工业深色工作台风格。

建议：

```text
深色 Canvas
蓝色选中框
绿色 Running
橙色 Blocking
红色 Fault
```

2D 和 3D 产品体验一致，但代码独立。

---

# 97. 页面组件建议

`2d-scene.vue`：

```text
Twin2DToolbar
Twin2DLeftPanel
Twin2DCanvas
Twin2DRightPanel
Twin2DStatusBar
Twin2DVersionDrawer
Twin2DValidationDrawer
```

不要继续让一个 `index.vue` 包含全部逻辑。

---

# 98. Twin2DEditor

建议它作为核心 Facade：

```ts
class Twin2DEditor {
  loadManifest()
  getManifest()

  addObject()
  removeObject()
  selectObject()

  moveObject()
  resizeObject()
  rotateObject()

  createConnection()
  createBinding()

  undo()
  redo()

  setRuntimeMode()
  applyTelemetryUpdates()

  dispose()
}
```

页面只操作这个稳定 API。

---

# 99. Twin2DRenderer

职责限定为：

```text
Manifest -> SVG
RuntimeState -> SVG update
```

Renderer 不负责：

- 请求 API
- 保存场景
- 发布
- 用户权限

---

# 100. Twin2DRuntime

职责：

```text
Telemetry Snapshot
BindingEngine
Runtime State
MaterialFlow
RouteEngine
Animation State
```

它不负责编辑功能。

---

# 101. 数据流

完整数据流：

```text
                 Scene API
                    │
                    ▼
              TwinSceneManifest
                    │
                    ▼
               Twin2DEditor
                    │
                    ▼
              Twin2DRenderer
                    │
                    ▼
                 SVG DOM

Telemetry Snapshot
        │
        ▼
TwinDataUpdate[]
        │
        ▼
BindingEngine
        │
        ▼
Runtime State
        │
        ▼
Twin2DAnimationEngine
        │
        ▼
Twin2DRenderer
```

---

# 102. 保存数据流

```text
Editor
  ↓
Manifest + view2d
  ↓
Validate
  ↓
Save Draft API
  ↓
Scene Revision
```

---

# 103. 发布数据流

```text
Draft
  ↓
Validate
  ↓
Publish API
  ↓
SceneVersion
  ↓
2D Viewer
```

---

# 104. 运行数据流

```text
Device
  ↓
Telemetry
  ↓
Twin Snapshot
  ↓
BindingEngine
  ↓
Runtime State
  ↓
SVG Animation / Color / Text / MaterialFlow
```

---

# 105. 不应该做的事情

以下设计明确禁止：

## 105.1 2D 自己保存设备状态

错误：

```text
smallConveyerInfoList.status = Running
```

作为权威。

正确：

```text
Telemetry -> RuntimeState
```

## 105.2 2D 单独做一套路由逻辑

错误：

```text
2DRouteEngine
3DRouteEngine
```

正确：

```text
Shared RouteEngine
```

## 105.3 每个组件自己调用遥测 API

禁止。

## 105.4 2D 和 3D 强制共用页面

不采用。

## 105.5 把 SVG 坐标直接覆盖 3D Transform

不采用。

---

# 106. 第一阶段开发范围 V1

建议第一阶段先做到可用设计器：

### P0 必须完成

- 新 2D Designer Shell
- Model Library
- Scene Tree
- SVG Canvas
- 拖拽添加对象
- 单选 / 多选
- Move / Resize / Rotate
- Grid / Snap
- Basic Property Panel
- 2D View Definition
- Scene API 加载
- Save Draft
- Dirty State
- Undo / Redo

---

# 107. 第二阶段 V1.5

- Device Binding
- Telemetry Binding
- Runtime Snapshot
- Status Color
- Running Animation
- Alarm
- Stale
- Device Detail Dialog
- Runtime Preview

---

# 108. 第三阶段 V2

- Port
- Connection
- Route Editor
- Auto Snap
- Route Generate
- Material Flow
- Pallet / Carton / AGV
- Occupancy
- Buffer
- Junction
- Diverter

---

# 109. 第四阶段 V2.5

- Validation
- Publish
- Version
- Rollback
- 2D Viewer
- Scene Copy
- Export / Import

---

# 110. 第五阶段 V3

- Custom SVG Component
- Component Designer
- User Model Library
- Favorites
- Template Center
- MiniMap
- Layer
- Large Scene Optimization

---

# 111. 开发优先级

建议顺序：

```text
1. Manifest + View2D
2. Canvas / Transform
3. Model Library
4. Property Panel
5. Save Draft
6. Telemetry Runtime
7. Binding Designer
8. Animation
9. Route / Connection
10. Validation
11. Publish
12. Version / Rollback
13. Viewer
14. Custom Component
```

---

# 112. 预期最终页面

最终 2D 页面应接近专业工业组态设计器：

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ 亚特包装线        Draft · r21                  [运行] [保存草稿] [发布]    │
├────────────────┬──────────────────────────────────────────┬──────────────────┤
│ 模型库         │                                          │ 属性             │
│                │       CV01 ═══ CV02 ═══ CV03             │                  │
│ ▣ 小辊道       │                     │                    │ 名称 CV03        │
│ ▣ 大辊道       │                     ▼                    │ Device CV003     │
│ ▣ 转盘         │                 [Robot01]                │ X  1450         │
│ ▣ 机器人       │                     │                    │ Y  720          │
│ ▣ 桁架         │                     ▼                    │ W  240          │
│ ▣ 外检         │                 Inspection              │ H   80          │
│ ▣ 套袋         │                     │                    │ Rotation 0      │
│                │                     ▼                    │                  │
│ 场景树         │                 Bagging                  │ Data Binding     │
│                │                                          │ Running ✓       │
│                │                                          │ Fault   ✓       │
├────────────────┴──────────────────────────────────────────┴──────────────────┤
│ Telemetry 720 | Good 716 | Stale 4 | Objects 355 | Zoom 92% | Grid 20       │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

# 113. 与现有 3D Workbench 的能力对照

| 能力 | 3D | 新 2D |
|---|---|---|
| 独立页面 | 是 | 是 |
| 场景选择 | 是 | 是 |
| 模型/资源库 | 是 | 是 |
| 拖拽添加 | 是 | 是 |
| 对象选中 | 是 | 是 |
| Transform | XYZ | XY/WH/Rotation |
| 属性面板 | 是 | 是 |
| Asset 绑定 | 是 | 是 |
| Device 绑定 | 是 | 是 |
| Telemetry Binding | 是 | 是 |
| 运行动画 | Three.js | SVG |
| 路线 | 是 | 是 |
| 组件端口 | 是 | 是 |
| 自动连接 | 是 | 是 |
| Material Flow | 是 | 是 |
| Occupancy | 是 | 是 |
| Collision/Reservation | Runtime | Runtime |
| Save Draft | 是 | 是 |
| Validation | 是 | 是 |
| Publish | 是 | 是 |
| Version | 是 | 是 |
| Rollback | 是 | 是 |
| Viewer | 3D Viewer | 2D Viewer |

---

# 114. 最终架构结论

最终建议不是建设一个“带几个可移动 SVG 的页面”，而是正式建设：

> IoTSharp Twin 2D Designer

其架构边界为：

```text
业务层共用
────────────
Scene
Object
Component
Asset
Device
Telemetry
Binding
Route
Connection
MaterialFlow
RuntimeState
Publish
Version

视觉层独立
────────────
2D Editor
SVG Renderer
2D Symbol Library
2D View Definition
2D Transform
2D Layout
2D Animation
```

最终形成：

```text
                Shared IoTSharp Digital Twin Domain
                              │
              ┌───────────────┴───────────────┐
              │                               │
              ▼                               ▼
       IoTSharp 2D Designer            IoTSharp 3D Workbench
              │                               │
           SVG UI                         Three.js UI
              │                               │
              └───────────────┬───────────────┘
                              │
                         Telemetry
```

2D 和 3D 后期可以完全独立迭代 UI、Renderer 和编辑功能，而不会产生两套工业业务状态和两套路线规则。

这套结构同时满足：

- 2D 与 3D 页面完全分离
- 后期维护清晰
- 2D 能力达到 3D 工作台等级
- 统一走 Telemetry
- 支持模型库
- 支持属性设计器
- 支持实时运行
- 支持发布
- 支持版本与回滚
- 支持未来大型工业场景

---

# 115. 建议下一步

建议后续实际开发从以下第一批文件开始：

```text
ClientApp/src/digital-twin-2d/contracts/Twin2DViewDefinition.ts
ClientApp/src/digital-twin-2d/library/Twin2DLibraryRegistry.ts
ClientApp/src/digital-twin-2d/renderer/Twin2DRenderer.ts
ClientApp/src/digital-twin-2d/editor/Twin2DEditor.ts
ClientApp/src/digital-twin-2d/components/Twin2DCanvas.vue
ClientApp/src/digital-twin-2d/components/Twin2DModelLibrary.vue
ClientApp/src/digital-twin-2d/components/Twin2DPropertyPanel.vue
ClientApp/src/views/iot/digital-twin/2d-scene.vue
```

第一阶段先将现有亚特包装线作为模板迁入新设计器，不影响当前已有 SVG 页面逻辑；设计器稳定后再切换正式入口。

---

# 116. 2026-09-01 实施收口记录

本轮已经将 `/iot/digital-twin/2d-scene` 从固定 SVG 展示入口升级为独立的 `IoTSharp Twin 2D Professional Designer`，并保留 `yt-pack-2d` 作为亚特包装线模板来源。

## 116.1 V1 P0 完成项

- 独立 Designer Shell、模型库、场景树、图层和 SVG Canvas
- 模型卡片点击添加与 HTML5 拖入画布
- 创建共享 Scene Object 与独立 `view2d` 视图对象
- 单选、Ctrl 多选、框选、移动、缩放、旋转、复制和删除
- 10/20/50 网格、网格吸附、对象边缘/中心辅助线吸附
- 对齐、等距分布、ZIndex、置顶、置底、锁定和隐藏
- Undo / Redo 同时覆盖 Manifest 与 View2D
- Dirty 状态、页面离开提醒和场景切换保护
- Scene API 加载、新建空白场景和保存草稿
- 左右面板独立收起，画布保持可见

## 116.2 已提前完成的后续能力

- Telemetry Binding、1 秒批量 Snapshot、Good/Stale/Bad 和运行动画
- 端口、Connection、路线节点/边、分流节点、容量与占用状态
- 前后端联合校验、发布、不可变版本、回退草稿
- 独立 `/iot/digital-twin/2d-viewer` 线上只读运行态
- 场景复制、Manifest 导入导出、MiniMap
- 数据库参数化组件映射、收藏、最近使用
- 自定义 SVG 安全清洗、组件资源入库尝试和 Binding Slot

## 116.3 架构边界

- `objects / bindings / routes / connections / runtime` 继续由 2D 与 3D 共用。
- `view2d` 只保存二维坐标、尺寸、角度、图层、颜色和图元信息，不覆盖 3D Transform。
- 无需 3D 模型资源的二维业务对象使用 `kind: visual`；数据库智能组件继续使用 `kind: component` 并引用已入库 `resourceId`。
- 生产状态只从 IoTSharp Telemetry Snapshot 获取，2D 页面不持久化伪运行状态，也不直接控制 PLC。

## 116.4 后续版本边界

以下能力不属于本次 V1 封版，不应混入 P0 返工：大型场景虚拟化、独立 SVG 可视化组件设计器、模板中心、多人协同编辑以及工业大屏编排。它们继续按 V2.5/V3 阶段推进。
