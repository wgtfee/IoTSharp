# Studio V2 r11：绿色小托盘、蓝箭头下方空托回流和左侧下行接驳

日期：2026-11-16。以用户上传的产线平面图裁剪（机器人下方蓝色右行箭头和正下方红色左行箭头）为依据。**本轮通过局部真实浏览器专项；未完成主闭环托盘占用联锁与整线机械净空验收。**

## 一、纠正 r10 的两项错误

1. 原 r10 在缓存机器人下方生成棕色长方形方板，外观像木托盘。实际这里应使用项目已有的 **绿色圆形小托盘**，包含圆形底座、承托中心座、定位柱，与 108 个循环小托盘使用相同组件 `SmallPalletComponent`、同一资源 `builtin-small-pallet`，物流类型 `plastic-pallet`、变体 `small-pallet`。没有新增木托盘、木方板或任何母托盘资源。
2. 用户图纸的**蓝色箭头上方道是载丝小托盘向右**，紧接着**蓝箭头下方红色独立道是机器人取丝后的空小托盘向左回流**，右端经过实体 180° U 转弯。红色下排不能只运行到机器人附近就消失，必须向左延伸到左侧竖向双排辊道，转入其内侧向下回流通路。

## 二、场景几何与业务规则

- 双排中心间距 1.9 m，上排世界 Z = -8.15，**载丝向右（X 递增）**；下排世界 Z = -6.25，**空托向左（X 递减）**。平面图中后者位于蓝箭头下方。
- 双排辊道由原 5.4 m 扩展为 **11.4 m**，X 从 -12.7 至 -1.3；辊道中心 X = -7，机器人取丝位固定 X = -4（局部 X = 3），没有随辊道中心移动。
- 上排载丝小托盘从 (-12.7, -8.15) 向右到机器人 (-4, -8.15)，取丝后同一小托盘右行至 (-1.3, -8.15)；在右端 U 转弯至下排 (-1.3, -6.25)；再沿红箭头下排向左至 (-12.7, -6.25)。
- 在左侧已有的 `reference-double-small-upper-left` 内侧竖向辊道新增中途接驳口 `a-cache-empty-lower-return`，连接下排 `b-output`，对应世界 (-12.7, -6.25)。支路图中新增继续向下到 (-12.7, 9) 的空托流向；物理入口已配置，但**尚未完成真实主回路占位仲裁与相同托盘 ID 的实体转交**。
- 100 个挂杆缓存和机器人抓丝动作保持；小托盘实体在抓丝后由载丝变空，并沿 U 转弯连续运动。到左侧接驳点时等候下游接收确认，不凭空消失或重复入主回流。
- 原 108 个主闭环托盘 ID 和完整 42 点 / 46 边主路线未改动。本轮隔离测试托盘始终标记 `previewOnly=true`，不能宣称它已经接入 108 个真实运行托盘之一。

## 三、开发库与验收

开发 SQL Server：`DESKTOP-2ALRK02\MSSQ`，数据库 `IOTSharp`。

| 项目 | 结果 |
| --- | --- |
| Studio V2 场景 `d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94` | **Draft r11**，场景 57 对象、53 个连接、5 条路线 |
| V2 SQL DraftPayload 哈希 | `6C14270B559563EFB590EC971D08B506E3A83CD7A0E06FD7449894BBE59CA81C` |
| 原始场景 `69a6b03a-0a0c-45e9-b3c1-f29bcaeb142e` | Published r11，严格只读，SHA256 `470C08343F35E5671B38455D3018CA15C1A726FD8AB7E2AD4D93A1DD24393B66` |
| TypeScript 全量 `vue-tsc --noEmit` | 通过 |
| 5 项错流向、漏接驳、短辊道反例 | 通过：全部触发禁止/校验失败 |
| 实际 SQL r11 写入和回读 | 通过：全文与已测试候选完全相同 |
| 真实 Edge + Three.js（**从 SQL r11 重新回读**） | 通过：0 场景结构错误，4 张运行截图 |
| 绿色小托盘生成器 | 通过：`SmallPallet-Base`、`SmallPallet-SupportSeat`、`SmallPallet-LocatingPost` 全部存在，木质方板不存在 |
| 红色下排空托连续左行到左侧竖道交接点 | 通过：同一隔离预览托盘 ID，不允许提前确认或重入 |
| 108 主闭环托盘身份 | 通过：短时 ID 核对无增加、删除或更名 |
| 当前工程警告 | **未验收：77 条**，较 r10 增加 3 条，需要继续进行机械包络实测 |
| 桁架取出后与 108 托盘同一实体交接 | **未验收**，仅手动仿真业务输入 |
| 左侧竖道与主回流占用锁/接收确认 | **未验收**，虽然接驳口和方向建立，不能当作无碰撞动态合流通过 |
| 108 托盘多圈、整线持续运行 | **未验收** |
| 现场 PLC、MES、机器人 | **未发送**，仅使用开发隔离 Simulation |

## 四、可复现资料

- r11 数据构建：`ClientApp/scripts/build-studio-v2-cache-small-pallet-return-below-blue-r11.cjs`；
- 负向测试：`ClientApp/scripts/verify-studio-v2-cache-small-pallet-return-r11.mjs`；
- Edge + Three.js：`ClientApp/scripts/verify-studio-v2-cache-small-pallet-return-r11-browser.cjs`；
- SQL 保护事务：`scripts/digital-twin/apply-studio-v2-small-pallet-below-blue-r11.ps1`，**已执行一次，不得在 r11 上重复运行**；
- SQL r11 精确回读：`ClientApp/.tmp-studio-v2-r11-db-readback.json`；
- 本机真浏览器截图和报告：`ClientApp/.tmp-studio-v2-cache-small-pallet-r11-sql-edge/`。

原始 V19 和其他 Git 未提交文件均保留。源码仅提交单独验证分支，不能覆盖远程 `Develop`。
