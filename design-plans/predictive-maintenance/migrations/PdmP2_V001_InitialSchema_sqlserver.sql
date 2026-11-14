-- IoTSharp PdM P2 V001 INITIAL SCHEMA / DBA REVIEW DRAFT
-- Generated offline from isolated PdmP2ReviewDbContext and PdmP2PolicyDbContext.
-- No connection was opened and this SQL was NOT executed.
-- Manual, controlled staging migration only, with backup and rollback approval.
-- Never apply to IoTSharp SysDb/ApplicationDbContext or the production telemetry hot path.
-- Provider: sqlserver
CREATE TABLE [PdmP2Review] (
    [Id] uniqueidentifier NOT NULL,
    [TenantId] uniqueidentifier NOT NULL,
    [CustomerId] uniqueidentifier NOT NULL,
    [DeviceId] uniqueidentifier NOT NULL,
    [ProfileId] uniqueidentifier NOT NULL,
    [ProfileVersion] int NOT NULL,
    [RiskEventId] uniqueidentifier NOT NULL,
    [Fingerprint] nvarchar(64) NOT NULL,
    [Title] nvarchar(300) NOT NULL,
    [State] nvarchar(32) NOT NULL,
    [Revision] int NOT NULL,
    [CreatedAtUtc] datetime2 NOT NULL,
    [UpdatedAtUtc] datetime2 NOT NULL,
    CONSTRAINT [PK_PdmP2Review] PRIMARY KEY ([Id])
);
GO


CREATE TABLE [PdmP2ReviewAudit] (
    [Id] uniqueidentifier NOT NULL,
    [ReviewId] uniqueidentifier NOT NULL,
    [TenantId] uniqueidentifier NOT NULL,
    [CustomerId] uniqueidentifier NOT NULL,
    [ActorId] uniqueidentifier NOT NULL,
    [Action] nvarchar(36) NOT NULL,
    [Reason] nvarchar(512) NOT NULL,
    [AtUtc] datetime2 NOT NULL,
    CONSTRAINT [PK_PdmP2ReviewAudit] PRIMARY KEY ([Id]),
    CONSTRAINT [FK_PdmP2ReviewAudit_PdmP2Review_ReviewId] FOREIGN KEY ([ReviewId]) REFERENCES [PdmP2Review] ([Id]) ON DELETE NO ACTION
);
GO


CREATE INDEX [IX_PdmP2Review_TenantId_CustomerId_DeviceId_CreatedAtUtc] ON [PdmP2Review] ([TenantId], [CustomerId], [DeviceId], [CreatedAtUtc]);
GO


CREATE UNIQUE INDEX [IX_PdmP2Review_TenantId_CustomerId_Fingerprint] ON [PdmP2Review] ([TenantId], [CustomerId], [Fingerprint]);
GO


CREATE INDEX [IX_PdmP2ReviewAudit_ReviewId] ON [PdmP2ReviewAudit] ([ReviewId]);
GO


CREATE INDEX [IX_PdmP2ReviewAudit_TenantId_CustomerId_ReviewId_AtUtc] ON [PdmP2ReviewAudit] ([TenantId], [CustomerId], [ReviewId], [AtUtc]);
GO



CREATE TABLE [PdmP2PolicyRevision] (
    [Id] uniqueidentifier NOT NULL,
    [TenantId] uniqueidentifier NOT NULL,
    [CustomerId] uniqueidentifier NOT NULL,
    [ProfileId] uniqueidentifier NOT NULL,
    [ProfileVersion] int NOT NULL,
    [PolicyVersion] int NOT NULL,
    [MinimumRisk] int NOT NULL,
    [MinimumOccurrences] int NOT NULL,
    [CooldownMinutes] int NOT NULL,
    [RequireGoodQuality] bit NOT NULL,
    [Status] nvarchar(32) NOT NULL,
    [Revision] int NOT NULL,
    [CreatedBy] uniqueidentifier NOT NULL,
    [ReviewedBy] uniqueidentifier NULL,
    [CreatedAtUtc] datetime2 NOT NULL,
    [ReviewedAtUtc] datetime2 NULL,
    [ProductionEnabled] bit NOT NULL,
    CONSTRAINT [PK_PdmP2PolicyRevision] PRIMARY KEY ([Id])
);
GO


CREATE TABLE [PdmP2PolicyAudit] (
    [Id] uniqueidentifier NOT NULL,
    [TenantId] uniqueidentifier NOT NULL,
    [CustomerId] uniqueidentifier NOT NULL,
    [PolicyId] uniqueidentifier NOT NULL,
    [ActorId] uniqueidentifier NOT NULL,
    [Action] nvarchar(32) NOT NULL,
    [Reason] nvarchar(512) NOT NULL,
    [AtUtc] datetime2 NOT NULL,
    CONSTRAINT [PK_PdmP2PolicyAudit] PRIMARY KEY ([Id]),
    CONSTRAINT [FK_PdmP2PolicyAudit_PdmP2PolicyRevision_PolicyId] FOREIGN KEY ([PolicyId]) REFERENCES [PdmP2PolicyRevision] ([Id]) ON DELETE NO ACTION
);
GO


CREATE INDEX [IX_PdmP2PolicyAudit_PolicyId] ON [PdmP2PolicyAudit] ([PolicyId]);
GO


CREATE INDEX [IX_PdmP2PolicyAudit_TenantId_CustomerId_PolicyId_AtUtc] ON [PdmP2PolicyAudit] ([TenantId], [CustomerId], [PolicyId], [AtUtc]);
GO


CREATE UNIQUE INDEX [IX_PdmP2PolicyRevision_TenantId_CustomerId_ProfileId_ProfileVersion_PolicyVersion] ON [PdmP2PolicyRevision] ([TenantId], [CustomerId], [ProfileId], [ProfileVersion], [PolicyVersion]);
GO


CREATE INDEX [IX_PdmP2PolicyRevision_TenantId_CustomerId_Status] ON [PdmP2PolicyRevision] ([TenantId], [CustomerId], [Status]);
GO


