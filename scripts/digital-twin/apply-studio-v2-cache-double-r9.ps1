#Requires -Version 7.0
# Studio V2 Draft r8 -> r9, development SQL Server ONLY.
# No PLC/MES/work-order/equipment commands. V19 Published r11 is strictly read-only.
# Protects the exact SQL r8 source payload hash and validates all changes within
# one SERIALIZABLE transaction. Never re-apply after r9 or overwrite parallel edits.
param(
    [string]$Candidate = 'ClientApp/.tmp-studio-v2-cache-double-r9-candidate.json'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$v2Id = [guid]'d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94'
$v19Id = [guid]'69a6b03a-0a0c-45e9-b3c1-f29bcaeb142e'
$expectedR8 = '40E6031C6B3D7F89ADE91510C5BA755384B0988251EDE7F4F453118B71C77339'
$expectedV19 = '470C08343F35E5671B38455D3018CA15C1A726FD8AB7E2AD4D93A1DD24393B66'

if (!(Test-Path $Candidate)) { throw "V2 r9 candidate not found: $Candidate" }
$payload = [IO.File]::ReadAllText((Resolve-Path $Candidate).Path)
$doc = $payload | ConvertFrom-Json
$handoffId = 'studio-v2-surplus-silk-handoff-roller'
$roll = @($doc.objects | Where-Object objectId -eq $handoffId)
$cache = @($doc.routes | Where-Object routeId -eq 'studio-v2-surplus-silk-bidirectional-handoff')
$loop = @($doc.routes | Where-Object routeId -eq 'component-route-d045206d')
$v2Init = @($doc.runtime.routePalletInitializers | Where-Object routeId -eq 'component-route-d045206d')
if ([guid]$doc.sceneId -ne $v2Id -or $doc.objects.Count -ne 56 -or
    $doc.connections.Count -ne 50 -or $doc.routes.Count -ne 5 -or
    $roll.Count -ne 1 -or $cache.Count -ne 1 -or $loop.Count -ne 1 -or
    $v2Init.Count -ne 1 -or $v2Init[0].simulationDefaultCount -ne 108 -or
    $loop[0].edges.Count -ne 46 -or $loop[0].points.Count -ne 42 -or
    $cache[0].points.Count -ne 6 -or $cache[0].edges.Count -ne 4 -or
    $roll[0].component.componentType -ne 'double-small-roller-conveyor' -or
    $roll[0].component.properties.laneAReverse -ne $false -or
    $roll[0].component.properties.laneBReverse -ne $true -or
    [math]::Abs([double]$roll[0].component.properties.laneSpacing - 1.9) -gt 0.01) {
    throw 'Candidate does not satisfy the verified V2 2-lane handoff contract'
}
foreach ($edge in $cache[0].edges) {
    if ($edge.bidirectional -eq $true -or $edge.componentObjectId -ne $handoffId) {
        throw 'Old single-line bidirectional handoff edge found; refusing migration'
    }
}
function SqlPayloadHash([string]$s) {
    return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::Unicode.GetBytes($s)))
}
$connection = [Data.SqlClient.SqlConnection]::new(
    'Server=DESKTOP-2ALRK02\MSSQ;Database=IOTSharp;Integrated Security=True;Encrypt=False;TrustServerCertificate=True')
$transaction = $null
function Read-Payload([guid]$id) {
    $cmd=$connection.CreateCommand()
    $cmd.Transaction=$transaction
    $cmd.CommandText='SELECT DraftPayload FROM dbo.DigitalTwinScenes WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id AND Deleted=0'
    $null=$cmd.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier)
    $cmd.Parameters['@id'].Value=$id
    try { return [string]$cmd.ExecuteScalar() } finally { $cmd.Dispose() }
}
try {
    $connection.Open()
    $transaction=$connection.BeginTransaction([Data.IsolationLevel]::Serializable)
    $sourceV19=Read-Payload $v19Id
    $beforeV2=Read-Payload $v2Id
    if ((SqlPayloadHash $sourceV19) -cne $expectedV19) { throw 'Original Published V19 hash changed' }
    if ((SqlPayloadHash $beforeV2) -cne $expectedR8) { throw 'V2 Draft r8 differs from verified baseline; refusing overwrite' }
    $cmd=$connection.CreateCommand()
    $cmd.Transaction=$transaction
    $cmd.CommandTimeout=60
    $cmd.CommandText=@'
UPDATE dbo.DigitalTwinScenes
SET DraftPayload=@payload, Revision=Revision+1,
    UpdatedAt=SYSUTCDATETIME(), UpdatedBy='studio-v2-r9-cache-double-handoff'
WHERE Id=@id AND Status='Draft' AND Revision=8
AND SceneKey='studio-v2-copy-reference-v19-20261116' AND Deleted=0
AND CONVERT(varchar(64),HASHBYTES('SHA2_256',DraftPayload),2)=@hash;
'@
    $null=$cmd.Parameters.Add('@payload',[Data.SqlDbType]::NVarChar,-1)
    $cmd.Parameters['@payload'].Value=$payload
    $null=$cmd.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier)
    $cmd.Parameters['@id'].Value=$v2Id
    $null=$cmd.Parameters.Add('@hash',[Data.SqlDbType]::VarChar,64)
    $cmd.Parameters['@hash'].Value=$expectedR8
    $affected=$cmd.ExecuteNonQuery()
    $cmd.Dispose()
    if ($affected -ne 1) { throw "Unexpected affected rows: $affected" }
    if ((Read-Payload $v2Id) -cne $payload) { throw 'V2 r9 SQL write/read-back mismatch' }
    if ((Read-Payload $v19Id) -cne $sourceV19) { throw 'V19 modified; transaction rollback required' }
    $check=$connection.CreateCommand()
    $check.Transaction=$transaction
    $check.CommandText='SELECT Revision FROM dbo.DigitalTwinScenes WHERE Id=@id'
    $null=$check.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier)
    $check.Parameters['@id'].Value=$v2Id
    if ([long]$check.ExecuteScalar() -ne 9) { throw 'Expected exact V2 Draft r9 revision' }
    $check.Dispose()
    $transaction.Commit()
    Write-Output "PASS Studio V2 Draft r9 double-lane cache handoff saved SHA256=$(SqlPayloadHash $payload)"
    Write-Output "PASS Published V19 r11 unchanged SHA256=$expectedV19"
    Write-Output 'PASS 2 physical lanes / inner A right / outer B left / 100 rack slots / 108 unchanged circulating pallets'
} catch {
    if ($transaction) { try { $transaction.Rollback() } catch {} }
    throw
} finally {
    if ($transaction) { $transaction.Dispose() }
    $connection.Dispose()
}
