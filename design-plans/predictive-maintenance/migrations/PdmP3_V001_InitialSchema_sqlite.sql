-- P3 V001 initial four-table schema generated from independent EF models.
-- DBA review only. Do NOT run against production, IoTSharp SysDb or telemetry tables.
-- No live database connection was opened. Not a versioned EF migrations chain.
-- Backup/rollback, permissions, UTC, concurrency, indexes require staging review.
-- Provider: sqlite
CREATE TABLE "PdmP3FaultCase" (
    "Id" TEXT NOT NULL CONSTRAINT "PK_PdmP3FaultCase" PRIMARY KEY,
    "TenantId" TEXT NOT NULL,
    "CustomerId" TEXT NOT NULL,
    "DeviceId" TEXT NOT NULL,
    "ProfileId" TEXT NOT NULL,
    "ProfileVersion" INTEGER NOT NULL,
    "PointKey" TEXT NOT NULL,
    "EngineeringUnit" TEXT NOT NULL,
    "OperatingMode" TEXT NOT NULL,
    "EventTimeUtc" TEXT NOT NULL,
    "CaseReference" TEXT NOT NULL,
    "EvidenceReference" TEXT NOT NULL,
    "State" TEXT NOT NULL,
    "Revision" INTEGER NOT NULL,
    "SubmittedBy" TEXT NOT NULL,
    "SubmittedAtUtc" TEXT NOT NULL,
    "ReviewedBy" TEXT NULL,
    "ReviewedAtUtc" TEXT NULL
);


CREATE TABLE "PdmP3FaultCaseAudit" (
    "Id" TEXT NOT NULL CONSTRAINT "PK_PdmP3FaultCaseAudit" PRIMARY KEY,
    "TenantId" TEXT NOT NULL,
    "CustomerId" TEXT NOT NULL,
    "CaseId" TEXT NOT NULL,
    "ActorId" TEXT NOT NULL,
    "Action" TEXT NOT NULL,
    "Reason" TEXT NOT NULL,
    "AtUtc" TEXT NOT NULL,
    CONSTRAINT "FK_PdmP3FaultCaseAudit_PdmP3FaultCase_CaseId" FOREIGN KEY ("CaseId") REFERENCES "PdmP3FaultCase" ("Id") ON DELETE RESTRICT
);


CREATE UNIQUE INDEX "IX_PdmP3FaultCase_TenantId_CustomerId_DeviceId_ProfileId_ProfileVersion_PointKey_EventTimeUtc" ON "PdmP3FaultCase" ("TenantId", "CustomerId", "DeviceId", "ProfileId", "ProfileVersion", "PointKey", "EventTimeUtc");


CREATE INDEX "IX_PdmP3FaultCaseAudit_CaseId" ON "PdmP3FaultCaseAudit" ("CaseId");


CREATE INDEX "IX_PdmP3FaultCaseAudit_TenantId_CustomerId_CaseId_AtUtc" ON "PdmP3FaultCaseAudit" ("TenantId", "CustomerId", "CaseId", "AtUtc");



CREATE TABLE "PdmP3Experiment" (
    "Id" TEXT NOT NULL CONSTRAINT "PK_PdmP3Experiment" PRIMARY KEY,
    "TenantId" TEXT NOT NULL,
    "CustomerId" TEXT NOT NULL,
    "DeviceId" TEXT NOT NULL,
    "ProfileId" TEXT NOT NULL,
    "ProfileVersion" INTEGER NOT NULL,
    "Fingerprint" TEXT NOT NULL,
    "DatasetSha256" TEXT NOT NULL,
    "ReplaySha256" TEXT NOT NULL,
    "CodeSha256" TEXT NOT NULL,
    "AlgorithmVersion" TEXT NOT NULL,
    "TrainingRows" INTEGER NOT NULL,
    "HoldoutRows" INTEGER NOT NULL,
    "EvaluatedSamples" INTEGER NOT NULL,
    "UnlabeledSamples" INTEGER NOT NULL,
    "AbstainedSamples" INTEGER NOT NULL,
    "Precision" REAL NULL,
    "Recall" REAL NULL,
    "State" TEXT NOT NULL,
    "Revision" INTEGER NOT NULL,
    "CreatedBy" TEXT NOT NULL,
    "ReviewedBy" TEXT NULL,
    "CreatedAtUtc" TEXT NOT NULL,
    "ReviewedAtUtc" TEXT NULL
);


CREATE TABLE "PdmP3ExperimentAudit" (
    "Id" TEXT NOT NULL CONSTRAINT "PK_PdmP3ExperimentAudit" PRIMARY KEY,
    "TenantId" TEXT NOT NULL,
    "CustomerId" TEXT NOT NULL,
    "ExperimentId" TEXT NOT NULL,
    "ActorId" TEXT NOT NULL,
    "Action" TEXT NOT NULL,
    "Reason" TEXT NOT NULL,
    "AtUtc" TEXT NOT NULL,
    CONSTRAINT "FK_PdmP3ExperimentAudit_PdmP3Experiment_ExperimentId" FOREIGN KEY ("ExperimentId") REFERENCES "PdmP3Experiment" ("Id") ON DELETE RESTRICT
);


CREATE INDEX "IX_PdmP3Experiment_TenantId_CustomerId_DeviceId_CreatedAtUtc" ON "PdmP3Experiment" ("TenantId", "CustomerId", "DeviceId", "CreatedAtUtc");


CREATE UNIQUE INDEX "IX_PdmP3Experiment_TenantId_CustomerId_Fingerprint" ON "PdmP3Experiment" ("TenantId", "CustomerId", "Fingerprint");


CREATE INDEX "IX_PdmP3ExperimentAudit_ExperimentId" ON "PdmP3ExperimentAudit" ("ExperimentId");


CREATE INDEX "IX_PdmP3ExperimentAudit_TenantId_CustomerId_ExperimentId_AtUtc" ON "PdmP3ExperimentAudit" ("TenantId", "CustomerId", "ExperimentId", "AtUtc");


