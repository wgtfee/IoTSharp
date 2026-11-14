-- P3 V001 initial four-table schema generated from independent EF models.
-- DBA review only. Do NOT run against production, IoTSharp SysDb or telemetry tables.
-- No live database connection was opened. Not a versioned EF migrations chain.
-- Backup/rollback, permissions, UTC, concurrency, indexes require staging review.
-- Provider: sqlserver
CREATE TABLE [PdmP3FaultCase] (
    [Id] uniqueidentifier NOT NULL,
    [TenantId] uniqueidentifier NOT NULL,
    [CustomerId] uniqueidentifier NOT NULL,
    [DeviceId] uniqueidentifier NOT NULL,
    [ProfileId] uniqueidentifier NOT NULL,
    [ProfileVersion] int NOT NULL,
    [PointKey] nvarchar(128) NOT NULL,
    [EngineeringUnit] nvarchar(32) NOT NULL,
    [OperatingMode] nvarchar(64) NOT NULL,
    [EventTimeUtc] datetime2 NOT NULL,
    [CaseReference] nvarchar(160) NOT NULL,
    [EvidenceReference] nvarchar(160) NOT NULL,
    [State] nvarchar(40) NOT NULL,
    [Revision] int NOT NULL,
    [SubmittedBy] uniqueidentifier NOT NULL,
    [SubmittedAtUtc] datetime2 NOT NULL,
    [ReviewedBy] uniqueidentifier NULL,
    [ReviewedAtUtc] datetime2 NULL,
    CONSTRAINT [PK_PdmP3FaultCase] PRIMARY KEY ([Id])
);
GO


CREATE TABLE [PdmP3FaultCaseAudit] (
    [Id] uniqueidentifier NOT NULL,
    [TenantId] uniqueidentifier NOT NULL,
    [CustomerId] uniqueidentifier NOT NULL,
    [CaseId] uniqueidentifier NOT NULL,
    [ActorId] uniqueidentifier NOT NULL,
    [Action] nvarchar(40) NOT NULL,
    [Reason] nvarchar(512) NOT NULL,
    [AtUtc] datetime2 NOT NULL,
    CONSTRAINT [PK_PdmP3FaultCaseAudit] PRIMARY KEY ([Id]),
    CONSTRAINT [FK_PdmP3FaultCaseAudit_PdmP3FaultCase_CaseId] FOREIGN KEY ([CaseId]) REFERENCES [PdmP3FaultCase] ([Id]) ON DELETE NO ACTION
);
GO


CREATE UNIQUE INDEX [IX_PdmP3FaultCase_TenantId_CustomerId_DeviceId_ProfileId_ProfileVersion_PointKey_EventTimeUtc] ON [PdmP3FaultCase] ([TenantId], [CustomerId], [DeviceId], [ProfileId], [ProfileVersion], [PointKey], [EventTimeUtc]);
GO


CREATE INDEX [IX_PdmP3FaultCaseAudit_CaseId] ON [PdmP3FaultCaseAudit] ([CaseId]);
GO


CREATE INDEX [IX_PdmP3FaultCaseAudit_TenantId_CustomerId_CaseId_AtUtc] ON [PdmP3FaultCaseAudit] ([TenantId], [CustomerId], [CaseId], [AtUtc]);
GO



CREATE TABLE [PdmP3Experiment] (
    [Id] uniqueidentifier NOT NULL,
    [TenantId] uniqueidentifier NOT NULL,
    [CustomerId] uniqueidentifier NOT NULL,
    [DeviceId] uniqueidentifier NOT NULL,
    [ProfileId] uniqueidentifier NOT NULL,
    [ProfileVersion] int NOT NULL,
    [Fingerprint] nvarchar(64) NOT NULL,
    [DatasetSha256] nvarchar(64) NOT NULL,
    [ReplaySha256] nvarchar(64) NOT NULL,
    [CodeSha256] nvarchar(64) NOT NULL,
    [AlgorithmVersion] nvarchar(80) NOT NULL,
    [TrainingRows] int NOT NULL,
    [HoldoutRows] int NOT NULL,
    [EvaluatedSamples] int NOT NULL,
    [UnlabeledSamples] int NOT NULL,
    [AbstainedSamples] int NOT NULL,
    [Precision] float NULL,
    [Recall] float NULL,
    [State] nvarchar(32) NOT NULL,
    [Revision] int NOT NULL,
    [CreatedBy] uniqueidentifier NOT NULL,
    [ReviewedBy] uniqueidentifier NULL,
    [CreatedAtUtc] datetime2 NOT NULL,
    [ReviewedAtUtc] datetime2 NULL,
    CONSTRAINT [PK_PdmP3Experiment] PRIMARY KEY ([Id])
);
GO


CREATE TABLE [PdmP3ExperimentAudit] (
    [Id] uniqueidentifier NOT NULL,
    [TenantId] uniqueidentifier NOT NULL,
    [CustomerId] uniqueidentifier NOT NULL,
    [ExperimentId] uniqueidentifier NOT NULL,
    [ActorId] uniqueidentifier NOT NULL,
    [Action] nvarchar(40) NOT NULL,
    [Reason] nvarchar(512) NOT NULL,
    [AtUtc] datetime2 NOT NULL,
    CONSTRAINT [PK_PdmP3ExperimentAudit] PRIMARY KEY ([Id]),
    CONSTRAINT [FK_PdmP3ExperimentAudit_PdmP3Experiment_ExperimentId] FOREIGN KEY ([ExperimentId]) REFERENCES [PdmP3Experiment] ([Id]) ON DELETE NO ACTION
);
GO


CREATE INDEX [IX_PdmP3Experiment_TenantId_CustomerId_DeviceId_CreatedAtUtc] ON [PdmP3Experiment] ([TenantId], [CustomerId], [DeviceId], [CreatedAtUtc]);
GO


CREATE UNIQUE INDEX [IX_PdmP3Experiment_TenantId_CustomerId_Fingerprint] ON [PdmP3Experiment] ([TenantId], [CustomerId], [Fingerprint]);
GO


CREATE INDEX [IX_PdmP3ExperimentAudit_ExperimentId] ON [PdmP3ExperimentAudit] ([ExperimentId]);
GO


CREATE INDEX [IX_PdmP3ExperimentAudit_TenantId_CustomerId_ExperimentId_AtUtc] ON [PdmP3ExperimentAudit] ([TenantId], [CustomerId], [ExperimentId], [AtUtc]);
GO


