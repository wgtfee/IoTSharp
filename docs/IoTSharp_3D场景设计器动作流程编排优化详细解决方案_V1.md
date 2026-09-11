# IoTSharp 3D 场景设计器动作流程编排优化详细解决方案 V1

> 文档状态：实施基线草案  
> 编制日期：2026-09-08  
> 适用范围：IoTSharp 3D 场景专业编辑、运行预览、数字孪生场景发布、PLC/WCS 联动  
> 核心目标：把当前“前端顺序动作演示”升级为“可视化编辑、确定性模拟、服务端发布校验、实时设备握手、故障可恢复、全过程可追溯”的工业动作流程编排能力。

---

## 1. 结论先行

IoTSharp 当前已经具备 WorkPoint、MaterialSlot、ToolFrame、Actuator、Pose、Behavior、Interlock、路线与数据绑定等基础对象，继续沿用 Three.js 编辑器和现有数字孪生场景体系是正确方向，不需要更换 3D 引擎。

真正的短板不在“有没有动作字段”，而在以下五个方面：

1. 当前 Behavior 本质上是一个顺序动作数组，无法清楚表达条件分支、并行、汇合、子流程、重试、补偿和人工干预。
2. 动作执行主要存在于浏览器内存，刷新页面或前端崩溃后不能恢复，也不能作为生产流程的权威状态。
3. 实时模式下 BehaviorRuntime 不主动执行动作，但系统也没有完整的“命令下发—PLC 接收—忙信号—完成信号—结果确认”链路。
4. 前端虽有部分校验，后端发布时没有对 WorkPoint、MaterialSlot、Pose、Behavior、Interlock 等动作对象做完整校验，绕过前端可能发布错误流程。
5. 场景对象、运输对象、动作步骤和 PLC 数据之间缺少稳定的运行实例标识，容易出现物料瞬移、重复执行、断点恢复后归属不清和设备状态与画面不同步。

因此建议采用以下总体方案：

- 保留现有 Behavior 顺序动作作为 V1 兼容格式。
- 新增 `Action Flow V2` 有向图协议和可视化流程设计器。
- 模拟模式继续由前端确定性执行，便于编辑、调试和演示。
- 实时模式由后端编排服务作为流程状态权威，PLC/机器人控制器作为实际动作权威，3D 页面只消费状态和事件进行可视化。
- 草稿中的完整定义仍随 Manifest 原子保存，同时投影到数据库表，支持服务端校验、查询、发布、运行和审计。
- 所有设备绑定继续进入数据库；流程只引用 bindingId/bindingKey，禁止把 Token、密码、脚本、外部 URL 写入场景清单。

### 1.1 强制兼容原则：Action Flow V2 只能增量增强，禁止破坏现有 3D 场景设计器

本条为本方案的硬性实施规则，优先级高于具体 UI 重构和代码整理建议：

> **Action Flow V2 只能作为现有 3D 场景设计器的增量能力接入，不能以“重构、统一、迁移、替换”为理由删除、弱化、隐藏、改变或破坏已经稳定使用的 3D 场景设计功能。**

现有 `workbench.vue`、Three.js 专业编辑器和数字孪生场景体系继续作为 3D 场景设计主工作区。Action Flow V2 应增加“流程”或“分屏”等工作区能力，而不是重做整个 3D 页面。

以下既有能力属于必须保留的兼容基线，后续 Action Flow 开发不得导致功能回退：

- 3D 专业编辑与运行预览模式；
- 模型资源库、V7 参数化组件、GLB 模型拖拽和重复实例化；
- 场景树、对象选择、根/子节点选择、对象改名；
- 移动、旋转、缩放、相机操作、框选多选、Ctrl/Shift 增减选择；
- 撤销、重做、复制、删除以及现有快捷键；
- Port、Connection、组件自动吸附、移动后重校验；
- 小托盘、木托盘、纸箱等运输对象的路线吸附；
- Route、Section、Capacity、Occupancy、Reserved、岔口、分流、合流和路线编辑；
- 自动生成 Route/Section 的只读约束；
- 右侧属性面板和组件动态属性；
- Device / Telemetry Binding、运行状态、告警、在线状态和数据绑定；
- 运行、暂停、Simulation、Live、对象运行状态查看；
- 运行态点击业务组件而不是单个 Mesh 的交互规则；
- 运行状态浮窗跟随模型位置；
- 新建空白场景、场景中心、场景校验；
- 保存草稿、发布、查看线上版本、版本与回滚、导出 Manifest；
- “完整工艺 V6”“参考图双套袋产线”等既有场景模板入口；
- Behavior V1、Interlock、WorkPoint、MaterialSlot、ToolFrame、Actuator、Pose 等现有动作编排能力。

实施要求：

1. `workbench.vue` 允许新增“3D / 流程 / 分屏”工作区，但默认 3D 工作区必须保留现有编辑功能和交互习惯。
2. Action Flow 相关组件必须独立模块化，禁止把模型库、场景树、Route、Binding、属性面板等基础能力搬入流程模块后再删除原入口。
3. 如果必须替换某个既有组件或运行模块，必须先证明新实现完整覆盖原入口、公开契约、配置项、快捷键、交互行为、保存格式、运行行为和回滚路径；无法完全覆盖时必须保留兼容层。
4. 任何 Action Flow 相关改动在合并前都必须执行 3D 原功能回归，不允许只验证新增流程功能。
5. 旧场景必须在不转换 Action Flow V2 的情况下继续正常打开、编辑、保存、发布和运行预览。
6. 新流程功能出现异常时，不能阻断基础 3D 场景编辑、保存草稿、发布、版本回滚和运行预览。
7. 不允许因为新增 Action Flow 而改变已有 Manifest 中对象、组件、路线、Binding、Behavior 的语义；所有迁移必须显式、可逆、可追踪。
8. 任何“清理旧代码”的提交只要会影响上述兼容基线，就必须先补等价回归测试，再允许删除旧实现。

因此，本方案的页面演进关系必须保持为：

```text
现有 3D 场景设计器
├─ 场景 / 模型 / 组件 / Route / Binding / 属性 / 发布      ← 必须继续保留
├─ Behavior V1                                           ← 兼容保留
└─ Action Flow V2                                        ← 新增增强
   ├─ 流程工作区
   ├─ 分屏工作区
   ├─ 校验/编译
   └─ 模拟/实时编排
```

目标关系如下：

```text
3D 场景对象 / 工作点 / 物料槽 / 路线
                 │
                 ▼
        Action Flow V2 图形编辑器
                 │
          校验 + 编译 + 发布
                 │
      ┌──────────┴──────────┐
      │                     │
      ▼                     ▼
前端确定性模拟器       服务端实时编排器
      │                     │
      │             命令/确认/遥测/告警
      │                     ▼
      └──────────► 运行事件流 ◄──── PLC/WCS/机器人
                         │
                         ▼
                  Three.js 状态投影
```

---

## 2. 本次代码审查范围

本方案不是抽象建议，主要对照了当前仓库中的以下实现：

| 领域 | 当前文件 | 关注点 |
| --- | --- | --- |
| 场景与动作协议 | `ClientApp/src/digital-twin/contracts/index.ts` | WorkPoint、Slot、ToolFrame、Actuator、Pose、Behavior、Interlock、客户端校验 |
| 流程表单 | `ClientApp/src/views/iot/digital-twin/workbench.vue` | 动作步骤编辑、联锁配置、运行状态显示 |
| 顺序动作设计器 | `ClientApp/src/digital-twin/orchestration/TwinOrchestrationDesigner.ts` | 动作增删、导入导出、上下排序 |
| 行为运行时 | `ClientApp/src/digital-twin/runtime/BehaviorRuntime.ts` | 动作选择、执行、等待、抓取/放置、状态快照 |
| 设备工艺状态机 | `ClientApp/src/digital-twin/runtime/ComponentProcessStateMachine.ts` | Ready、Busy、Complete、Fault、Stale |
| 设备工艺运行时 | `ClientApp/src/digital-twin/runtime/ComponentProcessRuntime.ts` | 绑定判断、运输对象与工位联动 |
| 多对象工位管理 | `ClientApp/src/digital-twin/runtime/ProcessStationManager.ts` | 工位容量、队列和实体状态机 |
| 总运行时 | `ClientApp/src/digital-twin/runtime/TwinRuntime.ts` | 渲染循环、绑定、路线、工艺和行为的调用顺序 |
| 服务端 Manifest 校验 | `IoTSharp/Services/DigitalTwin/TwinManifestInspector.cs` | 保存/发布时的结构、安全和引用校验 |
| 实时快照 | `IoTSharp/Services/DigitalTwin/TwinRuntimeSnapshotService.cs` | 遥测、属性、在线、告警快照 |
| 实时接口 | `IoTSharp/Controllers/TwinRuntimeController.cs` | 当前只有 snapshot 能力 |
| 路线与绑定持久化 | `IoTSharp.Data/TwinRoute.cs`、`TwinObjectBinding.cs` | 定义投影、版本归属、租户隔离 |

---

## 3. 当前能力盘点

### 3.1 已具备的可复用能力

当前实现不是推倒重来，以下基础应直接复用：

- 三维对象、程序化组件和普通 GLB/GLTF 对象统一进入 Manifest。
- WorkPoint 可表达设备目标点和节点路径。
- MaterialSlot 可表达来源位、目标位、缓存位和容量。
- ToolFrame 可表达机器人/桁架末端执行器参考坐标。
- Actuator 与 Pose 已能描述轴、关节和目标姿态。
- Interlock 已有信号条件、超时和诊断的基本数据结构。
- Behavior 已支持 moveTo、movePose、jointMove、axisMove、pick、place、gripOpen、gripClose、waitSignal、wait、prepareSlot、home、attach、detach。
- 路线已有数据库实体、版本关系、GraphPayload 和发布复制流程，可作为 Action Flow 持久化的参考样板。
- 设备/资产遥测、属性、在线和告警已有统一绑定入口。
- ProcessStationManager 已经具备按运输对象创建状态机和工位容量的雏形。

### 3.2 当前适合的使用边界

当前 Behavior 更适合：

- 编辑阶段的设备动作预览；
- 单机器人或单桁架的线性演示；
- 不跨浏览器恢复的短时模拟；
- 对动作编排进行概念验证。

当前实现尚不应直接承担：

- 生产环境的跨设备流程控制；
- 带并行、岔路、资源互锁的完整包装线调度；
- 需要断电/重启续跑的任务；
- 需要严格审计、幂等、补偿和人工确认的动作；
- 直接用浏览器向 PLC 写控制位。

---

## 4. 问题清单与优先级

### 4.1 P0：影响正确性、发布安全和实时运行

| 编号 | 问题 | 当前表现 | 风险 | 处理建议 |
| --- | --- | --- | --- | --- |
| AF-P0-01 | 服务端未完整校验动作编排 | `TwinManifestInspector` 主要校验 resources、objects、connections、bindings、routes | 错误动作引用可能被保存或发布 | 后端实现与前端一致且更严格的 Action Flow/Behavior 校验器 |
| AF-P0-02 | Behavior 级联锁没有真正阻止启动 | `behavior.interlockIds` 主要用于展示，动作选择时未形成统一准入门 | 设备未就绪时仍可能进入流程 | 编译后在 Flow Start 和每个危险动作前生成 Guard |
| AF-P0-03 | 模拟/实时模式判定混用 | ComponentProcessRuntime 根据“是否配置绑定”推断 live | 配了绑定的模拟场景可能卡住；未配绑定的实时场景可能自运行 | 只允许由场景 RuntimeMode 决定模式，绑定完整性作为校验项 |
| AF-P0-04 | 超时定义未形成统一语义 | process timeout、部分 action timeout、durationSeconds 未被完整执行 | 等待永久挂起，故障不能明确归因 | 所有阻塞节点必须有超时策略；编译器补默认值并生成超时边 |
| AF-P0-05 | Busy 信号未进入状态转换 | busyBindingId 可配置但状态机未完整使用 | 无法区分 PLC 未接单、正在动作和动作完成 | 使用 CommandAck、Busy、Done、Fault 的标准握手模板 |
| AF-P0-06 | 浏览器是运行状态载体 | 页面刷新后通道、步骤、物料归属丢失 | 无法生产使用，重复动作风险高 | 实时运行状态迁入服务端并持久化事件 |
| AF-P0-07 | 实时 Behavior 无完整闭环 | live 下不执行模拟动作，也没有服务端命令执行器 | 页面显示“实时”但动作链并未被真正编排 | 建立 Published Flow → Run → Command → Ack → Event 链路 |
| AF-P0-08 | 物料归属依赖 Three.js 节点 | attach/detach 和批次信息部分存于 `root.userData` | 画面对象与真实托盘/丝锭可能错配 | 建立 TransportUnit/MaterialInstance 运行状态及原子转移事件 |
| AF-P0-09 | 故障恢复只有整体重置 | 通道进入 error 后缺少 retry/resume/compensate | 短暂信号异常会导致整线人工重开 | 增加步骤重试、从安全点恢复、补偿、人工确认和取消 |

### 4.2 P1：影响复杂产线表达和长期维护

| 编号 | 问题 | 优化方向 |
| --- | --- | --- |
| AF-P1-01 | 只支持顺序数组 | 升级为节点/边流程图，支持条件、并行、汇合、子流程 |
| AF-P1-02 | 多套运行时职责重叠 | 收敛 Route、Process、Behavior、程序化产线之间的状态所有权 |
| AF-P1-03 | 多路线仍有 primary route 假设 | 建立 TwinRouteRuntimeManager，按 routeId 管理多个路线实例 |
| AF-P1-04 | 通过 `userData` 隐式耦合 | 使用 Runtime Store 和显式领域事件通信 |
| AF-P1-05 | 缺少资源锁与预占 | 增加设备锁、工位容量、路线区段和物料槽预留 |
| AF-P1-06 | 缺少运行历史 | 增加 Run、Step、Event、Command、Alarm 全链路记录 |
| AF-P1-07 | 缺少定义编译 | 草稿图不能直接运行，发布时编译为不可变执行计划 |
| AF-P1-08 | 客户端/服务端规则可能漂移 | 共享规则编号和 JSON Schema 测试向量，后端作为最终裁决 |

### 4.3 P2：影响编辑效率和调试体验

| 编号 | 问题 | 优化方向 |
| --- | --- | --- |
| AF-P2-01 | 动作靠长表单上下排列 | 增加图形画布、节点连线、缩略图、缩放和自动布局 |
| AF-P2-02 | 3D 对象与动作关系不直观 | 双向定位：选流程节点高亮对象/工作点，选对象过滤相关流程 |
| AF-P2-03 | 无断点和单步调试 | 模拟器增加断点、单步、继续、倍速和时间线 |
| AF-P2-04 | 缺少标准流程模板 | 提供机器人取放、桁架码垛、工位握手、岔口分流等模板 |
| AF-P2-05 | 错误提示位置分散 | 画布节点、属性项、发布面板同时显示同一诊断编号 |
| AF-P2-06 | 批量配置能力不足 | 结合 3D 多选，为多个对象批量创建 Actor、Binding 和流程模板 |

---

## 5. 目标架构

### 5.1 六层职责

| 层 | 职责 | 不应承担的职责 |
| --- | --- | --- |
| 3D 编辑层 | 对象、工作点、工具坐标、物料槽、路线和动作图的可视化编辑 | 不直接控制生产设备 |
| 合同层 | Action Flow V2、绑定引用、状态和事件的稳定协议 | 不包含运行时对象、函数或凭据 |
| 校验/编译层 | 引用检查、图检查、安全检查，生成确定执行计划 | 不依赖 Three.js 网格实例 |
| 模拟运行层 | 浏览器内确定性仿真、断点、倍速、测试数据 | 不冒充真实 PLC 成功结果 |
| 实时编排层 | 服务端运行实例、锁、命令、确认、超时、恢复、审计 | 不代替 PLC 的设备安全逻辑 |
| 可视化投影层 | 将运行事件映射为 3D 动画、状态颜色和面板数据 | 不作为生产状态唯一真相 |

### 5.2 三类权威状态

必须明确“谁说了算”：

| 数据 | 模拟模式 | 实时模式 |
| --- | --- | --- |
| 流程当前步骤 | 前端模拟执行器 | 服务端 ActionFlowRun |
| 设备实际动作 | Three.js 动画 | PLC/机器人控制器反馈 |
| 物料实际位置 | 模拟 Runtime Store | PLC/WCS/MES 事件与服务端物料状态 |
| 3D 网格位置 | 模拟结果 | 真实状态的视觉投影 |
| 超时/故障 | 模拟时钟 | 服务端时钟 + 设备 Fault/Alarm |
| 发布版本 | 服务端数据库 | 服务端数据库 |

浏览器绝不能在实时模式下因为“没收到数据”而自行把动作判定为完成，也不能通过 Three.js 动画结束事件反向证明设备已经完成。

---

## 6. Action Flow V2 数据合同

### 6.1 为什么采用图而不是继续扩展数组

继续向 `actions[]` 增加 `if/else` 字段会很快产生嵌套、跳转索引和不可维护的异常分支。V2 使用显式节点和边：

- 节点负责一个明确职责；
- 边负责流程走向；
- 条件使用结构化谓词；
- 并行通过 Fork/Join 明确表达；
- 超时、失败和补偿有独立端口；
- 发布时编译为执行计划，运行时不解释任意脚本。

### 6.2 推荐节点类型

| 分类 | 节点 | 用途 |
| --- | --- | --- |
| 控制 | Start、End、Merge | 开始、结束、多路径汇合 |
| 分支 | Condition、Switch | 按绑定值、物料属性、流程变量选择路径 |
| 并行 | ParallelFork、ParallelJoin | 并行启动及 all/any/quorum 汇合 |
| 动作 | MoveTo、MovePose、JointMove、AxisMove、Home | 机器人、桁架、旋转台、提升机动作 |
| 夹具 | GripOpen、GripClose、Attach、Detach | 夹具与物料转移 |
| 物料 | PrepareSlot、ReserveSlot、TransferMaterial、ReleaseSlot | 容量和物料所有权管理 |
| 输送 | ReserveSection、EnterSection、LeaveSection、SelectRoute | 防碰撞、岔口和路线区段控制 |
| 信号 | WaitSignal、WriteCommand、WaitAck | PLC/WCS 标准握手 |
| 时间 | Delay、Deadline | 延时及总时限 |
| 复用 | Subflow | 调用已发布子流程 |
| 运维 | ManualConfirm、RaiseAlarm、Compensate | 人工介入、告警和补偿 |

第一阶段不建议开放任意脚本节点，也不接受 JavaScript 表达式。复杂计算通过已注册、已审核、带版本的服务器扩展节点实现。

### 6.3 建议 TypeScript 合同

```ts
export interface TwinActionFlowDefinitionV2 {
  flowId: string;
  key: string;
  name: string;
  contractVersion: '2.0';
  actorObjectIds: string[];
  variables: TwinFlowVariableDefinition[];
  nodes: TwinActionFlowNode[];
  edges: TwinActionFlowEdge[];
  policies: TwinActionFlowPolicies;
  enabled: boolean;
  revision: number;
}

export interface TwinActionFlowNode {
  nodeId: string;
  type: TwinActionFlowNodeType;
  name: string;
  actorObjectId?: string;
  config: Record<string, unknown>;
  retryPolicy?: TwinRetryPolicy;
  timeoutPolicy?: TwinTimeoutPolicy;
  compensationNodeId?: string;
  editor?: { x: number; y: number; collapsed?: boolean };
}

export interface TwinActionFlowEdge {
  edgeId: string;
  sourceNodeId: string;
  sourcePort: 'success' | 'failure' | 'timeout' | 'true' | 'false' | string;
  targetNodeId: string;
  priority?: number;
  isDefault?: boolean;
  predicate?: TwinPredicateGroup;
}

export interface TwinPredicateGroup {
  logic: 'and' | 'or';
  items: Array<TwinPredicateGroup | {
    source: 'binding' | 'variable' | 'material' | 'runtime';
    ref: string;
    operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'changed' | 'risingEdge';
    value?: string | number | boolean | Array<string | number>;
  }>;
}
```

约束：

- `config` 必须按 node.type 使用受控 Schema 校验，不能保存任意对象后直接执行。
- 条件只能引用已声明变量、绑定、物料字段或运行上下文。
- 凭据只存在于服务端设备/连接配置，流程图不得保存 Token。
- `editor` 仅影响画布布局，不参与执行哈希。
- 发布生成 `graphHash` 和 `compiledPlanHash`，运行实例必须记录两者。

### 6.4 PLC 工位握手示例

以“套袋机处理一个托盘”为例，流程不是看到 Ready 就直接延时完成，而应是：

```text
Start
  → ReserveSlot(套袋机入口)
  → WaitSignal(machine.ready == true)
  → WriteCommand(commandId, palletId, recipeId, start = true)
  → WaitAck(ack.commandId == commandId)
  → WaitSignal(machine.busy risingEdge)
  → WaitSignal(machine.done && result.commandId == commandId)
  → TransferMaterial(入口槽 → 出口槽)
  → WriteCommand(start = false)
  → ReleaseSlot
  → End

任一步骤 timeout/fault
  → RaiseAlarm
  → SafeStop/Compensate
  → ManualConfirm 或 RetryFromCheckpoint
```

这能避免旧完成信号残留导致新托盘被立即判定完成。

---

## 7. 定义、运行和步骤状态机

### 7.1 定义生命周期

```text
Draft → Validated → Published → Retired
  ↑         │            │
  └──修改───┘            └──不可原地修改，只能创建新版本
```

- Draft 可编辑，不可用于实时生产。
- Validated 表示当前修订通过静态校验和编译。
- Published 是不可变定义，绑定具体场景版本。
- Retired 禁止创建新 Run，但历史 Run 可继续查询。

### 7.2 运行实例状态

```text
Created → Ready → Running → Completed
                    │
                    ├→ WaitingSignal → Running
                    ├→ WaitingResource → Running
                    ├→ Paused → Running
                    ├→ Recovering → Running/Faulted
                    ├→ Faulted
                    └→ Cancelled
```

### 7.3 步骤状态

```text
Pending → Ready → Running → Succeeded
                    │
                    ├→ Waiting → Running
                    ├→ Failed → Ready（按重试策略）
                    ├→ Compensating → Compensated
                    └→ Skipped
```

所有状态转换都必须写入不可变事件，并带 `runId`、`stepInstanceId`、`sequence`、`occurredAt`、`correlationId` 和操作者/来源。

---

## 8. 实时编排可靠性设计

### 8.1 标准标识

| 标识 | 作用 |
| --- | --- |
| sceneVersionId | 固定本次运行的场景版本 |
| flowVersionId | 固定本次运行的流程版本 |
| runId | 一次完整流程运行 |
| stepInstanceId | 一次步骤尝试 |
| correlationId | 贯穿命令、PLC 回执、遥测和告警 |
| commandId | 一次设备命令，必须幂等 |
| transportUnitId | 小托盘、木托盘、丝车等运输单元 |
| materialInstanceId | 单个丝锭、隔板、天盖或批次 |
| reservationId | 工位槽/路线区段/设备资源预占 |

### 8.2 幂等与乱序

- 同一个 commandId 重复下发，设备适配器必须返回同一接收结果，不重复启动。
- 遥测事件按设备时间和服务端接收时间记录，运行判断使用递增 sequence 或 PLC cycleId。
- Ack/Done 必须能关联当前 commandId 或 cycleId；不允许只看一个长期为 true 的布尔位。
- 服务端使用乐观并发版本更新 Run，避免双实例同时推进同一步骤。
- Outbox 负责可靠发布命令/事件，Inbox 负责命令或回执去重。

### 8.3 锁与资源预占

至少实现四类锁：

1. Actor Lock：同一机器人/桁架/旋转台同一时刻只能被一个互斥流程控制。
2. Slot Reservation：目标物料槽必须先预留，放置成功后再提交占用。
3. Route Section Reservation：托盘进入共享或交叉区段前必须预占，离开后释放。
4. Material Ownership：夹具、工位和路线对同一物料的所有权转移必须原子完成。

预留必须有 lease 到期时间和心跳，服务重启后根据持久化事件恢复；不能只存在于内存或 Mesh.userData。

### 8.4 重试、恢复和补偿

每个节点可配置：

- 最大尝试次数；
- 固定或指数退避；
- 哪些错误允许自动重试；
- 重试前是否重新读取设备状态；
- 安全检查点；
- 补偿节点；
- 超时后 Fault、Skip、Compensate 或 ManualConfirm。

设备动作不能盲目重发。恢复时先执行状态对账：确认夹具是否有料、托盘是否在位、轴是否在安全区、旧 commandId 是否已完成，再决定继续、补偿或人工处理。

---

## 9. 物料与动画一致性

用户此前关注的“物料瞬移、重叠和穿越”本质上也属于流程编排问题。建议引入显式物料状态：

```ts
interface TwinMaterialRuntimeState {
  materialInstanceId: string;
  transportUnitId?: string;
  ownerType: 'route' | 'slot' | 'tool' | 'buffer' | 'external';
  ownerId: string;
  poseSource: 'telemetry' | 'kinematic' | 'interpolated';
  state: 'reserved' | 'inTransit' | 'placed' | 'blocked' | 'unknown';
  revision: number;
}
```

执行规则：

- Pick 只有在工具到达抓取容差、来源槽确认有料、夹具确认闭合后才提交所有权转移。
- Attach 是视觉层对“物料已属于工具”的投影，不是判定抓取成功的依据。
- Place 只有在工具到达放置容差、目标槽仍有效、夹具确认打开后提交转移。
- Detach 与目标槽占用在同一个服务端事务/事件批次中完成。
- 动画从上一条真实/确认姿态插值到新姿态，缺失遥测时显示“估算”状态，不伪装为实测。
- 路线上每个托盘必须保留独立 transportUnitId，合流时只改变所属路线/区段，不合并实体。
- 交叉口和共享区段必须先预占后进入，从编排层保证无重叠，而不是仅在渲染层把模型错开。

---

## 10. 数据库设计

### 10.1 定义表

`TwinActionFlow` 建议参照 TwinRoute：

| 字段 | 说明 |
| --- | --- |
| Id | 数据库主键 |
| SceneId | 所属场景 |
| SceneVersionId | 草稿为空，发布后指向不可变场景版本 |
| FlowKey / Name | 业务键和名称 |
| ContractVersion | 协议版本，如 2.0 |
| ActorScope | 涉及的对象摘要 |
| GraphPayload | 完整流程图 JSON |
| GraphHash | 排除编辑布局后的定义哈希 |
| CompiledPayload | 编译执行计划 |
| CompiledPlanHash | 执行计划哈希 |
| Revision | 草稿乐观并发版本 |
| Enabled / IsDeleted | 启用和软删除 |
| TenantId / CustomerId | 租户和客户隔离 |
| CreatedBy/At、UpdatedBy/At | 审计字段 |

草稿 Manifest 仍保存完整 Action Flow，以保证场景保存的原子性；保存后同步投影到 TwinActionFlow。发布时像 Route/Binding 一样复制到 SceneVersion。

### 10.2 运行表

| 表 | 关键内容 |
| --- | --- |
| TwinActionFlowRun | runId、版本、状态、输入、当前序列、开始/结束、故障、并发版本 |
| TwinActionFlowRunStep | 节点实例、尝试次数、状态、输入/输出摘要、deadline、错误 |
| TwinActionFlowEvent | 仅追加事件流、sequence、类型、payload、来源、时间 |
| TwinDeviceCommand | commandId、bindingId、payload hash、状态、发送/确认时间 |
| TwinResourceReservation | 资源类型/id、ownerRunId、lease、状态、版本 |
| TwinMaterialRuntime | 物料/托盘、当前位置、所有权、状态、版本 |

运行大载荷和长期事件可设置归档策略，但 Run 摘要、最终结果和告警关联必须长期可查。

### 10.3 多数据库迁移

IoTSharp 支持的数据库提供程序必须同步迁移，至少覆盖当前实际使用的 SQL Server，并保持 SQLite/PostgreSQL/MySQL/Oracle/SonnetDB 的模型快照一致。JSON 大字段、索引长度、并发标记和时间精度需按提供程序适配，不能只在开发库验证。

---

## 11. 服务端 API 设计

建议统一在 `/api/digital-twin/action-flows`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/validate` | 校验草稿并返回诊断编号和定位 |
| POST | `/compile` | 编译流程图，返回执行计划摘要 |
| GET | `/{flowId}` | 读取草稿或已发布定义 |
| POST | `/{flowId}/runs` | 基于发布版本创建运行实例 |
| GET | `/runs/{runId}` | 获取运行快照 |
| GET | `/runs/{runId}/events` | 按 sequence 增量获取事件 |
| POST | `/runs/{runId}/pause` | 请求安全暂停 |
| POST | `/runs/{runId}/resume` | 对账后恢复 |
| POST | `/runs/{runId}/cancel` | 请求安全取消和补偿 |
| POST | `/runs/{runId}/steps/{stepId}/retry` | 经权限检查后重试步骤 |
| POST | `/runs/{runId}/manual-confirm` | 人工确认并记录原因 |

进一步使用 SignalR 推送 RunEvent。页面断线重连时先按最后 sequence 补拉，再进入实时订阅，避免状态缺口。

权限要求：

- 场景查看者只能查看定义和运行状态；
- 场景编辑者可以保存草稿和模拟；
- 发布者可以校验、编译和发布；
- 操作员可以启动、暂停和恢复授权流程；
- 管理员可强制终止，但必须填写原因；
- 所有查询和操作都校验 TenantId/CustomerId/SceneId，不因超级管理员能力而绕开审计。

---

## 12. 服务端发布校验规则

客户端校验用于即时反馈，服务端校验是最终安全边界。建议使用稳定编号：

### 12.1 结构规则

- AF1001：flowId/key 重复。
- AF1002：节点 ID 或边 ID 重复。
- AF1003：缺少且只能有一个 Start。
- AF1004：不存在可达 End。
- AF1005：边引用不存在节点或端口。
- AF1006：出现未注册节点类型。
- AF1007：存在不可达节点。
- AF1008：存在无受控退出的环。
- AF1009：ParallelJoin 与 Fork 不匹配。

### 12.2 引用规则

- AF1101：actorObjectId 不存在或对象禁用。
- AF1102：nodePath 在组件实例中不存在。
- AF1103：workPoint/pose/actuator/toolFrame/slot 不存在。
- AF1104：bindingId 不存在、已删除或越租户。
- AF1105：Subflow 版本不存在、未发布或形成递归环。
- AF1106：路线/区段引用不存在。

### 12.3 动作规则

- AF1201：危险动作缺少联锁。
- AF1202：阻塞动作缺少有限超时策略。
- AF1203：Pick/Place 的来源、目标、载荷和工具类型不兼容。
- AF1204：Move 动作目标坐标、速度或轴范围非法。
- AF1205：失败/超时端口没有处理且策略不允许终止。
- AF1206：同一路径重复占用互斥 Actor。
- AF1207：并行分支可能竞争同一资源且没有锁。
- AF1208：实时流程存在模拟专用节点。

### 12.4 安全规则

- AF1301：发现函数、脚本、可执行表达式。
- AF1302：发现外部 URL、data URL 或未登记资源。
- AF1303：发现访问令牌、密码或连接串形态字段。
- AF1304：节点类型或版本未列入服务器允许清单。
- AF1305：流程体积、节点数或嵌套深度超限。

发布失败必须返回诊断数组，而不是拼接为一条难定位的错误文本；每条包含 code、severity、flowId、nodeId/edgeId、propertyPath、message 和 suggestion。

---

## 13. 编辑器交互方案

### 13.1 页面布局

专业编辑页建议提供三个工作区模式：

1. 3D：专注搭建场景。
2. 流程：专注编排和校验。
3. 分屏：左侧/上方 3D，右侧/下方流程图，支持拖动分隔条。

流程模式结构：

```text
┌──────────────┬─────────────────────────────────┬──────────────┐
│ 节点/模板库   │           流程画布               │ 节点属性      │
│ 搜索/分类     │ 缩放、框选、连线、缩略图、面包屑 │ 绑定/超时/重试│
├──────────────┴─────────────────────────────────┴──────────────┤
│ 诊断列表 | 运行时间线 | 变量/信号 | 资源锁 | 物料归属           │
└──────────────────────────────────────────────────────────────┘
```

左右和底部面板均应可独立收缩，收缩不能卸载或隐藏 3D 主视图。

### 13.2 3D 与流程双向联动

- 在 3D 里选择机器人，流程画布筛选或高亮所有使用该 Actor 的节点。
- 在流程里选择 MoveTo，3D 高亮 Actor、目标 WorkPoint 和运动预览线。
- 编辑 Pick/Place 时，3D 显示来源槽、目标槽、工具中心点和容差范围。
- 选择路线区段预留节点时，高亮对应路线和冲突区。
- 使用 3D 多选后可批量生成 Actor 列表、统一设置标签或应用流程模板，但不能把不同设备错误合并成一个运行 Actor。

### 13.3 图编辑基础操作

- 节点库拖入画布；
- 端口连线和连接兼容性提示；
- 框选、Shift/Ctrl 增减选择、整体移动、复制、对齐和分布；
- 撤销/重做必须覆盖节点、边和属性修改；
- 自动布局只修改 editor 坐标，不改变执行定义；
- 节点折叠、分组和注释不参与发布执行；
- 删除被引用节点时明确展示受影响边、补偿和子流程；
- 保存前增量校验，发布前全量服务端校验和编译。

### 13.4 调试器

仅在“运行预览”显示运行状态，专业编辑默认不占用 3D 空间。模拟调试器支持：

- 开始、暂停、继续、停止、单步进入、单步跳过；
- 0.25x、0.5x、1x、2x、5x 倍速；
- 节点断点和条件断点；
- 当前节点、已完成路径和等待原因高亮；
- 信号注入面板，并明确标记为模拟数据；
- 运行时间线、变量快照、资源锁和物料归属；
- 导出可复现的模拟输入和事件记录。

实时模式只能显示真实状态及经授权的操作按钮，不能提供“跳过设备完成信号”的普通按钮。

---

## 14. 标准模板

首批应内置以下模板，减少用户从空白图开始：

### 14.1 机器人取放

Ready → 来源有料 → 目标可用 → 到待机位 → 到抓取位 → 夹紧确认 → 提升 → 到放置位 → 松开确认 → 返回 Home。

### 14.2 桁架码垛

层/列/行变量 → 计算受控目标 Pose → 轴互锁 → 抓取 → X/Z 或多轴移动 → 放置 → 更新托盘层位 → 判断满托 → 进入换托分支。

目标 Pose 由参数化算法节点或已审核服务生成，不允许场景内嵌脚本。

### 14.3 工艺设备握手

预留入口 → Ready → 下发 commandId/recipe → Ack → Busy → Done/Result → 释放出口；Fault/Timeout 进入告警和恢复。

### 14.4 岔口分流

识别 transportUnitId → 读取工艺属性 → 计算目标路线 → 预占岔口和下游区段 → 切换道岔 → 到位确认 → 放行 → 离开确认 → 释放资源。

### 14.5 空托盘回流

进外检前判断载荷 → 空托盘进入反向回流 → 分区预占 → 回到机器人下方入口 → 与来料路径互锁 → 恢复可用托盘状态。

---

## 15. 与现有 Behavior V1 的兼容迁移

### 15.1 自动转换

旧 `behavior.actions[]` 可自动转换为线性 V2 图：

```text
Start → Action[0] → Action[1] → ... → Action[n] → End
```

- `behavior.interlockIds` 转换为 Start Guard；
- action.interlockId 转换为节点 Guard；
- action.timeoutSeconds 转换为 TimeoutPolicy；
- onStartState/onCompleteState 转换为受控 SetSemanticState 节点或步骤副作用；
- loop 转换为有边界的循环策略，禁止无限生产循环未经服务器调度直接执行；
- selectionWeight 转换为显式 Switch/WeightedChoice 节点，仅允许在模拟或明确授权的业务场景使用。

### 15.2 双读单写策略

建议迁移顺序：

1. 运行时同时读取 Behavior V1 和 Action Flow V2，V2 优先。
2. 打开旧场景时提示“一键转换”，转换前保留原定义。
3. 新建流程只写 V2。
4. V2 稳定后，BehaviorRuntime 改为 V1 Adapter，内部也编译成统一执行计划。
5. 停止新增 V1 功能，但长期保留旧场景只读和转换能力。

---

## 16. 代码实施位置

### 16.1 前端新增

建议目录：

```text
ClientApp/src/digital-twin/action-flow/
├─ contracts/action-flow-v2.ts
├─ schema/
├─ validation/ActionFlowValidator.ts
├─ compiler/ActionFlowCompiler.ts
├─ runtime/SimulationFlowRuntime.ts
├─ runtime/RuntimeEventProjector.ts
├─ migration/BehaviorV1Migrator.ts
├─ templates/
└─ components/
   ├─ ActionFlowDesigner.vue
   ├─ ActionNodePalette.vue
   ├─ ActionFlowCanvas.vue
   ├─ ActionNodeInspector.vue
   ├─ ActionFlowDiagnostics.vue
   └─ ActionFlowDebugger.vue
```

修改：

- `contracts/index.ts`：Manifest 增加 `actionFlows`，保留 behaviors。
- `workbench.vue`：增加 3D/流程/分屏模式和双向选择，但不得删除或弱化现有 3D 专业编辑入口和功能。
- `TwinRuntime.ts`：从直接持有多个领域状态改为协调 Runtime Store 和事件投影。
- `BehaviorRuntime.ts`：逐步降级为 V1 兼容适配器。
- `ComponentProcessRuntime.ts`：RuntimeMode 改为显式输入，不再通过绑定存在性推断。
- `ComponentProcessStateMachine.ts`：接入 Busy、Timeout、Ack、CycleId 和恢复状态。
- `ProcessStationManager.ts`：改为使用统一资源预留服务，移除业务语义 userData 耦合。

### 16.2 后端新增

建议新增：

```text
IoTSharp.Data/
├─ TwinActionFlow.cs
├─ TwinActionFlowRun.cs
├─ TwinActionFlowRunStep.cs
├─ TwinActionFlowEvent.cs
├─ TwinDeviceCommand.cs
├─ TwinResourceReservation.cs
└─ TwinMaterialRuntime.cs

IoTSharp/Services/DigitalTwin/ActionFlow/
├─ TwinActionFlowValidator.cs
├─ TwinActionFlowCompiler.cs
├─ TwinActionFlowDefinitionService.cs
├─ TwinActionFlowRuntimeService.cs
├─ TwinDeviceCommandService.cs
├─ TwinResourceReservationService.cs
└─ TwinRuntimeRecoveryService.cs

IoTSharp/Controllers/
└─ TwinActionFlowsController.cs
```

同时修改：

- `ApplicationDbContext.cs` 和 `DigitalTwinConfiguration.cs`；
- 各数据库迁移与模型快照；
- `DigitalTwinSceneService.cs`，在草稿保存/发布/回滚时同步流程定义；
- `TwinManifestInspector.cs`，接入服务端动作编排校验；
- `TwinRuntimeController.cs` 或新控制器，提供运行、事件和恢复接口；
- DI、权限策略、审计日志和 SignalR Hub 注册。

---

## 17. 分阶段实施计划

### 阶段 A：先修现有正确性（P0 收口）

目标：即使尚未上线图形编排，也不能继续保留已知错误语义。

- RuntimeMode 由场景模式显式传入。
- Behavior 级联锁在启动和动作执行前真正检查。
- 启用 busyBindingId、process timeout 和 action timeout。
- wait/waitSignal 均有有限等待策略。
- 完成信号改用 risingEdge/cycleId，避免旧高电平误触发。
- 故障状态增加受控 reset/retry，禁止静默自动恢复。
- 后端补齐 V1 动作对象的发布校验。
- 清理关键流程对 Three.js userData 的业务状态依赖。

阶段验收：旧场景行为不回归；错误引用无法发布；模拟/实时不会互相串模式；等待必然完成、超时或进入明确人工态。

### 阶段 B：Action Flow V2 编辑与模拟

- 完成合同、Schema、客户端校验和编译器。
- 完成节点图、属性面板、双向 3D 定位。
- 完成 V1 自动迁移。
- 完成确定性模拟器、断点和运行时间线。
- 加入四个首批工业模板。
- 对现有 3D 专业编辑功能执行完整回归，确保模型库、场景树、属性、Route、Binding、吸附、多选、撤销重做、运行预览、保存、发布和回滚均无回退。

阶段验收：能图形化表达分支、并行、汇合、超时和补偿；同一输入事件记录可重复得到同一模拟结果；新增流程工作区不破坏原 3D 工作区。

### 阶段 C：数据库投影与发布闭环

- 新增定义表和多数据库迁移。
- 草稿保存同步投影；发布生成不可变流程版本。
- 后端完整校验和编译，前后端共用测试向量。
- 场景中心能查看发布版本中的流程摘要和诊断。

阶段验收：前端被绕过时后端仍能拒绝非法流程；发布版本可追溯且不可原地修改；回滚恢复对应流程版本。

### 阶段 D：实时编排与故障恢复

- Run/Step/Event/Command/Reservation/Material 持久化。
- 标准 PLC 握手、命令幂等、事件去重和乱序处理。
- Actor/Slot/Section/Material 资源锁。
- 服务重启恢复、状态对账、人工确认、补偿。
- SignalR 运行事件和 3D 投影。

阶段验收：服务重启不重复执行已完成设备动作；同一托盘不会同时存在于两个槽；重复遥测/回执不重复推进；故障恢复全过程可审计。

### 阶段 E：规模化与运维

- 多路线 Runtime Manager。
- 流程版本差异、运行回放、指标和告警。
- 大场景图编辑性能优化、流程模板市场和扩展节点治理。
- 历史事件归档、运行报表和瓶颈分析。

---

## 18. 测试与验收方案

### 18.1 单元测试

- 节点/边重复、悬空引用、不可达节点、受控循环、Fork/Join。
- WorkPoint/Pose/Actuator/Slot/ToolFrame/Binding 引用。
- 结构化条件的每种操作符及类型不匹配。
- 超时、重试、补偿和取消状态转换。
- Command/Ack/Done 的 correlationId 和 cycleId。
- 资源预留的并发、租约过期和释放。
- V1 → V2 迁移前后语义等价。

### 18.2 确定性模拟测试

- 相同 Manifest、初始状态、随机种子和信号序列产生相同事件序列。
- 机器人抓取期间物料持续跟随工具，不瞬移。
- 50 个托盘经过分流、合流和交叉口不重叠、不穿越、不合并实体。
- 空托盘在外检前进入反向回流并回到机器人下方。
- 并行分支在 Join 条件未满足前不得继续。
- 目标槽已占用时流程进入 WaitingResource，而不是强行放置。

### 18.3 服务端集成测试

- 草稿、校验、发布、回滚后定义和哈希一致。
- 非法流程不能通过直接 API 发布。
- 租户/客户越权读取和启动被拒绝。
- 重复启动请求使用幂等键只创建一个 Run。
- 服务在命令发出、Ack、Busy、Done 各阶段重启后均能正确恢复。
- 重复、延迟、乱序、缺失的设备事件不会导致重复动作。
- SQL Server 迁移、索引和并发更新通过；其他支持库执行对应兼容测试。

### 18.4 UI 端到端测试

Action Flow UI 新增测试：

- 节点拖入、连线、框选、整体移动、复制、撤销/重做。
- 3D 对象与流程节点双向高亮。
- 面板收缩不导致 Three 视图卸载或尺寸为零。
- 错误节点能从发布诊断直接定位。
- 模拟断点、单步、倍速和时间线正确。
- 刷新运行预览后从服务端恢复到相同 runId 和 sequence。

3D 原功能强制回归：

- 模型资源库、V7 组件、GLB 模型拖入/放入正常。
- 场景树、对象改名、根选择/节点选择正常。
- 移动、旋转、缩放、相机交互正常。
- “框选多选”仅在显式启用时接管左键，默认左键旋转视角不被抢占。
- Ctrl/Shift 多选、整体移动、撤销/重做、复制、删除正常。
- 组件 Port 自动吸附、Connection 生成和移动后重校验正常。
- 小托盘、木托盘、纸箱的路线吸附规则正常。
- Route/Section/Capacity/岔口/分流/合流编辑正常，自动路线保持只读。
- 属性面板和动态组件属性正常。
- Device / Telemetry Binding 新增、保存、重新加载正常。
- 运行预览、Simulation/Live 切换、运行/暂停正常。
- 点击机器人、桁架、外检机、托盘等业务对象时状态浮窗显示正确，并继续跟随模型位置。
- 新建空白场景不会自动带入旧整机、托盘或路线。
- 保存草稿、场景校验、发布、查看线上版本、版本与回滚、导出 Manifest 正常。
- “完整工艺 V6”“参考图双套袋产线”等既有入口仍可使用。
- 未创建/未迁移 Action Flow V2 的旧场景仍可正常编辑、保存、发布和运行预览。

### 18.5 真实设备 Smoke Test

自动化测试中的 Mock PLC、Stub MQTT 和虚拟时钟必须明确标记为测试替身，不能作为真实联调通过的证明。生产验收还需在隔离测试线完成：

- IoTSharp → 设备适配器 → PLC 命令；
- PLC Ack/Busy/Done/Fault → MQTT/采集 → IoTSharp；
- SQL Server 中 Run/Step/Event/Command 记录；
- 浏览器刷新、服务重启、MQTT 短时断线和 PLC 高电平残留；
- 急停、安全门和设备本地模式下 IoTSharp 不得绕过设备安全逻辑。

本文件只定义真实联调方案，不代表真实 PLC 联调已经执行。

---

## 19. 性能和可观测性指标

建议初始目标：

- 编辑器 3D 渲染维持 30 FPS 以上，流程图编辑和运行状态更新不阻塞渲染线程。
- 前端运行投影与后端事件解耦，状态批量应用，避免每条遥测触发整棵 Vue 树更新。
- 服务端每个 Run 使用顺序事件序列，跨 Run 可并行。
- 运行事件端到端显示延迟建立 P50/P95/P99 指标。
- 指标至少包含运行数、等待信号时长、资源等待时长、动作超时、重试、补偿、设备命令延迟和事件积压。
- 日志必须可用 sceneId、flowVersionId、runId、commandId、transportUnitId 检索。

不建议在没有压测数据前承诺固定节点数和并发规模；应使用目标产线场景建立基准，例如双套袋环线、50 托盘、多个共享区段和机器人/桁架并发动作。

---

## 20. 风险与控制

| 风险 | 控制措施 |
| --- | --- |
| 图形编辑器功能过大 | 先实现固定节点和模板，不开放任意脚本/插件 |
| 前后端语义不一致 | 使用同一合同版本、诊断编号和共享 JSON 测试向量 |
| 重构破坏现有场景 | V1 Adapter、自动迁移、双读和回归快照；Action Flow 只能增量增强，禁止删除或弱化现有 3D 功能 |
| PLC 协议差异大 | 统一命令/回执领域合同，由设备适配器映射 |
| 运行状态与画面漂移 | 服务端事件为实时权威，3D 只做可重建投影 |
| 资源死锁 | 全局资源排序、有限 lease、等待图检测和人工释放审计 |
| 发布后被修改 | 版本不可变、定义哈希和编译计划哈希 |
| 凭据泄漏到场景 | 流程只存 bindingId，服务端扫描敏感字段并拒绝发布 |

---

## 21. 完成定义（Definition of Done）

动作流程编排功能只有同时满足以下条件才算完成：

- [ ] 旧 Behavior 场景可打开、模拟并一键转换。
- [ ] **Action Flow V2 接入后，现有 3D 场景设计器兼容基线全部通过回归；不得删除、弱化或改变既有模型库、场景树、专业编辑、吸附、Route、Binding、属性、运行预览、保存、发布和回滚能力。**
- [ ] 未迁移 Action Flow V2 的旧场景仍可正常打开、编辑、保存、发布和运行预览。
- [ ] 新流程可表达条件、并行、汇合、超时、失败和补偿。
- [ ] 客户端和服务端均校验，服务端是最终裁决。
- [ ] 发布版本包含不可变流程定义、执行计划和哈希。
- [ ] 模拟和实时模式由明确配置决定，不由是否有绑定推断。
- [ ] 实时动作采用命令、确认、忙、完成、故障握手。
- [ ] 所有阻塞动作都有有限超时和处理路径。
- [ ] 运行、步骤、命令、资源和物料状态进入数据库。
- [ ] 页面刷新或服务重启后可恢复，且不重复执行设备动作。
- [ ] 同一物料、托盘和共享区段不会被两个流程同时占用。
- [ ] 物料抓取/放置和 3D 动画与真实确认事件一致。
- [ ] 所有设备绑定进入数据库，场景不包含凭据、脚本或外部 URL。
- [ ] 权限、租户隔离、审计和人工操作原因完整。
- [ ] Mock/Stub 测试与真实 PLC/MQTT/SQL Server 联调结果分开报告。

---

## 22. 建议立即进入的开发顺序

第一批不应先花时间做漂亮的流程画布，而应先建立正确语义：

1. 修正 RuntimeMode、行为级联锁、Busy、Timeout、CycleId 和故障恢复。
2. 后端补齐当前 Behavior V1 的保存/发布校验。
3. 定义 Action Flow V2、诊断编号和 V1 迁移器。
4. 先实现编译器和无界面测试，再接流程图 UI。
5. 实现确定性模拟和 3D 双向定位。
6. 每完成一个 Action Flow UI/Runtime 阶段，先执行现有 3D 场景设计器兼容回归，再继续下一阶段。
7. 建立定义投影表、发布复制和版本哈希。
8. 建立服务端 Run/Event/Command/Reservation/Material，再接真实 PLC 握手。
9. 最后扩展多路线、运行回放、性能和模板生态。

这样可以保证每一阶段都得到可验证的能力，而不是出现“画布上能连线，但生产运行语义仍然不可靠”的半成品，也避免在新增 Action Flow 的过程中破坏已经稳定的 3D 场景设计器。

---

## 23. 最终判断

IoTSharp 已经具备构建专业动作编排器所需要的大部分领域积木，短期最合理的路线不是更换 Three.js 编辑器，也不是引入一套与现有 Manifest 割裂的外部工作流框架，而是在现有数字孪生合同之上补齐 Action Flow V2、服务端校验、运行持久化和设备握手。

其中最重要的架构原则是：

> 3D 编辑器负责“设计和呈现”，流程编译器负责“把设计变成确定计划”，服务端负责“生产运行状态”，PLC/设备控制器负责“实际安全动作”。

同时必须长期遵守本方案新增的兼容规则：

> **Action Flow V2 是现有 3D 场景设计器的增强层，不是替代层。已经稳定的 3D 场景设计能力必须持续保留，并作为每次 Action Flow 改动的强制回归基线。**

只要坚持这两条边界，路线、工位、机器人、桁架、托盘、丝锭和 PLC 数据就能在同一套可发布、可恢复、可审计的流程模型中闭环；否则继续向浏览器里的顺序动作数组叠加逻辑，或者在流程改造中反复破坏基础 3D 编辑能力，复杂度和生产风险都会快速失控。
