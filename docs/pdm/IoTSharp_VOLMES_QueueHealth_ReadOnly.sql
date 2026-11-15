-- IoTSharp PdM -> VOL.MES 运维查询。连接必须是审核过的独立 PdM 数据库。
-- 全程只读：不发送 HTTP，不重试 ManualReview，不修改工单、监测或队列。
SET NOCOUNT ON;
DECLARE @NowUtc datetime2(3) = SYSUTCDATETIME();

-- 监测报警 Outbox：数目、最老事件等待时间、立即到期投递量。
SELECT N'PdmIntegrationOutbox' AS QueueName,
       DeliveryStatus AS QueueStatus,
       COUNT_BIG(*) AS Total,
       MIN(CreatedAtUtc) AS EarliestCreatedUtc,
       MAX(DATEDIFF_BIG(SECOND,CreatedAtUtc,@NowUtc)) AS OldestAgeSeconds,
       SUM(CASE WHEN DeliveryStatus='Pending' AND NextAttemptAtUtc <= @NowUtc THEN CONVERT(bigint,1) ELSE 0 END) AS ReadyCount,
       MAX(AttemptCount) AS MaxAttempts
FROM dbo.PdmIntegrationOutbox
GROUP BY DeliveryStatus
ORDER BY DeliveryStatus;

SELECT TOP (30) EventId,TenantId,CustomerId,SourceEventKey,SourceSequence,
       EventType,DeliveryStatus,AttemptCount,NextAttemptAtUtc,LastErrorCode,
       DATEDIFF_BIG(SECOND,CreatedAtUtc,@NowUtc) AS AgeSeconds
FROM dbo.PdmIntegrationOutbox
WHERE DeliveryStatus <> 'Delivered'
ORDER BY CASE WHEN DeliveryStatus='ManualReview' THEN 0 ELSE 1 END,
         CreatedAtUtc,SourceSequence;

-- 人工维修工单 Outbox：独立监控，不以监测恢复代替人工完工。
SELECT N'PdmWorkOrderMesOutbox' AS QueueName,
       DeliveryStatus AS QueueStatus,
       COUNT_BIG(*) AS Total,
       MIN(CreatedAtUtc) AS EarliestCreatedUtc,
       MAX(DATEDIFF_BIG(SECOND,CreatedAtUtc,@NowUtc)) AS OldestAgeSeconds,
       SUM(CASE WHEN DeliveryStatus='Pending' AND NextAttemptAtUtc <= @NowUtc THEN CONVERT(bigint,1) ELSE 0 END) AS ReadyCount,
       MAX(AttemptCount) AS MaxAttempts
FROM dbo.PdmWorkOrderMesOutbox
GROUP BY DeliveryStatus
ORDER BY DeliveryStatus;

SELECT TOP (30) EventId,WorkOrderId,TenantId,CustomerId,SourceSequence,
       EventType,DeliveryStatus,AttemptCount,NextAttemptAtUtc,LastErrorCode,
       DATEDIFF_BIG(SECOND,CreatedAtUtc,@NowUtc) AS AgeSeconds
FROM dbo.PdmWorkOrderMesOutbox
WHERE DeliveryStatus <> 'Delivered'
ORDER BY CASE WHEN DeliveryStatus='ManualReview' THEN 0 ELSE 1 END,
         CreatedAtUtc,SourceSequence;

-- 仅检查索引存在、是否被禁用，不擅自创建或重建索引。
SELECT OBJECT_NAME(object_id) AS TableName,name AS IndexName,is_disabled,type_desc
FROM sys.indexes
WHERE object_id IN (OBJECT_ID('dbo.PdmIntegrationOutbox'),
                    OBJECT_ID('dbo.PdmWorkOrderMesOutbox')) AND name IS NOT NULL
ORDER BY TableName,IndexName;
