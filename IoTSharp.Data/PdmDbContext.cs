using IoTSharp.Data.Configurations;
using Microsoft.EntityFrameworkCore;

namespace IoTSharp.Data;

/// <summary>
/// 独立 PdM 元数据存储上下文。绝不引用主 ApplicationDbContext 的自动迁移。
/// 建表仅由经过评审的独立 SQL/DBA 流程显式执行。
/// </summary>
public sealed class PdmDbContext : DbContext
{
    public PdmDbContext(DbContextOptions<PdmDbContext> options) : base(options) { }

    public DbSet<PdmDeviceProfile> DeviceProfiles => Set<PdmDeviceProfile>();
    public DbSet<PdmPointPolicy> PointPolicies => Set<PdmPointPolicy>();
    public DbSet<PdmHealthSnapshot> HealthSnapshots => Set<PdmHealthSnapshot>();
    public DbSet<PdmRiskEvent> RiskEvents => Set<PdmRiskEvent>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.ApplyConfiguration(new PdmDeviceProfileConfiguration());
        modelBuilder.ApplyConfiguration(new PdmPointPolicyConfiguration());
        modelBuilder.ApplyConfiguration(new PdmHealthSnapshotConfiguration());
        modelBuilder.ApplyConfiguration(new PdmRiskEventConfiguration());
    }
}

