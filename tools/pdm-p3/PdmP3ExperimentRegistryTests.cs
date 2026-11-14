using IoTSharp.Services.PredictiveMaintenance.P2;
using IoTSharp.Services.PredictiveMaintenance.P3;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace IoTSharp.PredictiveMaintenance.P3.Tests;

public sealed class PdmP3ExperimentRegistryTests
{
    private static PdmP2TrustedActor Author(PdmP3SeriesScope scope) =>
        new(scope.TenantId,scope.CustomerId,Guid.NewGuid(),true,true,false);
    private static PdmP2TrustedActor Reviewer(PdmP3SeriesScope scope) =>
        new(scope.TenantId,scope.CustomerId,Guid.NewGuid(),true,false,true);
    private static PdmP3OfflineReplayRun Run(PdmP3SeriesScope scope)
    {
        var samples=PdmP3Fixtures.Samples(scope,1,1,1,1,1,1,1,1,7,1);
        return PdmP3OfflineReplayRunner.Run(samples,Array.Empty<PdmP3FaultLabel>(),
            8,PdmP3Fixtures.Start.AddHours(4));
    }
    private static async Task<(SqliteConnection,PdmP3ExperimentDbContext)> Open()
    {
        var c=new SqliteConnection("Data Source=:memory:");
        await c.OpenAsync();
        var db=new PdmP3ExperimentDbContext(
            new DbContextOptionsBuilder<PdmP3ExperimentDbContext>()
                .UseSqlite(c).Options);
        await db.Database.EnsureCreatedAsync();
        return(c,db);
    }
    private const string CodeHash="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    [Fact]
    public async Task UnlabeledExperimentPersistsNullMetricsAndAnAuditNotAccuracy()
    {
        var(con,db)=await Open();
        await using(con) await using(db)
        {
            var scope=PdmP3Fixtures.Scope();var author=Author(scope);
            var registry=new PdmP3ExperimentRegistry(db);
            var item=await registry.RegisterAsync(scope,Run(scope),
                "robust-mad-v1",CodeHash,author);
            Assert.Equal("Candidate",item.State);
            Assert.Null(item.Precision);
            Assert.Null(item.Recall);
            Assert.Equal(0,item.EvaluatedSamples);
            Assert.True(item.UnlabeledSamples>0);
            Assert.Equal(64,item.Fingerprint.Length);
            Assert.Single(await db.Audits.ToListAsync());
            db.ChangeTracker.Clear();
            var stored=await db.Experiments.AsNoTracking().SingleAsync();
            Assert.Equal(DateTimeKind.Utc,stored.CreatedAtUtc.Kind);
        }
    }

    [Fact]
    public async Task IndependentReviewerCanReviewOnlyForOfflineShadow()
    {
        var(con,db)=await Open();
        await using(con) await using(db)
        {
            var scope=PdmP3Fixtures.Scope();
            var author=Author(scope);
            var reviewer=Reviewer(scope);
            var registry=new PdmP3ExperimentRegistry(db);
            var item=await registry.RegisterAsync(scope,Run(scope),
                "robust-mad-v1",CodeHash,author);
            var reviewed=await registry.ReviewShadowAsync(item.Id,1,
                "仅用于隔离 Shadow 测试",reviewer);
            Assert.Equal("ReviewedForOfflineShadow",reviewed.State);
            Assert.Equal(2,reviewed.Revision);
            Assert.Equal(2,await db.Audits.CountAsync());
            await Assert.ThrowsAsync<DbUpdateConcurrencyException>(()=>
                registry.ReviewShadowAsync(item.Id,1,"再次审核",reviewer));
        }
    }

    [Fact]
    public async Task DuplicateDatasetAlgorithmAndCrossScopeReviewerAreRejected()
    {
        var(con,db)=await Open();
        await using(con) await using(db)
        {
            var scope=PdmP3Fixtures.Scope();
            var author=Author(scope);var reviewer=Reviewer(scope);
            var registry=new PdmP3ExperimentRegistry(db);
            var item=await registry.RegisterAsync(scope,Run(scope),
                "robust-mad-v1",CodeHash,author);
            await Assert.ThrowsAsync<InvalidOperationException>(()=>
                registry.RegisterAsync(scope,Run(scope),"robust-mad-v1",CodeHash,author));
            await Assert.ThrowsAsync<UnauthorizedAccessException>(()=>
                registry.ReviewShadowAsync(item.Id,1,"foreign",
                    reviewer with {CustomerId=Guid.NewGuid()}));
            await Assert.ThrowsAsync<UnauthorizedAccessException>(()=>
                registry.ReviewShadowAsync(item.Id,1,"self",
                    author with {CanReview=true}));
        }
    }

    [Fact]
    public async Task ForgedMetricsAndInputCodeHashesFailClosed()
    {
        var(con,db)=await Open();
        await using(con) await using(db)
        {
            var scope=PdmP3Fixtures.Scope();
            var author=Author(scope);
            var registry=new PdmP3ExperimentRegistry(db);
            var run=Run(scope);
            var forged=run with
            {
                Metrics=run.Metrics with {
                    Precision=0.999, Recall=0.999,
                    HasTrustedGroundTruth=false
                }
            };
            await Assert.ThrowsAsync<InvalidOperationException>(()=>
                registry.RegisterAsync(scope,forged,"robust-mad-v1",CodeHash,author));
            await Assert.ThrowsAsync<InvalidOperationException>(()=>
                registry.RegisterAsync(scope,run,"robust-mad-v1","fake",author));
            Assert.Empty(await db.Experiments.ToListAsync());
        }
    }

    [Fact]
    public async Task CrossScopePredictionOrInconsistentConfusionMatrixCannotBeArchived()
    {
        var(con,db)=await Open();
        await using(con) await using(db)
        {
            var scope=PdmP3Fixtures.Scope();
            var author=Author(scope);
            var registry=new PdmP3ExperimentRegistry(db);
            var run=Run(scope);
            var predictions=run.Predictions.ToArray();
            predictions[0]=predictions[0] with {
                Scope=scope with { CustomerId=Guid.NewGuid() }
            };
            await Assert.ThrowsAsync<InvalidOperationException>(()=>
                registry.RegisterAsync(scope,run with {Predictions=predictions},
                    "robust-mad-v1",CodeHash,author));
            var badCounts=run with {
                Metrics=run.Metrics with { FalsePositive=1, HasTrustedGroundTruth=false }
            };
            await Assert.ThrowsAsync<InvalidOperationException>(()=>
                registry.RegisterAsync(scope,badCounts,
                    "robust-mad-v1",CodeHash,author));
            Assert.Empty(await db.Experiments.ToListAsync());
        }
    }
    [Fact]
    public async Task EvenPlausibleForgedPrecisionCannotBeStoredAgainstTrueConfusionCounts()
    {
        var(con,db)=await Open();
        await using(con) await using(db)
        {
            var scope=PdmP3Fixtures.Scope();
            var samples=PdmP3Fixtures.Samples(scope,1,1,1,1,1,1,1,1,7,1);
            var asOf=PdmP3Fixtures.Start.AddHours(4);
            var label=PdmP3Fixtures.Label(scope,samples[8].EventTimeUtc,
                PdmP3FaultTruth.ConfirmedFault,asOf.AddMinutes(-1));
            var valid=PdmP3OfflineReplayRunner.Run(samples,new[] {label},8,asOf);
            Assert.Equal(1.0,valid.Metrics.Precision);
            var forged=valid with {
                Metrics=valid.Metrics with {Precision=0.85}
            };
            await Assert.ThrowsAsync<InvalidOperationException>(()=>
                new PdmP3ExperimentRegistry(db).RegisterAsync(
                    scope,forged,"robust-mad-v1",CodeHash,Author(scope)));
            Assert.Empty(await db.Experiments.ToListAsync());
        }
    }
    [Fact]
    public async Task MissingProductionAuthorizationCannotCreateADeployableModel()
    {
        var(con,db)=await Open();
        await using(con) await using(db)
        {
            var scope=PdmP3Fixtures.Scope();
            var author=Author(scope);
            var registry=new PdmP3ExperimentRegistry(db);
            var run=Run(scope) with { IsProductionModel=true };
            await Assert.ThrowsAsync<InvalidOperationException>(()=>
                registry.RegisterAsync(scope,run,"robust-mad-v1",CodeHash,author));
            var another=Run(scope) with {UsedFutureLabelsForDetection=true};
            await Assert.ThrowsAsync<InvalidOperationException>(()=>
                registry.RegisterAsync(scope,another,"robust-mad-v1",CodeHash,author));
        }
    }
}

