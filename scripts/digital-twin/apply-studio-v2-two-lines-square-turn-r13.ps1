#Requires -Version 7.0
# One-time development SQL Server Studio V2 Draft r12 -> r13.
# Original Published V19 strictly read-only. Not a PLC/MES equipment operation.
# r13 reuses the EXISTING 108-pallet main loaded conveyor; only a separately
# labeled simulation preview port is added. Production diversion needs a true
# RouteSlot pallet identity and occupancy handshake; not claimed here.
param([string]$Candidate='ClientApp/.tmp-studio-v2-two-lines-square-turn-r13-v2.json')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$v2=[guid]'d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94'
$v19=[guid]'69a6b03a-0a0c-45e9-b3c1-f29bcaeb142e'
$r12Sha='B058A208D296082A6AEE6E6595DBBA01C2001C7D6209CA707A892B44C044D990'
$v19Sha='470C08343F35E5671B38455D3018CA15C1A726FD8AB7E2AD4D93A1DD24393B66'
if(-not(Test-Path $Candidate)){throw "Missing r13 pre-tested candidate: $Candidate"}
$payload=[IO.File]::ReadAllText((Resolve-Path $Candidate).Path)
$scene=$payload|ConvertFrom-Json
$blueId='reference-conveyor-ref-edge-loaded-upper-right-in'
$duplicateId='studio-v2-surplus-silk-handoff-roller'
$redId='studio-v2-surplus-silk-empty-return-roller'
$turnId='studio-v2-cache-pallet-empty-u-turn'
$blue=@($scene.objects|Where-Object objectId -eq $blueId)
$duplicate=@($scene.objects|Where-Object objectId -eq $duplicateId)
$red=@($scene.objects|Where-Object objectId -eq $redId)
$turn=@($scene.objects|Where-Object objectId -eq $turnId)
$main=@($scene.routes|Where-Object routeId -eq 'component-route-d045206d')
$handoff=@($scene.routes|Where-Object routeId -eq 'studio-v2-surplus-silk-bidirectional-handoff')
$init=@($scene.runtime.routePalletInitializers|Where-Object routeId -eq 'component-route-d045206d')
if([guid]$scene.sceneId -ne $v2 -or
  $scene.objects.Count -ne 57 -or $scene.connections.Count -ne 53 -or
  $scene.routes.Count -ne 5 -or
  $blue.Count -ne 1 -or $duplicate.Count -ne 0 -or
  $red.Count -ne 1 -or $turn.Count -ne 1 -or
  $main.Count -ne 1 -or $handoff.Count -ne 1 -or $init.Count -ne 1 -or
  $main[0].points.Count -ne 42 -or $main[0].edges.Count -ne 46 -or
  $handoff[0].points.Count -ne 7 -or $handoff[0].edges.Count -ne 6 -or
  $init[0].simulationDefaultCount -ne 108) {
  throw 'Candidate is not the verified r13 2-roller scene'
}
if($blue[0].component.componentType -ne 'roller-conveyor' -or
  $blue[0].component.properties.cacheBranchOutput -ne $true -or
  [math]::Abs([double]$blue[0].transform.position[0]+2.95) -gt .00001 -or
  [math]::Abs([double]$blue[0].transform.position[2]+5.3) -gt .00001 -or
  [math]::Abs([double]$blue[0].component.properties.length-15.7) -gt .00001 -or
  $red[0].component.componentType -ne 'roller-conveyor' -or
  $red[0].component.properties.emptyPalletOnly -ne $true -or
  [math]::Abs([double]$red[0].transform.position[0]+3.9) -gt .00001 -or
  [math]::Abs([double]$red[0].transform.position[2]+3.4) -gt .00001 -or
  [math]::Abs([double]$red[0].component.properties.length-17.6) -gt .00001 -or
  $turn[0].component.componentType -ne 'roller-conveyor' -or
  $turn[0].component.properties.squareRightAngleTransfer -ne $true -or
  $turn[0].component.properties.rounded -ne $false -or
  [math]::Abs([double]$turn[0].component.properties.length-1.9) -gt .00001 -or
  [math]::Abs([double]$turn[0].transform.position[0]-4.9) -gt .00001 -or
  [math]::Abs([double]$turn[0].transform.position[2]+4.35) -gt .00001 -or
  [math]::Abs([double]$turn[0].transform.rotation[1]+[math]::PI/2) -gt .00001) {
  throw 'Wrong blue/red track coordinates or round turn remains in candidate'
}
$specs=@(
  @('studio-v2-cache-loaded-east-to-empty-u-input',$blueId,'cache-branch-output',$turnId,'input'),
  @('studio-v2-cache-u-output-to-empty-return-b',$turnId,'output',$redId,'input'),
  @('studio-v2-cache-red-lower-empty-return-to-left-downward-lane',$redId,'output','reference-double-small-upper-left','a-cache-empty-lower-return')
)
foreach($spec in $specs){
  $c=@($scene.connections|Where-Object connectionId -eq $spec[0])
  if($c.Count -ne 1 -or $c[0].from.objectId -ne $spec[1] -or
    $c[0].from.portId -ne $spec[2] -or $c[0].to.objectId -ne $spec[3] -or
    $c[0].to.portId -ne $spec[4]){throw "Unexpected physical connection $($spec[0])"}
}
function ShaSql([string]$s){
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::Unicode.GetBytes($s)))
}
$connection=[Data.SqlClient.SqlConnection]::new(
  'Server=DESKTOP-2ALRK02\MSSQ;Database=IOTSharp;Integrated Security=True;Encrypt=False;TrustServerCertificate=True')
$tx=$null
function ReadScene([guid]$id){
  $q=$connection.CreateCommand();$q.Transaction=$tx
  $q.CommandText='SELECT DraftPayload FROM dbo.DigitalTwinScenes WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id AND Deleted=0'
  $null=$q.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier);$q.Parameters['@id'].Value=$id
  try{return [string]$q.ExecuteScalar()}finally{$q.Dispose()}
}
try{
  $connection.Open()
  $tx=$connection.BeginTransaction([Data.IsolationLevel]::Serializable)
  $original=ReadScene $v19
  $oldDraft=ReadScene $v2
  if((ShaSql $original) -cne $v19Sha){throw 'Original Published V19 changed, abort without write'}
  if((ShaSql $oldDraft) -cne $r12Sha){throw 'Studio V2 Draft r12 baseline changed, abort without overwrite'}
  $q=$connection.CreateCommand();$q.Transaction=$tx
  $q.CommandText=@'
UPDATE dbo.DigitalTwinScenes SET DraftPayload=@payload,
  Revision=Revision+1,UpdatedAt=SYSUTCDATETIME(),
  UpdatedBy='studio-v2-r13-existing-blue-square-return'
WHERE Id=@id AND Status='Draft' AND Revision=12
  AND SceneKey='studio-v2-copy-reference-v19-20261116'
  AND Deleted=0
  AND CONVERT(varchar(64),HASHBYTES('SHA2_256',DraftPayload),2)=@hash;
'@
  $null=$q.Parameters.Add('@payload',[Data.SqlDbType]::NVarChar,-1)
  $q.Parameters['@payload'].Value=$payload
  $null=$q.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier)
  $q.Parameters['@id'].Value=$v2
  $null=$q.Parameters.Add('@hash',[Data.SqlDbType]::VarChar,64)
  $q.Parameters['@hash'].Value=$r12Sha
  if($q.ExecuteNonQuery() -ne 1){throw 'Expected exact one Draft r12 row; no concurrent writes allowed'}
  $q.Dispose()
  if((ReadScene $v2) -cne $payload){throw 'SQL r13 readback differs from browser-tested candidate'}
  if((ReadScene $v19) -cne $original){throw 'Original V19 was modified; rollback'}
  $check=$connection.CreateCommand();$check.Transaction=$tx
  $check.CommandText='SELECT Revision FROM dbo.DigitalTwinScenes WHERE Id=@id'
  $null=$check.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier)
  $check.Parameters['@id'].Value=$v2
  if([long]$check.ExecuteScalar() -ne 13){throw 'Expected exact r13 revision'}
  $check.Dispose()
  $tx.Commit()
  Write-Output "STUDIO_V2_R13_SAVED=YES hash=$(ShaSql $payload)"
  Write-Output "PUBLISHED_V19_R11_UNCHANGED=YES hash=$v19Sha"
  Write-Output 'TWO_HORIZONTAL_TRACKS=YES; SQUARE_90_DEGREE_CORNERS=YES; MAIN_108_HANDOFF=NOT_VERIFIED'
}catch{
  if($tx){try{$tx.Rollback()}catch{}}
  throw
}finally{
  if($tx){$tx.Dispose()}
  $connection.Dispose()
}
