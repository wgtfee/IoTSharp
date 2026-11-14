# IoTSharp PdM P1-01～P1-03：隔离测试与部署门禁

正式模块尚未部署或启用。此目录包含 P1 规则质量/健康指标计算及四张独立数据库模型的 SQLite :memory: 测试。

运行（在仓库根目录）：

    dotnet restore tools/pdm-p1/IoTSharp.PdM.P1.Tests.csproj --ignore-failed-sources -p:NuGetAudit=false
    dotnet build IoTSharp.Data/IoTSharp.Data.csproj -c Debug --no-restore -p:BuildProjectReferences=false -v:q
    dotnet build IoTSharp/IoTSharp.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false -v:q
    dotnet test tools/pdm-p1/IoTSharp.PdM.P1.Tests.csproj -c Debug --no-restore -p:BuildProjectReferences=false -p:GeneratePackageOnBuild=false -v:q

设计：Data 项目含未启用的 4 张实体与 Fluent API；IoTSharp 只含纯计算型服务。**尚未将实体注册进主 ApplicationDbContext，不能对生产数据库执行 Migrate/EnsureCreated**。要实际落表必须先针对各 Provider 生成兼容迁移，经测试与审查后发布。

健康指数不代表故障概率，任何缺失、跨租户或未确认工况的样本都不应得到“健康”的结论。

本阶段测试结果：P1 27/27 通过；P0 Node 20/20、.NET 5/5 回归通过。见 design-plans/predictive-maintenance/P1_01-03_实施验收报告.md。

