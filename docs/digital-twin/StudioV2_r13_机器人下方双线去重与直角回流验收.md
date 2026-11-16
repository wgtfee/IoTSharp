# Studio V2 r13：机器人下方只保留两条水平辊道，右端改两次 90°直角回流

日期：2026-11-16。用户发现 r12 机器人下直接出现**三条**水平辊道，同时右端 U 型转弯为**半圆角**，与原图的直角转接不符。本轮基于开发 SQL Server 的真实 V2 Draft r12、完整实体清单、主闭环对象引用和真实 Edge + Three.js 仿真修复。验收范围严格限制在物理布局与隔离缓存交接，**不宣称整线多圈与主闭环动态交接成功**。

## 1. 三条辊道的根因（已确认）

原有产线 **已经**存在 `reference-conveyor-ref-edge-loaded-upper-right-in`：一条小托盘主闭环载丝辊道，位于世界 z=-5.3、中心 x=-2.95，长度 15.7m，从 x=-10.8 向右到 x=4.9。它是 108 托盘主路线 `component-route-d045206d` 的边 `ref-edge-loaded-upper-right-in`，不可作为“错误多出来的无用组件”直接删除。

r12 又新增了两条水平实体：

- 重复的“蓝线” `studio-v2-surplus-silk-handoff-roller`：z=-6.25；
- “红线” `studio-v2-surplus-silk-empty-return-roller`：z=-4.35；

原蓝色主线 z=-5.3 被夹在这两条之间，三条还存在宽度重叠。仅把新双排组件改成“两个独立辊道”并不解决**重复添加已有原线**的问题。

## 2. r13 实际解决方案

| 项目 | r13 结果 |
| --- | --- |
| 蓝线（载丝小托盘向右） | **直接复用原主闭环的 `reference-conveyor-ref-edge-loaded-upper-right-in`**，x=-2.95，z=-5.3，长度 15.7m，原 `input/output` 及主物流路径保留 |
| 删除第三条水平线 | **彻底移除** `studio-v2-surplus-silk-handoff-roller` 场景实体，且增加启动守卫禁止再次添加 |
| 红线（空小托盘向左） | 唯一新增水平辊道 `studio-v2-surplus-silk-empty-return-roller`，中心 x=-3.9，z=-3.4，长 17.6m，旋转 π；在蓝线更下方 1.9m，延伸到左侧内竖向回流道 |
| 右端直角折返 | 原 `turn-conveyor-90` **弧形/180°半圆组件被替换**为普通 `roller-conveyor-v1` 垂直短辊道，x=4.9、z=-4.35，长 1.9m，yaw=-π/2 |
| 两次 90°转接 | 蓝线沿 X 右行，第一处**直角**转世界 +Z，下行 1.9m 后第二处**直角**进入向左的红线；路径只有水平与垂直直线段，**无 CatmullRom / 圆弧轨迹** |
| 真实物理端口 | 原蓝线 `output` 已被主回路连接占用，故新增独立 `cache-branch-output`，标识 `simulationPreviewOnly` 和需要主回路占位授权；垂直短辊道两端使用面向相邻设备的 **90°侧向端口**，通过严格端口相向/距离校验 |
| 左侧回流方向 | 红线左端仍接已有内侧竖向回流道，`cache-empty-lower-return` tap 位置调整为 local X=0.35（对应 z=-3.4），之后向下 |
| 托盘 | 仍为项目既有绿色圆形 `builtin-small-pallet`，机器人抓丝后同一**预览**托盘沿直角转接和红线连续运动 |

注：蓝线原来的主路径已连接其他设备。新增分支只作为**隔离仿真预览交接端口**，不视为真实 108 托盘分流已实现；后续需要主线占位锁、真正托盘实体移交及下游确认。

## 3. 数据库保护与 Git

- SQL Server：`DESKTOP-2ALRK02\MSSQ`，库 `IOTSharp`。
- V2 副本 ID：`d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94`，**Draft r12 → Draft r13**。NVARCHAR DraftPayload SHA256：`EB32032A3BCC0B5166DC24002AA6375771FDFC7B16BE4D577079955F2959617F`。
- 原始 V19 ID：`69a6b03a-0a0c-45e9-b3c1-f29bcaeb142e`，严格只读，**Published r11**，SHA256：`470C08343F35E5671B38455D3018CA15C1A726FD8AB7E2AD4D93A1DD24393B66`，未变化。
- 场景对象数由 58 降为 57；连接总数 53；路线 5；余丝局部路线 7 点/6 边。108 小托盘主闭环仍 42 点/46 边，所有既有路线边和初始托盘数保持不变。
- r13 SQL 更新为 **一次性 SERIALIZABLE 事务**，检查 r12 精确哈希、V19 原哈希、目标 ID、SceneKey 和 Draft revision，并在事务中回读确认。更新后独立 SQL readback 与已经过浏览器测试的 JSON 全文一致。
- 远程 `Develop` 和本地其他未提交文件不覆盖；源码和截图仅推独立验证分支。

## 4. 专项测试结果

| 验证项 | 结果 |
| --- | --- |
| TypeScript `vue-tsc --noEmit --pretty false` | **通过** |
| r12 的第三条重叠辊道/半圆角配置被阻止启动 | **通过** |
| r13 物理路径校验 | **0 错误** |
| 11 项退化反例（第三条出现、红线上移、圆弧、直角端口错误、分支抢占 output 等） | **全部阻断** |
| 真实 Edge + Three.js 候选测试 | **通过**，0 场景结构错误 |
| **从 SQL Draft r13 实际回读**后再次在 Edge + Three.js 测试 | **通过**，0 页面运行错误 |
| 机器人下水平辊道实体数量 | **精确 2 条**，分别是原蓝主线与新增红线，旧重复蓝线不存在 |
| 圆角物理组件 | **已移除**，改为垂直短直辊道、两处 90°端口 |
| 动态路径 | **通过局部隔离仿真**：机器人取丝后空小托盘保持 X=4.9 直线下行，不走圆弧，随后沿红线向左到达接驳口 |
| 绿色小托盘 | **通过**，非木托盘，动作不瞬移 |
| 108 原主路线及托盘 ID | **保持不变**，仅做短时身份回归，不代表整线多圈通过 |
| 工程警告 | **未解决：77 条** |
| 真正的 108 托盘主线 → 缓存支路分流 | **未验收**，待实体身份和占位互锁 |
| 红线 → 原左侧下行主线动态接收/放行 | **未验收**，当前仍是隔离的显式接收确认 |
| PLC/MES/机器人真机 | **未执行**，无任何下发指令 |

## 5. 复现

本机文件：

- r13 候选构建：`ClientApp/scripts/build-studio-v2-two-lines-square-turn-r13.cjs`
- r13 11 项反例校验：`ClientApp/scripts/verify-studio-v2-two-lines-square-turn-r13.mjs`
- r13 Edge + Three.js E2E：`ClientApp/scripts/verify-studio-v2-two-lines-square-turn-r13-browser.cjs`
- r13 一次性 SQL 保护更新：`scripts/digital-twin/apply-studio-v2-two-lines-square-turn-r13.ps1`，**已执行，不得再次对 r13 调用**。
- SQL 精确回读文件：`ClientApp/.tmp-studio-v2-r13-db-readback.json`。
- 最终四张浏览器截图及 JSON 报告：`ClientApp/.tmp-studio-v2-two-lines-square-turn-r13-sql-edge/`。

凡是**已画出接驳口但尚未实现跨 108 托盘主回路占用交接**的功能，均只能标记为局部仿真通过，不能标记整线最终验收完成。
