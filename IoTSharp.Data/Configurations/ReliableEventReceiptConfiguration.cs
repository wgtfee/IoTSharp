using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace IoTSharp.Data.Configurations;

public sealed class ReliableEventReceiptConfiguration : IEntityTypeConfiguration<ReliableEventReceipt>
{
    public void Configure(EntityTypeBuilder<ReliableEventReceipt> builder)
    {
        builder.ToTable("ReliableEventReceipts");
        builder.HasKey(item => item.Id);
        builder.Property(item => item.EventId).HasMaxLength(128).IsRequired();
        builder.Property(item => item.EventType).HasMaxLength(64).IsRequired();
        builder.Property(item => item.PayloadHash).HasMaxLength(64).IsRequired();
        builder.Property(item => item.Payload).IsRequired();
        builder.Property(item => item.Status).HasMaxLength(32).IsRequired();
        builder.Property(item => item.LastError).HasMaxLength(2048);
        builder.HasIndex(item => new { item.GatewayId, item.EventId }).IsUnique();
        builder.HasIndex(item => new { item.GatewayId, item.ReceivedAt });
        builder.HasIndex(item => new { item.Status, item.ReceivedAt });
    }
}
