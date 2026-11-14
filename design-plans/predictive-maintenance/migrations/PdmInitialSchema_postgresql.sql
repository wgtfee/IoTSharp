-- IoTSharp PdM P1-04 INITIAL SCHEMA DRAFT
-- Generated offline from PdmDbContext. NEVER automatically executed.
-- DBA review, permissions, backup and provider staging migration required.
-- Provider: postgresql

CREATE TABLE "PdmDeviceProfile" (
    "Id" uuid NOT NULL,
    "TenantId" uuid NOT NULL,
    "CustomerId" uuid NOT NULL,
    "DeviceId" uuid NOT NULL,
    "ProductId" uuid,
    "AssetId" uuid,
    "Version" integer NOT NULL,
    "Enabled" boolean NOT NULL,
    "PointMappingsVerified" boolean NOT NULL,
    "RunStateVerified" boolean NOT NULL,
    "RunStateTelemetryKey" text,
    "RunStateIntervalSeconds" integer NOT NULL,
    "RunStateRunningValue" double precision NOT NULL,
    "WindowMinutes" integer NOT NULL,
    "MinimumCoverageRatio" double precision NOT NULL,
    "CreatedAtUtc" timestamp with time zone NOT NULL,
    "UpdatedAtUtc" timestamp with time zone NOT NULL,
    CONSTRAINT "PK_PdmDeviceProfile" PRIMARY KEY ("Id")
);


CREATE TABLE "PdmHealthSnapshot" (
    "Id" uuid NOT NULL,
    "TenantId" uuid NOT NULL,
    "CustomerId" uuid NOT NULL,
    "DeviceId" uuid NOT NULL,
    "ProfileId" uuid NOT NULL,
    "ProfileVersion" integer NOT NULL,
    "WindowStartUtc" timestamp with time zone NOT NULL,
    "WindowEndUtc" timestamp with time zone NOT NULL,
    "DataQuality" character varying(40) NOT NULL,
    "RiskLevel" character varying(40) NOT NULL,
    "HealthIndex" double precision,
    "CoverageRatio" double precision NOT NULL,
    "EvaluatedPointCount" integer NOT NULL,
    "FailedPointCount" integer NOT NULL,
    "ExplanationJson" text NOT NULL,
    "CreatedAtUtc" timestamp with time zone NOT NULL,
    CONSTRAINT "PK_PdmHealthSnapshot" PRIMARY KEY ("Id"),
    CONSTRAINT "FK_PdmHealthSnapshot_PdmDeviceProfile_ProfileId" FOREIGN KEY ("ProfileId") REFERENCES "PdmDeviceProfile" ("Id") ON DELETE RESTRICT
);


CREATE TABLE "PdmPointPolicy" (
    "Id" uuid NOT NULL,
    "ProfileId" uuid NOT NULL,
    "TelemetryKey" character varying(256) NOT NULL,
    "Unit" character varying(32) NOT NULL,
    "ExpectedIntervalSeconds" integer NOT NULL,
    "MinValidValue" double precision NOT NULL,
    "MaxValidValue" double precision NOT NULL,
    "WarningHighValue" double precision NOT NULL,
    "CriticalHighValue" double precision NOT NULL,
    "RisingTrendPerMinute" double precision,
    "Weight" double precision NOT NULL,
    "Required" boolean NOT NULL,
    "Enabled" boolean NOT NULL,
    CONSTRAINT "PK_PdmPointPolicy" PRIMARY KEY ("Id"),
    CONSTRAINT "FK_PdmPointPolicy_PdmDeviceProfile_ProfileId" FOREIGN KEY ("ProfileId") REFERENCES "PdmDeviceProfile" ("Id") ON DELETE RESTRICT
);


CREATE TABLE "PdmRiskEvent" (
    "Id" uuid NOT NULL,
    "TenantId" uuid NOT NULL,
    "CustomerId" uuid NOT NULL,
    "DeviceId" uuid NOT NULL,
    "ProfileId" uuid NOT NULL,
    "ProfileVersion" integer NOT NULL,
    "EventKey" character varying(128) NOT NULL,
    "RiskType" character varying(128) NOT NULL,
    "RiskLevel" character varying(40) NOT NULL,
    "Status" character varying(40) NOT NULL,
    "FirstObservedUtc" timestamp with time zone NOT NULL,
    "LastObservedUtc" timestamp with time zone NOT NULL,
    "LastEvaluatedWindowEndUtc" timestamp with time zone NOT NULL,
    "RecoveryStreak" integer NOT NULL,
    "ClearedAtUtc" timestamp with time zone,
    "OccurrenceCount" integer NOT NULL,
    "LinkedAlarmId" uuid,
    "EvidenceJson" text NOT NULL,
    CONSTRAINT "PK_PdmRiskEvent" PRIMARY KEY ("Id"),
    CONSTRAINT "FK_PdmRiskEvent_PdmDeviceProfile_ProfileId" FOREIGN KEY ("ProfileId") REFERENCES "PdmDeviceProfile" ("Id") ON DELETE RESTRICT
);


CREATE UNIQUE INDEX "IX_PdmDeviceProfile_TenantId_CustomerId_DeviceId" ON "PdmDeviceProfile" ("TenantId", "CustomerId", "DeviceId");


CREATE INDEX "IX_PdmDeviceProfile_TenantId_CustomerId_Enabled" ON "PdmDeviceProfile" ("TenantId", "CustomerId", "Enabled");


CREATE UNIQUE INDEX "IX_PdmHealthSnapshot_ProfileId_ProfileVersion_WindowStartUtc_W~" ON "PdmHealthSnapshot" ("ProfileId", "ProfileVersion", "WindowStartUtc", "WindowEndUtc");


CREATE INDEX "IX_PdmHealthSnapshot_TenantId_CustomerId_DeviceId_WindowEndUtc" ON "PdmHealthSnapshot" ("TenantId", "CustomerId", "DeviceId", "WindowEndUtc");


CREATE INDEX "IX_PdmHealthSnapshot_TenantId_CustomerId_RiskLevel_WindowEndUtc" ON "PdmHealthSnapshot" ("TenantId", "CustomerId", "RiskLevel", "WindowEndUtc");


CREATE INDEX "IX_PdmPointPolicy_ProfileId" ON "PdmPointPolicy" ("ProfileId");


CREATE UNIQUE INDEX "IX_PdmPointPolicy_ProfileId_TelemetryKey" ON "PdmPointPolicy" ("ProfileId", "TelemetryKey");


CREATE INDEX "IX_PdmRiskEvent_ProfileId" ON "PdmRiskEvent" ("ProfileId");


CREATE INDEX "IX_PdmRiskEvent_TenantId_CustomerId_DeviceId_Status_LastObserv~" ON "PdmRiskEvent" ("TenantId", "CustomerId", "DeviceId", "Status", "LastObservedUtc");


CREATE UNIQUE INDEX "IX_PdmRiskEvent_TenantId_CustomerId_EventKey" ON "PdmRiskEvent" ("TenantId", "CustomerId", "EventKey");


