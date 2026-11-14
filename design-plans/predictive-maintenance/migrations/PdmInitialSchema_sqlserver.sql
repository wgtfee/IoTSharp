-- IoTSharp PdM P1-04 INITIAL SCHEMA DRAFT
-- Generated offline from PdmDbContext. NEVER automatically executed.
-- DBA review, permissions, backup and provider staging migration required.
-- Provider: sqlserver

CREATE TABLE [PdmDeviceProfile] (
    [Id] uniqueidentifier NOT NULL,
    [TenantId] uniqueidentifier NOT NULL,
    [CustomerId] uniqueidentifier NOT NULL,
    [DeviceId] uniqueidentifier NOT NULL,
    [ProductId] uniqueidentifier NULL,
    [AssetId] uniqueidentifier NULL,
    [Version] int NOT NULL,
    [Enabled] bit NOT NULL,
    [PointMappingsVerified] bit NOT NULL,
    [RunStateVerified] bit NOT NULL,
    [RunStateTelemetryKey] nvarchar(max) NULL,
    [RunStateIntervalSeconds] int NOT NULL,
    [RunStateRunningValue] float NOT NULL,
    [WindowMinutes] int NOT NULL,
    [MinimumCoverageRatio] float NOT NULL,
    [CreatedAtUtc] datetime2 NOT NULL,
    [UpdatedAtUtc] datetime2 NOT NULL,
    CONSTRAINT [PK_PdmDeviceProfile] PRIMARY KEY ([Id])
);
GO


CREATE TABLE [PdmHealthSnapshot] (
    [Id] uniqueidentifier NOT NULL,
    [TenantId] uniqueidentifier NOT NULL,
    [CustomerId] uniqueidentifier NOT NULL,
    [DeviceId] uniqueidentifier NOT NULL,
    [ProfileId] uniqueidentifier NOT NULL,
    [ProfileVersion] int NOT NULL,
    [WindowStartUtc] datetime2 NOT NULL,
    [WindowEndUtc] datetime2 NOT NULL,
    [DataQuality] nvarchar(40) NOT NULL,
    [RiskLevel] nvarchar(40) NOT NULL,
    [HealthIndex] float NULL,
    [CoverageRatio] float NOT NULL,
    [EvaluatedPointCount] int NOT NULL,
    [FailedPointCount] int NOT NULL,
    [ExplanationJson] nvarchar(max) NOT NULL,
    [CreatedAtUtc] datetime2 NOT NULL,
    CONSTRAINT [PK_PdmHealthSnapshot] PRIMARY KEY ([Id]),
    CONSTRAINT [FK_PdmHealthSnapshot_PdmDeviceProfile_ProfileId] FOREIGN KEY ([ProfileId]) REFERENCES [PdmDeviceProfile] ([Id]) ON DELETE NO ACTION
);
GO


CREATE TABLE [PdmPointPolicy] (
    [Id] uniqueidentifier NOT NULL,
    [ProfileId] uniqueidentifier NOT NULL,
    [TelemetryKey] nvarchar(256) NOT NULL,
    [Unit] nvarchar(32) NOT NULL,
    [ExpectedIntervalSeconds] int NOT NULL,
    [MinValidValue] float NOT NULL,
    [MaxValidValue] float NOT NULL,
    [WarningHighValue] float NOT NULL,
    [CriticalHighValue] float NOT NULL,
    [RisingTrendPerMinute] float NULL,
    [Weight] float NOT NULL,
    [Required] bit NOT NULL,
    [Enabled] bit NOT NULL,
    CONSTRAINT [PK_PdmPointPolicy] PRIMARY KEY ([Id]),
    CONSTRAINT [FK_PdmPointPolicy_PdmDeviceProfile_ProfileId] FOREIGN KEY ([ProfileId]) REFERENCES [PdmDeviceProfile] ([Id]) ON DELETE NO ACTION
);
GO


CREATE TABLE [PdmRiskEvent] (
    [Id] uniqueidentifier NOT NULL,
    [TenantId] uniqueidentifier NOT NULL,
    [CustomerId] uniqueidentifier NOT NULL,
    [DeviceId] uniqueidentifier NOT NULL,
    [ProfileId] uniqueidentifier NOT NULL,
    [ProfileVersion] int NOT NULL,
    [EventKey] nvarchar(128) NOT NULL,
    [RiskType] nvarchar(128) NOT NULL,
    [RiskLevel] nvarchar(40) NOT NULL,
    [Status] nvarchar(40) NOT NULL,
    [FirstObservedUtc] datetime2 NOT NULL,
    [LastObservedUtc] datetime2 NOT NULL,
    [LastEvaluatedWindowEndUtc] datetime2 NOT NULL,
    [RecoveryStreak] int NOT NULL,
    [ClearedAtUtc] datetime2 NULL,
    [OccurrenceCount] int NOT NULL,
    [LinkedAlarmId] uniqueidentifier NULL,
    [EvidenceJson] nvarchar(max) NOT NULL,
    CONSTRAINT [PK_PdmRiskEvent] PRIMARY KEY ([Id]),
    CONSTRAINT [FK_PdmRiskEvent_PdmDeviceProfile_ProfileId] FOREIGN KEY ([ProfileId]) REFERENCES [PdmDeviceProfile] ([Id]) ON DELETE NO ACTION
);
GO


CREATE UNIQUE INDEX [IX_PdmDeviceProfile_TenantId_CustomerId_DeviceId] ON [PdmDeviceProfile] ([TenantId], [CustomerId], [DeviceId]);
GO


CREATE INDEX [IX_PdmDeviceProfile_TenantId_CustomerId_Enabled] ON [PdmDeviceProfile] ([TenantId], [CustomerId], [Enabled]);
GO


CREATE UNIQUE INDEX [IX_PdmHealthSnapshot_ProfileId_ProfileVersion_WindowStartUtc_WindowEndUtc] ON [PdmHealthSnapshot] ([ProfileId], [ProfileVersion], [WindowStartUtc], [WindowEndUtc]);
GO


CREATE INDEX [IX_PdmHealthSnapshot_TenantId_CustomerId_DeviceId_WindowEndUtc] ON [PdmHealthSnapshot] ([TenantId], [CustomerId], [DeviceId], [WindowEndUtc]);
GO


CREATE INDEX [IX_PdmHealthSnapshot_TenantId_CustomerId_RiskLevel_WindowEndUtc] ON [PdmHealthSnapshot] ([TenantId], [CustomerId], [RiskLevel], [WindowEndUtc]);
GO


CREATE INDEX [IX_PdmPointPolicy_ProfileId] ON [PdmPointPolicy] ([ProfileId]);
GO


CREATE UNIQUE INDEX [IX_PdmPointPolicy_ProfileId_TelemetryKey] ON [PdmPointPolicy] ([ProfileId], [TelemetryKey]);
GO


CREATE INDEX [IX_PdmRiskEvent_ProfileId] ON [PdmRiskEvent] ([ProfileId]);
GO


CREATE INDEX [IX_PdmRiskEvent_TenantId_CustomerId_DeviceId_Status_LastObservedUtc] ON [PdmRiskEvent] ([TenantId], [CustomerId], [DeviceId], [Status], [LastObservedUtc]);
GO


CREATE UNIQUE INDEX [IX_PdmRiskEvent_TenantId_CustomerId_EventKey] ON [PdmRiskEvent] ([TenantId], [CustomerId], [EventKey]);
GO


