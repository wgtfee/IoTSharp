-- SQL Server 2019 DEVELOPMENT ONLY.
-- Execute in tempdb, inside a single transaction that is always rolled back.
-- Connection must be to DESKTOP-2ALRK02\MSSQ and tempdb.
SET XACT_ABORT ON;
SET NOCOUNT ON;
SET LOCK_TIMEOUT 2000;
IF DB_NAME() <> N'tempdb'
    OR CONVERT(nvarchar(128),SERVERPROPERTY('ServerName')) <> N'DESKTOP-2ALRK02\MSSQ'
    THROW 51051,'Not approved local SQL Server tempdb',1;
IF EXISTS(SELECT 1 FROM sys.tables WHERE name LIKE 'PdmP2%' OR name LIKE 'PdmP3%')
    THROW 51052,'Existing Pdm tables found in tempdb; refusing conflict',1;
BEGIN TRANSACTION;
GO
:r .\design-plans\predictive-maintenance\migrations\PdmP2_V001_InitialSchema_sqlserver.sql
:r .\design-plans\predictive-maintenance\migrations\PdmP3_V001_InitialSchema_sqlserver.sql
SELECT COUNT(*) AS created_pdm_tables_in_transaction
FROM sys.tables WHERE name LIKE 'PdmP2%' OR name LIKE 'PdmP3%';
IF (SELECT COUNT(*) FROM sys.tables WHERE name LIKE 'PdmP2%' OR name LIKE 'PdmP3%') <> 8
    THROW 51053,'DDL did not create the expected eight isolated tables',1;
ROLLBACK TRANSACTION;
GO
IF EXISTS(SELECT 1 FROM sys.tables WHERE name LIKE 'PdmP2%' OR name LIKE 'PdmP3%')
    THROW 51054,'Rollback failed to remove Pdm test tables',1;
SELECT N'P2_P3_SCHEMA_TRANSACTION_ROLLBACK_PASS' AS verdict;

