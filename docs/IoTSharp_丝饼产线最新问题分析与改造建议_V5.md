# IoTSharp 丝饼产线最新问题分析与改造建议 V5

> 适用分支：`wgtfee/IoTSharp` → `Develop`  
> 当前检查基线 HEAD：`9cc6c7e34b92f730b0bc21864f114e8845f58178`  
> 本文针对当前实际运行中发现的三个问题进行原因分析和下一轮代码改造设计。
>
> 继续复用现有 `TwinMaterialFlowRuntime`、`TwinSectionManager`、`TwinEntityManager`、`TwinJunctionManager`、`SilkCakeLineRuntime`、`ProceduralSilkCakeLine` 以及 Draft/Publish API，不重新发明一套运行时。

---

## 1. 三个问题总览

| 编号 | 问题 | 当前判断 | 优先级 |
|---|---|---|---|
| 1 | 第三轮以后在线托盘异常，只剩约 6 个参与上料 | 已定位为回流固定 Slot + FIFO 不可超车造成业务死锁；同时当前 SourceQueue 模式不符合“80 个托盘全部在线闭环”的目标 | P0 |
| 2 | 桁架抓取穿透塑料托盘，运输轨迹基本固定高度平移 | 已定位：业务任务有 `layer/row/column`，但 Three.js 桁架运动没有把 `layer` 用于 Y 高度；Pick/Place 下降量还是固定值 | P0 |
| 3 | 保存草稿/发布提示失败，但 Draft revision 已增加；发布后也不知道去哪里看 | 已定位：服务端提交和后续 UI 刷新共用一个 catch；Publish 还会先静默 Save Draft。需要增加 Scene Center / Version History / Published Viewer | P0 |

---

# 2. 问题一：80 个塑料托盘应该全部在线闭环

用户目标不是：

```text
SourceQueue
→ 分批上线
→ 少量托盘循环
```

而是：

```text
系统启动即存在 80 个 Plastic Pallet
→ 80 个全部位于物理线体 / 缓存段
→ 一直闭环流转
→ 空托盘上料
→ Loaded 托盘输送
→ 外检机外检
→ 套袋机套袋
→ 桁架抓走丝饼
→ 空托盘回流
→ 再次上料
```

所以建议增加：

```ts
export type PalletPopulationMode =
    | 'closed-loop'
    | 'source-queue';
```

丝饼产线：

```ts
palletPopulationMode = 'closed-loop';
```

---

## 2.1 当前已经找到的死锁

当前更严格测试暴露：

```text
前两批空托盘已经进入回流线
↓
上料区又被两只新托盘占据最深位置
↓
回流队列最前面的旧托盘仍坚持等待原来的固定 Loading Slot
↓
固定 Slot 被新托盘占用
↓
前车不能进入
↓
后车不能超车
↓
整个队列停止
```

本质：

```text
固定 Slot 所有权
+
FIFO 实体队列
+
不可超车
=
死锁
```

不是碰撞检测问题。

---

## 2.2 Loading Buffer 改成动态 FIFO 补位

错误：

```text
Pallet-17 永远属于 Slot-4
Pallet-18 永远属于 Slot-5
```

正确：

```text
[Slot1][Slot2][Slot3][Slot4][Slot5][Slot6]
 Robot
```

Slot1 放行后：

```text
Slot2 → Slot1
Slot3 → Slot2
Slot4 → Slot3
Slot5 → Slot4
Slot6 → Slot5
新来的托盘 → Slot6
```

即：

```text
FIFO Compaction
```

托盘不永久绑定具体 Slot。

---

## 2.3 直接扩大产线容量

既然 80 个托盘都在线，物理总 Capacity 必须明显大于 80。

不要只设计：

```text
Total Capacity = 80
```

否则没有生产缓冲。

建议总物理 Capacity：

```text
90 ~ 100
```

一个参考布局：

```text
Robot 6位上料缓存          6
上料后缓存                 8
主输送缓存                10
岔口/分支缓存              18
Gantry Plastic Lane A      3
Gantry Plastic Lane B      3
桁架后空托盘缓存           6
空托盘主回流              18
上料前回流缓存             20
--------------------------------
总物理位置                90
```

这样：

```text
80 个在线托盘
+
18 个自由位置
```

遇到机器人、桁架短暂停顿时还有缓冲余量。

---

## 2.4 Batch 与 Capacity 分开

机器人：

```text
BatchBarrier.requiredCount = 6
```

只代表：

> 凑齐 6 个空托盘以后，机器人 1×6 才动作。

它不代表：

```text
系统只有 6 个托盘
```

职责必须分开：

```text
TwinSection Capacity
→ 物理线体能放多少托盘

BatchBarrier
→ 工艺上凑齐多少才能动作
```

---

## 2.5 Closed Loop 约束

正常运行必须：

```text
PlasticPallet 总数恒定 = 80
SourceQueue = 0
不创建第 81 个
不销毁已有托盘
```

托盘只变化：

```text
Section
Progress
Empty / Loaded
Waiting
CycleCount
```

---

## 2.6 增加 Deadlock Watchdog

建议：

```ts
interface TwinDeadlockWatchdog {
    lastProgressAt: number;
    timeoutSeconds: number;
    lastTransitionCount: number;
}
```

如果：

```text
连续 N 秒没有 Pallet Section Transition
AND
Robot 不在 Processing
AND
Gantry 不在 Processing
AND
没有明确 FULL / FAULT / PROCESS WAIT
```

触发：

```text
DEADLOCK_DETECTED
```

并记录：

```text
队首 Pallet
当前 Section
目标 Section / Slot
目标占用者
Blocking Chain
```

---

# 3. 问题二：桁架为什么会穿透，而且没有随层数上升

这个问题已经在最新代码中定位。

业务层 `GantryStackController` 实际已经知道：

```text
targetPosition.layer
targetPosition.row
targetPosition.column
```

说明：

> Runtime 知道这批丝饼应该落在第几层。

问题发生在 Three.js 渲染动画层。

---

## 3.1 当前运动高度写死

当前 `ProceduralSilkCakeLine` 的桁架动画核心类似：

```ts
if (state === 'approach' || state === 'pick') {
    position
        .copy(home)
        .lerp(new Vector3(3.8, 3.5, 5), t);

    if (state === 'pick')
        lift = -0.45 * progress;
}
```

放料目标类似：

```ts
const placeTarget = new Vector3(
    11.8 + (task.targetPosition.column - 0.5) * 1.5,
    3.5,
    7.5 + (task.targetPosition.row - 0.5) * 1.5
);
```

可以看到：

```text
X ← column
Z ← row
Y ← 永远 3.5
```

但是：

```text
task.targetPosition.layer
```

没有参与桁架运动 Y 轴计算。

---

## 3.2 固定下降量导致穿托盘

当前 Pick / Place 又使用类似：

```text
lift = -0.45
lift = -0.5
```

这种固定值。

但实际 Pick Height 应由：

```text
Plastic Pallet 顶面
+
SilkCake 高度
+
Gripper Tool Offset
```

决定。

否则夹具会：

```text
从固定高度下降
↓
穿过丝饼
↓
穿过塑料托盘的中心柱 / 底盘
↓
再 Attach
```

---

## 3.3 当前是“最终堆叠高度正确，运动过程错误”

当前 `parkSilkCake()` 已经根据：

```text
stackPosition.layer
```

计算最终丝饼位置。

因此最后堆叠结果可能看起来是：

```text
Layer 1
Layer 2
...
```

但是搬运过程没有使用这个层高。

结果：

```text
桁架固定高度平移
↓
固定下降
↓
Release
↓
丝饼突然 Snap 到第 N 层正确位置
```

这正是：

```text
穿模
+
轨迹像水平平移
+
层数提高但桁架没有相应提高
```

的根因。

---

# 4. 正确的桁架轨迹

不要：

```text
Source ─────────→ Target
        低位平移
```

应改成：

```text
HOME
↓
MOVE ABOVE PICK
↓
VERTICAL DESCEND
↓
GRIP 6
↓
VERTICAL LIFT TO SAFE Y
↓
HORIZONTAL X/Z MOVE AT SAFE Y
↓
TARGET ABOVE
↓
VERTICAL DESCEND TO CURRENT LAYER
↓
RELEASE 6
↓
VERTICAL LIFT
↓
RETURN HOME
```

---

## 4.1 动态 Pick Pose

```ts
const pickCakeCenterY =
    palletTopY
    + silkCakeHalfHeight;

const gripperPickY =
    pickCakeCenterY
    + gripperToolOffset;
```

不能再：

```text
固定下降 0.45m
```

---

## 4.2 动态 Place Pose

第 N 层：

```ts
const placeCakeCenterY =
    woodenPalletTopY
    + silkCakeHalfHeight
    + targetPosition.layer * layerPitch;
```

其中：

```text
layerPitch
≈ SilkCakeHeight + LayerGap
```

所以：

```text
Layer 0 最低
Layer 1 更高
...
Layer 7 最高
```

这是用户说的：

> 随着层数叠加，桁架的运动应该越来越高。

---

## 4.3 Safe Y 动态计算

```ts
const safeY = Math.max(
    configuredSafeY,

    pickObstacleTopY
        + carriedCakeHeight
        + clearance,

    currentStackTopY
        + carriedCakeHeight
        + clearance
);
```

横向移动时：

```text
Gripper / SilkCake 最低点
必须高于：
Plastic Pallet
Wooden Pallet
已有 Stack
```

---

## 4.4 2×3 六个丝饼保持相对位置

建议结构：

```text
GantryGripperRoot
├── G11 → SilkCake1
├── G12 → SilkCake2
├── G13 → SilkCake3
├── G21 → SilkCake4
├── G22 → SilkCake5
└── G23 → SilkCake6
```

移动期间保持：

```text
2 × 3
```

的相对空间位置。

不要六个丝饼全部 Attach 到同一个中心点。

---

## 4.5 建议增加 GantryPoseResolver

新增：

```text
ClientApp/src/digital-twin/runtime/GantryPoseResolver.ts
```

负责：

```text
Pick Pose
Pick Above Pose
Place Pose
Place Above Pose
Safe Y
Layer Y
2×3 Gripper Slot Offset
```

例如：

```ts
interface GantryTransferPose {
    pick: Vector3;
    pickAbove: Vector3;

    place: Vector3;
    placeAbove: Vector3;

    safeY: number;
}
```

---

## 4.6 状态机按阶段插值

建议：

```ts
switch (task.state) {

case 'approach':
    // Home → PickAbove
    break;

case 'lower-pick':
    // PickAbove → Pick
    break;

case 'grip-six':
    // Attach 6 cakes
    break;

case 'lift':
    // Pick → SafeY
    break;

case 'move-to-wood-pallet':
    // 只在 SafeY 做 X/Z 横移
    break;

case 'lower-place':
    // PlaceAbove → layer-aware PlaceY
    break;

case 'release-six':
    // Detach / park without position snap
    break;

case 'return':
    // Safe return
    break;
}
```

---

# 5. 桁架无需先引入完整物理引擎

当前穿透问题不需要先做：

```text
Cannon
RigidBody
OBB Physics
```

先通过：

```text
真实 Pose
+
Safe Height
+
垂直抓取
+
安全横移
+
Layer-aware Place Y
```

即可解决主要问题。

Collision 可以作为断言和异常兜底。

---

## 5.1 建议增加严格运行断言

水平移动阶段：

```text
carriedCakeBottomY
>
maxObstacleTopY + clearance
```

否则：

```text
GANTRY_CLEARANCE_VIOLATION
```

并验证：

```text
Layer7 PlaceY
>
Layer0 PlaceY
```

且：

```text
Layer7 PlaceY - Layer0 PlaceY
≈ 7 × layerPitch
```

---

# 6. 问题三：为什么保存报错但 Draft Revision 已经增加

这个现象和当前 `workbench.vue` 的流程是吻合的。

当前 Save Draft 并不只是一次 API 请求。

逻辑接近：

```text
Capture Manifest
↓
同步 Name / Description / RootAssetId
↓
如果 Metadata Changed
    updateScene()
↓
saveDraft()
↓
currentScene = response
↓
normalize / apply editor state
↓
loadScenes()
↓
Success
```

问题是：

> 服务端 `saveDraft()` 已经成功以后，后续任何本地应用或列表刷新再抛异常，都会进入同一个 catch。

---

## 6.1 所以会发生

```text
Server Save Success
↓
DB Revision 17 → 18
↓
后面的 loadScenes() / apply / normalize 失败
↓
catch
↓
UI 显示“保存失败 / 可能版本冲突”
```

因此：

```text
Revision 已增加
+
用户看到保存失败
```

是完全可能同时发生的。

---

# 7. Save 的错误分类必须拆开

现在实际混合了：

```text
A. Server Save Failed

B. Revision Conflict

C. Server Save Success,
   Local Refresh Failed
```

不能统一显示：

```text
草稿保存失败
```

---

## 7.1 正确 Save 流程

```ts
let savedDetail;

try {

    savedDetail =
        await digitalTwinApi.saveDraft(...);

} catch (error) {

    showRealSaveError(error);
    return false;
}

// 服务端到这里已经成功提交

currentScene.value = savedDetail;

ElMessage.success(
    `草稿已保存，Revision ${savedDetail.revision}`
);

// 下面只是 UI 后处理

const refreshResults =
    await Promise.allSettled([
        loadScenes(),
        reloadEditorState()
    ]);

if (
    refreshResults.some(
        item => item.status === 'rejected'
    )
) {
    ElMessage.warning(
        '草稿已经保存，但页面状态刷新不完整'
    );
}

return true;
```

---

# 8. 一次保存可能 Revision 连加两次

当前还有：

```text
updateScene()
+
saveDraft()
```

两个 mutation。

如果它们都增加 revision：

```text
Revision 17
↓
updateScene
18
↓
saveDraft
19
```

用户只点一次：

```text
保存草稿
```

Revision 却可能增加两次。

长期建议修掉。

---

## 8.1 推荐后端原子保存

推荐：

```http
PUT /digital-twin/scenes/{sceneId}/draft
```

一次提交：

```json
{
  "expectedRevision": 17,

  "metadata": {
    "name": "...",
    "description": "...",
    "rootAssetId": "..."
  },

  "draftPayload": {}
}
```

后端事务：

```text
Check Revision
↓
Update Metadata
↓
Update Draft Payload
↓
Revision +1
↓
Commit
```

保证：

```text
一次 Save
=
Revision +1
```

---

# 9. Publish 为什么也会 Revision 增加后再报错

当前 Publish：

```text
点击发布
↓
先 saveDraft(true)
↓
再 publish()
```

所以例如：

```text
Draft Revision = 18
```

点击发布：

```text
saveDraft()
↓
Revision = 19
↓
publish()
↓
如果 publish 失败
```

最终：

```text
用户看到发布失败
但 Draft Revision 已经是 19
```

这不是数据库乱了，是当前前端操作链决定的。

---

# 10. Publish 成功后 Refresh 失败也不能说发布失败

Publish 后当前还会刷新：

```text
versions
scenes list
```

如果：

```text
publish API 已成功
```

但是：

```text
loadSceneVersions()
或
loadScenes()
```

失败：

不能反过来说：

```text
发布失败
```

正确：

```text
V7 已发布成功，
但版本列表刷新失败。
```

---

# 11. Publish 分成三个状态

```text
Stage 1
Draft Saved

Stage 2
Publish Committed

Stage 3
UI Refreshed
```

真正决定发布成功的是：

```text
Stage 2
```

Stage 3 失败只能 Warning。

---

# 12. Draft Revision 与 Published Version 必须区分

建议系统明确：

```text
DraftRevision
PublishedVersionNo
PublishedVersionId
SourceDraftRevision
```

例如：

```text
Draft Revision = 27
↓
Publish
↓
Published Version = V6
Source Draft Revision = 27
```

之后继续编辑：

```text
Draft Revision = 28
29
30
```

但是：

```text
Published V6
```

必须保持不可变。

---

# 13. Published Version 必须 Immutable

发布历史：

```text
V1
V2
V3
...
```

是正式快照。

不能因为 Draft 后续继续保存而变化。

只有这样才能支持：

```text
生产运行
历史追溯
版本比较
回滚
审计
```

---

# 14. 当前已经有 Version API，但产品入口不完整

当前客户端已经有：

```text
versions(sceneId)
getVersion(sceneId, versionId)
publish(...)
rollback(...)
```

Workbench 也已有部分 Version Drawer。

但是缺少明确产品链：

```text
场景列表
↓
编辑 Draft
↓
发布
↓
去哪里查看 Published Scene？
↓
去哪里查看历史版本？
```

所以应该新增独立页面。

---

# 15. 新增 Scene Center

路由建议：

```text
/iot/digital-twin/scenes
```

页面：

```text
数字孪生场景中心
```

列表字段：

```text
Scene Name
Draft Revision
Latest Published Version
Status
Draft Updated At
Published At
```

操作：

```text
编辑
预览草稿
查看已发布
版本记录
复制运行链接
```

---

## 15.1 场景状态

建议：

```text
DraftOnly
Published
ModifiedAfterPublish
Publishing
PublishFailed
Archived
```

中文：

```text
仅草稿
已发布
发布后有修改
发布中
发布失败
已归档
```

---

# 16. 新增 Version History Page

路由：

```text
/iot/digital-twin/scenes/:sceneId/versions
```

不要只依赖 Workbench 里的 Drawer。

字段：

```text
Version No
Version ID
Source Draft Revision
Published By
Published At
Change Summary
Validation Result
Current?
```

操作：

```text
查看
与当前版本比较
与 Draft 比较
回滚为新 Draft
复制版本链接
```

---

# 17. Rollback 不应该删除历史

例如：

```text
V4
V5
V6
```

用户选择：

```text
Rollback V4
```

正确：

```text
读取 V4
↓
创建新的 Draft Revision
```

历史：

```text
V4 / V5 / V6
```

继续保留。

---

# 18. 新增 Published Viewer

这是当前发布流程最需要补的页面。

建议：

```text
/iot/digital-twin/viewer/:sceneId
```

默认打开：

```text
Latest Published Version
```

查看指定历史版本：

```text
/iot/digital-twin/viewer/:sceneId/:versionId
```

---

# 19. Workbench 与 Published Viewer 分开

Workbench：

```text
编辑器
```

可以：

```text
拖模型
改 Route
保存 Draft
发布
```

Published Viewer：

```text
正式运行查看
```

不能编辑 Manifest。

只提供：

```text
运行
暂停
复位
实时 / Simulation
视角
全屏
运行指标
告警
MCP / AI
```

---

# 20. 发布成功以后直接给入口

Publish Success：

```text
发布成功

Version:
V7

Source Draft:
Revision 28
```

按钮：

```text
[查看已发布场景]

[查看版本记录]

[继续编辑]
```

这样“发布以后去哪里看”就有明确答案。

---

# 21. Draft Preview 也应该独立

建议：

```text
/iot/digital-twin/preview/:sceneId
```

或 Viewer 支持：

```text
?source=draft
```

区别：

```text
Draft Preview
=
当前尚未发布的编辑结果

Published Viewer
=
正式不可变发布版本
```

---

# 22. 推荐版本数据

```ts
interface DigitalTwinSceneDetail {
    id: string;

    draftRevision: number;

    latestPublishedVersionId?: string;
    latestPublishedVersionNo?: number;
    latestPublishedSourceRevision?: number;

    draftUpdatedAt?: string;
    publishedAt?: string;

    publicationState:
        | 'draft-only'
        | 'published'
        | 'modified-after-publish';
}
```

Published DTO：

```ts
interface DigitalTwinPublishedVersion {
    versionId: string;
    sceneId: string;

    versionNo: number;
    sourceDraftRevision: number;

    payload: TwinSceneManifest;

    publishedBy?: string;
    publishedAt: string;

    changeSummary?: string;
}
```

---

# 23. Revision Conflict 必须有专门错误码

后端：

```http
409 Conflict
```

返回：

```json
{
  "code": "REVISION_CONFLICT",
  "expectedRevision": 27,
  "actualRevision": 28
}
```

前端：

```text
场景已经被其他操作修改。

你的 Revision：27
服务器 Revision：28

[重新加载]
[比较差异]
```

不能把所有异常都说成：

```text
可能存在版本冲突
```

---

# 24. Save / Publish 错误码建议

```text
SAVE_DRAFT_FAILED
REVISION_CONFLICT
SAVE_COMMITTED_REFRESH_FAILED

PUBLISH_FAILED
PUBLISH_COMMITTED_REFRESH_FAILED

VALIDATION_FAILED
NETWORK_FAILED
```

---

# 25. 建议增加 Operation Result

Save：

```json
{
  "operation": "SaveDraft",
  "serverCommitted": true,
  "revision": 28,
  "localApplied": true,
  "sceneListRefreshed": false
}
```

Publish：

```json
{
  "operation": "Publish",
  "draftSaved": true,
  "publishCommitted": true,
  "publishedVersion": 7,
  "versionsRefreshed": false
}
```

这样以后报错时能直接判断：

```text
是数据库写入失败
还是 UI 刷新失败
```

---

# 26. 主要修改文件

## 问题一

重点：

```text
ClientApp/src/digital-twin/runtime/PalletFlowController.ts
ClientApp/src/digital-twin/runtime/SilkCakeLineRuntime.ts
ClientApp/src/digital-twin/runtime/ProcessStationManager.ts
```

Contracts：

```text
palletPopulationMode
closedLoop
deadlock watchdog
```

---

## 问题二

重点：

```text
ClientApp/src/digital-twin/runtime/ProceduralSilkCakeLine.ts
```

建议新增：

```text
ClientApp/src/digital-twin/runtime/GantryPoseResolver.ts
```

继续复用：

```text
GantryStackController.ts
StackAreaManager.ts
SilkMaterialRuntime.ts
```

不要重新写 Stack 业务逻辑。

---

## 问题三

重点：

```text
ClientApp/src/views/iot/digital-twin/workbench.vue
ClientApp/src/api/digital-twin/index.ts
```

后端：

```text
Draft Save API
Publish API
Versions API
```

新增页面建议：

```text
ClientApp/src/views/iot/digital-twin/scenes/index.vue
ClientApp/src/views/iot/digital-twin/versions/index.vue
ClientApp/src/views/iot/digital-twin/viewer/index.vue
```

---

# 27. P0 开发顺序

```text
1. 80 Pallet Closed Loop
2. 扩大 Line / Section Capacity
3. Loading Buffer FIFO Compaction
4. Deadlock Watchdog
5. Gantry Safe Y
6. Layer-aware Place Y
7. Gantry 2×3 Slot Parent
8. Save Commit 与 Refresh Error 拆开
9. Publish Commit 与 Refresh Error 拆开
10. Published Viewer
```

---

# 28. P1 开发顺序

```text
Scene Center
Version History Page
Draft / Published Compare
Rollback To New Draft
Published Link
Publish Audit
WCS Inbound Viewer
```

---

# 29. 总体验收矩阵

| 项目 | 验收要求 |
|---|---|
| Plastic Pallet 总数 | 始终 80 |
| SourceQueue | Closed Loop 正常运行时为空 |
| 托盘循环 | 80 个托盘最终都 `cycleCount > 0` |
| Loading Buffer | FIFO 动态补位，无永久 Slot 绑定 |
| Robot Batch | 6 个空托盘齐全才启动 |
| Section Capacity | `Occupancy + Reserved <= Capacity` |
| Deadlock | 200+ 批次无固定 Slot 死锁 |
| Gantry Pick | 不穿 Plastic Pallet |
| Gantry Horizontal Move | 始终高于障碍 Safe Clearance |
| Gantry Layer | Layer 7 明显高于 Layer 0 |
| Gantry 2×3 | 六个 Cake 保持 2×3 相对位置 |
| Stack | 8 层 × 6 = 48 |
| Save | Server 成功后不能显示“保存失败” |
| Revision | 一次 Save 最好只增加一次 |
| Publish | 明确生成 Published Version |
| Publish Refresh | Refresh 失败不能反转 Publish Success |
| Versions | 有独立历史版本页面 |
| Viewer | 有独立 Published URL |
| Publish UX | 发布完成可直接“查看已发布场景” |
| Rollback | 创建新 Draft，不破坏历史版本 |

---

# 30. 最终结论

三个问题分别属于三个层次。

### 问题一：物流运行模型

从：

```text
SourceQueue
+
固定上料 Slot
```

改成：

```text
80 Plastic Pallet
+
Expanded Closed-Loop Conveyor
+
FIFO Loading Buffer
+
Deadlock Watchdog
```

80 个托盘全部一直在线循环。

### 问题二：桁架空间轨迹

当前：

```text
Runtime 已经知道 layer
```

但：

```text
Three.js Gantry Motion 没有使用 layer 计算 Y
```

导致：

```text
固定高度平移
固定下降
穿托盘
最后 Snap 到正确层
```

正确方案：

```text
Pick Above
↓
Vertical Pick
↓
Safe Lift
↓
Safe Horizontal Move
↓
Layer-Aware Vertical Place
↓
Release
```

### 问题三：版本与发布产品流程

当前：

```text
服务端保存/发布
+
UI 后处理刷新
```

共用一套错误处理。

所以可能出现：

```text
Server 已成功
Revision 已增加
但 UI 仍提示失败
```

必须拆成：

```text
Draft Commit
Published Version Commit
UI Refresh
```

三个不同结果。

同时新增：

```text
Scene Center
Version History
Published Viewer
```

形成完整产品链：

```text
编辑 Draft
↓
保存
↓
发布 Vn
↓
查看已发布
↓
版本记录
↓
继续编辑 Draft
```

这三项完成后，数字孪生才会从当前“能跑的模拟场景”进一步变成可长期运行、发布、追溯和运维的正式功能。

---

# 16. V5.1 实际落地基线（2026-08-28）

本节是对前述建议的工程收口。它定义当前代码已经实现的事实、必须长期保持的运行不变量，以及后续修改的回归门槛。若本节与前文的“建议实现”有差异，以本节的已落地结构为准。

## 16.1 最终运行边界

当前工作台的 `silk-cake-packaging-line` 预设仍由 `TwinRuntime` 装配 `ProceduralPackagingLine`。这是有意保留的兼容边界：现有单体运行时已经覆盖双面丝车、1×6 机器人、2×3 桁架、八层木托、盖板、贴标、缠膜和入库，直接切换到尚未覆盖全部后包装工艺的模块化运行时会产生功能回退。

本轮复用了以下稳定能力：

- `TwinMaterialFlowRuntime`：Section Capacity、实体当前段、Waiting/Resume；
- `TwinManifestInspector`：Manifest 安全校验、绑定与路线数据库投影；
- Draft / Publish 服务：租户边界、乐观并发、不可变发布快照；
- Three.js Runtime：渲染、选择、运行指标、模型资源加载。

新增的专业化部件为：

- `GantryPoseResolver`：把目标层转换为安全的空间轨迹；
- 回流 FIFO 有符号沿线坐标：统一不同分支进入汇流后的车序；
- 物理距离防碰撞：路线进度只负责定位，实体是否能够前进由真实米制间距决定；
- Deadlock Watchdog：持续无工艺进展时清理过期目标槽预留，再按真实空位压实；
- Scene Center / Published Viewer：把草稿编辑和线上只读运行分开。

## 16.2 80 托盘闭环的强不变量

运行时必须始终满足：

```text
TotalPallets = 80
SourceQueue = 0
OnlinePallets = 80
Σ Section.Occupancy = 80
Section.Occupancy + Reserved <= Section.Capacity
任意两个在线托盘的 XZ 中心距 >= 1.5m
FIFO 序列不允许超车
```

其中 `SourceQueue` 只作为构造阶段的临时集合。初始化结束后，前 6 个托盘进入机器人上料位，其余 74 个托盘已经分布到回流物理缓存环，不存在“仓库里还有 74 个逻辑托盘、画面里只有 6 个”的双重现实。

每个塑料托盘记录 `cycleCount`。验收不能只观察第一批托盘是否回到上料位，必须在加速仿真中证明：

```text
80 / 80 pallets have cycleCount > 0
```

## 16.3 为什么回流线必须改成正交矩形

旧回流路线在西侧使用一条斜线直接连接机器人上料入口。即使沿线节距达到 2.2m，两辆托盘分别位于斜角两边时，欧氏距离仍可能缩小到 1.5m；此时前车转弯会进入后车安全圆，后车又不能倒车，形成几何死锁。

V5.1 将回流缓存改为五段正交路线：

```text
Merger (15, -4.2)
→ East-Lower (44, -4.2)
→ North-East (44, 34)
→ North-West (-42, 34)
→ West-Lower (-42, -5.8)
→ Source (-11, -5.8)
```

托盘回流节距为 2.2m。对 90° 拐角，两车沿线距离为 `s` 时，最不利的欧氏距离为：

```text
dmin = s / √2 = 2.2 / 1.414 ≈ 1.556m > 1.5m
```

因此该路线不是为了“把画面拉大”，而是同时满足回流容量和转弯包络的几何约束。辊道模型直接由相同 Route Point 生成，路线编辑器控制点与可见辊道不会再各用一套坐标。

## 16.4 FIFO、汇流和动态上料位分配

回流托盘使用全局单调 `returnSequence`。A/B 支路离开桁架时，先按到汇流口的物理距离编队，再进入统一 FIFO。

所有回流托盘用“距机器人回流入口的有符号沿线距离”作为公共坐标：

```text
coordinate = distanceToReturnEntry - progress × pathLength
```

相邻 FIFO 实体必须满足：

```text
follower.coordinate >= leader.coordinate + 2.2m
```

上料位不再永久绑定给某一个返回托盘。每一帧按当前真实空位从最深的 5 号位向 0 号位分配，队首先进入最深可达位置，后车依次停靠。托盘到达终点但目标位被占用时停在入口前，不允许 `progress = 1` 后瞬移、穿过已停托盘或降级到任意空槽。

## 16.5 桁架安全轨迹和分层高度

桁架结构高度已提升到 8.4m，小车统一安全高度不低于 7.45m。完整动作分为：

| 阶段 | 进度 | 约束 |
|---|---:|---|
| Approach Pick | 0–0.10 | 位于安全平面 |
| Descend Pick | 0.10–0.22 | 只做竖直下降 |
| Grip | 0.22–0.30 | 2×3 六件全部确认 |
| Lift Pick | 0.30–0.42 | 先升到安全平面 |
| Transfer | 0.42–0.62 | 只在安全平面做水平运动 |
| Descend Place | 0.62–0.76 | 使用目标层高度 |
| Release | 0.76–0.82 | 放置后解绑 |
| Lift Place | 0.82–0.91 | 竖直撤离堆垛 |
| Return Home | 0.91–1.00 | 安全平面返回 |

目标层小车高度为：

```text
placeCarriageY(layer) = 3.82 + layer × 0.46m
layer ∈ [0, 7]
```

第 8 层相对第 1 层提高 3.22m。水平转运始终使用安全高度；不能重新改回固定 `sin(progress) × dropHeight` 的视觉动画。

夹具抓取后，六个丝饼始终保持 2 行 × 3 列拓扑。转运过程中，取料节距平滑收拢到木托盘堆叠节距，不把六个对象合并为一个，也不允许行列互穿。

## 16.6 草稿保存的事务语义

一个“保存草稿”动作现在只有一次后端请求，并在同一个 `SaveChanges` 中提交：

```text
Scene Name / Description / RootAssetId
+ Normalized Manifest
+ Draft Bindings
+ Draft Routes
+ Audit Log
+ Revision + 1
```

前端不再先调用 `UpdateScene`、再调用 `SaveDraft`，所以一次点击不会产生两个 revision。

提交结果分为两个阶段：

1. Server Commit：失败才显示“保存失败”；
2. Local Refresh：失败显示“已提交成功，但页面刷新失败”。

严禁因为 `loadScenes()` 或 Three.js 本地重载失败，把已经写入数据库的 revision 误报成保存失败。

## 16.7 发布、版本和回退语义

每一个 `DigitalTwinSceneVersion` 都记录：

- 不可变 Manifest 和 SHA-256；
- Bindings / Routes 发布快照；
- `SourceRevision`，即该发布版本来源的草稿 revision；
- 校验报告、发布人、发布时间和变更说明。

页面状态由以下规则计算：

```text
无 PublishedVersion             → 仅草稿
DraftRevision = SourceRevision  → 已发布
DraftRevision > SourceRevision  → 发布后已修改
```

“回退”不再改变当前线上发布指针。它执行：

```text
选择历史 vN
→ 复制不可变 Manifest / Binding / Route 到新草稿
→ Draft Revision + 1
→ 当前线上版本保持不变
→ 用户确认后再发布成新的 vN+1
```

这样历史版本不会被删除或重写，线上运行也不会因为查看历史而突然切换。

已增加的产品入口：

- `/iot/digital-twin/scenes`：场景中心；
- `/iot/digital-twin/workbench?sceneId=...`：精确打开草稿编辑；
- `/iot/digital-twin/viewer?sceneId=...&version=N`：不可变发布版本只读运行；
- 工作台“版本与回滚”：从历史版本创建新草稿。

## 16.8 SQL Server 数据库升级

SQL Server 迁移：

```text
20260828090000_AddTwinVersionSourceRevision
```

新增 `DigitalTwinSceneVersions.SourceRevision bigint not null`。旧发布记录使用版本号回填为兼容值；新发布记录写入真实草稿 revision。模型快照已经同步，后续 EF Migration 不会重复添加该列。

## 16.9 自动验收结果

前端工艺验收命令：

```bash
npx vite-node@1.6.1 scripts/verify-packaging-line.ts
```

2026-08-28 的实际结果：

```text
plasticPallets                 80
cycledPallets                  80/80
SourceQueue                    0
minimumPalletGapMeters         1.500
robotBatch                     1×6
gantryBatch                    2×3
woodPallet                     2×3×8 = 48
storedWoodPallets              >= 1
distinctPalletsAfterMerger     true
robotReturnRouteAligned        true
status                         PASS
```

同时通过：

```text
npm run build
dotnet test IoTSharp.Test/IoTSharp.Test.csproj --filter FullyQualifiedName~DigitalTwin
```

后端数字孪生专项测试结果为 7/7 通过。构建日志中的 NuGet 漏洞提示属于仓库既有依赖治理问题，不是本次 V5 代码失败，但应另立安全升级任务处理。

## 16.10 后续 P1，不得混入 P0 正确性

以下工作可以继续，但不能以牺牲上述不变量为代价：

1. 把单体 `ProceduralPackagingLine` 的后包装工艺逐步下沉到模块化 Controller；每迁移一段必须保持同一验收脚本通过；
2. 为 80 托盘近邻检测引入运行时空间索引，降低极大场景的 O(N²) 检查成本；
3. PLC 模式下将 Section Occupancy、岔口到位和急停信号接入 Watchdog 诊断，保持仿真和真实信号同一状态语义；
4. 增加发布版本差异对比和双人审批；不改变版本不可变原则；
5. 将依赖漏洞升级作为独立安全变更验证，避免与产线状态机改造混合发布。
