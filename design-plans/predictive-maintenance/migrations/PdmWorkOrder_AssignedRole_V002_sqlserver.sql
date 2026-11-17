-- IoTSharp PdM internal work-order role assignment, SQL Server V002.
-- Development target: IOTSharp main database.
-- Existing orders, assignments, states and audit rows are preserved.
-- Requires a verified full backup before execution. This script never drops data.
SET NOCOUNT ON;
SET XACT_ABORT ON;
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;

IF DB_NAME() <> N'IOTSharp'
    THROW 51041, 'V002 must run explicitly against the IOTSharp main database.', 1;
IF OBJECT_ID(N'dbo.PdmInternalWorkOrders', N'U') IS NULL
    THROW 51042, 'PdM work-order table is missing; apply V001 first.', 1;

BEGIN TRANSACTION;
IF COL_LENGTH(N'dbo.PdmInternalWorkOrders', N'AssignedRoleId') IS NULL
    ALTER TABLE dbo.PdmInternalWorkOrders ADD AssignedRoleId NVARCHAR(450) NULL;

IF NOT EXISTS (
    SELECT 1 FROM sys.indexes WHERE object_id = OBJECT_ID(N'dbo.PdmInternalWorkOrders')
      AND name = N'IX_PdmInternalWorkOrders_AssignedRoleId_State'
)
    EXEC(N'CREATE INDEX IX_PdmInternalWorkOrders_AssignedRoleId_State
          ON dbo.PdmInternalWorkOrders(AssignedRoleId, State)');
COMMIT TRANSACTION;

-- Verification: existing orders keep their historical AssignedTo values.
SELECT COUNT(*) AS TotalOrders FROM dbo.PdmInternalWorkOrders;
SELECT COUNT(*) AS TotalAudits FROM dbo.PdmInternalWorkOrderAudits;
SELECT COL_LENGTH(N'dbo.PdmInternalWorkOrders', N'AssignedRoleId') AS RoleColumnBytes;
