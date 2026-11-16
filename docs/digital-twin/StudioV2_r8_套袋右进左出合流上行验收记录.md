# Studio V2 r8：套袋机右进左出、合流上行与两处蓝色流向

日期：2026-11-16。依据用户最新上传产线平面图中红箭头及亲自修订的两处蓝色箭头。**局部工程路线/短时仿真通过，不代表机械净空、全工艺或108托盘多圈验收通过。**

## 1. 本次确定的工艺

1. 套袋机 A（平面图上方）和 B（下方）都严格**右侧进料、左侧出料**。
2. B 线从左侧出料后，沿右侧双排辊道 B 排**向上**，到 A 左侧同一汇流点。
3. A/B 汇流后，继续沿该排**向上**到顶部，再通过实体转接辊道**向左**进入桁架前输送线。
4. 用户画蓝色的中央横线由西往东；蓝色竖线由下往上。这两段与上述套袋后上行是不同的物理辊道分支，不能互相反转。
5. 仿真不得只沿抽象 RouteEdge 穿越没有实体辊道的空间。

对照 V2 坐标（平面图向上等于世界 Z 递减）：

| 物料路径 | 世界坐标（X,Z） |
| --- | --- |
| A 左出口 → 上方汇流点 | (11.8,-12.9) → (6.8,-12.9) |
| B 左出口 → 下方上行入口 | (11.3,-5.5) → (6.8,-5.5) |
| B 上行接入 A | (6.8,-5.5) → (6.8,-12.9) |
| A/B 合流继续上行 | (6.8,-12.9) → (6.8,-17.7) |
| 顶部转弯向左 | (6.8,-17.7) → (4.9,-17.7) → 桁架前 |
| 蓝色横向箭头 | (-10.8,-5.3) → (4.9,-5.3)，向右 |
| 蓝色纵向箭头 | (4.9,-5.3) → (4.9,-17.7)，向上 |

## 2. 已完成的代码与数据

- 实体：套袋 A/B 前后共有 4 条补齐辊道；顶部新增 1.9m 转接辊道，共 5 条补齐组件可在 Three.js 中实例化。
- 设备：套袋 A/B 绕 Y 旋转 180°，与真实右进左出的端口一致。
- 上行：`reference-double-small-upper-right` 的 A/B 两排均配置为向上；纠正 r7 中 B 排错误向下。
- 汇流：把 r7 位于下方的合流点移至上方 A 左出口，B 上来后统一向上；删除旧的向下绕行路段与过时辊道。
- 顶端：西向辊道的普通入口接套袋上行顶端，新增一个只在显式配置下生成的 `side-input` 侧向汇流口给蓝色上行内排；避免两个连接占用同一普通 Input。
- `StudioV2PhysicalRouteGuard.ts` 在启动 Simulation 前检查设备端口、五条实体辊道、两处蓝色方向、A/B 合流位置及上行方向。错误则阻止运行，而不是仅发警告。
- 开发 SQL Server 仅更新 V2 副本 `d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94`：Draft **r7 → r8**。V19 严格只读。
- r8 SQL `DraftPayload` SHA256（SQL NVARCHAR 二进制）：
  `40E6031C6B3D7F89ADE91510C5BA755384B0988251EDE7F4F453118B71C77339`。
- 原 V19 `69a6b03a-0a0c-45e9-b3c1-f29bcaeb142e` Published r11，回读哈希仍为：
  `470C08343F35E5671B38455D3018CA15C1A726FD8AB7E2AD4D93A1DD24393B66`。

## 3. 测试证据

| 验证 | 结果 | 范围 |
| --- | --- | --- |
| 全量 `vue-tsc --noEmit` | 通过 | 当前工作区 TS 检查 |
| r7 旧错误方向禁止启动 | 通过 | 旧场景 10 个物理路线违规；启动被拒绝 |
| r8 实体路线规则 | 通过 | 0 个物理路线违规 |
| 负向测试：删辊道、缩短辊道、反转蓝箭头、反转 B 排或汇流方向 | 通过 | 全部可被守卫识别 |
| 真实 Edge + Three.js 运行 | 通过 | Vite 5173，真实运行时，不使用模拟 HTTP API |
| SQL r8 写入/精确回读 | 通过 | 数据库回读文本与验证候选 **逐字节相同** |
| 数据库回读后再次运行 Edge | 通过 | 5 个补齐辊道全部实例化，JS 页面错误 0 |
| r8 结构诊断 | 通过 | 0 个结构错误 |
| 108 托盘短时身份及中心距 | 通过 | 23 次采样 ID 不增不减，无小于 1.5m - 容差的重叠 |
| 72 条机械工程警告 | **未验收** | 不能忽略或者用新结果掩盖 |
| 108 托盘完整多圈/无死锁、进出库工位完整物流交接 | **未验收** | 当前局部短时测试不代表通过 |
| 真实 PLC/MES/设备动作 | **未执行** | 禁止向现场发送命令 |

## 4. 可复现操作（开发环境）

在 `ClientApp` 中：

```powershell
node scripts/build-studio-v2-bagging-merge-up-r8.cjs .tmp-studio-v2-blue-arrows-r7-v2.json .tmp-studio-v2-bagging-merge-up-r8-candidate-recheck.json
node --experimental-strip-types scripts/verify-studio-v2-bagging-physical-routes.mjs
node node_modules/vue-tsc/bin/vue-tsc.js --noEmit --pretty false
$env:STUDIO_V2_BLUE_MANIFEST='.tmp-studio-v2-r8-db-readback.json'
node scripts/verify-studio-v2-blue-arrow-browser.cjs
```

SQL 版本受事务、SceneId、Revision、SceneKey、V19 哈希以及 r7 旧哈希多重保护：`scripts/digital-twin/apply-studio-v2-bagging-merge-up-r8.ps1`。**已经迁移到 r8，禁止重复执行并覆盖数据。**

截图及报告存放于本机：
`ClientApp/.tmp-studio-v2-r8-sql-readback-edge/studio-v2-r8-bagging-merge-up-physical-rollers.png`、
`ClientApp/.tmp-studio-v2-r8-sql-readback-edge/report.json`。

当前 `Develop` 有大量其他未提交修改，所有原有更改原样保留；未将非本轮代码混入远程 `Develop`。工程布局、设备端口接触公差和长期动态联锁仍需后续专项审查。
