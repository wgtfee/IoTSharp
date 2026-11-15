using System;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;

namespace IoTSharp.Data;

/// <summary>Committed in the same transaction as the P1 risk transition; never sent from an ingest hot path.</summary>
public sealed class PdmIntegrationOutbox
{
    public Guid EventId { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid CustomerId { get; set; }
    public string SourceEventKey { get; set; } = "";
    public long SourceSequence { get; set; }
    public string EventType { get; set; } = "";
    public string PayloadJson { get; set; } = "";
    public string DeliveryStatus { get; set; } = "Pending";
    public int AttemptCount { get; set; }
    public DateTime NextAttemptAtUtc { get; set; } = DateTime.UtcNow;
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
    public DateTime? DeliveredAtUtc { get; set; }
    public string? LastErrorCode { get; set; }
}

public sealed class PdmIntegrationOutboxConfiguration : IEntityTypeConfiguration<PdmIntegrationOutbox>
{
    public void Configure(EntityTypeBuilder<PdmIntegrationOutbox> b)
    {
        b.ToTable("PdmIntegrationOutbox");
        b.HasKey(x => x.EventId);
        b.Property(x => x.SourceEventKey).HasMaxLength(128).IsRequired();
        b.Property(x => x.EventType).HasMaxLength(40).IsRequired();
        b.Property(x => x.DeliveryStatus).HasMaxLength(32).IsRequired();
        b.Property(x => x.PayloadJson).IsRequired();
        b.Property(x => x.LastErrorCode).HasMaxLength(80);
        b.HasIndex(x => new { x.TenantId, x.CustomerId, x.SourceEventKey, x.SourceSequence }).IsUnique();
        b.HasIndex(x => new { x.DeliveryStatus, x.NextAttemptAtUtc });
    }
}
