-- IoTSharp PdM P2 V001 INITIAL SCHEMA / DBA REVIEW DRAFT
-- Generated offline from isolated PdmP2ReviewDbContext and PdmP2PolicyDbContext.
-- No connection was opened and this SQL was NOT executed.
-- Manual, controlled staging migration only, with backup and rollback approval.
-- Never apply to IoTSharp SysDb/ApplicationDbContext or the production telemetry hot path.
-- Provider: sqlite
CREATE TABLE "PdmP2Review" (
    "Id" TEXT NOT NULL CONSTRAINT "PK_PdmP2Review" PRIMARY KEY,
    "TenantId" TEXT NOT NULL,
    "CustomerId" TEXT NOT NULL,
    "DeviceId" TEXT NOT NULL,
    "ProfileId" TEXT NOT NULL,
    "ProfileVersion" INTEGER NOT NULL,
    "RiskEventId" TEXT NOT NULL,
    "Fingerprint" TEXT NOT NULL,
    "Title" TEXT NOT NULL,
    "State" TEXT NOT NULL,
    "Revision" INTEGER NOT NULL,
    "CreatedAtUtc" TEXT NOT NULL,
    "UpdatedAtUtc" TEXT NOT NULL
);


CREATE TABLE "PdmP2ReviewAudit" (
    "Id" TEXT NOT NULL CONSTRAINT "PK_PdmP2ReviewAudit" PRIMARY KEY,
    "ReviewId" TEXT NOT NULL,
    "TenantId" TEXT NOT NULL,
    "CustomerId" TEXT NOT NULL,
    "ActorId" TEXT NOT NULL,
    "Action" TEXT NOT NULL,
    "Reason" TEXT NOT NULL,
    "AtUtc" TEXT NOT NULL,
    CONSTRAINT "FK_PdmP2ReviewAudit_PdmP2Review_ReviewId" FOREIGN KEY ("ReviewId") REFERENCES "PdmP2Review" ("Id") ON DELETE RESTRICT
);


CREATE INDEX "IX_PdmP2Review_TenantId_CustomerId_DeviceId_CreatedAtUtc" ON "PdmP2Review" ("TenantId", "CustomerId", "DeviceId", "CreatedAtUtc");


CREATE UNIQUE INDEX "IX_PdmP2Review_TenantId_CustomerId_Fingerprint" ON "PdmP2Review" ("TenantId", "CustomerId", "Fingerprint");


CREATE INDEX "IX_PdmP2ReviewAudit_ReviewId" ON "PdmP2ReviewAudit" ("ReviewId");


CREATE INDEX "IX_PdmP2ReviewAudit_TenantId_CustomerId_ReviewId_AtUtc" ON "PdmP2ReviewAudit" ("TenantId", "CustomerId", "ReviewId", "AtUtc");



CREATE TABLE "PdmP2PolicyRevision" (
    "Id" TEXT NOT NULL CONSTRAINT "PK_PdmP2PolicyRevision" PRIMARY KEY,
    "TenantId" TEXT NOT NULL,
    "CustomerId" TEXT NOT NULL,
    "ProfileId" TEXT NOT NULL,
    "ProfileVersion" INTEGER NOT NULL,
    "PolicyVersion" INTEGER NOT NULL,
    "MinimumRisk" INTEGER NOT NULL,
    "MinimumOccurrences" INTEGER NOT NULL,
    "CooldownMinutes" INTEGER NOT NULL,
    "RequireGoodQuality" INTEGER NOT NULL,
    "Status" TEXT NOT NULL,
    "Revision" INTEGER NOT NULL,
    "CreatedBy" TEXT NOT NULL,
    "ReviewedBy" TEXT NULL,
    "CreatedAtUtc" TEXT NOT NULL,
    "ReviewedAtUtc" TEXT NULL,
    "ProductionEnabled" INTEGER NOT NULL
);


CREATE TABLE "PdmP2PolicyAudit" (
    "Id" TEXT NOT NULL CONSTRAINT "PK_PdmP2PolicyAudit" PRIMARY KEY,
    "TenantId" TEXT NOT NULL,
    "CustomerId" TEXT NOT NULL,
    "PolicyId" TEXT NOT NULL,
    "ActorId" TEXT NOT NULL,
    "Action" TEXT NOT NULL,
    "Reason" TEXT NOT NULL,
    "AtUtc" TEXT NOT NULL,
    CONSTRAINT "FK_PdmP2PolicyAudit_PdmP2PolicyRevision_PolicyId" FOREIGN KEY ("PolicyId") REFERENCES "PdmP2PolicyRevision" ("Id") ON DELETE RESTRICT
);


CREATE INDEX "IX_PdmP2PolicyAudit_PolicyId" ON "PdmP2PolicyAudit" ("PolicyId");


CREATE INDEX "IX_PdmP2PolicyAudit_TenantId_CustomerId_PolicyId_AtUtc" ON "PdmP2PolicyAudit" ("TenantId", "CustomerId", "PolicyId", "AtUtc");


CREATE UNIQUE INDEX "IX_PdmP2PolicyRevision_TenantId_CustomerId_ProfileId_ProfileVersion_PolicyVersion" ON "PdmP2PolicyRevision" ("TenantId", "CustomerId", "ProfileId", "ProfileVersion", "PolicyVersion");


CREATE INDEX "IX_PdmP2PolicyRevision_TenantId_CustomerId_Status" ON "PdmP2PolicyRevision" ("TenantId", "CustomerId", "Status");


