using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.EntityFrameworkCore;

namespace IoTSharp.Services.PredictiveMaintenance.P3;

/// <summary>
/// Isolated offline-label database, NOT registered with production Startup.
/// Persist only source case references and independent reviewer evidence.
/// </summary>
public sealed class PdmP3FaultCaseDbContext(
    DbContextOptions<PdmP3FaultCaseDbContext> options) : DbContext(options)
{
    public DbSet<PdmP3FaultCase> Cases => Set<PdmP3FaultCase>();
    public DbSet<PdmP3FaultCaseAudit> Audits => Set<PdmP3FaultCaseAudit>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        var c=modelBuilder.Entity<PdmP3FaultCase>();
        c.ToTable("PdmP3FaultCase");
        c.HasKey(x=>x.Id);
        c.Property(x=>x.PointKey).HasMaxLength(128).IsRequired();
        c.Property(x=>x.EngineeringUnit).HasMaxLength(32).IsRequired();
        c.Property(x=>x.OperatingMode).HasMaxLength(64).IsRequired();
        c.Property(x=>x.CaseReference).HasMaxLength(160).IsRequired();
        c.Property(x=>x.EvidenceReference).HasMaxLength(160).IsRequired();
        c.Property(x=>x.State).HasMaxLength(40).IsRequired();
        c.Property(x=>x.Revision).IsConcurrencyToken();
        c.Property(x=>x.EventTimeUtc).HasConversion(
            v=>v,v=>DateTime.SpecifyKind(v,DateTimeKind.Utc));
        c.Property(x=>x.SubmittedAtUtc).HasConversion(
            v=>v,v=>DateTime.SpecifyKind(v,DateTimeKind.Utc));
        c.Property(x=>x.ReviewedAtUtc).HasConversion(
            v=>v,v=>v.HasValue?DateTime.SpecifyKind(v.Value,DateTimeKind.Utc):null);
        c.HasIndex(x=>new {
            x.TenantId,x.CustomerId,x.DeviceId,x.ProfileId,
            x.ProfileVersion,x.PointKey,x.EventTimeUtc
        }).IsUnique();
        var a=modelBuilder.Entity<PdmP3FaultCaseAudit>();
        a.ToTable("PdmP3FaultCaseAudit");
        a.HasKey(x=>x.Id);
        a.Property(x=>x.Action).HasMaxLength(40).IsRequired();
        a.Property(x=>x.Reason).HasMaxLength(512).IsRequired();
        a.Property(x=>x.AtUtc).HasConversion(
            v=>v,v=>DateTime.SpecifyKind(v,DateTimeKind.Utc));
        a.HasIndex(x=>new {x.TenantId,x.CustomerId,x.CaseId,x.AtUtc});
        a.HasOne<PdmP3FaultCase>().WithMany().HasForeignKey(x=>x.CaseId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class PdmP3FaultCase
{
    public Guid Id {get;set;}=Guid.NewGuid();
    public Guid TenantId {get;set;}
    public Guid CustomerId {get;set;}
    public Guid DeviceId {get;set;}
    public Guid ProfileId {get;set;}
    public int ProfileVersion {get;set;}
    public string PointKey {get;set;}="";
    public string EngineeringUnit {get;set;}="";
    public string OperatingMode {get;set;}="";
    public DateTime EventTimeUtc {get;set;}
    public string CaseReference {get;set;}="";
    public string EvidenceReference {get;set;}="";
    public string State {get;set;}="PendingReview";
    public int Revision {get;set;}=1;
    public Guid SubmittedBy {get;set;}
    public DateTime SubmittedAtUtc {get;set;}
    public Guid? ReviewedBy {get;set;}
    public DateTime? ReviewedAtUtc {get;set;}
}

public sealed class PdmP3FaultCaseAudit
{
    public Guid Id {get;set;}=Guid.NewGuid();
    public Guid TenantId {get;set;}
    public Guid CustomerId {get;set;}
    public Guid CaseId {get;set;}
    public Guid ActorId {get;set;}
    public string Action {get;set;}="";
    public string Reason {get;set;}="";
    public DateTime AtUtc {get;set;}
}

/// <summary>
/// Human-in-the-loop fault truth. Submission/independent verification is
/// transactional, explicitly scoped and versioned. Never inferred from P1/P2
/// risk events and never connected to production business DB by default.
/// </summary>
public sealed class PdmP3FaultCaseLedger(PdmP3FaultCaseDbContext db)
{
    private static void CheckActor(PdmP2TrustedActor actor, Guid tenant,
        Guid customer, bool reviewer)
    {
        if(!actor.IsAuthenticated || actor.UserId==Guid.Empty ||
           actor.TenantId!=tenant || actor.CustomerId!=customer ||
           tenant==Guid.Empty || customer==Guid.Empty ||
           (reviewer ? !actor.CanReview : !actor.CanSubmitDraft))
            throw new UnauthorizedAccessException("故障标签的身份、租户或审核角色不可信");
    }

    public async Task<PdmP3FaultCase> SubmitAsync(PdmP3SeriesScope scope,
        DateTimeOffset eventTimeUtc,string caseReference,string evidenceReference,
        PdmP2TrustedActor actor,CancellationToken ct=default)
    {
        ArgumentNullException.ThrowIfNull(scope);
        CheckActor(actor,scope.TenantId,scope.CustomerId,false);
        if (eventTimeUtc.Offset!=TimeSpan.Zero || eventTimeUtc.Year<2000 ||
            scope.DeviceId==Guid.Empty || scope.ProfileId==Guid.Empty ||
            scope.ProfileVersion<1 ||
            !scope.MappingVerified || !scope.UnitVerified || !scope.OperatingModeVerified ||
            string.IsNullOrWhiteSpace(scope.PointKey) || scope.PointKey.Length>128 ||
            string.IsNullOrWhiteSpace(scope.EngineeringUnit) || scope.EngineeringUnit.Length>32 ||
            string.IsNullOrWhiteSpace(scope.OperatingMode) || scope.OperatingMode.Length>64 ||
            string.IsNullOrWhiteSpace(caseReference) || caseReference.Length>160 ||
            string.IsNullOrWhiteSpace(evidenceReference) || evidenceReference.Length>160)
            throw new InvalidOperationException("故障 Case 时间、单位、点位或证据没有核验");
        var eventUtc=eventTimeUtc.UtcDateTime;
        var existing=await db.Cases.AsNoTracking().AnyAsync(c=>
            c.TenantId==scope.TenantId && c.CustomerId==scope.CustomerId &&
            c.DeviceId==scope.DeviceId && c.ProfileId==scope.ProfileId &&
            c.ProfileVersion==scope.ProfileVersion && c.PointKey==scope.PointKey &&
            c.EventTimeUtc==eventUtc,ct);
        if(existing) throw new InvalidOperationException("同设备点位、版本、UTC事件时间已经存在故障核验 Case");
        var now=DateTime.UtcNow;
        var item=new PdmP3FaultCase
        {
            TenantId=scope.TenantId, CustomerId=scope.CustomerId,
            DeviceId=scope.DeviceId, ProfileId=scope.ProfileId,
            ProfileVersion=scope.ProfileVersion, PointKey=scope.PointKey,
            EngineeringUnit=scope.EngineeringUnit, OperatingMode=scope.OperatingMode,
            EventTimeUtc=eventUtc, CaseReference=caseReference,
            EvidenceReference=evidenceReference, SubmittedBy=actor.UserId,
            SubmittedAtUtc=now
        };
        await using var tx=await db.Database.BeginTransactionAsync(ct);
        db.Cases.Add(item);
        db.Audits.Add(new PdmP3FaultCaseAudit {
            TenantId=item.TenantId,CustomerId=item.CustomerId,CaseId=item.Id,
            ActorId=actor.UserId,Action="Submitted",Reason="仅作为待复核样本，不构成故障标签",
            AtUtc=now
        });
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return item;
    }

    public async Task<PdmP3FaultCase> VerifyAsync(Guid caseId,int expectedRevision,
        PdmP3FaultTruth truth,string reason,PdmP2TrustedActor actor,
        CancellationToken ct=default)
    {
        CheckActor(actor,actor.TenantId,actor.CustomerId,true);
        if(caseId==Guid.Empty || expectedRevision<1 ||
           truth is not (PdmP3FaultTruth.ConfirmedFault or PdmP3FaultTruth.ConfirmedNormal) ||
           string.IsNullOrWhiteSpace(reason) || reason.Length>512)
            throw new ArgumentException("独立审核需要确认正常或真实故障及理由");
        var item=await db.Cases.SingleOrDefaultAsync(c=>
            c.Id==caseId && c.TenantId==actor.TenantId &&
            c.CustomerId==actor.CustomerId,ct)
            ?? throw new UnauthorizedAccessException("无权访问此故障 Case");
        if(item.SubmittedBy==actor.UserId)
            throw new UnauthorizedAccessException("提交人不得自己核验故障标签");
        if(item.State!="PendingReview" || item.Revision!=expectedRevision)
            throw new DbUpdateConcurrencyException("故障标签已核验或版本冲突");
        var now=DateTime.UtcNow;
        if(item.EventTimeUtc>now) throw new InvalidOperationException("未来发生的故障不能被提前核验");
        item.State=truth==PdmP3FaultTruth.ConfirmedFault?"ConfirmedFault":"ConfirmedNormal";
        item.Revision++;
        item.ReviewedBy=actor.UserId; item.ReviewedAtUtc=now;
        db.Audits.Add(new PdmP3FaultCaseAudit {
            TenantId=item.TenantId,CustomerId=item.CustomerId,CaseId=item.Id,
            ActorId=actor.UserId,Action=item.State,Reason=reason,AtUtc=now
        });
        await using var tx=await db.Database.BeginTransactionAsync(ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return item;
    }

    public async Task<IReadOnlyList<PdmP3FaultLabel>> GetVerifiedLabelsAsync(
        PdmP3SeriesScope scope,DateTimeOffset asOfUtc,
        PdmP2TrustedActor actor,CancellationToken ct=default)
    {
        ArgumentNullException.ThrowIfNull(scope);
        CheckActor(actor,scope.TenantId,scope.CustomerId,false);
        if(asOfUtc.Offset!=TimeSpan.Zero || asOfUtc.Year<2000)
            throw new ArgumentException("需要可信 UTC as-of");
        var maxTime=asOfUtc.UtcDateTime;
        var rows=await db.Cases.AsNoTracking()
            .Where(c=>c.TenantId==scope.TenantId &&
                c.CustomerId==scope.CustomerId && c.DeviceId==scope.DeviceId &&
                c.ProfileId==scope.ProfileId && c.ProfileVersion==scope.ProfileVersion &&
                c.PointKey==scope.PointKey &&
                c.EngineeringUnit==scope.EngineeringUnit &&
                c.OperatingMode==scope.OperatingMode &&
                c.ReviewedAtUtc!=null && c.ReviewedAtUtc<=maxTime &&
                (c.State=="ConfirmedFault" || c.State=="ConfirmedNormal"))
            .OrderBy(c=>c.EventTimeUtc).Take(501).ToListAsync(ct);
        if(rows.Count>500)
            throw new InvalidOperationException("已核验故障标签超出 500 条离线导出上限；不能静默截断作为完整标注集");
        return rows.Select(c=>new PdmP3FaultLabel(scope,
            new DateTimeOffset(c.EventTimeUtc,TimeSpan.Zero),
            new DateTimeOffset(c.ReviewedAtUtc!.Value,TimeSpan.Zero),
            c.State=="ConfirmedFault"?PdmP3FaultTruth.ConfirmedFault:
                PdmP3FaultTruth.ConfirmedNormal,
            c.CaseReference,c.ReviewedBy!.Value.ToString("N"))).ToArray();
    }
}

