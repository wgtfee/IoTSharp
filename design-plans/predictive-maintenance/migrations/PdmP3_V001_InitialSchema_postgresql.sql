-- P3 V001 initial four-table schema generated from independent EF models.
-- DBA review only. Do NOT run against production, IoTSharp SysDb or telemetry tables.
-- No live database connection was opened. Not a versioned EF migrations chain.
-- Backup/rollback, permissions, UTC, concurrency, indexes require staging review.
-- Provider: postgresql
CREATE TABLE "PdmP3FaultCase" (
    "Id" uuid NOT NULL,
    "TenantId" uuid NOT NULL,
    "CustomerId" uuid NOT NULL,
    "DeviceId" uuid NOT NULL,
    "ProfileId" uuid NOT NULL,
    "ProfileVersion" integer NOT NULL,
    "PointKey" character varying(128) NOT NULL,
    "EngineeringUnit" character varying(32) NOT NULL,
    "OperatingMode" character varying(64) NOT NULL,
    "EventTimeUtc" timestamp with time zone NOT NULL,
    "CaseReference" character varying(160) NOT NULL,
    "EvidenceReference" character varying(160) NOT NULL,
    "State" character varying(40) NOT NULL,
    "Revision" integer NOT NULL,
    "SubmittedBy" uuid NOT NULL,
    "SubmittedAtUtc" timestamp with time zone NOT NULL,
    "ReviewedBy" uuid,
    "ReviewedAtUtc" timestamp with time zone,
    CONSTRAINT "PK_PdmP3FaultCase" PRIMARY KEY ("Id")
);


CREATE TABLE "PdmP3FaultCaseAudit" (
    "Id" uuid NOT NULL,
    "TenantId" uuid NOT NULL,
    "CustomerId" uuid NOT NULL,
    "CaseId" uuid NOT NULL,
    "ActorId" uuid NOT NULL,
    "Action" character varying(40) NOT NULL,
    "Reason" character varying(512) NOT NULL,
    "AtUtc" timestamp with time zone NOT NULL,
    CONSTRAINT "PK_PdmP3FaultCaseAudit" PRIMARY KEY ("Id"),
    CONSTRAINT "FK_PdmP3FaultCaseAudit_PdmP3FaultCase_CaseId" FOREIGN KEY ("CaseId") REFERENCES "PdmP3FaultCase" ("Id") ON DELETE RESTRICT
);


CREATE UNIQUE INDEX "IX_PdmP3FaultCase_TenantId_CustomerId_DeviceId_ProfileId_Profi~" ON "PdmP3FaultCase" ("TenantId", "CustomerId", "DeviceId", "ProfileId", "ProfileVersion", "PointKey", "EventTimeUtc");


CREATE INDEX "IX_PdmP3FaultCaseAudit_CaseId" ON "PdmP3FaultCaseAudit" ("CaseId");


CREATE INDEX "IX_PdmP3FaultCaseAudit_TenantId_CustomerId_CaseId_AtUtc" ON "PdmP3FaultCaseAudit" ("TenantId", "CustomerId", "CaseId", "AtUtc");



CREATE TABLE "PdmP3Experiment" (
    "Id" uuid NOT NULL,
    "TenantId" uuid NOT NULL,
    "CustomerId" uuid NOT NULL,
    "DeviceId" uuid NOT NULL,
    "ProfileId" uuid NOT NULL,
    "ProfileVersion" integer NOT NULL,
    "Fingerprint" character varying(64) NOT NULL,
    "DatasetSha256" character varying(64) NOT NULL,
    "ReplaySha256" character varying(64) NOT NULL,
    "CodeSha256" character varying(64) NOT NULL,
    "AlgorithmVersion" character varying(80) NOT NULL,
    "TrainingRows" integer NOT NULL,
    "HoldoutRows" integer NOT NULL,
    "EvaluatedSamples" integer NOT NULL,
    "UnlabeledSamples" integer NOT NULL,
    "AbstainedSamples" integer NOT NULL,
    "Precision" double precision,
    "Recall" double precision,
    "State" character varying(32) NOT NULL,
    "Revision" integer NOT NULL,
    "CreatedBy" uuid NOT NULL,
    "ReviewedBy" uuid,
    "CreatedAtUtc" timestamp with time zone NOT NULL,
    "ReviewedAtUtc" timestamp with time zone,
    CONSTRAINT "PK_PdmP3Experiment" PRIMARY KEY ("Id")
);


CREATE TABLE "PdmP3ExperimentAudit" (
    "Id" uuid NOT NULL,
    "TenantId" uuid NOT NULL,
    "CustomerId" uuid NOT NULL,
    "ExperimentId" uuid NOT NULL,
    "ActorId" uuid NOT NULL,
    "Action" character varying(40) NOT NULL,
    "Reason" character varying(512) NOT NULL,
    "AtUtc" timestamp with time zone NOT NULL,
    CONSTRAINT "PK_PdmP3ExperimentAudit" PRIMARY KEY ("Id"),
    CONSTRAINT "FK_PdmP3ExperimentAudit_PdmP3Experiment_ExperimentId" FOREIGN KEY ("ExperimentId") REFERENCES "PdmP3Experiment" ("Id") ON DELETE RESTRICT
);


CREATE INDEX "IX_PdmP3Experiment_TenantId_CustomerId_DeviceId_CreatedAtUtc" ON "PdmP3Experiment" ("TenantId", "CustomerId", "DeviceId", "CreatedAtUtc");


CREATE UNIQUE INDEX "IX_PdmP3Experiment_TenantId_CustomerId_Fingerprint" ON "PdmP3Experiment" ("TenantId", "CustomerId", "Fingerprint");


CREATE INDEX "IX_PdmP3ExperimentAudit_ExperimentId" ON "PdmP3ExperimentAudit" ("ExperimentId");


CREATE INDEX "IX_PdmP3ExperimentAudit_TenantId_CustomerId_ExperimentId_AtUtc" ON "PdmP3ExperimentAudit" ("TenantId", "CustomerId", "ExperimentId", "AtUtc");


