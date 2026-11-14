using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace IoTSharp.Data.Configurations;

/// <summary>PdM 表按租户/客户/设备建索引；此映射本身不会执行生产数据库迁移。</summary>
public sealed class PdmDeviceProfileConfiguration : IEntityTypeConfiguration<PdmDeviceProfile>
{
    public void Configure(EntityTypeBuilder<PdmDeviceProfile> b)
    {
        b.ToTable("PdmDeviceProfile");
        b.HasKey(x => x.Id);
        b.HasIndex(x => new { x.TenantId, x.CustomerId, x.DeviceId }).IsUnique();
        b.HasIndex(x => new { x.TenantId, x.CustomerId, x.Enabled });
        // 试点表仅存 ID，不设置级联删除；删除 Device 不应自动删除健康审计历史。
    }
}

public sealed class PdmPointPolicyConfiguration : IEntityTypeConfiguration<PdmPointPolicy>
{
    public void Configure(EntityTypeBuilder<PdmPointPolicy> b)
    {
        b.ToTable("PdmPointPolicy");
        b.HasKey(x => x.Id);
        b.Property(x => x.TelemetryKey).IsRequired().HasMaxLength(256);
        b.Property(x => x.Unit).IsRequired().HasMaxLength(32);
        b.HasIndex(x => new { x.ProfileId, x.TelemetryKey }).IsUnique();
        b.HasIndex(x => x.ProfileId);
        b.HasOne<PdmDeviceProfile>().WithMany().HasForeignKey(x => x.ProfileId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class PdmHealthSnapshotConfiguration : IEntityTypeConfiguration<PdmHealthSnapshot>
{
    public void Configure(EntityTypeBuilder<PdmHealthSnapshot> b)
    {
        b.ToTable("PdmHealthSnapshot");
        b.HasKey(x => x.Id);
        b.Property(x => x.DataQuality).IsRequired().HasMaxLength(40);
        b.Property(x => x.RiskLevel).IsRequired().HasMaxLength(40);
        b.Property(x => x.ExplanationJson).IsRequired();
        b.HasIndex(x => new { x.TenantId, x.CustomerId, x.DeviceId, x.WindowEndUtc });
        b.HasIndex(x => new { x.TenantId, x.CustomerId, x.RiskLevel, x.WindowEndUtc });
        b.HasIndex(x => new { x.ProfileId, x.ProfileVersion, x.WindowStartUtc, x.WindowEndUtc }).IsUnique();
        b.HasOne<PdmDeviceProfile>().WithMany().HasForeignKey(x => x.ProfileId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}



/// <summary>后续风险事件按租户和 EventKey 去重，避免重试造成多条活动风险。</summary>
public sealed class PdmRiskEventConfiguration : IEntityTypeConfiguration<PdmRiskEvent>
{
    public void Configure(EntityTypeBuilder<PdmRiskEvent> b)
    {
        b.ToTable("PdmRiskEvent");
        b.HasKey(x => x.Id);
        b.Property(x => x.EventKey).IsRequired().HasMaxLength(128);
        b.Property(x => x.RiskType).IsRequired().HasMaxLength(128);
        b.Property(x => x.RiskLevel).IsRequired().HasMaxLength(40);
        b.Property(x => x.Status).IsRequired().HasMaxLength(40);
        b.Property(x => x.EvidenceJson).IsRequired();
        b.HasIndex(x => new { x.TenantId, x.CustomerId, x.EventKey }).IsUnique();
        b.HasIndex(x => new { x.TenantId, x.CustomerId, x.DeviceId, x.Status, x.LastObservedUtc });
        b.HasOne<PdmDeviceProfile>().WithMany().HasForeignKey(x => x.ProfileId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}