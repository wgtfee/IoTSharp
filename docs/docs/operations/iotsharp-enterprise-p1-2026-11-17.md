# IoTSharp 企业级 P1 首轮实施与验收清单（2026-11-17）

> 工作区：H:\code\Industrial.Platform\IoTSharp-master，Develop。
> P0 内网配置和历史明文凭据相关事项按用户要求暂缓；风险仍需生产交付前单独复核，不意味着安全问题已消除。

## 代码调整

1. **用户分页**：AccountController.List 在数据库端应用客户/租户范围、名称/邮箱/姓名搜索、稳定排序与分页。本地 Relationship 与 IAM Shadow 用户都保留，分页后批量读取声明、角色与客户，不再全量扫描再逐用户读取。
2. **角色分页**：RoleManagementController 用 IQueryable + correlated EXISTS/SQL 子查询做授权范围计算；角色成员和候选用户查询都在数据库端分页。
3. **审计**：AccountController 创建/编辑用户、RoleManagementController 角色增删改、成员授权及角色权限变更写入 AuditLog，包含操作人、对象、前后角色/客户或权限、时间和结果。审计与相应 Identity 业务变更在同一数据库事务提交。
4. **生产 CORS**：开发和 Test 环境保持原跨域开发策略；其他环境只允许 Cors:AllowedOrigins 显式配置的 HTTP(S) origin。列表为空时不向跨域浏览器响应 CORS 放行头，错误 URL 配置则拒绝启动。
5. **健康探针**：/healthz 只表示进程存活（status=Alive，dependenciesChecked=false）；/health/ready 与 /readyz 执行已注册依赖检查；/health/traffic 沿用关键/降级依赖评估，建议负载均衡按服务能力选用。
6. **数据库升级**：Production 的 Database:AutoMigrate 缺省关闭。需数据库备份、脚本审核、预生产演练、升级窗口及回滚审批；开发环境原默认保持。
7. **专用角色**：可由 SystemAdmin 在角色管理页人工初始化 PdmReviewApprover、PdmWorkOrderManager、PdmTechnician 三个受保护职责角色，不自动授予成员或 P2 审批授权。
8. **自定义角色权限基础机制**：角色管理页可配置固定目录内的六个 IoT 应用权限码，使用 Identity 角色声明存储；本地/IAM 本地权限提供器读取角色声明并保留 SystemAdmin 和租户/客户数据范围边界。内置及审批职责角色不经此界面提权。

## 生产配置示例

- 跨域访问：使用配置键 Cors:AllowedOrigins:0=https://your-approved-intranet-portal.example；按实际已批准内网域名/协议/端口配置。前后端同源时可不配置跨域来源。仅支持明确 origin，不允许星号通配。
- 数据迁移：Database:AutoMigrate=false（Production 缺省行为）；仅在审批过的专门升级窗口临时显式启用或使用受控迁移脚本。
- 探针：/healthz 仅存活，/health/ready 表示严格依赖就绪，/health/traffic 表示关键业务流量可路由。不得把存活结果描述为数据库或 MES 已准备就绪。

## 验收项目

- 后端编译、前端类型检查/构建、Git diff --check；
- 本地 /healthz 状态及 /health/ready 数据，Swagger 已声明的角色/授权 API；
- 系统管理员可跨客户查用户，客户管理员不可跨客户读记录；
- 用户列表 1/100/500 条分页、姓名检索、IAM + 本地账号回显、用户原角色回显；
- 创建用户—改客户—改角色—回查 AuditLog 的原子性和回滚；
- 角色成员增删、专用角色初始化幂等、普通管理员受限及最后一个 SystemAdmin 保护；
- 自定义角色权限查询/更新/回显、未授权权限码拒绝、不可对内置/PdM 专项角色配置通用权限；
- 生产环境空白 CORS 跨域请求被拒、白名单合法 Origin 可访问；
- 生产迁移默认不运行，升级前数据库备份和回滚演练；
- 10万用户级 SQL 执行计划和 P95/CPU/IO 对比，以真实规模验证索引，不预设性能提升比例。

## 未闭环范围

- **全部业务 Controller 和菜单未统一迁移到策略式权限码校验**：当前六个权限码服务于已有 Industrial.Security 权限合同；老接口的 [Authorize(Roles)]、菜单生成仍以真实角色判定为主。不得把本轮说成全站 RBAC 改造完成。
- 角色授权变更后的会话失效/缓存主动刷新仍需专项验证，当前要求用户重新登录；
- 登录态浏览器 E2E、跨租户负向测试、SQL 大规模基准、生产/内网 HTTPS 配置及 MES/飞书真实回执尚需现场回归；
- 本轮不触碰 P0 延后项、不修改其他脏工作树文件、不提交远端。
## 本轮实际验证记录

- 后端 Compile-only 调用：0 error；仍有项目原有警告。
- 前端 npm run typecheck：通过。第二次前端 npm run build -- --logLevel error：通过；存在第三方打包注释警告。第一次前端构建超时不计成功。
- 已对开发环境 5088 后端先备份、再更新、验证；本轮部署得到 PID 33964（以实际进程状态为准）。
- GET /healthz：HTTP 200，返回 Alive 与 dependenciesChecked:false；
  GET /health/ready：HTTP 200，返回真实依赖检查及耗时；
  GET /health/traffic：HTTP 200，当前报告 Allowed。
- Swagger 注册了 /api/role-management/permission-catalog 和 /api/role-management/ensure-pdm-roles；未登录访问角色和用户管理接口返回 401。
- Vite 开发服务 5173 输出了角色权限设置和 PdM 职责角色初始化的新模块。
- 当前数据库角色仍为五个，原角色成员关系未改动；未通过 SystemAdmin 实际执行 PdM 角色初始化或权限授予。
- .NET 安全测试未通过：第一次被并行构建占用 IoTSharp.EventBus.CAP 输出 DLL；第二次 IoTSharp.Test/DigitalTwinSceneServiceTests.cs 第83行报 CS9007 原始字符串语法错误。未擅自修改并行工作的数字孪生测试文件。
- 尚未完成实际登录身份下的用户/角色 E2E、持久化审计回查、10万用户的执行计划和性能基准、以及正式环境部署参数演练。

## 下一轮最小剩余事项

1. 在隔离构建环境处理测试项目编译阻断，运行用户/权限/审计事务回归。
2. 授权管理员会话验证用户分页、多租户隔离、角色权限分配、专用职责角色初始化及最后一个系统管理员保护。
3. 按照权限矩阵逐模块迁移旧业务路由和菜单静态角色检查；当前仅接通 Industrial.Security 权限合同，不能声称全站 RBAC 已实现。
4. 用真实规模评估 SQL Server 用户查询执行计划、索引、P95/CPU/IO，且不得预设优化比例。
## P1 第二轮：设备、遥测、租户客户 RBAC 贯通

### 本轮已实现的代码

1. 新增 IotRequirePermissionAttribute/IotRequirePermissionFilter：后端 Action 权限与已有 Identity 用户-角色-权限声明一致，并保留原控制器的认证要求。角色配置的权限码必须在 IotRolePermissionCatalog 六个已支持的权限列表中。
2. DevicesController：设备查询/新增/编辑/删除、遥测查看及手工上报、批量属性查询、设备属性维护和 X509 证书管理使用实际权限码。查询统一校验租户和客户，系统管理员跨范围访问；无效或缺失 scope 拒绝。证书下载须有管理权限且设备必须在可访问范围。
3. CustomersController：普通用户只能访问自身客户；租户管理员只能跨当前租户；SystemAdmin 可跨客户。普通编辑采用已加载实体和明确字段映射，防止覆盖 Deleted/AISettings 等字段。普通编辑不支持直接跨租户迁移客户，因为必须同时更新设备、用户声明、资产和归属审计；如需迁移应建单独流程。
4. TenantsController：普通读取只允许自身租户；租户资料和 AI 设置采用真实 tenant.admin 权限，阻断跨租户修改；SystemAdmin 可管理所有租户。
5. MenuController.GetProfile：返回按实际登录 Identity 成员与权限声明计算的六项 effectivePermissions，设备和遥测菜单由对应只读权限过滤，客户管理菜单按 tenant.admin 资格显示；其余菜单仍保留旧逻辑。
6. 前端 deviceCrudOptions/devicelist/telemetry：根据 GetProfile 返回的权限快照显示新增/编辑/删除与手工上报，失败时回退只读；后端继续负责最终授权。
7. userInfo Pinia：将后端 MyInfo 返回的逗号分隔角色解析为独立角色，同步修复已有浏览器缓存；仅真实 SystemAdmin 附加 legacy admin 路由别名，其他已登录用户最多附加 common。
8. 专项维护接口仍有旧的 Roles 检查或业务细粒度状态机，未在本轮扩大其权限；PdmReviewApprover 继续独立审批，未将 SystemAdmin 直接映射成审批人。

### 交付影响与边界

- 客户新增操作从原来宽泛的 CustomerAdmin 路由限制收紧到实际 tenant.admin 权限；原租户管理功能应由 TenantAdmin、SystemAdmin 或经审核授予 tenant.admin 的自定义角色执行。此项需要用现有 PC 页面账号回归。
- 某些历史跨客户查询过去可能返回数据，现在会被拒绝；应修改调用方传入正确的 customerId，而不是放宽后端范围。
- 此轮没有引入真实 PLC/MES/飞书操作，也没有写入生产或开发业务表。
- 剩余：资产、规则链、告警、Edge、其他设备控制接口与所有菜单/按钮仍需全面迁移；不能声称全站 RBAC 完成。用户登录态功能、跨租户反向测试和 10 万用户性能还需要现场验收。
### P1 第二轮实际验证记录

- 后端 IoTSharp.csproj Compile-only 编译：0 error，有历史项目警告。最近一次编译后的程序集已备份旧版本并部署到开发实例 5088；新 PID 29260，部署后校验程序集 SHA-256 与编译输出相等。
- 前端 npm run typecheck：通过；npm run build -- --logLevel error：通过（第三方依赖的 Rollup 注释警告不影响构建）。
- 独立角色映射回归：运行 node scripts/verify-iot-user-roles.cjs，9 个断言通过，包括 SystemAdmin、NormalUser、自定义角色、缓存角色以及伪装 admin/common 别名被拒的情况。
- 后端健康：GET /healthz、GET /health/ready、GET /health/traffic 均 HTTP 200，ready 返回实际依赖检查明细。
- 未登录访问 GET /api/Devices/Customers、GET /api/Menu/GetProfile 和 GET /api/role-management/roles 均为 HTTP 401；Swagger 含 Devices、Menu 和角色管理路由。Vite 5173 已提供最新设备、遥测和角色解析模块。
- .NET 针对性测试仍被与本轮无关的 IoTSharp.Test/DigitalTwinSceneServiceTests.cs 第 83 行 CS9007 编译错误阻断；不能记为通过；没有改动该并行开发的测试文件。
- 目前没有实际登录会话下跨租户/跨客户、不同角色菜单和编辑弹窗的全流程 UI 操作证据，以上仍处于待验收。
- 本轮修改只留在 Develop 本地工作树，未提交或推送远端，也没有执行生产数据库写入、PLC、MES、飞书调用。

下一批待办：资产/Edge/规则/告警的策略式权限码和导航一致性，用户/角色真实 E2E、审计回滚试验、跨租户负向用例、旧测试工程修复及大规模性能。
## P1 第三轮：实际权限与范围专项回归（2026-11-17）

本轮只执行测试，没有修改生产/开发数据库业务数据，没有发送真实 PLC/MES/飞书请求，也没有修改数字孪生模块代码。

### 验证总览

| 测试类型 | 通过 | 执行方式与边界 |
|---|---:|---|
| .NET 10 权限过滤器及权限码 | 24 | 编译后的真实 IoTSharp.dll；授权源使用隔离的假权限源，涵盖 401/403/允许、LocalUserId 优先、权限白名单、控制器注解及角色映射 |
| 客户/租户范围 | 24 | EF Core InMemory，仅映射 Tenant/Customer；直接执行实际控制器方法，按 NormalUser/TenantAdmin/SystemAdmin/CustomerAdmin 构造隔离 Principal |
| 设备数据范围 | 19 | EF Core InMemory；实际调用设备访问判断、设备列表和手工遥测的拒绝分支，包含跨客户、跨租户、软删除和无效 Claims |
| ASP.NET Core HTTP 管道 | 8 | 临时绑定本机随机端口，真实 MVC/Authorize/TypeFilter 过滤器 + 隔离 Synthetic 登录，检查 401/403/200，不接生产 Identity |
| 浏览器设备/遥测按钮 | 4 | Playwright + Edge，对 5173 Vite 实际页面，浏览器网络层隔离模拟 API；只读与管理/指令角色分别测试，页面无 JavaScript 异常 |
| 浏览器用户新增、编辑、角色多选 | 3 | Playwright + Edge，验证新增/编辑时客户及角色下拉控件、编辑多角色回显、追加 CustomerAdmin 仍保留 NormalUser；未发任何创建/修改请求 |
| 运行中后端拒绝越权 | 14 | 实际 5088：12 个匿名 GET/POST/PUT 接口全部 401；伪造管理员请求头和错误 Bearer Token 均 401 |
| 后端健康与 Swagger | 4 | 实际 5088：healthz、health/ready、health/traffic、swagger/v1/swagger.json 全部 HTTP 200 |
| **本轮合计** | **100** | 以上项目按实际脚本断言/请求计数，不能等同于 100 个数据库级 E2E |

另有上一轮已通过的前端角色规范化 JS 脚本 9 项，不重复计入上述 100。

### 测试用数据及截图

- .NET 临时专项程序位于系统临时目录 IoTSharpP1PermissionSmoke_20261117，其中的 EF 数据只在内存生命周期存在，真实数据库没有新增或删除用户。
- UI 使用隔离浏览器上下文和模拟 token，所有网络 API 由 Playwright 拦截；截图暂存在 %TEMP%\iotsharp-p1-rbac-ui-20261117。包含 device-viewer.png、device-admin.png、telemetry-viewer.png、telemetry-operator.png、user-add-role-binding.png、user-edit-role-binding.png。
- 第一轮浏览器模拟使用 data: [] 响应规则列表，导致 addRules.vue 的 rows.map 抛错。定位后改为真实列表返回结构 data: {rows:[],total:0}，四个页面复测均无页面错误。此为测试桩错误，不记录为生产缺陷。
- 前端用户测试发现 FastCrud 的新增按钮实际文本为“添加”；修正测试选择器后新增、编辑、多选均通过。

### 仍未通过与未执行的验收

1. **原 IoTSharp.Test 测试程序集编译阻断**：DigitalTwinSceneServiceTests.cs 第 83 行 CS9007；另有 SonnetDB Testcontainers 的 SSH.NET NU1903 作为错误导致构建失败。未修改并行开发的文件或依赖版本。独立 75 项 .NET 专项测试通过不代表全量 xUnit 通过。
2. **真实登录账号的端到端授权仍待验收**：本轮没有以真实密码/登录令牌进行角色创建、授予、移除、保存、重新登录与历史审计查询；也没有对真实 SQL Server 数据执行跨租户写入试验。
3. **真实身份存储/Shadow/Federated 联调仍待验收**：虽验证了 LocalUserId 优先及角色映射，尚未以 IAM 的真实断联/重连、角色映射事件执行后台完整闭环。
4. **P1 全站尚未完成**：资产、Edge、规则链、告警和 PdM 更广泛的接口/菜单均需要独立权限范围回归；没有通过 10 万用户规模性能或角色变更后的 token 失效测试。

结果状态：**P1 第三轮 100 项专项检查通过；真实账号全链路及全站回归仍未通过验收**。未提交或推送代码。
## P1 第四轮：真实数据库只读与角色控制器正式验收（2026-11-17 晚间）

**验收裁决：专项功能大部分通过，完整 P1 正式验收未通过，继续保留真实登录/持久化写入及全量 xUnit 的待验收项。**

### 本轮新增测试与修复

| 测试 | 结果 | 实际执行范围 |
|---|---|---|
| 真实开发 SQL Server 连接 | 通过 | sqlcmd 使用本地 Development 配置连接 本机 SQL Server 开发库（IOTSharp），未输出密码 |
| 实际用户/角色/客户/租户/设备基线 | 通过 | Sqlcmd 只读聚合统计及完整性检查 |
| Identity 角色权限授权、撤销和立即生效 | 27/27 通过 | .NET 10 内存数据库；实际 UserManager、RoleManager、IoTSharpLocalPermissionSource，包含锁定 SystemAdmin 不授权 |
| RoleManagementController 角色管理和审计 | 24/24 通过 | 内存数据库真实控制器方法：角色创建、授权白名单、授权回读、成员绑定与解绑、保护最后一个系统管理员、删除有成员角色保护、审计写入、角色删除；InMemory 事务忽略回滚事件，不等同真实 SQL 回滚 |
| Role 管理 UI：TenantAdmin 与 SystemAdmin | 2/2 通过 | Playwright/Edge，模拟两种身份 API，直接渲染 5173 真实 Vue 页面；非超级管理员只读且看不到新增/编辑/删除/成员变更按钮，超级管理员可打开角色新增和六项权限配置；无 JS 错误和写请求 |
| 后端编译 | 通过 | IoTSharp.csproj Compile-only，0 错误，9 条当前项目警告 |
| 前端 vue-tsc | 通过 | npm run typecheck |
| 前端生产打包 | 通过 | npm run build -- --logLevel error；第三方 Rollup PURE 注释警告，不阻止完成 |
| 之前 75 项 .NET 权限/范围/HTTP 专项 | 复测通过 | 使用原隔离测试程序再次执行 |
| 原 IoTSharp.Test xUnit | 未通过 | DigitalTwinSceneServiceTests.cs 第83行 CS9007；SonnetDB Testcontainers 依赖 SSH.NET 2025.1.0 的 NU1903 警告作为错误；没有改动并行开发文件 |
| 真实登录后的角色写入与事务回滚 | 未验证 | 真实用户的登录态未获得；涉及真实 Identity 表的写入验收受到执行环境安全限制，未运行，不记通过 |

测试计数：**本轮新增 51 项 .NET + 2 个 UI 场景。** 按去重的回归类型加总，上轮 100 项基础上新增 53 项，累计 153 项专项检查通过（126 项 .NET、9 项浏览器场景、18 项实际服务 HTTP 检查）。此计数绝不代表 153 项真实数据库完整 E2E。

### 实际开发库核对

- 测试前后均为 3 用户、5 角色、13 用户角色关系、9 用户声明、0 角色声明。
- 3 客户、3 租户、7 设备、76 审计记录；实际用户关系表 Relationship 为 2。
- RoleClaims/用户角色/用户声明均无孤立外键，用户客户/租户声明均存在且非重复；设备没有跨租户客户归属不一致。
- **P1 数据一致性待办：1 个 SystemAdmin 用户有有效客户/租户声明，但缺少 Relationship 记录。** Account/List 已有 Claims 回退，不能据此直接断言页面错误；正式交付前需明确是否回填，并验证全站读取 Relationship 的历史代码。
- 结束时数据库计数未发生改变，未保留 P1Acceptance 测试角色，未重置任何用户密码。

### 本轮发现并修复的界面缺陷

- 原 rolelist.vue 对非 SystemAdmin 仍显示新增、编辑、删除、自定义角色权限、添加与移除成员按钮，导致用户误点后才收到 403。
- 已在 ClientApp/src/views/iot/settings/rolelist.vue 收紧所有修改入口并添加方法层守卫；角色和成员列表仍允许租户管理员只读查看。
- 已做两种身份的浏览器回归，成功截图留存于 %TEMP%\iotsharp-p1-enterprise-roles-20261117 （role-tenant.png、role-admin.png、role-admin-permissions.png）。
- 该文件原本为工作树未跟踪文件，本轮未整理或覆盖其他并行开发文件；仍未 Git commit/push。

### 遗留项与退出条件

1. **真实账号 E2E**：SystemAdmin/CustomerAdmin/TenantAdmin/NormalUser 通过真实登录签发 JWT，验证所有可见按钮、真实 API 响应、角色保存、撤销后的旧/新会话权限。
2. **开发 SQL Server 事务和审计**：经授权的隔离数据库或可审计可恢复的专用账号，实际提交并回查角色权限、成员关系、审计日志、事务失败回滚；本轮没有修改真实用户/角色表。
3. **归属数据修复**：核查缺失 Relationship 的 SystemAdmin，确认是否应补齐关系记录，并对迁移及旧查询做回归。
4. **xUnit 全量回归**：解决 DigitalTwinSceneServiceTests.cs CS9007（需与孪生模块并行开发协调）与 NU1903 依赖阻断，再跑完整针对性和广泛回归。
5. **全站 RBAC 余量**：资产/Edge/规则链/告警/PdM 全部 API、菜单和数据域边界仍需逐模块验证；P0 内网部署暂缓项仍按用户决定忽略。

环境：Develop HEAD dc20b1de，开发后端 5088 / 前端 Vite 5173 健康检查均 HTTP 200。测试后工作树保留已有约 284 个脏文件，不做批量重置。