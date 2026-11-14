-- IoTSharp PdM P1-04 INITIAL SCHEMA DRAFT
-- Generated offline from PdmDbContext. NEVER automatically executed.
-- DBA review, permissions, backup and provider staging migration required.
-- Provider: sqlite

CREATE TABLE "PdmDeviceProfile" (
    "Id" TEXT NOT NULL CONSTRAINT "PK_PdmDeviceProfile" PRIMARY KEY,
    "TenantId" TEXT NOT NULL,
    "CustomerId" TEXT NOT NULL,
    "DeviceId" TEXT NOT NULL,
    "ProductId" TEXT NULL,
    "AssetId" TEXT NULL,
    "Version" INTEGER NOT NULL,
    "Enabled" INTEGER NOT NULL,
    "PointMappingsVerified" INTEGER NOT NULL,
    "RunStateVerified" INTEGER NOT NULL,
    "RunStateTelemetryKey" TEXT NULL,
    "RunStateIntervalSeconds" INTEGER NOT NULL,
    "RunStateRunningValue" REAL NOT NULL,
    "WindowMinutes" INTEGER NOT NULL,
    "MinimumCoverageRatio" REAL NOT NULL,
    "CreatedAtUtc" TEXT NOT NULL,
    "UpdatedAtUtc" TEXT NOT NULL
);


CREATE TABLE "PdmHealthSnapshot" (
    "Id" TEXT NOT NULL CONSTRAINT "PK_PdmHealthSnapshot" PRIMARY KEY,
    "TenantId" TEXT NOT NULL,
    "CustomerId" TEXT NOT NULL,
    "DeviceId" TEXT NOT NULL,
    "ProfileId" TEXT NOT NULL,
    "ProfileVersion" INTEGER NOT NULL,
    "WindowStartUtc" TEXT NOT NULL,
    "WindowEndUtc" TEXT NOT NULL,
    "DataQuality" TEXT NOT NULL,
    "RiskLevel" TEXT NOT NULL,
    "HealthIndex" REAL NULL,
    "CoverageRatio" REAL NOT NULL,
    "EvaluatedPointCount" INTEGER NOT NULL,
    "FailedPointCount" INTEGER NOT NULL,
    "ExplanationJson" TEXT NOT NULL,
    "CreatedAtUtc" TEXT NOT NULL,
    CONSTRAINT "FK_PdmHealthSnapshot_PdmDeviceProfile_ProfileId" FOREIGN KEY ("ProfileId") REFERENCES "PdmDeviceProfile" ("Id") ON DELETE RESTRICT
);


CREATE TABLE "PdmPointPolicy" (
    "Id" TEXT NOT NULL CONSTRAINT "PK_PdmPointPolicy" PRIMARY KEY,
    "ProfileId" TEXT NOT NULL,
    "TelemetryKey" TEXT NOT NULL,
    "Unit" TEXT NOT NULL,
    "ExpectedIntervalSeconds" INTEGER NOT NULL,
    "MinValidValue" REAL NOT NULL,
    "MaxValidValue" REAL NOT NULL,
    "WarningHighValue" REAL NOT NULL,
    "CriticalHighValue" REAL NOT NULL,
    "RisingTrendPerMinute" REAL NULL,
    "Weight" REAL NOT NULL,
    "Required" INTEGER NOT NULL,
    "Enabled" INTEGER NOT NULL,
    CONSTRAINT "FK_PdmPointPolicy_PdmDeviceProfile_ProfileId" FOREIGN KEY ("ProfileId") REFERENCES "PdmDeviceProfile" ("Id") ON DELETE RESTRICT
);


CREATE TABLE "PdmRiskEvent" (
    "Id" TEXT NOT NULL CONSTRAINT "PK_PdmRiskEvent" PRIMARY KEY,
    "TenantId" TEXT NOT NULL,
    "CustomerId" TEXT NOT NULL,
    "DeviceId" TEXT NOT NULL,
    "ProfileId" TEXT NOT NULL,
    "ProfileVersion" INTEGER NOT NULL,
    "EventKey" TEXT NOT NULL,
    "RiskType" TEXT NOT NULL,
    "RiskLevel" TEXT NOT NULL,
    "Status" TEXT NOT NULL,
    "FirstObservedUtc" TEXT NOT NULL,
    "LastObservedUtc" TEXT NOT NULL,
    "LastEvaluatedWindowEndUtc" TEXT NOT NULL,
    "RecoveryStreak" INTEGER NOT NULL,
    "ClearedAtUtc" TEXT NULL,
    "OccurrenceCount" INTEGER NOT NULL,
    "LinkedAlarmId" TEXT NULL,
    "EvidenceJson" TEXT NOT NULL,
    CONSTRAINT "FK_PdmRiskEvent_PdmDeviceProfile_ProfileId" FOREIGN KEY ("ProfileId") REFERENCES "PdmDeviceProfile" ("Id") ON DELETE RESTRICT
);


CREATE UNIQUE INDEX "IX_PdmDeviceProfile_TenantId_CustomerId_DeviceId" ON "PdmDeviceProfile" ("TenantId", "CustomerId", "DeviceId");


CREATE INDEX "IX_PdmDeviceProfile_TenantId_CustomerId_Enabled" ON "PdmDeviceProfile" ("TenantId", "CustomerId", "Enabled");


CREATE UNIQUE INDEX "IX_PdmHealthSnapshot_ProfileId_ProfileVersion_WindowStartUtc_WindowEndUtc" ON "PdmHealthSnapshot" ("ProfileId", "ProfileVersion", "WindowStartUtc", "WindowEndUtc");


CREATE INDEX "IX_PdmHealthSnapshot_TenantId_CustomerId_DeviceId_WindowEndUtc" ON "PdmHealthSnapshot" ("TenantId", "CustomerId", "DeviceId", "WindowEndUtc");


CREATE INDEX "IX_PdmHealthSnapshot_TenantId_CustomerId_RiskLevel_WindowEndUtc" ON "PdmHealthSnapshot" ("TenantId", "CustomerId", "RiskLevel", "WindowEndUtc");


CREATE INDEX "IX_PdmPointPolicy_ProfileId" ON "PdmPointPolicy" ("ProfileId");


CREATE UNIQUE INDEX "IX_PdmPointPolicy_ProfileId_TelemetryKey" ON "PdmPointPolicy" ("ProfileId", "TelemetryKey");


CREATE INDEX "IX_PdmRiskEvent_ProfileId" ON "PdmRiskEvent" ("ProfileId");


CREATE INDEX "IX_PdmRiskEvent_TenantId_CustomerId_DeviceId_Status_LastObservedUtc" ON "PdmRiskEvent" ("TenantId", "CustomerId", "DeviceId", "Status", "LastObservedUtc");


CREATE UNIQUE INDEX "IX_PdmRiskEvent_TenantId_CustomerId_EventKey" ON "PdmRiskEvent" ("TenantId", "CustomerId", "EventKey");


