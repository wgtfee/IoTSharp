# IoTSharp Studio V2 r7 — 蓝色箭头、套袋进出料和实体辊道

> 2026-11-16。依据用户最新标注的平面图：**蓝色横向箭头向右、缓存架右侧内排蓝色纵向箭头向上**；外层红色纵向段下行。不能因为路线连通就认定实际存在输送设备。

## 场景与保护

- Windows 工程：`H:\code\Industrial.Platform\IoTSharp-master`，`Develop`；工作区包含其他未提交改动，均应保留。
- 本地 SQL Server：`DESKTOP-2ALRK02\MSSQ`，数据库 `IOTSharp`。
- **原始 V19**：`69a6b03a-0a0c-45e9-b3c1-f29bcaeb142e`，Published r11，只读。数据库 NVARCHAR 哈希在修改前后均为 `470C08343F35E5671B38455D3018CA15C1A726FD8AB7E2AD4D93A1DD24393B66`。
- **仅修改 V2 副本**：`d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94`，Draft r6 → **Draft r7**，使用严格 Revision=6、原始字节匹配及 Serializable 事务提交。写入后新 JSON 与审核文件完全一致。
- 未向 PLC、MES、包装机、机器人或真实设备下发指令；只运行隔离 Simulation。

## 原因与本次更改

1. 先比较真实 r6 RouteEdge、双排辊道旋转角和局部车道方向：`ref-edge-loaded-upper-right-in`（从 `ref-loaded-inner-up` 向右）和 `ref-edge-loaded-upper-right`（从右侧内排下方向上）原有**逻辑边方向与两处蓝箭头已相符**，因此没有盲目反转这两条路线。右侧双排 A 道上行、B 道下行保持不变。
2. 真正的实体不一致在套袋 A、B：主路线要求右入左出，原机器模型 `rotationY=0` 却把左右入口输出端口放反；两个模型均转向 `rotationY=π`。
3. 机器前后各有实际空缺，旧路线把一条边直接穿过空气。新增四段**真实的参数化小辊道**，全长按机器本体物理端口而不是工位中心推算：

   | 衔接段 | 实体长度 | 世界坐标中点 (x,z) | 方向 |
   | --- | ---: | --- | --- |
   | 套袋 A 入口 | 1.8m | (19.1, -12.9) | 向左 |
   | 套袋 A 出口 | 5.0m | (9.3, -12.9) | 向左 |
   | 套袋 B 入口 | 2.3m | (18.85, -5.5) | 向左 |
   | 套袋 B 出口 | 4.5m | (9.05, -5.5) | 向左 |

4. 主闭环原本的 `ref-edge-bag-a`、`ref-edge-bag-a-out` 和 B 道对应边改为**设备与辊道分段**，增加真实入口/出口点；路线依然保持原 `component-route-d045206d` ID 和循环逻辑。场景由 **52 对象、47 连接、38 主路线点、42 边**变为 **56 对象、51 连接、42 主路线点、46 边**，默认循环 108 个小托盘不变。
5. A 套袋机出口不是连接右侧双排辊道最上端！在 `reference-double-small-upper-right` 的 B 排增加 `bag-a-outfeed` 中途接驳口（局部 x=1.4，世界 z=-12.9），避免错误的远距端口连接。
6. `StudioV2PhysicalRouteGuard` 在 V2 余丝缓存场景进入 Simulation 前检查袋机方向、实体辊道数量与长度、四段 route 的归属、蓝箭头、A 排中途接驳及双排运行方向。**旧 r6 必须拒绝启动**；缺辊道、短辊道、蓝箭头反向、套袋设备方向反转均触发负向测试。
7. `TwinRuntime` 对不符合物理约束的开始操作 fail-closed，连同已有运动子引擎停止；Studio V2 的运行标签现在从真实运行状态回读，不能“报错但仍显示运行中”。

## 验证（代码和真实浏览器）

- TypeScript 全量 `vue-tsc --noEmit`：通过。
- `verify-studio-v2-bagging-physical-routes.mjs`：旧 r6 安全违规、r7 零违规、缺/短辊道、反转箭头、错误端口的负向测试通过。
- `verify-studio-v2-blue-arrow-browser.cjs`：真实 Edge、Three.js 和本地 Vite 测试；先读取 SQL r6 派生候选，再从**数据库真实 Draft r7 再次只读导出复测**。旧版禁止启动，新版能启动；四段辊道模型在实际 Three.js 中存在，场景结构错误 0、浏览器错误 0；108 小托盘身份稳定，短时采样没有小于 1.5 米的重叠（最小约 1.500606m）。
- 最新浏览器截图：`ClientApp/.tmp-studio-v2-blue-arrows-r7-browser/studio-v2-blue-arrow-bagging-physical-rollers.png`；对应 `report.json`。
- SQL 事务、数据库回读和 V19 SHA256 核验通过；未覆盖远程 `Develop`。

## 明确尚未验收

- 工程诊断从 71 条增为 **75 条警告**。这不是通过全部机械净空检查；特别需要 CAD 包络签核、辊道端口接驳容差、A/B 进出口及旋转/分合流机械干涉检查。**禁止简单隐藏警告**。
- 图纸左侧双排回流、底部回流、缓存机器人周围的整个红色箭头区域**尚未逐米 CAD 对照签核**。本轮保留确认正确的两条蓝色路线并补齐可证实的机器缺口，不臆造未给出尺寸的附加弯道。
- 108 托盘 **多圈完成数、长稳无死锁**未通过验收；短时 0 重叠不等于多圈合格。
- 桁架结批→余丝入缓存→新任务匹配→生产线实际接收、全线外检/套袋/包装一体化联调未通过完整验收。
- 本轮以真实渲染运行时与 SQL 场景做测试；在未启用后端登录态时，不将独立 Edge 仿真视为已经验收实际 Studio V2 登录后页面及业务 HTTP。
- Git 保护：当前 `TwinRuntime.ts` 和 `studio-v2/index.vue` 等已含本轮之前的其他未提交工作，本轮在其中增加的安全互锁与 UI 状态回读仍保留在 **Windows 实际工作区**，不会把整份脏文件强行打包进仅新增文件的隔离代码分支。故独立归档分支需要与本地集成改动合并后才能成为完整可部署源码，**不可把归档分支直接视为完整 r7**。

## 复现

```powershell
cd ClientApp
node --experimental-strip-types scripts/verify-studio-v2-bagging-physical-routes.mjs
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit --pretty false
$env:STUDIO_V2_BLUE_MANIFEST='.tmp-studio-v2-blue-arrow-r7-sql-live.json'
node scripts/verify-studio-v2-blue-arrow-browser.cjs
```

SQL 移植脚本（开发机限定，默认只检查；只应执行一次）：

```powershell
pwsh -NoProfile -File scripts/digital-twin/apply-studio-v2-blue-arrow-bagging-r7.ps1
# 仅在 SQL 副本仍为完全一致的 r6 时允许：
pwsh -NoProfile -File scripts/digital-twin/apply-studio-v2-blue-arrow-bagging-r7.ps1 -Apply
```

本轮 SQL 已经更新到 r7；不要对现在的 r7 重复运行 r6→r7 的 Apply。
