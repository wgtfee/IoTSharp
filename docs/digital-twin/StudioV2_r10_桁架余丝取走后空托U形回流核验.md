# Studio V2 r10：桁架余丝托盘经机器人取丝后 U 型空托回流

日期：2026-11-16。依据用户原始平面图红色箭头、蓝色更正箭头及新一轮口述确认。**已完成局部仿真与 SQL Draft 验证；尚未完成主闭环真实托盘转交与回流联锁**。

## 1. 纠正 r9 的业务误解

r9 的两排只是两个没有运输载体的短辊道，机器人单独将丝锭送到挂杆或取回，还把 B 排误当成同批余丝复用返回输送道。这不符合图纸。

正确流程：

1. 桁架结批剩余丝锭随托盘经内排 A 从左向右到达缓存机器人。
2. 机器人从托盘抓走丝锭并放入独立挂杆缓存位，**同一个托盘从有丝转为空托**。
3. 抓丝后原空托沿 A 排继续向右，通过右端实体 **180° U 型转弯辊道**转至外排 B。
4. B 排 **只允许运送空托盘**，从右向左回流，不传送库存复用丝锭。
5. B 排左端应与产线主空托回流道连接。本轮尚未建立跨主回路的占位仲裁和交接确认，因此**在 B 左端等待下游明确确认，不能自动删除空托或计为主闭环完成**。

## 2. 数据库和代码

原始 V19：`69a6b03a-0a0c-45e9-b3c1-f29bcaeb142e` Published r11，严格只读，SHA256:

`470C08343F35E5671B38455D3018CA15C1A726FD8AB7E2AD4D93A1DD24393B66`

Studio V2：`d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94` **Draft r9 → r10**，SQL Server `DESKTOP-2ALRK02\MSSQ` / `IOTSharp`，DraftPayload NVARCHAR SHA256:

`6DDBD18A99EA401DFA2E54ED6E73A7D3F1D68BD5F6DC31A73811CCF532F32C1E`

候选从精确核对的 SQL r9 快照生成；更新事务采用 r9 哈希、SceneId、SceneKey、Draft 修订号、原 V19 哈希保护，提交后数据库精确回读一致。

- 场景实体 **57**（增加 U 形实体辊道）、连接 **52**、路线 **5**。缓存支路 6 点 5 边，A 与 B 各 2 边，中间增加 1 条实体转弯边。
- 注册的转弯资源 `builtin-turn-conveyor-90` / `turn-conveyor-90-v1`，设置 `sweepDegrees=180`、半径 0.95m，实际有弧形边梁、辊筒和支腿。
- `SurplusSilkCacheRuntime` 增加有料载体实体，丝锭随托盘进入、机器人在交接位抓取后托盘 `loaded → empty`，同一托盘 ID 沿折返曲线连续运动，不会瞬移。
- B 排回流出口的托盘停留在 `awaiting-empty-return-acceptance`，下游没有确认时不得入第二托，测试的错误托盘确认不得放行。可通过隔离仿真 API 显式确认。
- 对于缺少实际桁架移交的手动仿真事件，托盘被标记为 `previewOnly=true`，**不能当作 108 个主闭环托盘中的一个已成功转交的实体**。
- 原 108 托盘闭环保持原有 **42 点 / 46 边**，没有增加、删除、占用或重置这些主线托盘实体。
- `StudioV2PhysicalRouteGuard` 严格拒绝 r9 的无实体折返、错误物料用途、反向边、缺少转弯组件或端口连接的场景。

## 3. 实测结果

| 验收项 | 结果 | 验证范围 |
| --- | --- | --- |
| r9 缺少 U 转弯被阻断 | 通过 | 旧场景启动互锁失败 |
| r10 路线及 5 种反例校验 | 通过 | 物理 U 转弯、用途、设备、方向 |
| TypeScript `vue-tsc --noEmit` | 通过 | 当前工作区 |
| 真实 Edge + Three.js 场景 | 通过 | 从 SQL r10 **回读**，零结构错误 |
| 机器人从载丝托盘抓取丝锭 | 通过（隔离仿真） | 托盘状态由 loaded 转 empty；库存挂杆占位 |
| 空托 A 右行 → 180° U → B 左行 | 通过（隔离仿真） | 同一预览托盘 ID，30Hz 固定逻辑步加速，经过 U 型弧线 |
| B 出口等待空托回流接收 | 通过（隔离仿真） | 不会自动消失，重复进入及错误确认被拒绝 |
| 100 挂杆 | 通过（本轮入库） | 入库后 99 空位，1 占用 |
| 108 小托盘主闭环 | 仅身份回归通过 | 没有修改 42 点/46 边主路线；不代表多圈通过 |
| 工程警告 | **未验收** | 当前 74 条；其中包含新辊道周边的几何警告 |
| 桁架尾批实际物料及托盘进入缓存支路 | **未实现完整自动联动** | 当前仍需显式注入仿真事件；不能把预览载体当作真实 108 托盘实体 |
| B 排出口自动回归下游空托主循环 | **未实现** | 需接入实际空托线物理入口、容量与接收互锁 |
| 同批号余丝复用到有承载托盘的新任务 | **未验证** | B 排已明确只运空托，不再作为余丝复用通路；需单独设计接料确认 |
| PLC、MES、机械设备 | **未执行** | 全部测试限制为 Simulation，不向设备发送命令 |

## 4. 证据、复现

源码：`ClientApp/src/digital-twin/runtime/SurplusSilkCacheRuntime.ts`、
`ClientApp/src/digital-twin/runtime/StudioV2PhysicalRouteGuard.ts`、
`ClientApp/src/digital-twin/runtime/TwinRuntime.ts`。

候选及测试：`ClientApp/scripts/build-studio-v2-cache-pallet-u-turn-r10.cjs`、
`ClientApp/scripts/verify-studio-v2-cache-pallet-u-turn-r10.mjs`、
`ClientApp/scripts/verify-studio-v2-cache-pallet-u-turn-browser.cjs`。

SQL 防覆盖迁移脚本：`scripts/digital-twin/apply-studio-v2-cache-pallet-u-turn-r10.ps1`，**已经执行一次，不能重复执行**。

浏览器验收截图及报告：`ClientApp/.tmp-studio-v2-cache-u-turn-r10-sql-edge/`，包含载丝托盘进料、机器人抓丝后变空、实体 U 转弯及空托出口等待确认四个阶段。

测试脚本中的手动确认属于隔离仿真，不是从真实 PLC 或生产空托线获得的确认。未经实际桁架接驳、空托回流联锁和机械净空签核，不得发布上线。
