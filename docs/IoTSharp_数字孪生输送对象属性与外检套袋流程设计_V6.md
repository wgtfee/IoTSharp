# IoTSharp 数字孪生输送对象属性与外检 / 套袋流程设计 V6

> 仓库：`wgtfee/IoTSharp`  
> 分支：`Develop`  
> 检查基线：`aa213ce270a529ad9c6a77d633cadd5583e8ab24`  
> 当前 V5 已具备 80 个托盘全在线闭环、Robot 1×6、Gantry 2×3、8 层码垛、后包装入库。

本次 V6 设计三个能力：

1. 辊道的输送对象类型做成可选属性；
2. 在桁架之前增加真正的“外检机”工艺；
3. 在桁架之前增加“套袋机”工艺。

---

## 1. V6 完整工艺流程

当前主流程：

```text
丝车
↓
Robot 1×6
↓
塑料托盘
↓
上料缓存
↓
分流
↓
Gantry A/B
↓
桁架
↓
木托盘码垛
```

建议改成：

```text
丝车
↓
Robot 1×6
↓
6 个塑料托盘
↓
上料后缓存
↓
【外检机】
↓
外检后缓存
↓
【套袋机】
↓
套袋后缓存
↓
分流岔口
├───────────────┐
↓               ↓
Gantry A         Gantry B
3 位             3 位
└───────┬───────┘
        ↓
     桁架 2×3
        ↓
     木托盘
        ↓
   2×3×8 = 48
        ↓
      盖板
        ↓
      贴标
        ↓
      缠膜
        ↓
      入库
```

外检和套袋必须是 **Robot 后、Gantry 前** 的正式 Process Station，不只是画两个 3D 模型。

---

# 2. 当前已有的“A线检测 / B线检测”不是外检工艺

当前 Manifest 已经存在：

```text
silk-left-inspection
silk-right-inspection
```

名称：

```text
A线检测
B线检测
```

但它们当前是：

```ts
kind: 'sensor'
```

它们更适合解释为：

```text
A线桁架到位检测
B线桁架到位检测
```

不是产品外观检测。

建议 V6 将它们改名为：

```text
A线桁架到位检测
B线桁架到位检测
```

真正的外检机另建：

```text
silk-external-inspection
kind = processStation
```

---

# 3. “托盘类型”不要直接命名为 PalletType

因为纸箱不是托盘。

建议平台统一叫：

```text
输送对象类型
Transport Unit Type
```

代码：

```ts
export type TwinTransportUnitType =
    | 'plastic-pallet'
    | 'wooden-pallet'
    | 'carton';
```

中文：

```text
塑料托盘
木托盘
纸箱
```

---

# 4. 辊道增加两个属性

```ts
export type TwinConveyorSizeClass =
    | 'small'
    | 'large';

export type TwinTransportUnitType =
    | 'plastic-pallet'
    | 'wooden-pallet'
    | 'carton';
```

建议直接扩展现有 `TwinRouteEdgeDefinition`：

```ts
export interface TwinRouteEdgeDefinition {
    ...

    conveyorSizeClass?: TwinConveyorSizeClass;

    transportUnitType?: TwinTransportUnitType;
}
```

因为当前 `TwinRouteEdgeDefinition` 本身已经承担：

```text
Capacity
Occupancy
Reserved
Blocked
conveyorObjectId
```

它已经是物理输送 Section 的运行定义，因此“这一段输送什么”也应该放在这里。

---

# 5. 小辊道 / 大辊道的选择规则

## 小辊道

允许：

```text
塑料托盘
纸箱
```

## 大辊道

允许：

```text
木托盘
纸箱
```

前端：

```ts
const transportUnitOptions = {
    small: [
        'plastic-pallet',
        'carton'
    ],

    large: [
        'wooden-pallet',
        'carton'
    ]
};
```

---

# 6. 编辑器中应该怎么显示

用户点击某一段辊道后，右侧显示：

```text
━━━━━━━━━━━━━━━━━━
输送属性
━━━━━━━━━━━━━━━━━━

辊道规格
[ 小辊道 ▼ ]

输送对象
[ 塑料托盘 ▼ ]

容量
[ 6 ]

占用模式
[ 离线仿真 ▼ ]

当前占用
4 / 6
```

点击大辊道：

```text
辊道规格
[ 大辊道 ▼ ]

输送对象
[ 木托盘 ▼ ]
```

切成：

```text
[ 纸箱 ]
```

以后这条大辊道就作为纸箱线使用。

---

# 7. 3D 对象与 Section 的关系

建议：

```text
Three.js Roller Object
        │
        │ userData.sectionId
        ▼
TwinRouteEdgeDefinition
        │
        ├─ capacity
        ├─ occupancy
        ├─ conveyorSizeClass
        ├─ transportUnitType
        └─ conveyorObjectId
```

点击 3D 辊道：

```text
Object
→ sectionId
→ Route Edge
→ 编辑输送属性
```

不要只把类型放在 `Mesh.userData`，否则保存 Manifest、发布、Runtime 校验都不好处理。

---

# 8. Entity 本身也要有类型

当前运行时已经有：

```text
PlasticPalletRuntime
WoodenPalletRuntime
```

以后会有：

```text
CartonRuntime
```

建议公共 `TwinFlowEntitySnapshot` 增加：

```ts
entityType?:
    | 'plastic-pallet'
    | 'wooden-pallet'
    | 'carton';
```

进入 Section 前：

```ts
if (
    section.transportUnitType &&
    section.transportUnitType !== entity.entityType
) {
    return {
        canAccept: false,
        reason: 'unit-type-not-allowed'
    };
}
```

新增等待原因：

```text
TARGET_SECTION_UNIT_TYPE_NOT_ALLOWED
```

这样木托盘不会误进入只允许塑料托盘的小辊道。

---

# 9. 当前丝饼 V6 模板默认值

Robot 到 Gantry 的所有小辊道：

```text
conveyorSizeClass = small
transportUnitType = plastic-pallet
```

包括：

```text
机器人上料
上料后缓存
外检机输送段
外检后缓存
套袋机输送段
套袋后缓存
A/B 分流
Gantry A/B
空托盘回流
```

木托盘码垛及后包装大辊道：

```text
conveyorSizeClass = large
transportUnitType = wooden-pallet
```

平台层仍允许以后选择：

```text
small + carton
large + carton
```

---

# 10. 建议新增 TransportUnitFactory

不要把 `createPlasticPallet()` 改成很多 if。

新增：

```text
ClientApp/src/digital-twin/runtime/TransportUnitFactory.ts
```

示例：

```ts
export class TransportUnitFactory {
    create(type: TwinTransportUnitType, id: string) {
        switch (type) {
            case 'plastic-pallet':
                return this.createPlasticPallet(id);

            case 'wooden-pallet':
                return this.createWoodenPallet(id);

            case 'carton':
                return this.createCarton(id);
        }
    }
}
```

以后增加：

```text
周转箱
料框
金属托盘
```

只扩 Factory，不需要复制整条辊道 Runtime。

---

# 11. 外检机是 Process Station，不是 Sensor

外检流程：

```text
托盘到达
↓
停止
↓
开始检测
↓
等待结果
↓
PASS / NG
↓
完成后才允许离开
```

因此必须：

```ts
kind = 'processStation'
```

当前已有 `ProcessStationManager`，可以直接复用。

建议类型从：

```ts
'robot-loading'
| 'gantry-stacking'
| 'scan'
| 'inspection'
```

升级为：

```ts
'robot-loading'
| 'gantry-stacking'
| 'scan'
| 'external-inspection'
| 'bagging'
```

---

# 12. 外检状态

```text
Idle
↓
Waiting
↓
Processing
↓
Completed
↓
Release
```

异常：

```text
Processing
↓
Fault
```

检测结果：

```text
PASS
NG
UNKNOWN
```

---

# 13. SilkCake 增加外检数据

当前 `SilkCakeDefinition` 已经有：

```ts
quality:
    'normal'
    | 'ng'
    | 'unknown';
```

建议继续复用，并增加：

```ts
appearanceInspection?: {
    state:
        | 'pending'
        | 'processing'
        | 'completed'
        | 'fault';

    result:
        | 'pass'
        | 'ng'
        | 'unknown';

    defectCode?: string;

    completedAt?: number;
};
```

---

# 14. Simulation 模式外检

建议参数：

```ts
inspectionCycleSeconds?: number;
inspectionNgRate?: number;
```

默认：

```text
inspectionCycleSeconds = 2
inspectionNgRate = 0
```

流程：

```text
Pallet 进入外检机
↓
Processing 2 秒
↓
默认 PASS
↓
cake.quality = normal
↓
允许进入外检后缓存
```

V6 默认 NG 率先设 0，因为当前还没有 NG 剔除线。

---

# 15. Live 模式外检

以后接 PLC / 视觉系统：

```text
InspectionReady
InspectionBusy
InspectionComplete
InspectionResult
InspectionFault
```

结果可以映射：

```text
0 = Waiting
1 = PASS
2 = NG
```

具体值由 Binding 配置，不写死到 Runtime。

---

# 16. NG 的 V6 处理

当前还没有 NG 支线，所以 V6：

```text
PASS
→ 放行到套袋

NG
→ 停留 / Hold
→ 报警
→ 不允许进入套袋和 Gantry
```

后续 V7 再扩：

```text
外检
├─ PASS → 套袋
└─ NG   → NG 剔除 / 人工复检
```

---

# 17. 套袋机流程

```text
外检 PASS
↓
进入套袋机
↓
停止
↓
Processing
↓
套袋完成
↓
bagged = true
↓
允许进入套袋后缓存
↓
分流
↓
Gantry
```

建议：

```ts
bagging?: {
    state:
        | 'pending'
        | 'processing'
        | 'completed'
        | 'fault';

    bagged: boolean;

    completedAt?: number;
};
```

---

# 18. Gantry 必须增加前置条件

V6 以后不能只判断：

```text
Loaded
+
A/B 3 个托盘
```

必须：

```ts
return pallet.loaded
    && cake.quality === 'normal'
    && cake.appearanceInspection?.result === 'pass'
    && cake.appearanceInspection?.state === 'completed'
    && cake.bagging?.state === 'completed'
    && cake.bagging?.bagged === true;
```

也就是：

```text
未外检
→ 不进 Gantry

外检 NG
→ 不进 Gantry

未套袋
→ 不进 Gantry
```

---

# 19. PalletStage V6

当前：

```ts
'source-queue'
'loading'
'to-gantry-a'
'to-gantry-b'
'gantry-a'
'gantry-b'
'returning'
```

建议：

```ts
type PalletStage =
    | 'source-queue'
    | 'loading'

    | 'to-external-inspection'
    | 'external-inspection'

    | 'to-bagging'
    | 'bagging'

    | 'to-diverter'

    | 'to-gantry-a'
    | 'to-gantry-b'

    | 'gantry-a'
    | 'gantry-b'

    | 'returning';
```

---

# 20. 路线节点建议

```text
silk-source
↓
silk-loading
↓
silk-load-buffer
↓
silk-external-inspection
↓
silk-inspection-out-buffer
↓
silk-bagging
↓
silk-bagging-out-buffer
↓
silk-diverter
├─ silk-left-buffer
│  ↓
│  silk-left-gantry-sensor
│  ↓
│  Gantry A
│
└─ silk-right-buffer
   ↓
   silk-right-gantry-sensor
   ↓
   Gantry B
```

---

# 21. 推荐坐标布局

当前 `silk-buffer` 到 `silk-diverter` 距离太短，不足以加入两个设备。

建议将 Gantry 区整体右移。

参考：

```text
Robot Loading            x ≈ -6

Load Buffer              x ≈ 3.2

External Inspection      x ≈ 7

Inspection Out Buffer    x ≈ 10.5

Bagging                  x ≈ 14.5

Bagging Out Buffer       x ≈ 18

Diverter                 x ≈ 21

Gantry Start             x ≈ 24

Wood Pallet Stack        x ≈ 26
```

后面的：

```text
盖板
贴标
缠膜
入库
空托盘东侧回流
```

整体一起向右移。

---

# 22. 不要继续增加 Magic Number

建议新增：

```text
ClientApp/src/digital-twin/runtime/SilkLineLayout.ts
```

例如：

```ts
export const silkLineLayout = {
    loadingX: -6.125,

    loadBufferX: 3.2,

    externalInspectionX: 7,

    inspectionBufferX: 10.5,

    baggingX: 14.5,

    baggingBufferX: 18,

    diverterX: 21,

    gantryStartX: 24,

    woodenPalletX: 26,

    postProcessStartX: 32,

    returnEastX: 58
};
```

以后扩产线只改 Layout，不到处修改常量。

---

# 23. 外检机 3D 设计

用户要求：

> 辊道上加一个大长方形，长方形显示“外检机”。

建议做成半透明大型设备罩：

```text
       ┌────────────────────┐
       │       外检机        │
       │                    │
───────│══════ 辊道 ═══════│──────
       │       丝饼         │
       │       托盘         │
       └────────────────────┘
```

建议尺寸：

```text
X 长度：4.0m
Y 高度：3.2m
Z 宽度：3.0m
```

使用：

```ts
THREE.BoxGeometry(4.0, 3.2, 3.0)
```

材质：

```text
半透明
opacity ≈ 0.2
```

这样托盘通过时仍然看得见。

---

# 24. 套袋机 3D 设计

与外检机统一风格：

```text
       ┌────────────────────┐
       │       套袋机        │
       │                    │
───────│══════ 辊道 ═══════│──────
       │       丝饼         │
       │       托盘         │
       └────────────────────┘
```

两台设备颜色可不同，方便识别。

---

# 25. 文字不要依赖外部字体文件

建议：

```text
Canvas
↓
CanvasTexture
↓
Sprite
```

新增通用：

```ts
createMachineLabel(text)
```

显示：

```text
外检机
套袋机
```

---

# 26. 不要分别写两套 Box 代码

新增：

```text
ProcessStationVisualFactory.ts
```

或：

```ts
addProcessBox(parent, options)
```

接口：

```ts
interface ProcessStationVisualOptions {
    stationId: string;
    name: string;
    position: [number, number, number];
    size: [number, number, number];
    color: number;
}
```

外检和套袋都走同一个 Factory。

---

# 27. Process Box 写入 userData

```ts
machine.userData = {
    twinObjectType: 'process-station',
    stationId: 'silk-external-inspection',
    processType: 'external-inspection'
};
```

套袋：

```ts
machine.userData = {
    twinObjectType: 'process-station',
    stationId: 'silk-bagging',
    processType: 'bagging'
};
```

以后点击设备，就能显示工位属性。

---

# 28. Process Station 属性面板

点击外检机：

```text
━━━━━━━━━━━━━━━━━━
工位属性
━━━━━━━━━━━━━━━━━━

工位类型
[ 外检机 ]

仿真节拍
[ 2.0 s ]

完成信号
[ InspectionComplete ▼ ]

结果信号
[ InspectionResult ▼ ]

故障信号
[ InspectionFault ▼ ]
```

点击套袋机：

```text
工位类型
[ 套袋机 ]

仿真节拍
[ 3.0 s ]

完成信号
[ BaggingComplete ▼ ]

故障信号
[ BaggingFault ▼ ]
```

---

# 29. Route Point 增加工艺定义

建议：

```ts
export interface TwinProcessDefinition {
    type:
        | 'robot-loading'
        | 'external-inspection'
        | 'bagging'
        | 'gantry-stacking';

    cycleSeconds?: number;

    completeBindingId?: string;

    resultBindingId?: string;

    faultBindingId?: string;
}
```

`TwinRoutePointDefinition`：

```ts
process?: TwinProcessDefinition;
```

外检：

```json
{
  "pointId": "silk-external-inspection",
  "kind": "processStation",
  "process": {
    "type": "external-inspection",
    "cycleSeconds": 2
  }
}
```

套袋：

```json
{
  "pointId": "silk-bagging",
  "kind": "processStation",
  "process": {
    "type": "bagging",
    "cycleSeconds": 3
  }
}
```

---

# 30. Capacity 设计

机器本体不要当大缓存。

推荐：

```text
Robot Loading Buffer      6

Load Out Buffer           6

External Inspection       1

Inspection Out Buffer     6

Bagging Machine           1

Bagging Out Buffer        6

Diverter In               6

Gantry A                  3

Gantry B                  3
```

机器：

```text
Capacity = 1
```

排队放在前后辊道缓存。

---

# 31. 外检与下游阻塞

外检完成并不表示一定能立即推出托盘。

必须：

```text
Inspection Complete
+
Inspection Out Buffer.CanAccept
=
Release
```

如果套袋机太慢，外检后缓存最终满：

```text
外检机完成当前件
但不能推出
```

然后上游自动 Backpressure。

这正好复用现有：

```text
TwinSectionManager
Capacity
Reserved
CanAccept
Waiting
```

---

# 32. 套袋与下游阻塞

同理：

```text
Bagging Complete
+
Bagging Out Buffer.CanAccept
=
Release
```

如果 Gantry 区满：

```text
套袋后缓存满
↓
套袋机不能放行
↓
外检后缓存逐渐满
↓
外检机阻塞
↓
Robot 后缓存阻塞
```

这是正确的真实产线阻塞传播。

---

# 33. Workbench V6 参数

当前丝饼参数增加：

```text
塑料托盘数          80

机器人节拍          ...

外检节拍            2.0s

外检 NG 率          0%

套袋节拍            3.0s

桁架节拍            ...

木托盘              2×3×8
```

---

# 34. Runtime Snapshot 增加

```ts
preProcess: {
    inspection: {
        state: string;
        currentPalletId?: string;
        passed: number;
        ng: number;
        progress: number;
    };

    bagging: {
        state: string;
        currentPalletId?: string;
        completed: number;
        progress: number;
    };
}
```

---

# 35. 顶部状态条建议

增加：

```text
前处理

外检：
Processing · PASS 126 · NG 0

套袋：
Processing · Completed 124
```

不要让用户只能看到 3D 动作，却不知道 Process Runtime 到底处于什么状态。

---

# 36. 套袋完成后的视觉建议

P0：

```text
只做套袋机流程
```

P1：

在丝饼外增加半透明袋膜：

```text
BagMesh.visible = true
```

这样在 Gantry 前后能明显看到：

```text
未套袋
已套袋
```

---

# 37. 外检状态灯

可选 P1：

```text
Idle       灰
Processing 黄
PASS       绿
NG         红
Fault      红闪
```

以后可直接绑定 PLC / IoT 实时状态。

---

# 38. 建议修改文件

## contracts

```text
ClientApp/src/digital-twin/contracts/index.ts
```

增加：

```text
TwinConveyorSizeClass
TwinTransportUnitType
TwinProcessDefinition
inspectionCycleSeconds
inspectionNgRate
baggingCycleSeconds
```

---

## Runtime

```text
ClientApp/src/digital-twin/runtime/TwinMaterialFlowRuntime.ts
```

增加：

```text
entityType
输送对象类型校验
TARGET_SECTION_UNIT_TYPE_NOT_ALLOWED
```

---

## Process

```text
ClientApp/src/digital-twin/runtime/ProcessStationManager.ts
```

增加：

```text
external-inspection
bagging
```

---

## Silk Line

重点：

```text
ClientApp/src/digital-twin/runtime/ProceduralPackagingLine.ts
```

改造：

```text
外检机
套袋机
PalletStage
新的 Outbound Flow
新的 Route Points
新的状态机
Gantry 前置工艺校验
```

---

## 建议新增

```text
ClientApp/src/digital-twin/runtime/TransportUnitFactory.ts

ClientApp/src/digital-twin/runtime/ProcessStationVisualFactory.ts

ClientApp/src/digital-twin/runtime/SilkLineLayout.ts
```

---

## Workbench

```text
ClientApp/src/views/iot/digital-twin/workbench.vue
```

增加：

```text
辊道规格选择
输送对象选择
外检参数
套袋参数
Process Station 属性面板
```

---

# 39. verify-packaging-line.ts 验收

必须增加：

```text
存在“外检机”对象
存在“套袋机”对象
```

流程顺序：

```text
Robot
<
External Inspection
<
Bagging
<
Diverter
<
Gantry
```

---

# 40. Gantry 强制断言

任意进入：

```text
gantry-a
gantry-b
```

的 SilkCake 必须：

```text
quality == normal

inspection == completed

inspectionResult == pass

bagging == completed

bagged == true
```

否则测试失败。

---

# 41. Transport Unit 类型测试

至少：

```text
Small + Plastic Pallet
PASS

Small + Carton
PASS

Large + Wooden Pallet
PASS

Large + Carton
PASS

Small + Wooden Pallet
FAIL
```

---

# 42. Process Capacity 测试

```text
Inspection Occupancy <= 1

Bagging Occupancy <= 1

所有 Buffer：
Occupancy + Reserved <= Capacity
```

---

# 43. 长周期测试

继续保持当前全在线闭环测试，并增加：

```text
80 个塑料托盘保持恒定

没有托盘绕过外检

没有托盘绕过套袋

没有未套袋丝饼进入 Gantry

外检 / 套袋阻塞能够向上游传播

解除阻塞以后自动 Resume
```

---

# 44. 后续通用化方向

这次需求实际上说明：

```text
ProceduralPackagingLine
```

不能长期继续把：

```text
塑料托盘线
木托盘线
纸箱线
外检
套袋
```

全部写成特例。

正确方向：

```text
Roller Conveyor
+
Transport Unit Property
+
Process Station
+
TwinSection
+
Binding
```

以后新增：

```text
称重机
扫码机
视觉检测
喷码机
封箱机
```

都走同一套 Process Station 模型。

---

# 45. 需要注意的现有架构点

当前塑料托盘主循环已经较多使用：

```text
TwinMaterialFlowRuntime
TwinSectionManager
TwinEntityManager
```

但是木托盘后面的：

```text
盖板
贴标
缠膜
入库
```

仍然比较多地由 `ProceduralPackagingLine` 内部 Stage 硬编码。

因为用户现在要求：

```text
大辊道可能是木托盘
也可能是纸箱
```

后续 V7 最好把大辊道也迁移为标准：

```text
TwinRouteEdge
+
TwinSection
+
TwinFlowEntity
```

这样大/小辊道才真正是平台能力。

V6 不需要一次性完成这个重构。

---

# 46. V6 P0 开发顺序

```text
1. TwinTransportUnitType

2. TwinConveyorSizeClass

3. Route Edge 增加输送对象属性

4. Workbench 辊道属性选择

5. Runtime 类型校验

6. SilkLineLayout 抽离

7. Gantry 区整体右移

8. 新增 External Inspection Section

9. 新增外检大型长方形和“外检机”文字

10. 外检 Process Runtime

11. 新增 Bagging Section

12. 新增套袋大型长方形和“套袋机”文字

13. 套袋 Process Runtime

14. Gantry 增加外检 + 套袋前置条件

15. Snapshot / Metrics

16. 长周期自动验收
```

---

# 47. V6 P1

```text
外检 NG 模拟

外检 PLC Binding

套袋 PLC Binding

套袋透明袋视觉

设备状态灯

纸箱 TransportUnitFactory

大辊道标准 TwinSection 化
```

---

# 48. 最终架构

```text
TwinSceneManifest
│
├─ Route Edge / Section
│   ├─ Capacity
│   ├─ ConveyorSizeClass
│   ├─ TransportUnitType
│   └─ ConveyorObjectId
│
├─ Process Station
│   ├─ Robot Loading
│   ├─ External Inspection
│   ├─ Bagging
│   └─ Gantry
│
├─ TwinMaterialFlowRuntime
│   ├─ SectionManager
│   ├─ EntityManager
│   ├─ Reservation
│   └─ Unit Type Validation
│
├─ ProcessStationManager
│
└─ Three.js Visual
    ├─ Roller
    ├─ External Inspection Box
    ├─ Bagging Box
    └─ Machine Labels
```

---

# 49. 最终验收表

| 项目 | V6 验收 |
|---|---|
| 小辊道 | 可选塑料托盘 / 纸箱 |
| 大辊道 | 可选木托盘 / 纸箱 |
| Manifest | 持久化 `conveyorSizeClass`、`transportUnitType` |
| Runtime | 类型不匹配不能进入 |
| 外检机 | 辊道上有大型长方形设备 |
| 外检文字 | 显示“外检机” |
| 外检流程 | 托盘停止、处理、完成才放行 |
| 外检结果 | PASS / NG |
| 套袋机 | 辊道上有大型长方形设备 |
| 套袋文字 | 显示“套袋机” |
| 套袋流程 | 外检 PASS 后才能执行 |
| Gantry | 只接收外检 PASS 且已套袋丝饼 |
| A/B 检测 | 保留并改名为桁架到位检测 |
| Layout | Gantry 整体右移，不与两台机器重叠 |
| Process Capacity | 外检=1，套袋=1 |
| Buffer | 使用现有 Capacity / Reserved |
| 80 托盘 | 保持全在线闭环 |
| Backpressure | 下游满后逐级向上游阻塞 |
| Resume | 下游释放后自动继续 |

---

# 50. 结论

这一版不建议只做：

```text
两个长方形
+
两个下拉框
```

应该一次把三个平台能力做正确：

```text
1. Roller Conveyor
   +
   Transport Unit Property

2. Process Station
   +
   External Inspection
   +
   Bagging

3. Silk Process State
   +
   Inspection PASS
   +
   Bagged
   +
   Gantry
```

最终丝饼流程：

```text
Robot
↓
外检
↓
套袋
↓
分流
↓
Gantry
↓
木托盘码垛
↓
后包装
↓
入库
```

这样后续再增加称重、扫码、视觉、喷码、封箱时，就可以继续沿用同一套 `ProcessStation + TwinSection + Binding + 3D Visual` 架构，而不需要每加一个设备就重新写一套特殊 Runtime。

---

# 51. V6 实施结果（2026-08-28）

本章记录本设计在 IoTSharp 中的实际落地结果。它是实现基线和回归验收入口，不替代前面的领域设计。

## 51.1 已落地的完整工艺

当前内置模板已经升级为“丝饼完整工艺数字孪生 V6”，主流程为：

```text
双面丝车
  → Robot 1×6 上料
  → 上料缓存
  → 外检机（Capacity = 1）
  → 外检出口缓存
  → 套袋机（Capacity = 1）
  → 套袋出口缓存
  → A/B 分流
  → 桁架到位检测
  → Gantry 2×3
  → 木托盘 2×3×8 码垛
  → 后包装大辊道
  → 入库
  → 80 个塑料托盘闭环回流
```

外检和套袋不是仅有外观的模型。两者均由 `ProcessStationManager` 管理占用、开始、处理、完成、故障和放行状态。工位完成后如果下游不能接收，实体继续保留在当前工位，阻塞能够逐级传播到上游；下游恢复后无需重新下达命令即可继续运行。

## 51.2 数据契约与数据库持久化

下列 V6 属性已经进入 `TwinSceneManifest`：

```text
RouteEdge
  conveyorSizeClass
  transportUnitType
  capacity
  reservationTimeoutSeconds
  occupancyBindingId
  fullBindingId
  blockedBindingId

ProcessStation Point
  process.type
  process.cycleSeconds
  process.completeBindingId
  process.resultBindingId
  process.faultBindingId

SilkCake
  appearanceInspection.status/result
  bagging.status/bagged
```

“路线控制点”“后包装大型辊道”和“对象与数据绑定”页面编辑的值都属于同一个 Manifest。点击“保存草稿”或“完整工艺 V6”确认后，前端调用既有场景保存接口，由后端在 SQL Server 中保存 Manifest、修订号和资源绑定；发布时以已入库草稿创建不可变版本。运行时临时状态和浏览器 Blob URL 不写数据库。

过程信号绑定只保存 `bindingId` 引用。真正的 Device、遥测/属性 Key、变换规则仍由 `manifest.bindings` 统一保存，避免同一 PLC 信号在设备、路线和工位中重复定义。

## 51.3 输送对象约束

已经实现的兼容矩阵为：

| 辊道规格 | 允许的输送对象 |
|---|---|
| `small` | `plastic-pallet`、`carton` |
| `large` | `wooden-pallet`、`carton` |

`TwinSection.canAccept/reserve/enter/tryTransfer` 均执行类型校验。类型不匹配时返回 `TARGET_SECTION_UNIT_TYPE_NOT_ALLOWED`，不会出现只在编辑器校验、运行时仍然穿越的情况。后包装木托盘路线作为独立大辊道路线保存在 Manifest 中，并在工作台提供属性和封锁信号编辑入口。

## 51.4 外检、套袋与 Gantry 硬门禁

实体必须按如下状态推进：

```text
外检 NotStarted → Processing → Completed(PASS/NG)
                                  │
                                  ├─ NG：留在外检，禁止进入套袋
                                  └─ PASS：允许进入套袋

套袋 NotStarted → Processing → Completed(bagged = true)
                                      │
                                      └─ 允许进入 Gantry
```

Gantry 接收条件已经固化为：

```text
qualityStatus == Normal
&& appearanceInspection.status == Completed
&& appearanceInspection.result == PASS
&& bagging.status == Completed
&& bagging.bagged == true
```

因此即使路线或 UI 配置错误，未通过外检、未完成套袋的丝饼也不能进入桁架码垛。

## 51.5 三维可视化与布局

新增 `ProcessStationVisualFactory` 统一生成半透明设备罩、状态灯和 Canvas 中文标签，外检机与套袋机均可显示 Idle、Processing、Completed、Fault。新增 `SilkLineLayout` 集中管理关键坐标，外检、套袋、A/B 分流和 Gantry 按工艺顺序右移，避免设备、平行辊道与交叉口重叠。

对象详情现在可查看塑料托盘所处工艺阶段，以及丝饼质量、外检和套袋状态；顶栏显示外检 PASS/NG、套袋完成数、工位进度、阻塞段与等待托盘数。

## 51.6 80 托盘、防穿越与阻塞验收

`ClientApp/scripts/verify-packaging-line.ts` 已升级为 V6 长周期验收，覆盖：

1. V6 工位、主小辊道、后包装大辊道和输送对象类型契约。
2. 外检与套袋工位 Capacity 均为 1。
3. 类型不匹配的 TransportUnit 无法预占或进入 Section。
4. 外检 PASS 后才套袋，套袋完成后才进入 Gantry。
5. 主动封锁套袋下游后，套袋完成实体不离站，阻塞向外检缓存传播。
6. 清除封锁信号后，产线自动恢复。
7. 80 个托盘持续闭环，无合流丢失、无“六变一”。
8. 所有 Section 的 `occupancy + reserved` 始终不超过 Capacity。
9. 队列重排和回流段重定位后，托盘最小间距仍不小于 1.5 m，不重叠、不穿越。

回归命令：

```powershell
cd ClientApp
npx --yes tsx scripts/verify-packaging-line.ts

cd ..
dotnet test IoTSharp.Test/IoTSharp.Test.csproj --no-restore --filter "FullyQualifiedName~DigitalTwin"
```

本次基线结果：

```text
V6 packaging line verification: PASS
80 / 80 pallets remained in the closed loop
minimum pallet gap: 1.5 m
DigitalTwin tests: 10 passed, 0 failed
```

## 51.7 使用与升级策略

为了保护已经人工编辑过的场景，系统不会在页面加载时无条件覆盖用户 Manifest：

1. 可识别的旧 V4/V5 内置默认坐标和默认路线会在内存中兼容升级。
2. 用户手工移动过的控制点保持原位置。
3. 需要完整替换为标准 V6 时，点击工作台工具栏“完整工艺 V6”。
4. 确认后新模板立即保存为数据库草稿；发布仍由用户单独确认。
5. 场景中心和三维工作台均可发布同一草稿。

场景保存和发布前会清除 Three Editor 的临时预览 URL；运行模型资源仍禁止外部 URL 或内联 `data:` URL。因此修复错误代码 10016 的同时，没有放宽已发布数字孪生场景的资源安全边界。

## 51.8 后续扩展原则

称重、扫码、喷码、封箱等设备应继续实现为 `ProcessStation`，新增工艺状态和绑定，不应直接把特殊判断写入 Three.js 模型。TransportUnit 的新类型则统一扩展兼容矩阵和实体工厂，并同时增加编辑器校验、后端校验与 Runtime 拒绝测试。

## 52. V6.1 外检前空托短回流与套袋后分流修订

现场工艺顺序修订为：

```text
机器人 1×6 上料
  → 外检前空托检测岔口
      ├─ hasSilkCake = false：空托短回流 → 机器人前汇流接入口
      └─ hasSilkCake = true：外检 → 外检后缓存 → 套袋 → 套袋后缓存
                                                    → A/B 分流 → 桁架
```

本修订明确区分两个岔口：

1. `silk-buffer` 是外检前空托检测岔口，只根据 `hasSilkCake` 决定进入外检或短回流。
2. `silk-diverter` 是套袋后的 A/B 工艺分流，只允许已经完成外检并套袋的有料托盘进入。
3. 空托短回流由下降段、主回流段和机器人前接入段组成，与长回流只在 `silk-source` 合流，不重复铺设辊道。
4. 机器人一次作业结束后写入 `loadAttempted`。即使本批没有抓到丝饼，托盘也必须离开机器人位，禁止因空托永久占位导致整线停机。
5. 仿真参数 `emptyPalletBatchRate` 用于模拟整批空抓；默认 10%，实时模式应由 PLC/视觉/称重结果提供 `hasSilkCake`。

短回流主段固定布置在主输送线的反侧 `z=0`。主输送线为 `z=-5.8`，旋转台中心为 `z=-10.5`，丝车从负 Z 方向进入旋转台；因此负 Z 一侧不得再横铺空托回流辊道。空托从外检前检测点向正 Z 侧转出，再沿与主线相反的方向返回机器人，最后从旋转台西侧接入机器人前汇流点。这样既不穿越旋转包络，也不封堵实际丝车进出通道。

阻塞与防碰撞规则同步修订：目标 Section 满位时，托盘保持当前到位点并持续重试，禁止向后回退。运动判定同时检查终点间距和本帧扫掠线段，防止大步长跨越前车。短回流和长回流在机器人前按距入口的实际剩余距离统一排队，保证不同来源托盘不对撞、不穿越。

V6.1 回归结果：

```text
80 / 80 塑料托盘完成闭环
外检前空托短回流：6 托盘
空托进入外检/套袋：0
最小托盘中心距：1.5 m
套袋后 A/B 分流：PASS
生产构建：PASS
```
