using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace IoTSharp.Data.Configurations;

/// <summary>
/// 数字孪生领域模型持久化映射。
/// </summary>
public static class DigitalTwinConfiguration
{
    internal static void ConfigureCommonScope<TEntity>(EntityTypeBuilder<TEntity> builder)
        where TEntity : class, IJustMy
    {
        builder.HasOne(item => item.Tenant).WithMany().HasForeignKey("TenantId").OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(item => item.Customer).WithMany().HasForeignKey("CustomerId").OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class DigitalTwinSceneConfiguration : IEntityTypeConfiguration<DigitalTwinScene>
{
    public void Configure(EntityTypeBuilder<DigitalTwinScene> builder)
    {
        builder.HasKey(item => item.Id);
        builder.Property(item => item.SceneKey).HasMaxLength(128).IsRequired();
        builder.Property(item => item.Name).HasMaxLength(256).IsRequired();
        builder.Property(item => item.Description).HasMaxLength(2048);
        builder.Property(item => item.Status).HasConversion<string>().HasMaxLength(64);
        builder.Property(item => item.CreatedBy).HasMaxLength(256);
        builder.Property(item => item.UpdatedBy).HasMaxLength(256);
        builder.Property(item => item.Revision).IsConcurrencyToken();
        builder.HasIndex(item => new { item.TenantId, item.CustomerId, item.SceneKey, item.Deleted }).IsUnique();
        builder.HasIndex(item => new { item.RootAssetId, item.Status, item.Deleted });
        builder.HasOne(item => item.RootAsset).WithMany().HasForeignKey(item => item.RootAssetId).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(item => item.PublishedVersion).WithMany().HasForeignKey(item => item.PublishedVersionId).OnDelete(DeleteBehavior.Restrict);
        DigitalTwinConfiguration.ConfigureCommonScope(builder);
    }
}

public sealed class DigitalTwinSceneVersionConfiguration : IEntityTypeConfiguration<DigitalTwinSceneVersion>
{
    public void Configure(EntityTypeBuilder<DigitalTwinSceneVersion> builder)
    {
        builder.HasKey(item => item.Id);
        builder.Property(item => item.SchemaVersion).HasMaxLength(64).IsRequired();
        builder.Property(item => item.ManifestHash).HasMaxLength(128).IsRequired();
        builder.Property(item => item.ChangeSummary).HasMaxLength(1024);
        builder.Property(item => item.CreatedBy).HasMaxLength(256);
        builder.HasIndex(item => new { item.SceneId, item.Version }).IsUnique();
        builder.HasIndex(item => new { item.TenantId, item.CustomerId, item.CreatedAt });
        builder.HasOne(item => item.Scene).WithMany(item => item.Versions).HasForeignKey(item => item.SceneId).OnDelete(DeleteBehavior.Restrict);
        DigitalTwinConfiguration.ConfigureCommonScope(builder);
    }
}

public sealed class TwinModelResourceConfiguration : IEntityTypeConfiguration<TwinModelResource>
{
    public void Configure(EntityTypeBuilder<TwinModelResource> builder)
    {
        builder.HasKey(item => item.Id);
        builder.Property(item => item.ResourceKey).HasMaxLength(128).IsRequired();
        builder.Property(item => item.Name).HasMaxLength(256).IsRequired();
        builder.Property(item => item.SourceType).HasConversion<string>().HasMaxLength(64);
        builder.Property(item => item.RuntimeFormat).HasMaxLength(128);
        builder.Property(item => item.OriginalFileName).HasMaxLength(512);
        builder.Property(item => item.StoragePath).HasMaxLength(1024);
        builder.Property(item => item.ContentHash).HasMaxLength(128);
        builder.Property(item => item.ProcessingStatus).HasConversion<string>().HasMaxLength(64);
        builder.Property(item => item.PreviewResourcePath).HasMaxLength(1024);
        builder.Property(item => item.CreatedBy).HasMaxLength(256);
        builder.Property(item => item.UpdatedBy).HasMaxLength(256);
        builder.HasIndex(item => new { item.TenantId, item.CustomerId, item.ResourceKey, item.Deleted }).IsUnique();
        builder.HasIndex(item => new { item.TenantId, item.CustomerId, item.ProcessingStatus, item.Deleted });
        builder.HasIndex(item => item.ContentHash);
        builder.HasOne(item => item.Product).WithMany().HasForeignKey(item => item.ProductId).OnDelete(DeleteBehavior.Restrict);
        DigitalTwinConfiguration.ConfigureCommonScope(builder);
    }
}

public sealed class TwinModelGenerationJobConfiguration : IEntityTypeConfiguration<TwinModelGenerationJob>
{
    public void Configure(EntityTypeBuilder<TwinModelGenerationJob> builder)
    {
        builder.HasKey(item => item.Id);
        builder.Property(item => item.JobKey).HasMaxLength(128).IsRequired();
        builder.Property(item => item.Name).HasMaxLength(256).IsRequired();
        builder.Property(item => item.Provider).HasMaxLength(128).IsRequired();
        builder.Property(item => item.Prompt).HasMaxLength(8000).IsRequired();
        builder.Property(item => item.QualityProfile).HasMaxLength(64).IsRequired();
        builder.Property(item => item.LicenseType).HasMaxLength(128).IsRequired();
        builder.Property(item => item.ReferenceImagePath).HasMaxLength(1024).IsRequired();
        builder.Property(item => item.ReferenceImageName).HasMaxLength(512).IsRequired();
        builder.Property(item => item.ReferenceImageContentType).HasMaxLength(128).IsRequired();
        builder.Property(item => item.Status).HasConversion<string>().HasMaxLength(64);
        builder.Property(item => item.Stage).HasMaxLength(256);
        builder.Property(item => item.ProviderJobId).HasMaxLength(256);
        builder.Property(item => item.ErrorMessage).HasMaxLength(4000);
        builder.Property(item => item.CreatedBy).HasMaxLength(256);
        builder.Property(item => item.UpdatedBy).HasMaxLength(256);
        builder.HasIndex(item => new { item.TenantId, item.CustomerId, item.JobKey, item.Deleted }).IsUnique();
        builder.HasIndex(item => new { item.TenantId, item.CustomerId, item.Status, item.CreatedAt, item.Deleted });
        builder.HasOne(item => item.ResultModelResource).WithMany().HasForeignKey(item => item.ResultModelResourceId).OnDelete(DeleteBehavior.Restrict);
        DigitalTwinConfiguration.ConfigureCommonScope(builder);
    }
}

public sealed class TwinObjectBindingConfiguration : IEntityTypeConfiguration<TwinObjectBinding>
{
    public void Configure(EntityTypeBuilder<TwinObjectBinding> builder)
    {
        builder.HasKey(item => item.Id);
        builder.Property(item => item.BindingKey).HasMaxLength(256).IsRequired();
        builder.Property(item => item.ObjectId).HasMaxLength(256).IsRequired();
        builder.Property(item => item.NodePath).HasMaxLength(1024);
        builder.Property(item => item.SemanticId).HasMaxLength(256);
        builder.Property(item => item.SourceKind).HasConversion<string>().HasMaxLength(64);
        builder.Property(item => item.SourceKey).HasMaxLength(256);
        builder.Property(item => item.TargetKind).HasConversion<string>().HasMaxLength(64);
        builder.Property(item => item.TargetPath).HasMaxLength(512);
        builder.Property(item => item.TransformKind).HasMaxLength(64);
        builder.Property(item => item.CreatedBy).HasMaxLength(256);
        builder.Property(item => item.UpdatedBy).HasMaxLength(256);
        builder.HasIndex(item => new { item.SceneId, item.SceneVersionId, item.BindingKey, item.Deleted }).IsUnique();
        builder.HasIndex(item => new { item.DeviceId, item.SourceKind, item.SourceKey, item.Enabled, item.Deleted });
        builder.HasIndex(item => new { item.AssetId, item.SceneId, item.Deleted });
        builder.HasIndex(item => new { item.ModelResourceId, item.SceneId, item.Deleted });
        builder.HasOne(item => item.Scene).WithMany(item => item.Bindings).HasForeignKey(item => item.SceneId).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(item => item.SceneVersion).WithMany(item => item.Bindings).HasForeignKey(item => item.SceneVersionId).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(item => item.ModelResource).WithMany(item => item.Bindings).HasForeignKey(item => item.ModelResourceId).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(item => item.Asset).WithMany().HasForeignKey(item => item.AssetId).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(item => item.Device).WithMany().HasForeignKey(item => item.DeviceId).OnDelete(DeleteBehavior.Restrict);
        DigitalTwinConfiguration.ConfigureCommonScope(builder);
    }
}

public sealed class TwinRouteConfiguration : IEntityTypeConfiguration<TwinRoute>
{
    public void Configure(EntityTypeBuilder<TwinRoute> builder)
    {
        builder.HasKey(item => item.Id);
        builder.Property(item => item.RouteKey).HasMaxLength(256).IsRequired();
        builder.Property(item => item.Name).HasMaxLength(256).IsRequired();
        builder.Property(item => item.RouteType).HasMaxLength(64).IsRequired();
        builder.Property(item => item.CreatedBy).HasMaxLength(256);
        builder.Property(item => item.UpdatedBy).HasMaxLength(256);
        builder.Property(item => item.Revision).IsConcurrencyToken();
        builder.HasIndex(item => new { item.SceneId, item.SceneVersionId, item.RouteKey, item.Deleted }).IsUnique();
        builder.HasIndex(item => new { item.TenantId, item.CustomerId, item.Enabled, item.Deleted });
        builder.HasOne(item => item.Scene).WithMany(item => item.Routes).HasForeignKey(item => item.SceneId).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(item => item.SceneVersion).WithMany(item => item.Routes).HasForeignKey(item => item.SceneVersionId).OnDelete(DeleteBehavior.Restrict);
        DigitalTwinConfiguration.ConfigureCommonScope(builder);
    }
}
