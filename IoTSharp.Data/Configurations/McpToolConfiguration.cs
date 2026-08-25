using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace IoTSharp.Data.Configurations;

public sealed class McpToolDefinitionConfiguration : IEntityTypeConfiguration<McpToolDefinition>
{
    public void Configure(EntityTypeBuilder<McpToolDefinition> builder)
    {
        builder.HasKey(item => item.Id);
        builder.Property(item => item.Name).HasMaxLength(64).IsRequired();
        builder.Property(item => item.Title).HasMaxLength(128).IsRequired();
        builder.Property(item => item.Description).HasMaxLength(2048).IsRequired();
        builder.Property(item => item.HandlerType).HasMaxLength(32).IsRequired();
        builder.Property(item => item.InputSchemaJson).IsRequired();
        builder.Property(item => item.HttpMethod).HasMaxLength(16).IsRequired();
        builder.Property(item => item.EndpointTemplate).HasMaxLength(2048).IsRequired();
        builder.Property(item => item.CreatedBy).HasMaxLength(256);
        builder.Property(item => item.UpdatedBy).HasMaxLength(256);
        builder.HasIndex(item => new { item.AISettingsId, item.Name, item.Deleted }).IsUnique();
        builder.HasIndex(item => new { item.AISettingsId, item.Enabled, item.Deleted });
        builder.HasOne(item => item.AISettings)
            .WithMany(item => item.McpTools)
            .HasForeignKey(item => item.AISettingsId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}

public sealed class McpToolInvocationLogConfiguration : IEntityTypeConfiguration<McpToolInvocationLog>
{
    public void Configure(EntityTypeBuilder<McpToolInvocationLog> builder)
    {
        builder.HasKey(item => item.Id);
        builder.Property(item => item.ToolName).HasMaxLength(64).IsRequired();
        builder.Property(item => item.InvocationSource).HasMaxLength(32).IsRequired();
        builder.Property(item => item.ArgumentKeys).HasMaxLength(2048);
        builder.Property(item => item.ErrorMessage).HasMaxLength(4000);
        builder.HasIndex(item => new { item.AISettingsId, item.StartedAt });
        builder.HasIndex(item => new { item.ToolDefinitionId, item.StartedAt });
        builder.HasOne(item => item.ToolDefinition)
            .WithMany(item => item.Invocations)
            .HasForeignKey(item => item.ToolDefinitionId)
            .OnDelete(DeleteBehavior.Cascade);
    }
}
