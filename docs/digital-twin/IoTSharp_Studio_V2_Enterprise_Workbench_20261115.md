# IoTSharp Digital Twin Studio V2 · 独立企业版编辑器

2026-11-15 · Develop · 新增独立工作台；旧版 3D 编辑器和运动/动作引擎不作重构。

## 1. 访问与隔离

- 新增前端路由：/iot/digital-twin/studio-v2。
- 旧版路由：/iot/digital-twin/workbench（不修改页面或原有业务代码）。
- 新工作台与旧版共用原有 TwinSceneManifest、资产/模型资源、场景草稿、发布和不可变版本 API，不添加第二套业务数据。
- 组件模板先注册为模型资源后创建实例；不允许持久化一个未注册的临时组件。
- 旧版 ThreeEditorCoreHost、TwinRuntime、ActionFlowDesigner、组件库、路线生成和校验器保持复用，不修改核心文件。

## 2. 五个方向的实际集成

| 方向 | 本批次实现 | 边界 |
| --- | --- | --- |
| 视觉 / 场景 | 独立企业级导航、布局、属性编辑器、场景状态、3D 主画布 | 沿用旧版 Three.js 模型和光照配置，不宣称已重新制作全部工业模型或 PBR 材质 |
| 设计工作台 | 组件库与 GLB 实例、点击/拖放、三维变换、Port 查看、路线绘制、多选、撤销/重做、参考产线模板、组件属性面板 | 工程场景仍基于原有 Manifest 和组件吸附校验 |
| 三种模式 | Design 使用 ThreeEditorCoreHost；Simulation 使用隔离 TwinRuntime；Live 获取已发布不可变 Manifest 并只读订阅 telemetry snapshot | Live 不发送设备控制命令；未发布或存在未保存编辑时禁止进入 |
| 渲染性能 | 从 TwinRuntime 实测 FPS、Draw Calls、Triangles、Geometries、Textures；运行前显示缺省而非演示数据 | 未新增 GPU 利用率、OEE 等无法真实获取的指标；大场景 LOD/Instancing 仍需单独基准 |
| 企业验收 | 草稿保存、结构诊断、服务端校验、校验闸口、发布和版本列表、历史回滚草稿；测试脚本截图与结果留档 | 空白场景允许保存未完成草稿，但发布必须先消除结构错误并通过服务端校验 |

## 3. 运行与测试

工作目录：ClientApp。

    node node_modules/vue-tsc/bin/vue-tsc.js --noEmit --pretty false
    node node_modules/vite/bin/vite.js build --outDir "$env:TEMP/iotsharp-studio-v2-build" --emptyOutDir
    node scripts/verify-studio-v2-browser.cjs
    node scripts/run-generate-drawing-packaging-line.mjs --action-flows
    node scripts/run-scene-drag-authoring.mjs

verify-studio-v2-browser.cjs 在独立 Vite 端口（默认 5191）打开真实 Edge 浏览器和 WebGL 画布，通过 Playwright **模拟 API** 来测试页面操作。不会写入实际 IoTSharp 数据库，不会发出 PLC、MES 或真实遥测控制指令。默认截图、结果存储于 Windows %TEMP%\iotsharp-studio-v2-e2e；浏览器测试会清理临时 HTML 测试入口。

### 自动化浏览器覆盖（11 项）

1. 独立工作台加载和真实 WebGL 画布。
2. 创建具有根资产的独立场景。
3. 参数化组件注册和场景实例化。
4. 仿真 / 未发布 Live 禁入。
5. 草稿保存和修订版本递增。
6. 不完整路线阻断工程验证。
7. 真实三维画布绘制路线点。
8. 已完成拓扑保存、服务端校验。
9. 校验并发布版本。
10. 读取已发布版本的 Live 只读场景。
11. 读取版本历史。

## 4. 仍需真实开发库/部署验收的内容

1. 登录后的资产权限、真实根 Asset、模型资源注册权限和业务数据库保存回读。
2. 真正的场景多用户冲突与 API 失败注入；服务端已通过 revision 检查防止无提示覆盖。
3. 真实已发布场景的多设备遥测绑定、信号质量及网络重连；此次浏览器验证只模拟 snapshot API。
4. 不同 GPU/大型模型、重复几千辊道/托盘场景的 FPS、Draw Calls、显存与 GC 压测，确认性能基线后再做材质和实例化优化。
5. 真实工厂或客户资产的模型精度、灯光、材质、机械运动符合设计要求的视觉验收。

**已知独立回归风险：** 仓库原有 run-v7-components-smoke.mjs 在 J1 跨 ±π 角度边界用例失败（final=179.000, travel=0.000）。本批次没有改动旧运动学实现，不将该项记为通过；该问题需单列原有 V7 组件回归排查。
