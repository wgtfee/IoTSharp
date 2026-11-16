# Studio V2 r9：缓存机器人下方双排独立输送道验收

日期：2026-11-16。状态：**双排模型、方向、缓存抓放专项通过；整线、机械净空和长稳未验收**。

## 1. 用户原图的真实方向

平面图弧形缓存架和机器人下方有 **两条平行小辊道，不是单条可逆辊道**：

- 靠机器人/缓存架内排 **A**：蓝箭头，由左向右，供桁架结批余丝进入缓存交接。
- 外侧回流排 **B**：红箭头，由右向左，供同批号取回丝锭返回交接方向。
- 两排各有独立辊筒、边梁、支腿、电机、物理端口与路线。原 r8 以 `roller-conveyor` 单条实体模拟两个方向是错误的。
- 当前端点仅是缓存工位的局部交接端，**不是已证明与桁架、包装和小托盘主闭环实现真实互锁的连接**。不能把两段局部输送证明当作整线工程验收。

## 2. 本轮源代码与 SQL 修正

- 对象 `studio-v2-surplus-silk-handoff-roller` 由普通辊道调整为真正的 `double-small-roller-conveyor-v1` 组件，仍保持原对象 ID，避免丢失工位引用。
- 两排：长 **5.4 m**；排宽 **1.55 m**；中心距 **1.9 m**；每排容量 3；速度设置 0.7；`laneAReverse=false`、`laneBReverse=true`。
- 机器人交接中心：A 排 `(-4,1.12,-8.15)`，B 排 `(-4,1.12,-6.25)`。入缓存时，丝锭从 A 西端 `(-6.7,1.12,-8.15)` 向右移动到抓取位；复用时，机器人在 B 排放料后向左移动到 `(-6.7,1.12,-6.25)`。
- 原缓存支路 **3 点/2 条共享双向边** 调整为 **6 点/4 条独立单向边**。两个排道不能共享同一物流占位或物理中心线。
- `SurplusSilkCacheRuntime` 的机器人动作从单个 `pickup` 变为分别跟随 A、B 排坐标的 `storePickup`、`reuseDrop`，丝锭沿相应实际辊道运动，不再在同一位置完成两种方向的交接。
- `StudioV2PhysicalRouteGuard` 启动前校验两条实体道、各自箭头、分排中心线、路由四边、独立实体和间距；旧 r8 单道被阻止启动。
- 原始 V19 场景 `69a6b03a-0a0c-45e9-b3c1-f29bcaeb142e`：**Published r11**，严格只读，哈希始终是 `470C08343F35E5671B38455D3018CA15C1A726FD8AB7E2AD4D93A1DD24393B66`。
- Studio V2 `d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94`：**Draft r8 → Draft r9**，写入后读取内容与经过浏览器测试的 r9 候选全文完全一致。SQL NVARCHAR `DraftPayload` SHA256：`0453C8C7FC27C9BE4194DD03C56A8DD007B466D57228494767565F6E29CC3A8B`。
- V2 r9 仍有 **56 个场景对象、50 条物理连接、5 条路线**，小托盘主闭环保持 **42 点/46 边**，默认 **108 个循环小托盘**，100 个缓存挂杆不变。

## 3. 已完成的真实验收证据

| 验证项 | 状态 | 实际证据 |
| --- | --- | --- |
| TypeScript 全量检查 | 通过 | `vue-tsc --noEmit --pretty false` exit 0 |
| 物理双排守卫专项 | 通过 | 9 种缺排、反转、间距异常、共享双向边、缺边、错中心线均被阻断 |
| 数据库事务写入、回读 | 通过 | V2 Draft r9 哈希一致，V19 Published r11 哈希不变 |
| 真实 Edge + Three.js | 通过 | SQL r9 **重新回读**后运行，无浏览器错误/结构错误；两组 `DoubleSmall-Lane-A/B` 实体生成 |
| A 入库抓取 | 通过 | 6 次 A 排 `conveyor-in` 位移采样；`z=-8.15`，丝锭从左向右，机器人完成入库 |
| B 复用放回 | 通过 | 7 次 B 排 `conveyor-out` 位移采样；`z=-6.25`，丝锭从右向左，完成复用 |
| 100 个缓存位 | 通过 | 入库 1、取回 1 后恢复 100 个空位；禁止错批及重复取料 |
| 108 小托盘短时抽查 | 通过 | 17 次采样，托盘 ID 不增不减；0 对低于 1.5m（容差 0.0001m） |
| 原 r8 单排仍可启动？ | **否：被拒绝** | 守卫报告双排实体和独立通路缺失，旧场景无法带错运行 |
| 工程空间警告 | **未验收** | 当前仍有 73 条布局/路线警告；不可隐去 |
| 缓存支路与主闭环真实进出站互锁 | **未验收** | A 西端、B 西端等外部接驳均需继续对照红色箭头和设备位置 |
| 108 托盘多圈/工艺全联动 | **未验收** | 短时采样不能代替多圈、故障恢复和无死锁长稳 |
| PLC/MES/机器人真机 | **未执行** | 仅隔离 Simulation，不向生产设备下发指令 |

## 4. 复现实测和文件

在 `ClientApp` 目录运行：

```powershell
node scripts/build-studio-v2-cache-dual-handoff-r9.cjs .tmp-studio-v2-r8-db-readback.json .tmp-studio-v2-cache-double-r9-candidate-recheck.json
node --experimental-strip-types scripts/verify-studio-v2-cache-dual-handoff-r9.mjs
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit --pretty false
$env:STUDIO_V2_R9_MANIFEST='.tmp-studio-v2-r9-db-readback.json'
$env:STUDIO_V2_R9_OUTPUT='.tmp-studio-v2-r9-recheck-edge'
node scripts/verify-studio-v2-cache-dual-browser.cjs
```

数据库变更脚本为 `scripts/digital-twin/apply-studio-v2-cache-double-r9.ps1`，**已执行一次，严禁对 r9 再次执行**。它使用 V2 唯一 ID、r8 来源哈希、Draft 修订、SceneKey、原 V19 哈希和事务回读强制保护。

本机 SQL 回读后的 Edge 实测证据在 `ClientApp/.tmp-studio-v2-r9-sql-edge/`：四张真实 Three.js 截图及 `report.json`。

Git `Develop` 原有未提交改动全部保留，本轮不强推覆盖远程分支。
