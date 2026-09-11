# IoTSharp 3D 数字孪生遥测驱动物体实时运动详细修改与完善方案 V1

> 文档目标：在保留现有 3D 场景设计器、组件设计器、路线、托盘、Behavior、Action Flow、发布/回滚等既有能力的前提下，优先打通“PLC/IoTGateway 遥测数据 → IoTSharp → 3D Runtime → 设备执行机构 → Three.js 模型运动”的实时闭环，使机器人、桁架、RGV、输送线、挡停、旋转台等对象能够优先根据实时遥测数据运动。
>
> 本文基于当前项目实际代码现状编写，重点文件包括：
>
> - `ClientApp/src/digital-twin/runtime/TwinRuntime.ts`
> - `ClientApp/src/digital-twin/bindings/BindingEngine.ts`
> - `ClientApp/src/digital-twin/runtime/BehaviorRuntime.ts`
> - `ClientApp/src/digital-twin/contracts/index.ts`
> - `ClientApp/src/views/iot/digital-twin/workbench.vue`
> - `ClientApp/src/digital-twin/components/ComponentActuatorSync.ts`
> - `ClientApp/src/digital-twin/components/IndustrialRobotComponent.ts`
> - `ClientApp/src/digital-twin/components/PackagingLineComponents.ts`
> - `IoTSharp/Services/DigitalTwin/TwinRuntimeSnapshotService.cs`
> - `IoTSharp/Controllers/TwinRuntimeController.cs`
>
> 本方案优先使用现有 Telemetry / Snapshot 链路，不依赖 SignalR 才能成立。

---

## 1. 当前阶段最重要的目标

现阶段最优先的不是继续增加 Action Flow 节点数量，而是先把下面这条链做到稳定、可配置、可回归：

```text
PLC / 机器人控制器 / 伺服 / IoTGateway
                 │
                 ▼
           IoTSharp Telemetry
                 │
                 ▼
        TwinRuntimeSnapshotService
                 │
                 ▼
        TwinDataUpdate[]
                 │
                 ▼
          BindingEngine
                 │
                 ▼
         ActuatorRuntime
                 │
        ┌────────┴────────┐
        │                 │
   linear-axis       rotary-joint
        │                 │
        ├──── gripper ────┤
        │                 │
        ▼                 ▼
          Three.js Object3D
                 │
                 ▼
  机器人 / 桁架 / RGV / 挡停 / 旋转台
```

最终要实现的用户体验应该是：

1. 在 3D 场景设计器选择一个设备；
2. 选择设备内部执行机构，例如 `robot-j1`；
3. 选择 IoTSharp 设备；
4. 选择遥测键，例如 `Robot.J1.Position`；
5. 选择单位，例如 PLC 上报 Degree；
6. 保存并发布场景；
7. Live 模式下 PLC 数值变化后，3D 对应关节实时跟随；
8. 不需要用户再理解 `nodePath`、`rotation.z`、`factor=PI/180` 这些底层细节。

---

# 2. 当前项目已经具备的基础

## 2.1 遥测到 3D Runtime 的主链已经存在

当前 `workbench.vue` 中 Live 模式会调用：

```ts
const refreshSnapshot = async () => {
    const snapshot = apiData<TwinRuntimeSnapshot>(
        await digitalTwinApi.snapshot(currentScene.value.id)
    );
    const updates = snapshot.updates || [];
    adapter.value?.applyDataUpdates(updates);
};
```

`TwinRuntime.applyDataUpdates()` 已经把更新送入：

```ts
applyDataUpdates(updates: TwinDataUpdate[]) {
    this.bindingEngine.apply(updates);
    this.behaviorRuntime?.setBindingContext(this.bindingEngine.getSignalSnapshot());
    this.syncOutputStopperBindings();
}
```

因此当前数据通路不是空白，而是已经具备：

```text
TelemetryLatest
    ↓
TwinRuntimeSnapshotService
    ↓
TwinDataUpdate
    ↓
BindingEngine.apply()
    ↓
Three.js Node
```

这个基础应该保留，不应推翻重做。

---

## 2.2 BindingEngine 已经可以直接修改 Three.js 对象

当前 `BindingEngine` 已支持以下 Target：

```ts
export type TwinBindingTargetKind =
    | 'visible'
    | 'color'
    | 'emissive'
    | 'opacity'
    | 'text'
    | 'number'
    | 'position'
    | 'rotation'
    | 'scale'
    | 'animation'
    | 'routeProgress'
    | 'routeDistance'
    | 'customProperty';
```

其中已经真正实现：

- `position`
- `rotation`
- `scale`
- `animation`
- `visible`
- `color`
- `opacity`
- `routeProgress`
- `routeDistance`
- `routeSlotArray`

所以当前底层实际上已经可以做到：

```text
Telemetry = 2.35
       ↓
Binding target = position
       ↓
node.position.y = 2.35
```

以及：

```text
Telemetry = 90
       ↓
numberRotation / rotation
       ↓
node.rotation.z = ...
```

问题不是“完全不能动”，而是目前这种方式仍然偏 Three.js 底层，不够适合工业设备。

---

## 2.3 执行机构 Actuator 体系已经存在

当前项目已经定义：

```ts
export interface TwinActuatorDefinition {
    actuatorId: string;
    name: string;
    objectId: string;
    nodePath: string;
    kind: TwinActuatorKind;
    motionAxis?: TwinActuatorAxis;
    unit: TwinActuatorUnit;
    minValue?: number;
    maxValue?: number;
    homeValue?: number;
    speed?: number;
    bindings?: TwinActuatorBindingDefinition;
}
```

并且已经存在：

```ts
export interface TwinActuatorBindingDefinition {
    positionBindingId?: string;
    openBindingId?: string;
    closeBindingId?: string;
    readyBindingId?: string;
    faultBindingId?: string;
}
```

这是非常关键的基础。

说明当前架构实际上已经预留了：

```text
Telemetry Binding
       ↓
Actuator Binding
       ↓
Actuator
```

只是目前 `BindingEngine` 还没有把这条链真正做成 Runtime 的标准能力。

---

## 2.4 机器人、桁架、RGV 已经具备标准执行机构定义

### 工业机器人

`IndustrialRobotComponent.ts` 已经定义：

```text
robot-j1
robot-j2
robot-j3
robot-j4
robot-j5
robot-j6
robot-gripper
```

每个执行机构都具备：

- `nodePath`
- `kind`
- `motionAxis`
- `unit`
- `minValue`
- `maxValue`
- `homeValue`
- `speed`

因此机器人并不需要重新设计运动模型。

### 丝锭/隔板桁架

当前已经存在类似：

```text
gantry-yarn-z
gantry-yarn-y
gantry-yarn-gripper
gantry-separator-z
gantry-separator-y
gantry-separator-gripper
```

### RGV

当前已经存在：

```text
rgv-x
```

所以这些设备非常适合直接接入统一 Actuator Runtime。

---

# 3. 当前真正的核心缺口

## 3.1 缺口一：Actuator Binding 只是“数据结构存在”，Runtime 没有真正消费

现在 `TwinActuatorDefinition.bindings.positionBindingId` 等字段已经存在，但 Runtime 没有形成统一流程：

```text
BindingId
    ↓
ActuatorDefinition.bindings
    ↓
ActuatorRuntime
    ↓
set actuator position
```

导致目前想让 J2 跟遥测走，只能做：

```text
objectId
nodePath = Robot-Axis-2
Target = rotation
Property = rotation.z
Transform = factor
```

这实际上绕开了 Actuator 层。

后续设备一多，会带来几个问题：

1. UI 需要用户理解 Three.js 节点结构；
2. 需要用户知道旋转轴 X/Y/Z；
3. 需要用户自己做 degree/radian 换算；
4. 需要用户自己维护 min/max；
5. Robot / Gantry / RGV 各自配置方式不统一；
6. Behavior 与 Telemetry 最终会分别写 Three.js 节点，出现控制权冲突。

因此这是当前第一优先级必须补齐的能力。

---

## 3.2 缺口二：Live 模式当前 2 秒轮询一次，无法形成连续运动

当前 `workbench.vue`：

```ts
snapshotTimer = window.setInterval(refreshSnapshot, 2000);
```

这意味着：

```text
PLC 每 100ms 更新一次
```

但 3D 只可能看到：

```text
0°
    2 秒后
80°
    2 秒后
160°
```

这对于状态颜色、告警显示可以接受，但对于：

- 机器人关节；
- 桁架位置；
- RGV 位置；
- 升降机；
- 旋转台；

明显不够。

但是不能简单把 2000ms 改成 20ms，因为当前 Snapshot Service 每次都要读取：

- Scene；
- Published Version；
- TwinObjectBindings；
- TelemetryLatest；
- AttributeLatest；
- Alarm；

如果直接 20ms 请求一次，会造成不必要数据库压力。

---

## 3.3 缺口三：Behavior / Action Flow / Telemetry 可能同时控制同一个执行机构

当前 `BehaviorRuntime` 已经有：

```ts
setActuatorValue(...)
```

Behavior 可以控制机器人、桁架执行机构。

Action Flow 也会通过：

```text
MoveTo
MovePose
JointMove
AxisMove
GripOpen
GripClose
```

间接控制执行机构。

如果 Live Telemetry 未来也直接写节点，而不做控制权治理，会出现：

```text
Telemetry: J1 = 45°
Behavior:  J1 = 90°
Telemetry: J1 = 46°
Behavior:  J1 = 90°
```

最终模型会抖动或者跳变。

因此 Live 与 Simulation 的控制权必须现在确定。

---

# 4. 总体架构调整

建议增加独立：

```text
ActuatorRuntime
```

它成为所有执行机构最终运动的唯一入口。

架构调整为：

```text
                       ┌───────────────┐
Telemetry ────────────▶│               │
                       │               │
Behavior ─────────────▶│ ActuatorRuntime│─────▶ Three.js
                       │               │
Action Flow ──────────▶│               │
                       └───────────────┘
```

三种输入不再直接改 Object3D。

---

# 5. 新增 ActuatorRuntime

建议新增文件：

```text
ClientApp/src/digital-twin/runtime/ActuatorRuntime.ts
```

## 5.1 职责

`ActuatorRuntime` 负责：

1. 根据 `actuatorId` 找到 `TwinActuatorDefinition`；
2. 根据 `objectId` 找到对象根节点；
3. 根据 `nodePath` 找到真正运动节点；
4. 自动处理 `motionAxis`；
5. 自动处理 `unit`；
6. 自动处理 min/max；
7. 自动处理 linear-axis；
8. 自动处理 rotary-joint；
9. 自动处理 gripper；
10. 提供直接值模式；
11. 提供平滑插值模式；
12. 管理 Live/Simulation 控制权；
13. 维护执行机构 Runtime Snapshot；
14. 维护 stale/fault 状态。

---

## 5.2 推荐接口

```ts
export type TwinActuatorControlSource =
    | 'telemetry'
    | 'behavior'
    | 'action-flow'
    | 'manual-test';

export interface TwinActuatorRuntimeCommand {
    actuatorId: string;
    value: number | boolean;
    source: TwinActuatorControlSource;
    timestamp?: number;
    immediate?: boolean;
}

export interface TwinActuatorRuntimeState {
    actuatorId: string;
    currentValue: number | boolean;
    targetValue: number | boolean;
    source?: TwinActuatorControlSource;
    stale: boolean;
    fault: boolean;
    moving: boolean;
    lastUpdatedAt?: number;
}
```

核心方法：

```ts
class ActuatorRuntime {
    setManifest(manifest: TwinSceneManifest): void;

    apply(command: TwinActuatorRuntimeCommand): void;

    applyTelemetry(
        actuatorId: string,
        value: unknown,
        timestamp: number,
        stale: boolean
    ): void;

    tick(deltaSeconds: number): void;

    getState(actuatorId: string): TwinActuatorRuntimeState | undefined;

    getSnapshot(): TwinActuatorRuntimeState[];

    reset(): void;

    dispose(): void;
}
```

---

# 6. ActuatorRuntime 的值换算规则

## 6.1 Rotary Joint

如果 Actuator：

```ts
{
    kind: 'rotary-joint',
    motionAxis: 'z',
    unit: 'degree'
}
```

PLC 上报：

```text
90
```

Runtime 自动转换：

```ts
THREE.MathUtils.degToRad(90)
```

最终：

```ts
node.rotation.z = Math.PI / 2
```

用户不需要再配置：

```text
rotation.z
factor = PI / 180
```

---

## 6.2 Linear Axis

```ts
{
    kind: 'linear-axis',
    motionAxis: 'x',
    unit: 'meter'
}
```

PLC 上报：

```text
2.34
```

最终：

```ts
node.position.x = 2.34
```

如果 PLC 是毫米，建议不要改变 `unit` 定义，而是在 Binding Transform 中提供：

```text
factor = 0.001
```

即：

```text
2340 mm
   ↓
2.340 m
```

---

## 6.3 Gripper

```ts
{
    kind: 'gripper',
    unit: 'boolean'
}
```

允许绑定：

```text
openBindingId
closeBindingId
positionBindingId
```

第一阶段建议简化成：

```text
positionBindingId
```

值规则：

```text
0 / false = open
1 / true  = close
```

后面再支持：

```text
OpenCmd
CloseCmd
OpenedFeedback
ClosedFeedback
```

---

# 7. BindingEngine 修改

当前 `BindingEngine` 仍保留，因为它负责：

- 状态；
- 颜色；
- opacity；
- animation；
- routeSlotArray；
- routeDistance；
- customProperty；

不应把它删除。

建议扩展 Binding Target：

```ts
export type TwinBindingTargetKind =
    | ...
    | 'actuator';
```

建议 `target` 增加：

```ts
{
    kind: 'actuator',
    actuatorId: 'robot-j1'
}
```

或者保持数据结构兼容，在 `target.path` 中保存：

```text
actuator:robot-j1
```

但从长期维护角度，更推荐明确字段：

```ts
export interface TwinObjectBindingDefinition {
    ...
    target: {
        kind: TwinBindingTargetKind;
        property?: string;
        path?: string;
        actuatorId?: string;
    };
}
```

`BindingEngine.applyBinding()` 增加：

```ts
case 'actuator':
    this.applyActuatorValue?.(
        binding.target.actuatorId!,
        transformed,
        timestamp,
        stale
    );
    break;
```

注意：

**BindingEngine 不应直接修改机器人节点。**

它只应该把标准化后的值送给 `ActuatorRuntime`。

---

# 8. TwinRuntime 修改

在 `TwinRuntime` 中新增：

```ts
private readonly actuatorRuntime: ActuatorRuntime;
```

构造时：

```ts
this.actuatorRuntime = new ActuatorRuntime(
    this.manifest,
    objectId => this.objectIndex.get(objectId),
    message => this.events.onError?.(message)
);
```

BindingEngine 增加回调：

```ts
this.bindingEngine = new BindingEngine(
    ...,
    (actuatorId, value, timestamp, stale) =>
        this.actuatorRuntime.applyTelemetry(
            actuatorId,
            value,
            timestamp,
            stale
        )
);
```

每帧：

```ts
this.actuatorRuntime.tick(this.fixedStep);
```

---

# 9. BehaviorRuntime 修改

当前：

```ts
BehaviorRuntime.setActuatorValue()
```

自己直接修改 Three.js。

应该逐步收敛为：

```text
BehaviorRuntime
    ↓
ActuatorRuntime.apply()
```

即：

```ts
actuatorRuntime.apply({
    actuatorId,
    value,
    source: 'behavior'
});
```

`BehaviorRuntime` 仍然负责：

- 行为步骤；
- Interlock；
- Attach；
- Detach；
- WorkPoint；
- MaterialSlot；
- Pose；
- 状态机；

但是最终轴值不要再直接写 Three.js。

---

# 10. Action Flow 修改原则

Action Flow 不需要推翻。

它后续应该负责：

```text
什么时候动
动哪个 Actuator
目标值是什么
满足什么联锁
什么时候等待
什么时候补偿
```

而不是负责：

```text
Three.js 节点怎么旋转
```

所以：

```text
Action Flow
   ↓
AxisMove / JointMove / GripClose
   ↓
ActuatorRuntime
   ↓
Three.js
```

这样 Action Flow 与 Live Telemetry 才能共用同一设备模型。

---

# 11. Live / Simulation 控制权规则

这是必须写死的规则。

## 11.1 Simulation 模式

```text
Behavior / Action Flow
         ↓
ActuatorRuntime
         ↓
Three.js
```

Telemetry 不接管轴位置。

Simulation 可以使用：

- 配置速度；
- Pose；
- WorkPoint；
- Action Flow；
- Behavior；

来驱动。

---

## 11.2 Live 模式

```text
PLC / Device Telemetry
         ↓
ActuatorRuntime
         ↓
Three.js
```

轴位置以真实反馈为准。

Action Flow 在 Live 模式下主要负责：

- 命令；
- 流程；
- Interlock；
- WaitSignal；
- Ack；
- Busy；
- Done；
- Fault；
- ManualConfirm；

不应与真实 Feedback 抢轴位置控制权。

---

## 11.3 推荐优先级

建议：

```text
Live Mode:
Telemetry > Manual Test > Action Flow > Behavior

Simulation Mode:
Manual Test > Action Flow > Behavior
```

在 Live 模式中，任何位置反馈已经绑定的 Actuator：

```text
positionBindingId != null
```

都应该进入：

```text
telemetry-owned
```

Behavior / Action Flow 对该执行机构的运动命令可以：

1. 只作为命令发送；
2. 等待 PLC Feedback；
3. 不直接改变最终 3D 轴位置。

---

# 12. 遥测刷新策略调整

## 12.1 当前问题

目前：

```ts
setInterval(refreshSnapshot, 2000)
```

不适合实时运动。

---

## 12.2 第一阶段建议

不要马上改后端架构。

第一阶段直接使用：

```text
250 ~ 500 ms
```

建议默认：

```text
300 ms
```

配置项：

```ts
runtime.telemetryRefreshMs = 300
```

范围限制：

```text
100 ~ 5000 ms
```

默认不低于 250ms。

---

## 12.3 客户端使用 60FPS 插值

Snapshot 不需要 60FPS。

正确方式：

```text
Telemetry 300ms 一个 Target
        ↓
ActuatorRuntime 保存 targetValue
        ↓
requestAnimationFrame / fixedStep
        ↓
每帧向 targetValue 插值
```

例如：

```text
t0     J1 = 10°
t300   J1 = 28°
```

客户端显示：

```text
10
11
12
13
...
27
28
```

而不是：

```text
10
28
```

---

# 13. Live 插值策略

建议每个 Actuator 增加：

```ts
telemetryInterpolation?: {
    enabled: boolean;
    mode: 'linear' | 'shortest-angle';
    maxLagMs?: number;
    snapThreshold?: number;
};
```

## 13.1 Linear Axis

使用：

```text
linear
```

## 13.2 Rotary Joint

使用：

```text
shortest-angle
```

避免：

```text
179° → -179°
```

被错误插值成绕 358°。

## 13.3 Stale

若超过：

```text
staleAfterMs
```

不应继续预测。

应该：

```text
停止最后值
+ stale visual
+ runtime state stale=true
```

---

# 14. Snapshot Service 第一阶段优化

当前 `TwinRuntimeSnapshotService` 每次会查询：

- Scene；
- Version；
- Bindings；
- TelemetryLatest；
- AttributeLatest。

第一阶段可以先不重构数据库。

但是建议加入 Scene Binding Cache：

```text
(sceneId, publishedVersionId)
        ↓
PublishedBindingCache
```

缓存内容：

```text
bindings
required device ids
required telemetry keys
required attribute keys
```

只在：

- 发布新版本；
- 回滚版本；
- Scene 删除；

时失效。

这样 300ms 轮询时不需要每次重新加载所有 Binding 定义。

---

# 15. Snapshot 增量模式 P2

第二阶段增加：

```text
sinceTimestamp
```

请求：

```json
{
  "sceneId": "...",
  "sinceTimestamp": "2026-09-09T09:00:00.000Z"
}
```

后端只返回变化项：

```json
{
  "updates": [
    {
      "bindingKey": "robot-j1-position",
      "value": 42.5
    }
  ]
}
```

前端保存：

```text
lastServerTimestamp
```

减少数据量。

---

# 16. 3D 场景设计器 UI 修改

## 16.1 新增“执行机构绑定”区域

选择一个机器人/桁架/RGV 后，右侧属性新增：

```text
执行机构
--------------------------------
J1 底座回转      实时绑定：Robot.J1
J2 肩轴          实时绑定：Robot.J2
J3 肘轴          未绑定
J4 腕部回转      未绑定
J5 腕部摆动      未绑定
J6 法兰回转      未绑定
末端夹具         实时绑定：Robot.Gripper
```

---

## 16.2 点击某个 Actuator 后显示

```text
名称：J1 底座回转
类型：旋转关节
轴：Y
模型节点：Robot-Axis-1
单位：degree
范围：-180 ~ 180
Home：0

实时位置来源
设备：[Robot01 ▼]
遥测：[J1.Position ▼]

输入单位：[degree ▼]
缩放：1
偏移：0
反向：[ ]

平滑插值：[√]
最大追赶时间：300 ms

[测试输入]  [解除绑定]
```

用户不需要编辑 `nodePath`。

---

# 17. 遥测 Key 下拉

继续沿用当前用户已经要求的设计：

```text
Device 下拉
Telemetry Key 下拉
```

不要要求用户手工输入：

```text
Robot.J1.Position
```

除非开启“高级配置”。

下拉应该显示：

```text
J1.Position       Double    最新值 42.3
J2.Position       Double    最新值 -18.5
ServoReady        Bool      true
RobotRunning      Bool      true
```

这样现场配置效率会高很多。

---

# 18. Component Designer 修改

组件设计器负责定义：

```text
这个组件有哪些 Actuator
```

场景设计器负责定义：

```text
这个场景实例的 Actuator 绑定哪个设备遥测
```

两者不要混淆。

Component Designer 中应该允许配置：

```text
执行机构 ID
名称
节点
类型
运动轴
单位
Min
Max
Home
Simulation Speed
```

但不要把具体：

```text
DeviceId
TelemetryKey
```

写死进组件模板。

具体设备绑定属于 Scene Instance。

---

# 19. Actuator 自动发现

当前组件已经通过：

```text
root.userData.actuatorDefinitions
```

以及：

```text
ComponentActuatorSync
```

自动同步到 SceneManifest。

这个机制应该继续保留。

用户把机器人组件拖入场景后：

```text
robot-j1
robot-j2
...
```

应该自动出现在“执行机构绑定”面板。

不允许再让用户手工创建 6 个轴定义。

---

# 20. 第一批支持设备

建议按如下顺序实现。

## P0-1：滚筒动画

验证：

```text
MotorRunning
   ↓
booleanAnimation
   ↓
Roller.rotation
```

目的：确认完整遥测链路。

这部分当前已经基本具备。

---

## P0-2：桁架或 RGV 单轴

优先选择：

```text
rgv-x
```

或者：

```text
gantry-yarn-z
```

例如：

```text
Telemetry:
GantryXPosition = 2.350
```

最终：

```text
ActuatorRuntime
   ↓
node.position.x = 2.350
```

这是最重要的 MVP。

---

## P0-3：机器人 6 轴

绑定：

```text
Robot.J1 → robot-j1
Robot.J2 → robot-j2
Robot.J3 → robot-j3
Robot.J4 → robot-j4
Robot.J5 → robot-j5
Robot.J6 → robot-j6
```

最终真实 PLC：

```text
J1 = 15.2
J2 = -31.0
J3 = 45.5
J4 = 90.0
J5 = 12.3
J6 = 180.0
```

3D 应在 300ms 内收到目标值，并以 60FPS 插值显示姿态。

---

# 21. 机器人 6 轴特殊要求

## 21.1 角度必须用绝对位置

Live 模式不能使用：

```text
每次加多少度
```

必须使用：

```text
Absolute Joint Position
```

否则浏览器刷新后无法恢复真实姿态。

---

## 21.2 周期轴处理

J1/J4/J6 要考虑：

```text
-180 ↔ 180
```

或：

```text
0 ↔ 360
```

必须支持 shortest-angle。

否则：

```text
179 → -179
```

可能会错误绕整圈。

这也可以彻底解决之前出现的“机器人 1 轴先转一整圈”的同类问题。

---

# 22. 桁架实时驱动规则

对于丝锭桁架：

```text
横移轴
升降轴
夹具状态
```

全部应该可以从 PLC Feedback 映射。

Live 模式：

```text
位置 = PLC 真实轴位置
```

Simulation：

```text
位置 = Behavior / Action Flow 计算目标
```

丝锭实体 Attach/Detach 仍由业务状态判断，不因为轴绑定被删除。

---

# 23. 运输单元不全部走 Actuator

注意：

```text
小托盘
木托盘
纸箱
```

不建议统一变成 Actuator。

它们仍然应该使用：

```text
routeDistance
routeSlotArray
RouteRuntime
```

所以架构应明确：

```text
设备内部机械运动 → ActuatorRuntime
运输单元线路运动 → Route Runtime
流程逻辑            → Action Flow / Behavior
固定设备内部工艺    → Component Process Runtime
```

职责不能混合。

---

# 24. 数据质量处理

Telemetry 状态必须支持：

```text
good
stale
missing
bad
```

ActuatorRuntime 处理建议：

## good

正常更新 targetValue。

## stale

```text
保持最后位置
停止预测
标记 stale
```

## missing

```text
保持最后位置
显示灰色状态
不自动 Home
```

## bad

```text
保持最后位置
标记 fault/bad
不接受新的模拟移动
```

Live 模式绝对不能因为遥测断了就突然把机器人回 Home。

---

# 25. 状态弹窗增强

当前点击机器人、桁架已经有组件级运行状态。

后续建议增加：

```text
机器人 Robot01
--------------------------------
模式：LIVE
数据质量：GOOD
最后更新：85 ms

J1   42.5°   Moving
J2  -18.2°   Stable
J3   76.0°   Moving
J4    0.0°   Stable
J5   12.0°   Stable
J6   90.0°   Moving

夹具：Closed
Ready：true
Fault：false
```

这对现场调试非常重要。

---

# 26. Runtime Snapshot 增加 Actuator 状态

建议 `TwinRuntime` 暴露：

```ts
getActuatorSnapshot()
```

结构：

```json
[
  {
    "actuatorId": "robot-j1",
    "currentValue": 42.3,
    "targetValue": 43.0,
    "source": "telemetry",
    "moving": true,
    "stale": false,
    "fault": false
  }
]
```

用于：

- 状态弹窗；
- 调试面板；
- Action Flow Debugger；
- Component Test；
- 回归测试。

---

# 27. 控制源冲突检测

新增诊断：

```text
twin.actuator.binding.conflict
```

示例：

```text
robot-j1 同时存在两个 positionBindingId
```

应该阻止发布。

新增：

```text
twin.actuator.live-control.conflict
```

例如 Live 场景中：

```text
J1 已绑定实时位置
但又配置了持续循环 Behavior 直接控制 J1
```

应至少给 warning。

---

# 28. 设计器中的“实时绑定测试”

右侧 Actuator 面板增加：

```text
[实时绑定测试]
```

测试模式只允许：

```text
读取遥测
驱动当前选中组件
```

不运行：

- Route；
- 其他机器人；
- Action Flow；
- 包装线完整流程。

这样现场调试一个伺服轴会很方便。

---

# 29. Component Test 与 Live Test 分开

当前已有 Component Test。

建议区分：

```text
组件模拟测试
组件实时映射测试
```

### 模拟测试

Behavior / Pose 驱动。

### 实时映射测试

Telemetry 驱动。

两种模式不能同时开启。

---

# 30. 不允许破坏的既有能力

本次改造必须遵循以下兼容规则。

### 3D 场景设计器全部旧功能保留

包括：

- 模型库；
- 场景树；
- 组件库；
- 拖拽；
- 移动/旋转/缩放；
- 吸附；
- 端口连接；
- 路线；
- Route 编辑；
- 框选；
- 多选；
- Undo/Redo；
- Delete；
- 发布；
- 回滚；
- Runtime；
- 点击状态；
- Component Designer；
- Behavior；
- Action Flow。

### 旧 Binding 继续兼容

不能因为新增 `actuator` target 就删除：

```text
position
rotation
animation
routeDistance
routeSlotArray
```

这些仍然可以作为高级绑定功能保留。

---

# 31. 推荐代码修改清单

## 新增

```text
ClientApp/src/digital-twin/runtime/ActuatorRuntime.ts
ClientApp/src/digital-twin/runtime/ActuatorInterpolation.ts
ClientApp/src/digital-twin/runtime/ActuatorControlAuthority.ts
```

可视情况后两者先合并进 ActuatorRuntime，后续再拆。

---

## 修改

```text
ClientApp/src/digital-twin/contracts/index.ts
```

增加：

- actuator Binding Target；
- 插值配置；
- Runtime State；
- 校验规则。

---

```text
ClientApp/src/digital-twin/bindings/BindingEngine.ts
```

增加：

```text
Binding → Actuator callback
```

---

```text
ClientApp/src/digital-twin/runtime/TwinRuntime.ts
```

接入：

```text
ActuatorRuntime
```

并统一 tick。

---

```text
ClientApp/src/digital-twin/runtime/BehaviorRuntime.ts
```

逐步把：

```text
setActuatorValue
```

收敛到 ActuatorRuntime。

---

```text
ClientApp/src/views/iot/digital-twin/workbench.vue
```

增加：

- Actuator Binding UI；
- Device/Telemetry 下拉；
- Live Mapping Test；
- telemetryRefreshMs；
- 状态显示。

---

```text
IoTSharp/Services/DigitalTwin/TwinRuntimeSnapshotService.cs
```

第一阶段：

- Published Binding Cache；

第二阶段：

- sinceTimestamp；
- 增量 Snapshot。

---

# 32. 分阶段开发计划

## Phase 1：单轴遥测直接驱动

目标：

```text
Telemetry → Actuator → Three.js
```

完成：

- ActuatorRuntime；
- Binding target actuator；
- 单轴 linear-axis；
- 单轴 rotary-joint；
- gripper boolean；
- Live/Simulation authority；
- 300ms Snapshot；
- 60FPS 插值。

验收设备：

```text
RGV 或桁架单轴
```

---

## Phase 2：机器人 6 轴

完成：

- 6 个关节实时映射；
- shortest-angle；
- Degree/Radian；
- min/max；
- stale；
- 状态弹窗。

---

## Phase 3：设计器工业化配置

完成：

- Actuator Binding 面板；
- Device 下拉；
- Telemetry Key 下拉；
- 当前值预览；
- Mapping Test；
- 自动保存到 SceneManifest；
- 发布校验。

---

## Phase 4：Snapshot 优化

完成：

- Binding Cache；
- sinceTimestamp；
- Incremental Update；
- 批量 Device/Key 查询优化。

---

## Phase 5：Live Action Flow 闭环

完成：

```text
Action Flow 发命令
       ↓
PLC 执行
       ↓
Telemetry Feedback
       ↓
ActuatorRuntime
       ↓
3D 实际位置
       ↓
WaitAck / Done
```

此时 Action Flow 真正成为工业流程编排，而不是动画脚本。

---

# 33. MVP 验收场景一：RGV

PLC/模拟遥测：

```text
RGV.Position = 0
RGV.Position = 0.5
RGV.Position = 1.0
RGV.Position = 1.5
```

绑定：

```text
Device: RGV01
Telemetry: Position
Actuator: rgv-x
```

验收：

1. Live 模式；
2. 数值更新 <= 500ms 可见；
3. 画面平滑；
4. 不跳帧式大跨度移动；
5. stale 后停在最后位置；
6. 不自动 Home；
7. Simulation 模式仍可通过 Behavior 移动。

---

# 34. MVP 验收场景二：机器人 6 轴

输入：

```text
J1 = 10
J2 = -20
J3 = 30
J4 = 40
J5 = -10
J6 = 90
```

3D 必须同步显示对应姿态。

更新：

```text
J1 = 15
J2 = -25
J3 = 35
J4 = 45
J5 = -5
J6 = 100
```

验收：

- 6 轴全部跟随；
- 无整圈错误旋转；
- 无 Behavior 抢控制；
- 无 NaN；
- 无超范围；
- 数据质量可见；
- 断线保留最后姿态。

---

# 35. MVP 验收场景三：丝锭桁架

输入：

```text
YarnGantry.X
YarnGantry.Z
YarnGantry.Gripper
```

要求：

```text
X/Z 实时跟随
夹具状态实时跟随
```

但：

```text
丝锭 Attach/Detach
```

仍由物料状态和动作逻辑控制，不允许单纯因为夹具反馈变化就凭空生成/删除丝锭。

---

# 36. 回归测试要求

新增自动测试建议：

## ActuatorRuntime 单元测试

必须覆盖：

```text
linear-axis
rotary-joint rad
rotary-joint degree
gripper
min/max
stale
missing
bad
shortest-angle
control authority
```

---

## BindingEngine 测试

验证：

```text
binding.target.kind='actuator'
```

能正确发送到 ActuatorRuntime。

---

## Runtime 集成测试

模拟：

```text
TwinDataUpdate
```

输入：

```text
robot-j1 = 45
```

检查：

```text
Robot-Axis-1.rotation.y
```

最终达到 45°。

---

## Live / Simulation 控制权测试

必须验证：

### Simulation

Behavior 可以动 J1。

### Live

有 positionBinding 的 J1 最终以 Telemetry 为准。

不能出现：

```text
Telemetry 与 Behavior 往返覆盖
```

---

# 37. 性能验收

第一阶段建议指标：

```text
100 个 Binding
30 个运动 Actuator
300ms Snapshot
60FPS Runtime
```

目标：

```text
平均 FPS >= 50
Runtime 主线程无持续长任务
Snapshot API P95 < 150ms
单次 Updates Payload 可控
```

第二阶段再测试：

```text
500 Binding
100 Actuator
多个浏览器客户端
```

---

# 38. 后端安全和数据隔离

继续沿用当前：

```text
TenantId
CustomerId
SceneId
PublishedVersionId
```

运行态只读取 Published Binding。

草稿绑定不允许影响正式 Runtime。

这一点当前 `TwinRuntimeSnapshotService` 已经符合，应保留。

---

# 39. 发布校验增加内容

发布时增加：

```text
Actuator 存在
Actuator objectId 存在
nodePath 存在
positionBindingId 存在
Binding objectId 与 Actuator objectId 匹配
单位合法
min <= max
遥测绑定重复检查
Live 控制冲突检查
```

错误应阻止发布。

警告不阻止发布，但必须显示诊断。

---

# 40. 建议的最终运行架构

```text
                         IoTGateway
                              │
                              ▼
                       IoTSharp Telemetry
                              │
                              ▼
                    TelemetryLatest / Cache
                              │
                              ▼
                 TwinRuntimeSnapshotService
                              │
                              ▼
                      TwinDataUpdate[]
                              │
                              ▼
                       BindingEngine
                  ┌───────────┼────────────┐
                  │           │            │
                  ▼           ▼            ▼
             Visual State   Route       Actuator
              Binding      Binding       Binding
                  │           │            │
                  │           │            ▼
                  │           │     ActuatorRuntime
                  │           │      ┌─────┴─────┐
                  │           │      │           │
                  │           │    Live      Simulation
                  │           │ Telemetry   Behavior/
                  │           │            Action Flow
                  │           │      │           │
                  │           │      └─────┬─────┘
                  │           │            ▼
                  └───────────┴──────▶ Three.js
```

---

# 41. 当前最推荐的实际实施顺序

不要同时大面积开发。

建议严格按下面顺序：

### 第一步

新增 `ActuatorRuntime`。

只支持：

```text
linear-axis
rotary-joint
gripper
```

### 第二步

让 `BindingEngine` 支持：

```text
Telemetry → actuator
```

### 第三步

选一个：

```text
RGV 或桁架轴
```

真实跑通。

### 第四步

把 Snapshot 从 2000ms 调整到约 300ms，并加入客户端插值。

### 第五步

机器人 6 轴全部接入。

### 第六步

补齐 3D 场景设计器 Actuator Binding UI。

### 第七步

再让 Behavior / Action Flow 全部改走统一 ActuatorRuntime。

### 第八步

优化 Snapshot Cache / Incremental。

---

# 42. 最终验收定义

本方案不能只以“某一个模型动了”为完成。

必须达到以下验收：

- [ ] PLC/IoTSharp Telemetry 能驱动 linear-axis；
- [ ] PLC/IoTSharp Telemetry 能驱动 rotary-joint；
- [ ] PLC/IoTSharp Telemetry 能驱动 gripper；
- [ ] 机器人 6 轴实时映射完整；
- [ ] 桁架实时轴映射完整；
- [ ] RGV 实时轴映射完整；
- [ ] Live 模式以 Telemetry Feedback 为真实位置来源；
- [ ] Simulation 模式 Behavior / Action Flow 正常运行；
- [ ] 两种模式不会抢执行机构控制权；
- [ ] Snapshot 默认刷新达到工业展示所需实时性；
- [ ] 画面有平滑插值；
- [ ] shortest-angle 正确；
- [ ] stale / bad / missing 状态正确；
- [ ] 断线不自动回 Home；
- [ ] Actuator Binding 可以在 3D 场景设计器配置；
- [ ] Device 和 Telemetry Key 使用下拉选择；
- [ ] Component Designer 可以定义 Actuator；
- [ ] 旧 position / rotation Binding 保持兼容；
- [ ] Route / routeSlotArray 不受影响；
- [ ] 旧 3D Scene 功能全部保留；
- [ ] Action Flow 功能继续保留；
- [ ] 发布/回滚继续正常；
- [ ] 全量前端 build 通过；
- [ ] 数字孪生专项回归通过；
- [ ] 至少执行两轮连续完整回归。

---

# 43. 结论

当前 IoTSharp 并不是缺少“让模型动”的基础，而是已经同时具备：

```text
Telemetry Snapshot
BindingEngine
Three.js Node Binding
Actuator Definition
Behavior Actuator Control
Robot / Gantry / RGV Actuator Metadata
```

真正缺少的是中间统一的一层：

```text
ActuatorRuntime
```

因此当前最值得优先投入的核心工作应该从：

```text
继续扩充复杂 Action Flow
```

调整为：

```text
Telemetry
   ↓
Actuator Binding
   ↓
ActuatorRuntime
   ↓
Three.js
```

先把这条链稳定做成平台能力。

当这层完成后：

- 机器人可以跟真实 PLC 6 轴位置；
- 桁架可以跟真实伺服位置；
- RGV 可以跟真实行走位置；
- 固定设备可以根据运行信号动画；
- Simulation 继续使用 Behavior / Action Flow；
- Live 则以真实设备反馈为最终物理姿态；
- Action Flow 只需要负责工业流程与命令，而不再承担 Three.js 动画细节。

这会成为 IoTSharp 3D 数字孪生从“可配置动画系统”走向“真实工业设备数字映射”的关键一步。
