using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace IoTSharp.Data.Configurations;

public sealed class TwinActionFlowConfiguration : IEntityTypeConfiguration<TwinActionFlow>
{
    public void Configure(EntityTypeBuilder<TwinActionFlow> builder)
    {
        builder.HasKey(x => x.Id);
        builder.Property(x => x.FlowKey).HasMaxLength(256).IsRequired();
        builder.Property(x => x.Name).HasMaxLength(256).IsRequired();
        builder.Property(x => x.ContractVersion).HasMaxLength(32).IsRequired();
        builder.Property(x => x.GraphHash).HasMaxLength(128).IsRequired();
        builder.Property(x => x.CompiledPlanHash).HasMaxLength(128).IsRequired();
        builder.Property(x => x.CreatedBy).HasMaxLength(256);
        builder.Property(x => x.UpdatedBy).HasMaxLength(256);
        builder.HasIndex(x => new { x.SceneId, x.SceneVersionId, x.FlowKey, x.Deleted }).IsUnique();
        builder.HasIndex(x => new { x.TenantId, x.CustomerId, x.Enabled, x.Deleted });
        builder.HasOne(x => x.Scene).WithMany(x => x.ActionFlows).HasForeignKey(x => x.SceneId).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.SceneVersion).WithMany(x => x.ActionFlows).HasForeignKey(x => x.SceneVersionId).OnDelete(DeleteBehavior.Restrict);
        DigitalTwinConfiguration.ConfigureCommonScope(builder);
    }
}

public sealed class TwinActionFlowRunConfiguration : IEntityTypeConfiguration<TwinActionFlowRun>
{
    public void Configure(EntityTypeBuilder<TwinActionFlowRun> builder)
    {
        builder.HasKey(x => x.Id);
        builder.Property(x => x.IdempotencyKey).HasMaxLength(256).IsRequired();
        builder.Property(x => x.Status).HasConversion<string>().HasMaxLength(64);
        builder.Property(x => x.GraphHash).HasMaxLength(128).IsRequired();
        builder.Property(x => x.CompiledPlanHash).HasMaxLength(128).IsRequired();
        builder.Property(x => x.FaultCode).HasMaxLength(128);
        builder.Property(x => x.FaultMessage).HasMaxLength(4000);
        builder.Property(x => x.CreatedBy).HasMaxLength(256);
        builder.Property(x => x.UpdatedBy).HasMaxLength(256);
        builder.Property(x => x.ConcurrencyVersion).IsConcurrencyToken();
        builder.HasIndex(x => new { x.TenantId, x.CustomerId, x.IdempotencyKey, x.Deleted }).IsUnique();
        builder.HasIndex(x => new { x.SceneId, x.Status, x.UpdatedAt, x.Deleted });
        builder.HasOne(x => x.Scene).WithMany().HasForeignKey(x => x.SceneId).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.SceneVersion).WithMany().HasForeignKey(x => x.SceneVersionId).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.ActionFlow).WithMany().HasForeignKey(x => x.ActionFlowId).OnDelete(DeleteBehavior.Restrict);
        DigitalTwinConfiguration.ConfigureCommonScope(builder);
    }
}

public sealed class TwinActionFlowRunStepConfiguration : IEntityTypeConfiguration<TwinActionFlowRunStep>
{
    public void Configure(EntityTypeBuilder<TwinActionFlowRunStep> builder)
    {
        builder.HasKey(x => x.Id);
        builder.Property(x => x.StepInstanceId).HasMaxLength(256).IsRequired();
        builder.Property(x => x.NodeId).HasMaxLength(256).IsRequired();
        builder.Property(x => x.Status).HasConversion<string>().HasMaxLength(64);
        builder.Property(x => x.ErrorCode).HasMaxLength(128);
        builder.Property(x => x.ErrorMessage).HasMaxLength(4000);
        builder.Property(x => x.CreatedBy).HasMaxLength(256);
        builder.Property(x => x.UpdatedBy).HasMaxLength(256);
        builder.HasIndex(x => new { x.RunId, x.StepInstanceId, x.Deleted }).IsUnique();
        builder.HasIndex(x => new { x.RunId, x.Status, x.UpdatedAt, x.Deleted });
        builder.HasOne(x => x.Run).WithMany(x => x.Steps).HasForeignKey(x => x.RunId).OnDelete(DeleteBehavior.Restrict);
        DigitalTwinConfiguration.ConfigureCommonScope(builder);
    }
}

public sealed class TwinActionFlowEventConfiguration : IEntityTypeConfiguration<TwinActionFlowEvent>
{
    public void Configure(EntityTypeBuilder<TwinActionFlowEvent> builder)
    {
        builder.HasKey(x => x.Id);
        builder.Property(x => x.EventType).HasMaxLength(128).IsRequired();
        builder.Property(x => x.NodeId).HasMaxLength(256);
        builder.Property(x => x.StepInstanceId).HasMaxLength(256);
        builder.Property(x => x.CorrelationId).HasMaxLength(256).IsRequired();
        builder.Property(x => x.Source).HasMaxLength(128).IsRequired();
        builder.HasIndex(x => new { x.RunId, x.Sequence }).IsUnique();
        builder.HasIndex(x => new { x.TenantId, x.CustomerId, x.OccurredAt });
        builder.HasOne(x => x.Run).WithMany(x => x.Events).HasForeignKey(x => x.RunId).OnDelete(DeleteBehavior.Restrict);
        DigitalTwinConfiguration.ConfigureCommonScope(builder);
    }
}

public sealed class TwinDeviceCommandConfiguration : IEntityTypeConfiguration<TwinDeviceCommand>
{
    public void Configure(EntityTypeBuilder<TwinDeviceCommand> builder)
    {
        builder.HasKey(x => x.Id);
        builder.Property(x => x.CommandId).HasMaxLength(256).IsRequired();
        builder.Property(x => x.CorrelationId).HasMaxLength(256).IsRequired();
        builder.Property(x => x.BindingKey).HasMaxLength(256).IsRequired();
        builder.Property(x => x.PayloadHash).HasMaxLength(128).IsRequired();
        builder.Property(x => x.DeviceCycleId).HasMaxLength(256);
        builder.Property(x => x.Status).HasConversion<string>().HasMaxLength(64);
        builder.Property(x => x.LastError).HasMaxLength(4000);
        builder.Property(x => x.CreatedBy).HasMaxLength(256);
        builder.Property(x => x.UpdatedBy).HasMaxLength(256);
        builder.HasIndex(x => new { x.TenantId, x.CustomerId, x.CommandId, x.Deleted }).IsUnique();
        builder.HasIndex(x => new { x.RunId, x.Status, x.CreatedAt, x.Deleted });
        builder.HasOne(x => x.Run).WithMany().HasForeignKey(x => x.RunId).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.Step).WithMany().HasForeignKey(x => x.StepId).OnDelete(DeleteBehavior.Restrict);
        DigitalTwinConfiguration.ConfigureCommonScope(builder);
    }
}

public sealed class TwinResourceReservationConfiguration : IEntityTypeConfiguration<TwinResourceReservation>
{
    public void Configure(EntityTypeBuilder<TwinResourceReservation> builder)
    {
        builder.HasKey(x => x.Id);
        builder.Property(x => x.ReservationId).HasMaxLength(256).IsRequired();
        builder.Property(x => x.ResourceType).HasMaxLength(64).IsRequired();
        builder.Property(x => x.ResourceId).HasMaxLength(512).IsRequired();
        builder.Property(x => x.Status).HasConversion<string>().HasMaxLength(64);
        builder.Property(x => x.CreatedBy).HasMaxLength(256);
        builder.Property(x => x.UpdatedBy).HasMaxLength(256);
        builder.Property(x => x.Revision).IsConcurrencyToken();
        builder.HasIndex(x => new { x.TenantId, x.CustomerId, x.ReservationId, x.Deleted }).IsUnique();
        // Only one active lease per resource is enforced transactionally by the reservation service.
        builder.HasIndex(x => new { x.TenantId, x.CustomerId, x.ResourceType, x.ResourceId, x.Status, x.LeaseUntil, x.Deleted });
        builder.HasOne(x => x.OwnerRun).WithMany().HasForeignKey(x => x.OwnerRunId).OnDelete(DeleteBehavior.Restrict);
        builder.HasOne(x => x.OwnerStep).WithMany().HasForeignKey(x => x.OwnerStepId).OnDelete(DeleteBehavior.Restrict);
        DigitalTwinConfiguration.ConfigureCommonScope(builder);
    }
}

public sealed class TwinMaterialRuntimeConfiguration : IEntityTypeConfiguration<TwinMaterialRuntime>
{
    public void Configure(EntityTypeBuilder<TwinMaterialRuntime> builder)
    {
        builder.HasKey(x => x.Id);
        builder.Property(x => x.MaterialInstanceId).HasMaxLength(256).IsRequired();
        builder.Property(x => x.TransportUnitId).HasMaxLength(256);
        builder.Property(x => x.MaterialType).HasMaxLength(128);
        builder.Property(x => x.OwnerType).HasMaxLength(64).IsRequired();
        builder.Property(x => x.OwnerId).HasMaxLength(512).IsRequired();
        builder.Property(x => x.PoseSource).HasMaxLength(64).IsRequired();
        builder.Property(x => x.Status).HasConversion<string>().HasMaxLength(64);
        builder.Property(x => x.CreatedBy).HasMaxLength(256);
        builder.Property(x => x.UpdatedBy).HasMaxLength(256);
        builder.Property(x => x.Revision).IsConcurrencyToken();
        builder.HasIndex(x => new { x.SceneId, x.MaterialInstanceId, x.Deleted }).IsUnique();
        builder.HasIndex(x => new { x.TenantId, x.CustomerId, x.TransportUnitId, x.Deleted });
        builder.HasOne(x => x.Scene).WithMany().HasForeignKey(x => x.SceneId).OnDelete(DeleteBehavior.Restrict);
        DigitalTwinConfiguration.ConfigureCommonScope(builder);
    }
}
