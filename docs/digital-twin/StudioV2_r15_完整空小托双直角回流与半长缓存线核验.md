# Studio V2 r15：最右侧到最左侧的空小托盘回流，恢复两处 90°直角弯

日期：2026-11-16。本轮根据用户纠正“**从最右侧到最左侧有一个两个直角弯的空小托盘回流。你现在变成了直线**”实施。

**核心区分：不能把“缓存机器人下方只有蓝线一半长的短红线”和“从最右端到最左端跨越整线的主空小托回流”当成同一根辊道。** r14 缩短了局部红线，但原有横跨整线的 25.4m 空托回流仅显示为孤立长直线，端点缺失明确的实物直角接驳。r15 在保持 r14 正确局部布置的前提下补齐主回路双直角。

## 一、正确物理路线

### A. 整线空小托回流（本轮修正，属于 108 托盘主闭环）

1. **最右端向下**：`ref-empty-return-diverter` (x=10.8, z=6.8) → `ref-empty-return-turn-b` (x=10.8, z=9.0)，由原 `reference-conveyor-ref-empty-return-down` 运送。
2. **第一个 90°转弯，随后向左**：右端 (10.8,9.0) 处的实物直角导轨 `EmptyReturnSquareElbow-Right` 和新增侧向 `square-right-input`，进入原水平长辊道 `reference-conveyor-ref-empty-return-merge`。从 x=10.8 向左穿过整线到 x=-14.6，总长 **25.4m**。**不使用圆弧，不额外复制第三根长辊道**。
3. **第二个 90°转弯，随后向下**：长水平辊道左端 (x=-14.6,z=9.0) 的实体直角导轨 `EmptyReturnSquareElbow-Left`，通过 `output` → 既有 `reference-gantry-merger` 新增第 3 个实体汇入口 `empty-return-square-input`，再沿原 `reference-conveyor-ref-return-edge-outer-down` 向下到 (-14.6,15.2)。
4. 原主闭环 **42 点 / 46 边**、既有 RouteSlot 108 托盘配置完全保留，三段路线点/箭头**未修改**。补的是原来缺少的物理直角导轨、端口方向与连接，避免图上长直线两头不接。

### B. 缓存机器人局部回流（保持 r14）

上方原蓝色载丝小托盘主辊道长 **15.7m**，方向向右；下方唯一独立红色空托辊道长 **7.85m**（蓝线的 1/2），右端对齐，方向向左，左端经 90°上行短辊道接回蓝线中段。机器人从绿色圆形小托盘抓走丝锭后，隔离预览空托沿相同 ID 经右端直角下行、红线左行、左端直角上行，等待蓝线接收确认。此处没有第三条平行辊道，也没有圆弧转弯。

两条回流属于不同工艺段；不能再次把 B 的 7.85m 红线替代 A 的 25.4m 整线空托回流。

## 二、实际保护和验收

| 项目 | 验收 |
| --- | --- |
| 开发 SQL Server `DESKTOP-2ALRK02\MSSQ` / `IOTSharp`，V2 Scene ID `d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94` | 已从 Draft r14 更新为 **Draft r15** |
| V2 DraftPayload SHA256（SQL NVARCHAR UTF-16） | `32F4F326C7668E7232BB3B6FF7F5A09D6162945A17351EFA621428022B3C2E7B` |
| 原始 V19 `69a6b03a-0a0c-45e9-b3c1-f29bcaeb142e` | **Published r11**，严格只读，SHA256 `470C08343F35E5671B38455D3018CA15C1A726FD8AB7E2AD4D93A1DD24393B66`，前后相同 |
| TypeScript 全量 `vue-tsc --noEmit --pretty false` | **通过** |
| 主线右端下转 → 横向左行 → 左端下转完整路径与方角实体 | **通过结构与物理端口专项检查** |
| r14 只有长直辊道但两个直角没有物理接驳 | 被新的启动守卫阻止 |
| r15 新增可视实体 `EmptyReturnSquareElbow-Right/Left` | **实际 Edge Three.js 创建，两端各一组，非圆弧** |
| 14 项反向退化检查（错方向、断开任一角、回流改成孤立长直线、位置错误等） | **全部通过** |
| SQL r15 写入、精确回读、V19 哈希保护 | **通过** |
| **从 SQL r15 实际回读后**再用真实 Edge + Three.js | **通过**，0 场景结构错误、0 浏览器运行错误；5 张截图，包括整线双直角鸟瞰 |
| 机器人局部 7.85m / 15.7m 红蓝线比例、绿色小托盘隔离动画 | **通过**，维持 r14 正确布置 |
| 108 托盘主路线数据及身份 | **短时保持不变**，没有验证多圈全线实际吞吐 |
| 工程布局警告 | **未通过清零：77 条** |
| 真实主回路向缓存分流、复归同托盘 ID、共享占位与机械净空 | **未验收**；场景中仍属 Simulation 预览，不等于 108 个托盘的真实实体交接 |
| 现场 PLC/MES/机械设备 | 没有发送任何命令 |

## 三、重现与源码

- 构建：`ClientApp/scripts/build-studio-v2-full-span-two-square-elbows-r15.cjs`；
- 静态及 14 项反向校验：`ClientApp/scripts/verify-studio-v2-full-span-two-square-elbows-r15.mjs`；
- Edge + Three.js 实际浏览器：`ClientApp/scripts/verify-studio-v2-full-span-two-square-elbows-r15-browser.cjs`；
- 一次性 SQL 保护更新：`scripts/digital-twin/apply-studio-v2-full-span-two-square-elbows-r15.ps1`，**已执行，不得在 r15 重复运行**；
- SQL 实际回读：`ClientApp/.tmp-studio-v2-r15-db-readback.json`；
- 真浏览器 SQL 回读验收截图与 JSON 报告：`ClientApp/.tmp-studio-v2-full-span-two-square-elbows-r15-sql-edge/`。其中 `00-far-right-down-cross-left-left-down-two-square-corners.png` 专门展示横贯整线的双直角空小托盘回流。

所有改动仅针对 V2 副本、相关可选组件属性与验证脚本。其他工作区未提交改动以及远程 `Develop` 严格保留。r14 和 r15 已验证代码应一起进入独立新分支，不能只提交 r15 脚本而遗漏 r14 局部半长修正。
