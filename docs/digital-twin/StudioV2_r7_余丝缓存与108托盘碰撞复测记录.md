# IoTSharp Studio V2 r7：余丝缓存运行时与 108 托盘防碰撞复测

> 日期：2026-11-16。状态：**专项通过，整线及多圈长稳未通过验收**。所有测试均为开发机隔离 Simulation，不向 PLC/MES/机器人发送指令。

## 1. 真实环境、保护基线

- 代码：`H:\code\Industrial.Platform\IoTSharp-master`，`Develop`，检查起点 `dc20b1de9a56cd6327cd1b4e403b0d2b81ec80db`，开始时有 **92 个既存未提交路径**，全部保留。
- SQL：`DESKTOP-2ALRK02\MSSQ` / `IOTSharp`。本轮仅执行 SELECT；没有更新任何场景数据库记录。
- **只读 V19**：`69a6b03a-0a0c-45e9-b3c1-f29bcaeb142e`，Published r11，`DraftPayload` SHA256（SQL nvarchar 二进制）`470C08343F35E5671B38455D3018CA15C1A726FD8AB7E2AD4D93A1DD24393B66`。
- **新 V2**：`d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94`，Draft r6，`DraftPayload` SHA256 `4CA47C668608942DABE8356CB1FA20B2FC8DBD40D3D48409783B58127CABEA85`。
- 两个 SQL 哈希在测试前后复读一致；**本轮只修改源代码和测试，未把新业务状态持久化到数据库，也未将 V2 r6 更新为 r7**。
- 场景：52 个对象、47 个连接、5 条路线；主闭环 38 点、42 边；可寻址缓存 5×20=100 根；初始 108 个小托盘。
- 提交边界：`Develop` 存在大量他人未提交修改，且检查时 `.git/index.lock` 被占用；**禁止强行删除锁或把整个脏文件暂存**。本轮已通过的新增独立模块可单独归档，`TwinRuntime.ts`、`RouteSlotArrayRuntime.ts`、`studio-v2/index.vue` 与 `studio.scss` 的集成修改仍留在当前工作区，待逐个隔离既存修改后再形成完整可合并提交。任何仅包含新增模块的分支均**不是独立可部署的完整 r7**。

## 2. 本轮实际实现

1. `SurplusSilkCacheStore.ts`：100 个独立挂杆 ID；丝锭 ID、批号、原任务号；`empty/storing/occupied/retrieving` 状态；重复入库/取料禁止；批号完全匹配；预约撤销与槽位回收。
2. `SurplusSilkCacheRuntime.ts`：三维丝锭模型从交接辊道进入、抓取、抬升、移动、落杆；反向取回并返回交接辊道；库存只在物理动作完成时提交。使用固定逻辑步，不以渲染帧号推进库存。
3. `TwinRuntime.ts`：在 V2 Simulation 且缓存架、机器人和交接辊道均存在时接入缓存运行时；新增只接收显式业务输入的 `queueSurplusBobbin` / `queueSurplusReuse` API；Live 不允许调用。
4. Studio V2 页面新增“余丝缓存”分页，展示全部 100 槽与预约进度；可手动注入开发仿真结批事件与新任务取料请求。**还未自动接入真实桁架结批检测或产线物料接收。**
5. `RouteSlotArrayRuntime.ts`：修复 108 托盘分批时使用终身初始序号进行物理离站、重置错误槽位导致重叠的问题，改为当前 A/B 批次排内序号，容量越界时阻止错误定位。

## 3. 真实执行与专项测试

| 测试 | 结果 | 证据及限制 |
| --- | --- | --- |
| SQL SELECT / 基线校验 | 通过 | V19、V2 状态、修订与 SHA256 前后一致 |
| 余丝缓存状态机专项 | 通过 | 100 槽、满架、重复入库、重复取料、错批、取消和回收，Node22 实测 |
| TypeScript 全量类型检查 | 通过 | `node node_modules/vue-tsc/bin/vue-tsc.js --noEmit --pretty false` |
| 路线结构核对 | 通过 | 38 点/42 边、抽查 10 处箭头、108 初始化、100 杆、双向交接 2 边；不代表物理净空 |
| 浏览器真实 3D 入缓存 | 通过 | SQL Server 只读导出 r6 → Vite 5173 → Edge + Three.js；预约 1，抓放结束实占 1 |
| 浏览器同批号取回 | 通过 | 错误批号无库存；正确批号入取料队列，重复预约禁止；完成后 100 空杆，0 占用 |
| 同一丝锭连续运动 | 短时通过 | 共 69 次运动采样，行程约 23.9m；头戴抓手为视觉运动学，不是设备真机 IK 签核 |
| 108 托盘防碰撞 | **先失败，定点修复后短时通过** | 首测 SIM-4 和 SIM-10 重叠（0m）；修复后 18 次身份/空间采样均为原 108 ID，采样最小中心距约 1.50119m，0 对低于 1.5m |
| 108 托盘完整多圈、吞吐、无死锁 | **未验证** | 本轮累计完整过圈 0；不能据短时样本推定长稳 |
| 与外检、套袋、桁架、贴标、缠膜、出库统一联动 | **未通过完整验收** | 缺少自动结批余丝事件及返回生产工艺的实际接收确认 |
| 机械包络/实际 CAD 运动净空 | **未签核** | 71 条工程警告仍存在，详见下节 |
| 真实设备联调 | **禁止执行/未验证** | 不向 PLC、MES、机器人、打印或标签设备发送任何动作指令 |
| 登录态 Studio V2 业务页面 HTTP | **未验证** | 开发后端未认证 GET 返回 401；本次浏览器专项是实际三维运行时与只读 SQL 数据，不等于登录后的全部业务页面验收 |

## 4. 71 条风险原样保留

当前结构错误 0，仍有 71 条未签核的空间/路线警告：

- `twin.layout.body-overlap`：**63**，设备主体包络重叠，主要在双排回流、分流/合流、外检、桁架及后包装附近；必须区分预期工位拼接与不可接受的真实机械干涉。
- `twin.layout.route-clearance`：**6**，木托盘后包装路线穿过桁架、天盖桁架、缠膜机等实体包络，需要实际设备模型的通行净空检验。
- `twin.transport-route.unattached`：**1**，木托盘/纸箱未吸附到大辊道路线。
- `route.authoring.direction.reverse`：**1**，底部双排回机器人分流位检测到 180° 折返，需和原始红色箭头、机械可行性核实。

**未通过几何净空验收，不允许发布或宣称完整上线。** 禁止简单隐藏诊断来降低警告数字。

## 5. 复现指令与截图

在 `ClientApp` 下：

```powershell
node --experimental-strip-types scripts/verify-studio-v2-surplus-cache-state.mjs
node scripts/verify-studio-v2-surplus-cache-layout.cjs
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit --pretty false
node scripts/verify-studio-v2-surplus-cache-browser.cjs
```

浏览器脚本从本地 SQL Server **只读导出 Draft r6**，在既有 Vite 5173 上使用隔离测试入口；不 mock 后端 API、不提交生产指令，结束时自动删除临时 HTML/HTTP JSON 文件。截图及浏览器 `report.json` 在 `ClientApp/.tmp-studio-v2-surplus-r7-e2e/`。

已单独推送截图分支（**没有推送 Develop**）：`studio-v2-screenshots-20261116`，提交 `c7c6ee1730f1ead242c5cc92652a2e1d132d9e53`，包括：

- `docs/digital-twin/screenshots/studio-v2-r7-robot-store-in-motion.png`
- `docs/digital-twin/screenshots/studio-v2-r7-stored-on-real-rack.png`
- `docs/digital-twin/screenshots/studio-v2-r7-robot-retrieve-in-motion.png`
- `docs/digital-twin/screenshots/studio-v2-r7-reuse-return-to-handoff.png`
- `docs/digital-twin/screenshots/studio-v2-r7-real-sql-browser-report.json`

## 6. 下一验收门槛（不得冒充本轮完成）

1. 桁架结批末次抓取的业务事件需提供可追溯的丝锭 ID、批号和原任务号；不能用随机丝锭代替真实事件。
2. 同批号缓存物料必须被实际生产工艺运行时确认接收（含联锁、下游容量和拒收/回退），不是只到交接辊道出口就认为完成复用。
3. 108 个托盘须覆盖多次完整回流圈，证明同 ID 不增不丢、无碰撞、无死锁，提供吞吐/等待/异常统计。
4. 71 条警告逐项按设备 CAD、辊道运动包络、路线箭头与机电联锁签核，并运行完整工艺回归。
5. 完成隔离鉴权下 Studio V2 登录态页面及业务 API、数据库持久化与重启恢复验证；现场真机操作仍应由用户另行授权。
