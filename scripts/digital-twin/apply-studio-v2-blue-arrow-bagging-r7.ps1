#Requires -Version 7.0
<#
Studio V2 r6 -> r7: corrected physical bagging transport and blue arrows.
Development SQL Server ONLY. V19 published scene remains strictly read-only.
Requires a reviewed candidate built from the exact SQL r6 payload.
Dry run by default; use -Apply only after isolated browser/TypeScript tests pass.
#>
param(
    [switch]$Apply,
    [string]$BeforePath='ClientApp/.tmp-studio-v2-surplus-layout-r6-live.json',
    [string]$CandidatePath='ClientApp/.tmp-studio-v2-blue-arrows-r7-v2.json'
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$sourceId=[guid]'69a6b03a-0a0c-45e9-b3c1-f29bcaeb142e'
$targetId=[guid]'d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94'
$sourceHash='470C08343F35E5671B38455D3018CA15C1A726FD8AB7E2AD4D93A1DD24393B66'
$beforeText=[IO.File]::ReadAllText((Resolve-Path $BeforePath).Path)
$candidateText=[IO.File]::ReadAllText((Resolve-Path $CandidatePath).Path)
$before=$beforeText|ConvertFrom-Json
$after=$candidateText|ConvertFrom-Json
if([guid]$before.sceneId -ne $targetId -or [guid]$after.sceneId -ne $targetId){throw 'Wrong scene id'}
if($before.objects.Count -ne 52 -or $after.objects.Count -ne 56){throw 'Unexpected component count'}
if($before.connections.Count -ne 47 -or $after.connections.Count -ne 51){throw 'Unexpected connection count'}
if($before.routes.Count -ne 5 -or $after.routes.Count -ne 5){throw 'Other routes have been added/removed'}
$main=@($after.routes|Where-Object routeId -eq 'component-route-d045206d')
if($main.Count -ne 1 -or $main[0].loop -ne $true -or $main[0].edges.Count -ne 46 -or $main[0].points.Count -ne 42){throw 'Unexpected main circulating route'}
$init=@($after.runtime.routePalletInitializers|Where-Object routeId -eq 'component-route-d045206d')
if($init.Count -ne 1 -or $init[0].simulationDefaultCount -ne 108){throw '108 stable pallets must be preserved'}
foreach($name in @('studio-v2-bag-a-infeed-roller','studio-v2-bag-a-outfeed-roller','studio-v2-bag-b-infeed-roller','studio-v2-bag-b-outfeed-roller')){
    if(@($after.objects|Where-Object objectId -eq $name).Count -ne 1){throw "Missing mandatory real conveyor $name"}
}
foreach($check in @(
    @('ref-edge-loaded-upper-right-in','ref-loaded-inner-up','ref-loaded-upper-right-in'),
    @('ref-edge-loaded-upper-right','ref-loaded-upper-right-in','ref-loaded-upper-right-out')
)){
    $edge=@($main[0].edges|Where-Object edgeId -eq $check[0])
    if($edge.Count -ne 1 -or $edge[0].fromPointId -ne $check[1] -or $edge[0].toPointId -ne $check[2]){
        throw "User blue arrow direction mismatch $($check[0])"
    }
}
$cn=[Data.SqlClient.SqlConnection]::new('Server=DESKTOP-2ALRK02\MSSQ;Database=IOTSharp;Integrated Security=True;Encrypt=False;TrustServerCertificate=True')
$tx=$null
try{
    $cn.Open()
    $tx=$cn.BeginTransaction([Data.IsolationLevel]::Serializable)
    $cmd=$cn.CreateCommand()
    $cmd.Transaction=$tx
    $cmd.CommandTimeout=60
    $paramId=$cmd.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier)
    $paramId.Value=$sourceId
    $cmd.CommandText="SELECT DraftPayload FROM dbo.DigitalTwinScenes WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id AND Status='Published' AND Revision=11 AND Deleted=0"
    $sourcePayload=[string]$cmd.ExecuteScalar()
    if(!$sourcePayload){throw 'Original V19 Published r11 not found'}
    $actualHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::Unicode.GetBytes($sourcePayload)))
    if($actualHash -cne $sourceHash){throw 'Original published V19 hash changed'}
    $paramId.Value=$targetId
    $cmd.CommandText="SELECT DraftPayload FROM dbo.DigitalTwinScenes WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id AND Status='Draft' AND Revision=6 AND SceneKey='studio-v2-copy-reference-v19-20261116' AND Deleted=0"
    $currentPayload=[string]$cmd.ExecuteScalar()
    if(!$currentPayload -or $currentPayload -cne $beforeText){throw 'V2 r6 payload differs from reviewed source, abort'}
    if(!$Apply){
        $tx.Rollback()
        Write-Output 'PREFLIGHT_OK SQL V19 Published r11 unchanged; V2 Draft r6 exact match; candidate objects=56 connections=51 main=42pts/46edges; no database writes'
        return
    }
    $payloadParam=$cmd.Parameters.Add('@payload',[Data.SqlDbType]::NVarChar,-1)
    $payloadParam.Value=$candidateText
    $cmd.CommandText=@'
UPDATE dbo.DigitalTwinScenes
SET DraftPayload=@payload,Revision=Revision+1,UpdatedAt=SYSUTCDATETIME(),UpdatedBy='studio-v2-blue-arrow-bagging-r7'
WHERE Id=@id AND Status='Draft' AND Revision=6
  AND SceneKey='studio-v2-copy-reference-v19-20261116' AND Deleted=0;
'@
    if($cmd.ExecuteNonQuery() -ne 1){throw 'Expected exactly one V2 draft row updated'}
    $cmd.CommandText="SELECT DraftPayload FROM dbo.DigitalTwinScenes WHERE Id=@id AND Revision=7 AND Status='Draft'"
    if(([string]$cmd.ExecuteScalar()) -cne $candidateText){throw 'V2 r7 database roundtrip mismatch'}
    $paramId.Value=$sourceId
    $cmd.CommandText="SELECT DraftPayload FROM dbo.DigitalTwinScenes WHERE Id=@id AND Revision=11 AND Status='Published'"
    if(([string]$cmd.ExecuteScalar()) -cne $sourcePayload){throw 'V19 changed, rolling back'}
    $tx.Commit()
    Write-Output 'COMMITTED Studio V2 Draft r7: 56 objects / 51 connections / 42 main points / 46 edges / four physical bagging conveyors, V19 unchanged'
}catch{
    if($tx){try{$tx.Rollback()}catch{}}
    throw
}finally{
    if($tx){$tx.Dispose()}
    $cn.Dispose()
}
