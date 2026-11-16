# Studio V2 r14：下方红色小辊道只有上方一半长，左端直角向上接回蓝线

日期：2026-11-16。针对用户纠正：“下面的辊道应该只有上面的一半。然后直角接续到上面”。本轮基于开发 SQL Server **Draft r13 的实际回读**创建 r14，严格只修改 Studio V2 副本场景及其专项运行时，不改 Published V19、108 托盘原始主路线和其他项目工作区修改。

## 一、实际纠正的场景布置

| 部件 | 位置与实际功能 |
| --- | --- |
| 原始上方蓝线 `reference-conveyor-ref-edge-loaded-upper-right-in` | **不重建、不删、不移动**。x=-2.95、z=-5.3、总长 15.7m，运载绿色小托盘向右，属于原 108 托盘主闭环 |
| 下方唯一独立红线 `studio-v2-surplus-silk-empty-return-roller` | 总长 **7.85m，恰好是 15.7m 的一半**；x=0.975、z=-3.4、右端 x=4.9 与蓝线对齐，向左到 x=-2.95；运输机器人抓丝后的**空绿色小托盘** |
| 右端原有直角折返 `studio-v2-cache-pallet-empty-u-turn` | 保留实际**直辊道**（不是圆弧），x=4.9、z=-4.35、长 1.9m，两端各为 90°移载转角，将蓝线向右的空小托盘引至红线向左 |
| **本轮新增**左端上行直角 `studio-v2-cache-empty-left-square-up` | x=-2.95、z=-4.35、长 1.9m、yaw=π/2；红线左端 x=-2.95 以 90°向上，经过直辊道，再以 90°接回蓝线原中段（x=-2.95，z=-5.3） |
| 蓝线中段待接收口 `cache-return-entry` | 新增**独立**端口，仅用于需要主回路占用授权的空托回流。保持原 `input`、`output` 和原 108 托盘路线完全不变 |
| 原来错误的长回流出口 | 删除上轮新增的 `studio-v2-cache-red-lower-empty-return-to-left-downward-lane` 实体连接和左侧竖道临时 tap，改为红线左端向上接蓝线 |

**画面应为上面长、下面短；两条水平辊道，左右各有实体直角短辊道，其中下方红线的左端在上方蓝线中段正下方。** 原产线其他不相关的双排辊道保留，机器人下方不生成第三条。

## 二、实际验证

| 项目 | 结论 |
| --- | --- |
| TS 全量 `vue-tsc --noEmit --pretty false` | **通过** |
| r14 物理路径校验 | **0 错误**；r13 错误长红线被新闸口拒绝 |
| 12 个逆向退化测试 | **通过**：红线不等于蓝线一半、端点错位、方向反转、恢复圆弧、删左端上行道、接错蓝线等全部被阻止 |
| 真实 Edge + Three.js 候选场景 | **通过** |
| SQL Server 开发库 r14 写入/精确回读 | **通过**：与通过浏览器测试的候选 JSON 全文一致 |
| 从 SQL r14 **重新回读**后的真实 Edge + Three.js 测试 | **通过**，零场景结构错误、零浏览器运行错误，保存四张实际截图 |
| 下方红线半长与端点 | **通过**：15.7m/7.85m，比值精确 0.5，右端 x=4.9 对齐 |
| 空小托盘运动 | **局部隔离仿真通过**：蓝线右行 → 右端直角向下 → 红线左行 → 左端直角向上到达蓝线中段，且红线不超长、不瞬移 |
| 108 原始主闭环托盘 ID | **短时不变**，未验收真实跨线身份交接或多圈耐久 |
| 100 个缓存挂杆/机器人抓丝 | **局部仿真保留**，一锭入缓存后 99 个空位 |
| 机械空间工程警告 | **未完成：77 条**，仍需对线体清理 |
| 真实 108 托盘主线占位锁、入支路与复归同 ID 接收 | **未完成**；现有演示载体一直是 `previewOnly=true`，手动确认不等于主线真实移交 |
| PLC/MES/真实机器人 | **未发送指令**，仅隔离 Simulation |

## 三、受保护数据库及 Git

- 开发 SQL Server：`DESKTOP-2ALRK02\MSSQ`，数据库 `IOTSharp`。
- V2 可修改场景 `d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94`：**Draft r14**，SHA256（NVARCHAR UTF-16）`38334FB421D0BF55BC6590988D298EDC9E5BBA34106ADBAE99877680F8B47B74`；58 个场景对象，54 条实体连接，5 条路线，余丝支路 7 点6 边。
- V19 原始只读场景 `69a6b03a-0a0c-45e9-b3c1-f29bcaeb142e`：**Published r11**，SHA256 `470C08343F35E5671B38455D3018CA15C1A726FD8AB7E2AD4D93A1DD24393B66`，未更改。
- SQL 一次性事务脚本 `scripts/digital-twin/apply-studio-v2-half-lower-square-up-r14.ps1` **已运行，不应在 r14 上重复执行**。
- 场景构建器：`ClientApp/scripts/build-studio-v2-half-lower-square-up-r14.cjs`。
- 退化测试：`ClientApp/scripts/verify-studio-v2-half-lower-square-up-r14.mjs`。
- 实际浏览器 E2E：`ClientApp/scripts/verify-studio-v2-half-lower-square-up-r14-browser.cjs`。
- 数据库实际回读：`ClientApp/.tmp-studio-v2-r14-db-readback.json`。
- 真实浏览器截图/JSON 测试报告：`ClientApp/.tmp-studio-v2-half-lower-square-up-r14-sql-edge/`。

每项已完成且通过的源码只进入 r14 独立代码分支，截图进入独立 screenshots 分支。保留本地 Develop、其他未提交修改、原始 V19 以及远程 Develop。
