using System;
using Microsoft.EntityFrameworkCore;

namespace IoTSharp.Services.PredictiveMaintenance.P2;

/// <summary>
/// IoTSharp-owned repair order, not an external maintenance system ticket.
/// Separate, versioned PdM SQL Server database. Never mapped in ApplicationDbContext.
/// </summary>
public sealed class PdmInternalWorkOrder
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid CustomerId { get; set; }
    public Guid DeviceId { get; set; }
    public Guid ProfileId { get; set; }
    public int ProfileVersion { get; set; }
    public Guid RiskEventId { get; set; }
    public string WorkOrderNo { get; set; } = "";
    public string RiskLevel { get; set; } = "Warning";
    public string Title { get; set; } = "";
    public string Description { get; set; } = "";
    public string State { get; set; } = "Open";
    public Guid? AssignedTo { get; set; }
    public string Resolution { get; set; } = "";
    public int Revision { get; set; } = 1;
    public DateTime FirstObservedUtc { get; set; }
    public DateTime CreatedAtUtc { get; set; }
    public DateTime UpdatedAtUtc { get; set; }
    public DateTime? CompletedAtUtc { get; set; }
    public DateTime? ClosedAtUtc { get; set; }
}

/// <summary>
/// Durable Feishu notification request. Pending is not delivered; an uncertain
/// attempt must become OutcomeUnknown and MUST NOT be retried without review.
/// </summary>
public sealed class PdmInternalWorkOrderNotification
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid CustomerId { get; set; }
    public Guid WorkOrderId { get; set; }
    public string DeliveryKey { get; set; } = "";
    public string Channel { get; set; } = "feishu";
    public string State { get; set; } = "Pending";
    public Guid? ClaimedBy { get; set; }
    public DateTime? ClaimedAtUtc { get; set; }
    public DateTime? AcknowledgedAtUtc { get; set; }
    public string ExternalMessageFingerprint { get; set; } = "";
    public DateTime CreatedAtUtc { get; set; }
}

public sealed class PdmInternalWorkOrderAudit
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public Guid TenantId { get; set; }
    public Guid CustomerId { get; set; }
    public Guid WorkOrderId { get; set; }
    public Guid? ActorId { get; set; }
    public string Action { get; set; } = "";
    public string FromState { get; set; } = "";
    public string ToState { get; set; } = "";
    public string Reason { get; set; } = "";
    public DateTime AtUtc { get; set; }
}

/// <summary>
/// No automatic EF migrations or EnsureCreated. Standalone SQL script must
/// be reviewed and applied explicitly; disabled service adds zero DB IO.
/// </summary>
public sealed class PdmInternalWorkOrderDbContext(DbContextOptions<PdmInternalWorkOrderDbContext> options)
    : DbContext(options)
{
    public DbSet<PdmInternalWorkOrder> WorkOrders => Set<PdmInternalWorkOrder>();
    public DbSet<PdmInternalWorkOrderNotification> Notifications => Set<PdmInternalWorkOrderNotification>();
    public DbSet<PdmInternalWorkOrderAudit> Audits => Set<PdmInternalWorkOrderAudit>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        var order = builder.Entity<PdmInternalWorkOrder>();
        order.ToTable("PdmInternalWorkOrders");
        order.HasKey(x => x.Id);
        order.HasIndex(x => new { x.TenantId, x.CustomerId, x.RiskEventId }).IsUnique();
        order.HasIndex(x => new { x.TenantId, x.CustomerId, x.State, x.CreatedAtUtc });
        order.HasIndex(x => x.WorkOrderNo).IsUnique();
        order.Property(x => x.WorkOrderNo).HasMaxLength(40).IsRequired();
        order.Property(x => x.Title).HasMaxLength(240).IsRequired();
        order.Property(x => x.Description).HasMaxLength(2048).IsRequired();
        order.Property(x => x.RiskLevel).HasMaxLength(24).IsRequired();
        order.Property(x => x.State).HasMaxLength(24).IsRequired();
        order.Property(x => x.Resolution).HasMaxLength(2000).IsRequired();
        order.Property(x => x.Revision).IsConcurrencyToken();
        order.Property(x => x.FirstObservedUtc).HasConversion(
            value => value, value => DateTime.SpecifyKind(value, DateTimeKind.Utc));
        order.Property(x => x.CreatedAtUtc).HasConversion(
            value => value, value => DateTime.SpecifyKind(value, DateTimeKind.Utc));
        order.Property(x => x.UpdatedAtUtc).HasConversion(
            value => value, value => DateTime.SpecifyKind(value, DateTimeKind.Utc));
        order.Property(x => x.CompletedAtUtc).HasConversion(
            value => value, value => value.HasValue
                ? DateTime.SpecifyKind(value.Value, DateTimeKind.Utc) : (DateTime?)null);
        order.Property(x => x.ClosedAtUtc).HasConversion(
            value => value, value => value.HasValue
                ? DateTime.SpecifyKind(value.Value, DateTimeKind.Utc) : (DateTime?)null);

        var notification = builder.Entity<PdmInternalWorkOrderNotification>();
        notification.ToTable("PdmInternalWorkOrderNotifications");
        notification.HasKey(x => x.Id);
        notification.HasIndex(x => x.DeliveryKey).IsUnique();
        notification.HasIndex(x => new { x.TenantId, x.CustomerId, x.WorkOrderId }).IsUnique();
        notification.HasIndex(x => new { x.State, x.CreatedAtUtc });
        notification.Property(x => x.DeliveryKey).HasMaxLength(128).IsRequired();
        notification.Property(x => x.Channel).HasMaxLength(24).IsRequired();
        notification.Property(x => x.State).HasMaxLength(32).IsRequired();
        notification.Property(x => x.ExternalMessageFingerprint).HasMaxLength(64).IsRequired();
        notification.Property(x => x.CreatedAtUtc).HasConversion(
            value => value, value => DateTime.SpecifyKind(value, DateTimeKind.Utc));
        notification.Property(x => x.ClaimedAtUtc).HasConversion(
            value => value, value => value.HasValue
                ? DateTime.SpecifyKind(value.Value, DateTimeKind.Utc) : (DateTime?)null);
        notification.Property(x => x.AcknowledgedAtUtc).HasConversion(
            value => value, value => value.HasValue
                ? DateTime.SpecifyKind(value.Value, DateTimeKind.Utc) : (DateTime?)null);
        notification.HasOne<PdmInternalWorkOrder>().WithMany().HasForeignKey(x => x.WorkOrderId)
            .OnDelete(DeleteBehavior.Restrict);

        var audit = builder.Entity<PdmInternalWorkOrderAudit>();
        audit.ToTable("PdmInternalWorkOrderAudits");
        audit.HasKey(x => x.Id);
        audit.HasIndex(x => new { x.TenantId, x.CustomerId, x.WorkOrderId, x.AtUtc });
        audit.Property(x => x.Action).HasMaxLength(48).IsRequired();
        audit.Property(x => x.FromState).HasMaxLength(24).IsRequired();
        audit.Property(x => x.ToState).HasMaxLength(24).IsRequired();
        audit.Property(x => x.Reason).HasMaxLength(512).IsRequired();
        audit.Property(x => x.AtUtc).HasConversion(
            value => value, value => DateTime.SpecifyKind(value, DateTimeKind.Utc));
        audit.HasOne<PdmInternalWorkOrder>().WithMany().HasForeignKey(x => x.WorkOrderId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}
