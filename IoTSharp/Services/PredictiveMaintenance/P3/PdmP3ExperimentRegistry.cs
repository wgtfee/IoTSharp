using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using IoTSharp.Services.PredictiveMaintenance.P2;
using Microsoft.EntityFrameworkCore;

namespace IoTSharp.Services.PredictiveMaintenance.P3;

public sealed class PdmP3ExperimentDbContext(
    DbContextOptions<PdmP3ExperimentDbContext> options) : DbContext(options)
{
    public DbSet<PdmP3ExperimentEntry> Experiments => Set<PdmP3ExperimentEntry>();
    public DbSet<PdmP3ExperimentAudit> Audits => Set<PdmP3ExperimentAudit>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        var e=builder.Entity<PdmP3ExperimentEntry>();
        e.ToTable("PdmP3Experiment");
        e.HasKey(x=>x.Id);
        e.Property(x=>x.Fingerprint).HasMaxLength(64).IsRequired();
        e.Property(x=>x.DatasetSha256).HasMaxLength(64).IsRequired();
        e.Property(x=>x.ReplaySha256).HasMaxLength(64).IsRequired();
        e.Property(x=>x.CodeSha256).HasMaxLength(64).IsRequired();
        e.Property(x=>x.AlgorithmVersion).HasMaxLength(80).IsRequired();
        e.Property(x=>x.State).HasMaxLength(32).IsRequired();
        e.Property(x=>x.Revision).IsConcurrencyToken();
        e.Property(x=>x.CreatedAtUtc).HasConversion(
            v=>v,v=>DateTime.SpecifyKind(v,DateTimeKind.Utc));
        e.Property(x=>x.ReviewedAtUtc).HasConversion(
            v=>v,v=>v.HasValue?DateTime.SpecifyKind(v.Value,DateTimeKind.Utc):null);
        e.HasIndex(x=>new{x.TenantId,x.CustomerId,x.Fingerprint}).IsUnique();
        e.HasIndex(x=>new{x.TenantId,x.CustomerId,x.DeviceId,x.CreatedAtUtc});
        var a=builder.Entity<PdmP3ExperimentAudit>();
        a.ToTable("PdmP3ExperimentAudit");
        a.HasKey(x=>x.Id);
        a.Property(x=>x.Action).HasMaxLength(40).IsRequired();
        a.Property(x=>x.Reason).HasMaxLength(512).IsRequired();
        a.Property(x=>x.AtUtc).HasConversion(
            v=>v,v=>DateTime.SpecifyKind(v,DateTimeKind.Utc));
        a.HasIndex(x=>new{x.TenantId,x.CustomerId,x.ExperimentId,x.AtUtc});
        a.HasOne<PdmP3ExperimentEntry>().WithMany().HasForeignKey(x=>x.ExperimentId)
            .OnDelete(DeleteBehavior.Restrict);
    }
}

public sealed class PdmP3ExperimentEntry
{
    public Guid Id {get;set;}=Guid.NewGuid();
    public Guid TenantId {get;set;}
    public Guid CustomerId {get;set;}
    public Guid DeviceId {get;set;}
    public Guid ProfileId {get;set;}
    public int ProfileVersion {get;set;}
    public string Fingerprint {get;set;}="";
    public string DatasetSha256 {get;set;}="";
    public string ReplaySha256 {get;set;}="";
    public string CodeSha256 {get;set;}="";
    public string AlgorithmVersion {get;set;}="";
    public int TrainingRows {get;set;}
    public int HoldoutRows {get;set;}
    public int EvaluatedSamples {get;set;}
    public int UnlabeledSamples {get;set;}
    public int AbstainedSamples {get;set;}
    public double? Precision {get;set;}
    public double? Recall {get;set;}
    public string State {get;set;}="Candidate";
    public int Revision {get;set;}=1;
    public Guid CreatedBy {get;set;}
    public Guid? ReviewedBy {get;set;}
    public DateTime CreatedAtUtc {get;set;}
    public DateTime? ReviewedAtUtc {get;set;}
}

public sealed class PdmP3ExperimentAudit
{
    public Guid Id {get;set;}=Guid.NewGuid();
    public Guid TenantId {get;set;}
    public Guid CustomerId {get;set;}
    public Guid ExperimentId {get;set;}
    public Guid ActorId {get;set;}
    public string Action {get;set;}="";
    public string Reason {get;set;}="";
    public DateTime AtUtc {get;set;}
}

/// <summary>
/// Isolated audit-ready experiment registry. Never auto-register in Startup,
/// auto-publish to live worker, or reinterpret statistical metrics as failure
/// probability. A signed second reviewer approves only offline Shadow review.
/// </summary>
public sealed class PdmP3ExperimentRegistry(PdmP3ExperimentDbContext db)
{
    private static void Check(PdmP2TrustedActor actor,Guid tenant,Guid customer,bool reviewer)
    {
        if(!actor.IsAuthenticated || actor.UserId==Guid.Empty ||
            tenant==Guid.Empty || customer==Guid.Empty ||
            actor.TenantId!=tenant || actor.CustomerId!=customer ||
            (reviewer?!actor.CanReview:!actor.CanSubmitDraft))
            throw new UnauthorizedAccessException("实验归档身份、作用域或人工角色未核验");
    }

    private static bool ValidSha(string s) => s is {Length:64} && s.All(char.IsAsciiHexDigit);

    public async Task<PdmP3ExperimentEntry> RegisterAsync(
        PdmP3SeriesScope scope,PdmP3OfflineReplayRun run,
        string algorithmVersion,string codeSha256,PdmP2TrustedActor author,
        CancellationToken ct=default)
    {
        ArgumentNullException.ThrowIfNull(scope);
        ArgumentNullException.ThrowIfNull(run);
        Check(author,scope.TenantId,scope.CustomerId,false);
        if(scope.DeviceId==Guid.Empty || scope.ProfileId==Guid.Empty ||
            scope.ProfileVersion<1 ||
            string.IsNullOrWhiteSpace(scope.PointKey) ||
            string.IsNullOrWhiteSpace(scope.EngineeringUnit) ||
            string.IsNullOrWhiteSpace(scope.OperatingMode) ||
            scope.PointKey.Length>128 || scope.EngineeringUnit.Length>32 ||
            scope.OperatingMode.Length>64 || !scope.MappingVerified ||
            !scope.UnitVerified || !scope.OperatingModeVerified ||
            string.IsNullOrWhiteSpace(algorithmVersion) ||
            algorithmVersion.Length>80 || !ValidSha(codeSha256) ||
            !ValidSha(run.InputSha256) || !ValidSha(run.Metrics.ReproducibilitySha256) ||
            run.TrainingRows<5 || run.HoldoutRows<1 ||
            run.Predictions is null ||
            run.HoldoutRows!=run.Predictions.Count ||
            run.Predictions.Any(p=>p is null || p.Scope!=scope ||
                p.AtUtc is null || p.AtUtc.Value.Offset!=TimeSpan.Zero ||
                (p.RobustDeviationScore.HasValue &&
                 (!double.IsFinite(p.RobustDeviationScore.Value) || p.RobustDeviationScore<0))) ||
            run.Metrics.EvaluatedSamples < 0 ||
            run.Metrics.UnlabeledSamples<0 || run.Metrics.AbstainedSamples<0 ||
            run.Metrics.EvaluatedSamples+run.Metrics.UnlabeledSamples+
                run.Metrics.AbstainedSamples != run.HoldoutRows ||
            run.Metrics.TruePositive<0 || run.Metrics.FalsePositive<0 ||
            run.Metrics.FalseNegative<0 || run.Metrics.TrueNegative<0 ||
            run.Metrics.TruePositive+run.Metrics.FalsePositive+
                run.Metrics.FalseNegative+run.Metrics.TrueNegative !=
                run.Metrics.EvaluatedSamples ||
            run.IsProductionModel || run.UsedFutureLabelsForDetection)
            throw new InvalidOperationException("实验版本或离线来源及留出结果不可信");
        var precision=run.Metrics.Precision; var recall=run.Metrics.Recall;
        if(run.Metrics.HasTrustedGroundTruth !=
           (run.Metrics.EvaluatedSamples>0))
            throw new InvalidOperationException("真实标签计数与可信度状态不一致");
        if(!run.Metrics.HasTrustedGroundTruth &&
            (run.Metrics.EvaluatedSamples!=0 || precision!=null || recall!=null))
            throw new InvalidOperationException("无人工标签不得报告准确率或召回率");
        if((precision.HasValue && (!double.IsFinite(precision.Value) ||
                precision.Value is <0 or >1)) ||
           (recall.HasValue && (!double.IsFinite(recall.Value) ||
                recall.Value is <0 or >1)))
            throw new InvalidOperationException("模型评测指标越界");
        double? expectedPrecision=run.Metrics.TruePositive+run.Metrics.FalsePositive>0
            ? (double)run.Metrics.TruePositive/
                (run.Metrics.TruePositive+run.Metrics.FalsePositive) : null;
        double? expectedRecall=run.Metrics.TruePositive+run.Metrics.FalseNegative>0
            ? (double)run.Metrics.TruePositive/
                (run.Metrics.TruePositive+run.Metrics.FalseNegative) : null;
        if(precision!=expectedPrecision || recall!=expectedRecall)
            throw new InvalidOperationException("精确率/召回率与人工核验混淆矩阵不一致");
        // Immutable identity includes all evaluation and source inputs, not machine clock.
        var canonical=string.Join("|","p3-offline-experiment-v1",
            scope.TenantId.ToString("N"),scope.CustomerId.ToString("N"),
            scope.DeviceId.ToString("N"),scope.ProfileId.ToString("N"),
            scope.ProfileVersion,scope.PointKey,scope.EngineeringUnit,
            scope.OperatingMode,run.InputSha256,run.Metrics.ReproducibilitySha256,
            algorithmVersion,codeSha256.ToLowerInvariant());
        var fingerprint=Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(canonical))).ToLowerInvariant();
        if(await db.Experiments.AsNoTracking().AnyAsync(e=>
            e.TenantId==scope.TenantId && e.CustomerId==scope.CustomerId &&
            e.Fingerprint==fingerprint,ct))
            throw new InvalidOperationException("同样输入与算法的实验已经登记，不重复记录");
        var now=DateTime.UtcNow;
        var entry=new PdmP3ExperimentEntry
        {
            TenantId=scope.TenantId,CustomerId=scope.CustomerId,DeviceId=scope.DeviceId,
            ProfileId=scope.ProfileId,ProfileVersion=scope.ProfileVersion,
            Fingerprint=fingerprint, DatasetSha256=run.InputSha256.ToLowerInvariant(),
            ReplaySha256=run.Metrics.ReproducibilitySha256.ToLowerInvariant(),
            CodeSha256=codeSha256.ToLowerInvariant(),AlgorithmVersion=algorithmVersion,
            TrainingRows=run.TrainingRows,HoldoutRows=run.HoldoutRows,
            EvaluatedSamples=run.Metrics.EvaluatedSamples,
            UnlabeledSamples=run.Metrics.UnlabeledSamples,
            AbstainedSamples=run.Metrics.AbstainedSamples,
            Precision=precision,Recall=recall,CreatedBy=author.UserId,CreatedAtUtc=now
        };
        await using var tx=await db.Database.BeginTransactionAsync(ct);
        db.Experiments.Add(entry);
        db.Audits.Add(new PdmP3ExperimentAudit {
            TenantId=scope.TenantId,CustomerId=scope.CustomerId,
            ExperimentId=entry.Id,ActorId=author.UserId,Action="CandidateRecorded",
            Reason="离线实验归档，不允许自动激活生产推理",AtUtc=now
        });
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return entry;
    }

    public async Task<PdmP3ExperimentEntry> ReviewShadowAsync(
        Guid id,int expectedRevision,string reason,
        PdmP2TrustedActor reviewer,CancellationToken ct=default)
    {
        Check(reviewer,reviewer.TenantId,reviewer.CustomerId,true);
        if(id==Guid.Empty || expectedRevision<1 ||
            string.IsNullOrWhiteSpace(reason) || reason.Length>512)
            throw new ArgumentException("实验审核必须带明确版本及理由");
        var entry=await db.Experiments.SingleOrDefaultAsync(e=>e.Id==id &&
            e.TenantId==reviewer.TenantId && e.CustomerId==reviewer.CustomerId,ct)
            ??throw new UnauthorizedAccessException("实验记录不在当前租户/客户范围");
        if(entry.CreatedBy==reviewer.UserId)
            throw new UnauthorizedAccessException("作者不能自行批准实验");
        if(entry.State!="Candidate" || entry.Revision!=expectedRevision)
            throw new DbUpdateConcurrencyException("实验审批版本冲突");
        // Shadow review is permitted without labeled metrics, but that is
        // NOT permission to present predictive fault accuracy or enter production.
        entry.State="ReviewedForOfflineShadow";
        entry.Revision++;entry.ReviewedBy=reviewer.UserId;entry.ReviewedAtUtc=DateTime.UtcNow;
        db.Audits.Add(new PdmP3ExperimentAudit {
            TenantId=entry.TenantId,CustomerId=entry.CustomerId,
            ExperimentId=entry.Id,ActorId=reviewer.UserId,Action=entry.State,
            Reason=reason,AtUtc=entry.ReviewedAtUtc.Value
        });
        await using var tx=await db.Database.BeginTransactionAsync(ct);
        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);
        return entry;
    }
}

