#Requires -Version 7.0
# Development SQL Server only; STRICT one-time V2 Draft r11 -> Draft r12.
# Original Published V19 is read-only, all mutations inside one transaction.
# Isolated preview carrier is NOT a claimed handoff of the 108 real main pallets.
param([string]$Candidate='ClientApp/.tmp-studio-v2-cache-independent-r12-candidate.json')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$targetId=[guid]'d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94'
$originalId=[guid]'69a6b03a-0a0c-45e9-b3c1-f29bcaeb142e'
$expectedR11='6C14270B559563EFB590EC971D08B506E3A83CD7A0E06FD7449894BBE59CA81C'
$expectedV19='470C08343F35E5671B38455D3018CA15C1A726FD8AB7E2AD4D93A1DD24393B66'
if(-not(Test-Path $Candidate)){throw "No reviewed r12 candidate: $Candidate"}
$payload=[IO.File]::ReadAllText((Resolve-Path $Candidate).Path)
$m=$payload|ConvertFrom-Json
$blue=@($m.objects|Where-Object objectId -eq 'studio-v2-surplus-silk-handoff-roller')
$red=@($m.objects|Where-Object objectId -eq 'studio-v2-surplus-silk-empty-return-roller')
$turn=@($m.objects|Where-Object objectId -eq 'studio-v2-cache-pallet-empty-u-turn')
$left=@($m.objects|Where-Object objectId -eq 'reference-double-small-upper-left')
$route=@($m.routes|Where-Object routeId -eq 'studio-v2-surplus-silk-bidirectional-handoff')
$main=@($m.routes|Where-Object routeId -eq 'component-route-d045206d')
$init=@($m.runtime.routePalletInitializers|Where-Object routeId -eq 'component-route-d045206d')
if([guid]$m.sceneId -ne $targetId -or $m.objects.Count -ne 58 -or
  $m.connections.Count -ne 53 -or $m.routes.Count -ne 5 -or
  $blue.Count -ne 1 -or $red.Count -ne 1 -or $turn.Count -ne 1 -or
  $left.Count -ne 1 -or $route.Count -ne 1 -or $main.Count -ne 1 -or
  $init.Count -ne 1 -or $route[0].points.Count -ne 7 -or
  $route[0].edges.Count -ne 6 -or $main[0].points.Count -ne 42 -or
  $main[0].edges.Count -ne 46 -or $init[0].simulationDefaultCount -ne 108) {
  throw 'r12 scene manifest differs from exact verified scope; SQL untouched'
}
if($blue[0].component.componentType -ne 'roller-conveyor' -or
  $red[0].component.componentType -ne 'roller-conveyor' -or
  [math]::Abs([double]$blue[0].transform.position[2] + 6.25) -gt .00001 -or
  [math]::Abs([double]$red[0].transform.position[2] + 4.35) -gt .00001 -or
  [math]::Abs([double]$blue[0].component.properties.length - 11.4) -gt .00001 -or
  [math]::Abs([double]$red[0].component.properties.length - 11.4) -gt .00001 -or
  $red[0].component.properties.emptyPalletOnly -ne $true -or
  [math]::Abs([double]$blue[0].transform.rotation[1]) -gt .00001 -or
  [math]::Abs([math]::Abs([double]$red[0].transform.rotation[1])-[math]::PI) -gt .00001 -or
  [math]::Abs([double]$turn[0].transform.position[2]+5.3) -gt .00001 -or
  $turn[0].component.properties.sweepDegrees -ne 180 -or
  $route[0].transportUnitResourceKey -ne 'builtin-small-pallet') {
  throw 'Expected blue (former lower) and new lower independent red conveyor geometry absent'
}
$tap=@($left[0].component.properties.routeTaps|Where-Object tapId -eq 'cache-empty-lower-return')
if($tap.Count -ne 1 -or [math]::Abs([double]$tap[0].localX + .6) -gt .00001){throw 'Wrong red empty return midspan connection'}
$links=@(
  @('studio-v2-cache-loaded-east-to-empty-u-input','studio-v2-surplus-silk-handoff-roller','output','studio-v2-cache-pallet-empty-u-turn','input'),
  @('studio-v2-cache-u-output-to-empty-return-b','studio-v2-cache-pallet-empty-u-turn','output','studio-v2-surplus-silk-empty-return-roller','input'),
  @('studio-v2-cache-red-lower-empty-return-to-left-downward-lane','studio-v2-surplus-silk-empty-return-roller','output','reference-double-small-upper-left','a-cache-empty-lower-return')
)
foreach($spec in $links){
  $match=@($m.connections|Where-Object connectionId -eq $spec[0])
  if($match.Count -ne 1 -or $match[0].from.objectId -ne $spec[1] -or
     $match[0].from.portId -ne $spec[2] -or $match[0].to.objectId -ne $spec[3] -or
     $match[0].to.portId -ne $spec[4]){throw "Physical handoff link mismatch: $($spec[0])"}
}
function HashSql([string]$value){
  return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::Unicode.GetBytes($value)))
}
$cn=[Data.SqlClient.SqlConnection]::new('Server=DESKTOP-2ALRK02\MSSQ;Database=IOTSharp;Integrated Security=True;Encrypt=False;TrustServerCertificate=True')
$tx=$null
function ReadScene([guid]$id){
  $cmd=$cn.CreateCommand();$cmd.Transaction=$tx
  $cmd.CommandText='SELECT DraftPayload FROM dbo.DigitalTwinScenes WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id AND Deleted=0'
  $null=$cmd.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier);$cmd.Parameters['@id'].Value=$id
  try {return [string]$cmd.ExecuteScalar()}finally{$cmd.Dispose()}
}
try{
  $cn.Open()
  $tx=$cn.BeginTransaction([Data.IsolationLevel]::Serializable)
  $baselineV19=ReadScene $originalId
  $baselineR11=ReadScene $targetId
  if((HashSql $baselineV19) -cne $expectedV19){throw 'Original V19 Published baseline changed, abort'}
  if((HashSql $baselineR11) -cne $expectedR11){throw 'Studio V2 r11 changed concurrently, abort'}
  $cmd=$cn.CreateCommand();$cmd.Transaction=$tx
  $cmd.CommandText=@'
UPDATE dbo.DigitalTwinScenes SET DraftPayload=@payload,
  Revision=Revision+1, UpdatedAt=SYSUTCDATETIME(),
  UpdatedBy='studio-v2-r12-separate-blue-red-rollers'
WHERE Id=@id AND Status='Draft' AND Revision=11
  AND SceneKey='studio-v2-copy-reference-v19-20261116'
  AND Deleted=0
  AND CONVERT(varchar(64),HASHBYTES('SHA2_256',DraftPayload),2)=@hash;
'@
  $null=$cmd.Parameters.Add('@payload',[Data.SqlDbType]::NVarChar,-1)
  $cmd.Parameters['@payload'].Value=$payload
  $null=$cmd.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier)
  $cmd.Parameters['@id'].Value=$targetId
  $null=$cmd.Parameters.Add('@hash',[Data.SqlDbType]::VarChar,64)
  $cmd.Parameters['@hash'].Value=$expectedR11
  if($cmd.ExecuteNonQuery() -ne 1){throw 'Expected precisely one isolated V2 Draft r11 row'}
  $cmd.Dispose()
  if((ReadScene $targetId) -cne $payload){throw 'V2 r12 SQL write-readback differs'}
  if((ReadScene $originalId) -cne $baselineV19){throw 'Published V19 changed, rollback'}
  $check=$cn.CreateCommand();$check.Transaction=$tx
  $check.CommandText='SELECT Revision FROM dbo.DigitalTwinScenes WHERE Id=@id'
  $null=$check.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier)
  $check.Parameters['@id'].Value=$targetId
  if([long]$check.ExecuteScalar() -ne 12){throw 'Unexpected revision after r12 update'}
  $check.Dispose()
  $tx.Commit()
  Write-Output "STUDIO_V2_R12_SAVED=YES hash=$(HashSql $payload)"
  Write-Output "PUBLISHED_V19_UNCHANGED=YES hash=$expectedV19"
  Write-Output 'BLUE_FORMER_LOWER=single-right ; RED_NEW_BELOW=single-left ; MAIN_108_HANDoFF=NOT_VERIFIED'
}catch{
  if($tx){try{$tx.Rollback()}catch{}}
  throw
}finally{
  if($tx){$tx.Dispose()}
  $cn.Dispose()
}
