-- IoTSharp PdM P2 V001 INITIAL SCHEMA / DBA REVIEW DRAFT
-- Generated offline from isolated PdmP2ReviewDbContext and PdmP2PolicyDbContext.
-- No connection was opened and this SQL was NOT executed.
-- Manual, controlled staging migration only, with backup and rollback approval.
-- Never apply to IoTSharp SysDb/ApplicationDbContext or the production telemetry hot path.
-- Provider: postgresql
CREATE TABLE "PdmP2Review" (
    "Id" uuid NOT NULL,
    "TenantId" uuid NOT NULL,
    "CustomerId" uuid NOT NULL,
    "DeviceId" uuid NOT NULL,
    "ProfileId" uuid NOT NULL,
    "ProfileVersion" integer NOT NULL,
    "RiskEventId" uuid NOT NULL,
    "Fingerprint" character varying(64) NOT NULL,
    "Title" character varying(300) NOT NULL,
    "State" character varying(32) NOT NULL,
    "Revision" integer NOT NULL,
    "CreatedAtUtc" timestamp with time zone NOT NULL,
    "UpdatedAtUtc" timestamp with time zone NOT NULL,
    CONSTRAINT "PK_PdmP2Review" PRIMARY KEY ("Id")
);


CREATE TABLE "PdmP2ReviewAudit" (
    "Id" uuid NOT NULL,
    "ReviewId" uuid NOT NULL,
    "TenantId" uuid NOT NULL,
    "CustomerId" uuid NOT NULL,
    "ActorId" uuid NOT NULL,
    "Action" character varying(36) NOT NULL,
    "Reason" character varying(512) NOT NULL,
    "AtUtc" timestamp with time zone NOT NULL,
    CONSTRAINT "PK_PdmP2ReviewAudit" PRIMARY KEY ("Id"),
    CONSTRAINT "FK_PdmP2ReviewAudit_PdmP2Review_ReviewId" FOREIGN KEY ("ReviewId") REFERENCES "PdmP2Review" ("Id") ON DELETE RESTRICT
);


CREATE INDEX "IX_PdmP2Review_TenantId_CustomerId_DeviceId_CreatedAtUtc" ON "PdmP2Review" ("TenantId", "CustomerId", "DeviceId", "CreatedAtUtc");


CREATE UNIQUE INDEX "IX_PdmP2Review_TenantId_CustomerId_Fingerprint" ON "PdmP2Review" ("TenantId", "CustomerId", "Fingerprint");


CREATE INDEX "IX_PdmP2ReviewAudit_ReviewId" ON "PdmP2ReviewAudit" ("ReviewId");


CREATE INDEX "IX_PdmP2ReviewAudit_TenantId_CustomerId_ReviewId_AtUtc" ON "PdmP2ReviewAudit" ("TenantId", "CustomerId", "ReviewId", "AtUtc");



CREATE TABLE "PdmP2PolicyRevision" (
    "Id" uuid NOT NULL,
    "TenantId" uuid NOT NULL,
    "CustomerId" uuid NOT NULL,
    "ProfileId" uuid NOT NULL,
    "ProfileVersion" integer NOT NULL,
    "PolicyVersion" integer NOT NULL,
    "MinimumRisk" integer NOT NULL,
    "MinimumOccurrences" integer NOT NULL,
    "CooldownMinutes" integer NOT NULL,
    "RequireGoodQuality" boolean NOT NULL,
    "Status" character varying(32) NOT NULL,
    "Revision" integer NOT NULL,
    "CreatedBy" uuid NOT NULL,
    "ReviewedBy" uuid,
    "CreatedAtUtc" timestamp with time zone NOT NULL,
    "ReviewedAtUtc" timestamp with time zone,
    "ProductionEnabled" boolean NOT NULL,
    CONSTRAINT "PK_PdmP2PolicyRevision" PRIMARY KEY ("Id")
);


CREATE TABLE "PdmP2PolicyAudit" (
    "Id" uuid NOT NULL,
    "TenantId" uuid NOT NULL,
    "CustomerId" uuid NOT NULL,
    "PolicyId" uuid NOT NULL,
    "ActorId" uuid NOT NULL,
    "Action" character varying(32) NOT NULL,
    "Reason" character varying(512) NOT NULL,
    "AtUtc" timestamp with time zone NOT NULL,
    CONSTRAINT "PK_PdmP2PolicyAudit" PRIMARY KEY ("Id"),
    CONSTRAINT "FK_PdmP2PolicyAudit_PdmP2PolicyRevision_PolicyId" FOREIGN KEY ("PolicyId") REFERENCES "PdmP2PolicyRevision" ("Id") ON DELETE RESTRICT
);


CREATE INDEX "IX_PdmP2PolicyAudit_PolicyId" ON "PdmP2PolicyAudit" ("PolicyId");


CREATE INDEX "IX_PdmP2PolicyAudit_TenantId_CustomerId_PolicyId_AtUtc" ON "PdmP2PolicyAudit" ("TenantId", "CustomerId", "PolicyId", "AtUtc");


CREATE UNIQUE INDEX "IX_PdmP2PolicyRevision_TenantId_CustomerId_ProfileId_ProfileVe~" ON "PdmP2PolicyRevision" ("TenantId", "CustomerId", "ProfileId", "ProfileVersion", "PolicyVersion");


CREATE INDEX "IX_PdmP2PolicyRevision_TenantId_CustomerId_Status" ON "PdmP2PolicyRevision" ("TenantId", "CustomerId", "Status");


