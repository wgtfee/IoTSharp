# Studio V2 r12：删除一体双辊道，以原下排为蓝线、其更下方新增红线

2026-11-16。以用户本轮明确确认的最终修订为准：**删除 r11 在缓存机器人下方创建的一体式双排辊道；原双排“下面一条”改为蓝色载丝单排线；更下面新建独立红色空托单排线，右往左回流后接左侧向下的主空托道。**

## 本轮实际修改

| 部位 | r11 错误做法 | r12 调整结果 |
| --- | --- | --- |
| 蓝色载丝线 | double-small-roller-conveyor 一体两排中 A 排 z=-8.15 | **独立** roller-conveyor-v1；沿原双排下排 z=-6.25，西向东 |
| 红色空托线 | 同一实体内的 B 排 z=-6.25 | **新建独立** roller-conveyor-v1；z=-4.35，东向西，位于蓝线更下方 1.9m |
| 右端折返 | 以旧双排中心 z=-7.2 折返 | 实体 180° U 型辊道中心改为 z=-5.3；蓝线东端出口接 U 输入，U 输出接红线东端 |
| 左侧下行 | 旧 B 排接内竖道局部 tap x=-2.5 | 新红线西端接已有左侧竖向回流道 tap x=-0.6；沿竖道下行的路线点保持 |
| 托盘材质 | r10 曾误用棕色方板 | 沿用既有 `builtin-small-pallet` **绿色圆形小托盘**，无木方板 |
| 机器人位置 | 误把双辊道组合当作两个业务角色 | 蓝线单独运载丝托盘；抓走余丝后原小托盘成为空托，右端折返后进入**独立红线** |

坐标说明：图纸向下 = 世界 Z 增大；蓝线 z=-6.25 是**原双排下面的那条**；红线 z=-4.35 才是这次**在其更下面新增加的那条**。二者不是一个双辊道模板的两个车道。两个单排实体均长 11.4m、宽 1.55m，中心 X=-7；蓝线 Y 旋转 0，红线 Y 旋转 π。机器人的抓取点仍为世界 X=-4。两排之间右端连接 180° 实体 U 形转弯。

## 安全和场景数据

- SQL Server `DESKTOP-2ALRK02\MSSQ`，数据库 `IOTSharp`。
- V2 场景 ID `d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94`：开发副本 **Draft r11 → Draft r12**。SQL DraftPayload SHA256（NVARCHAR UTF-16）`B058A208D296082A6AEE6E6595DBBA01C2001C7D6209CA707A892B44C044D990`。
- V19 原始场景 `69a6b03a-0a0c-45e9-b3c1-f29bcaeb142e`：**Published r11 严格只读**，SHA256 `470C08343F35E5671B38455D3018CA15C1A726FD8AB7E2AD4D93A1DD24393B66`，前后相同。
- r12 场景 58 个实体、53 个实体连接、5 条路线；余丝支路 7 点/6 边；主小托盘闭环仍为 42 点/46 边，108 个默认循环小托盘 ID 未增减。
- 一体双排组件已从缓存机器人下的对应对象中移除，但产线其他本来正确的双排输送道**没有被删除**。
- 加载时 `StudioV2PhysicalRouteGuard.ts` 检查两条独立滚道的实体、端口、上下位置、方向、U 转弯与左侧下行连接。错误版本不能启动 Simulation；不涉及 PLC/MES/现场设备指令。

## 验证结果

| 验证 | 结果 |
| --- | --- |
| 全量 `vue-tsc --noEmit --pretty false` | **通过** |
| r11 错误一体双辊道阻止启动 | **通过** |
| r12 物理路线守卫 | **0 项错误** |
| 11 种负向验证（重建双排、删红线、蓝线位置错误、红线位置/方向、U 转弯及左端断路等） | **全部通过** |
| Edge + Three.js 候选场景 | **通过** |
| SQL r12 事务保存、源场景哈希保护和 SQL 精确回读 | **通过** |
| **重新从 SQL r12 回读后**的 Edge + Three.js | **通过**：0 场景结构错误、0 页面异常 |
| 蓝、红两条模型均为独立 `roller-conveyor-v1` | **通过**：没有 `DoubleSmall-Lane-A/B` 生成于缓存机器人下 |
| 绿色小托盘载丝进入、机器人抓丝、同托空载 U 折返、红线西行至左下接驳位置 | **通过局部隔离仿真** |
| 错误下游确认/上游重复进托阻止 | **通过局部隔离仿真** |
| 108 原主回路托盘 ID 不改变 | **通过短时身份检查**，未做多圈验收 |
| 工程空间警告 | **未验收：80 条** |
| 桁架将真正的 108 主循环托盘转交给缓存支路 | **未验收**，当前支路的绿色小托盘是隔离预览实体 |
| 红线左端接入主回流时的真实占位、接收和放行互锁 | **未验收**，目前只能人工触发隔离仿真确认 |
| PLC/MES/真实机器人设备 | **未发送命令** |

## 可复现测试

工作区：`H:\code\Industrial.Platform\IoTSharp-master`

```powershell
cd ClientApp
node --experimental-strip-types scripts/verify-studio-v2-independent-blue-red-r12.mjs
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit --pretty false
$env:STUDIO_V2_R12_MANIFEST='.tmp-studio-v2-r12-db-readback.json'
$env:STUDIO_V2_R12_OUTPUT='.tmp-studio-v2-r12-recheck-edge'
node scripts/verify-studio-v2-independent-blue-red-r12-browser.cjs
```

- r12 场景构建：`ClientApp/scripts/build-studio-v2-cache-independent-blue-red-r12.cjs`
- r12 SQL 一次性保护迁移：`scripts/digital-twin/apply-studio-v2-independent-blue-red-r12.ps1`；**已执行，不能重复运行**。
- SQL 回读：`ClientApp/.tmp-studio-v2-r12-db-readback.json`。
- SQL 回读后的真实 Edge 截图和测试报告：`ClientApp/.tmp-studio-v2-cache-independent-r12-sql-edge/`。
- 所有既存未提交文件保留；源码与截图仅提交到各自独立 Git 分支，不强推覆盖远程 `Develop`。
