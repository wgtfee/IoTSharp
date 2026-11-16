#Requires -Version 7.0
# Development-only Studio V2 r9 -> r10. Never modifies Published V19.
# The branch is a verified local Simulation preview until the actual gantry
# pallet transfer and downstream empty-return occupancy handshake are wired.
param([string]$Candidate='ClientApp/.tmp-studio-v2-cache-pallet-u-turn-r10-v2.json')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$targetId=[guid]'d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94'
$sourceId=[guid]'69a6b03a-0a0c-45e9-b3c1-f29bcaeb142e'
$expectedR9='0453C8C7FC27C9BE4194DD03C56A8DD007B466D57228494767565F6E29CC3A8B'
$expectedV19='470C08343F35E5671B38455D3018CA15C1A726FD8AB7E2AD4D93A1DD24393B66'
if(!(Test-Path $Candidate)){throw 'Candidate not found'}
$payload=[IO.File]::ReadAllText((Resolve-Path $Candidate).Path)
$scene=$payload|ConvertFrom-Json
$branch=@($scene.routes|Where-Object routeId -eq 'studio-v2-surplus-silk-bidirectional-handoff')
$main=@($scene.routes|Where-Object routeId -eq 'component-route-d045206d')
$turn=@($scene.objects|Where-Object objectId -eq 'studio-v2-cache-pallet-empty-u-turn')
$init=@($scene.runtime.routePalletInitializers|Where-Object routeId -eq 'component-route-d045206d')
if([guid]$scene.sceneId -ne $targetId -or
  $scene.objects.Count -ne 57 -or $scene.connections.Count -ne 52 -or $scene.routes.Count -ne 5 -or
  $branch.Count -ne 1 -or $main.Count -ne 1 -or $turn.Count -ne 1 -or $init.Count -ne 1 -or
  $branch[0].points.Count -ne 6 -or $branch[0].edges.Count -ne 5 -or
  $main[0].points.Count -ne 42 -or $main[0].edges.Count -ne 46 -or
  $init[0].simulationDefaultCount -ne 108 -or
  $turn[0].component.componentType -ne 'turn-conveyor-90' -or
  $turn[0].resourceId -ne '1711f8bf-37dd-4a22-8371-1e9a3027d5d7' -or
  $turn[0].component.properties.sweepDegrees -ne 180) {
  throw 'Candidate layout differs from validated r10 physical U-turn'
}
$u=@($branch[0].edges|Where-Object edgeId -eq 'surplus-empty-after-pick-u-turn')
if($u.Count -ne 1 -or $u[0].componentObjectId -ne $turn[0].objectId -or $u[0].emptyPalletOnly -ne $true){throw 'Physical empty-pallet U-turn required'}
function HashSql([string]$value){
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::Unicode.GetBytes($value)))
}
$cn=[Data.SqlClient.SqlConnection]::new('Server=DESKTOP-2ALRK02\MSSQ;Database=IOTSharp;Integrated Security=True;Encrypt=False;TrustServerCertificate=True')
$tx=$null
function ReadSql([guid]$id) {
  $cmd=$cn.CreateCommand();$cmd.Transaction=$tx
  $cmd.CommandText='SELECT DraftPayload FROM dbo.DigitalTwinScenes WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id AND Deleted=0'
  $null=$cmd.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier)
  $cmd.Parameters['@id'].Value=$id
  try {return [string]$cmd.ExecuteScalar()}finally{$cmd.Dispose()}
}
try{
  $cn.Open()
  $tx=$cn.BeginTransaction([Data.IsolationLevel]::Serializable)
  $v19=ReadSql $sourceId
  $r9=ReadSql $targetId
  if((HashSql $v19) -cne $expectedV19){throw 'Original V19 protected hash changed'}
  if((HashSql $r9) -cne $expectedR9){throw 'V2 current r9 differs from last verified readback, abort'}
  $cmd=$cn.CreateCommand();$cmd.Transaction=$tx
  $cmd.CommandText=@'
UPDATE dbo.DigitalTwinScenes
SET DraftPayload=@payload,Revision=Revision+1,
  UpdatedAt=SYSUTCDATETIME(),UpdatedBy='studio-v2-r10-empty-pallet-u-turn'
WHERE Id=@id AND Status='Draft' AND Revision=9
AND SceneKey='studio-v2-copy-reference-v19-20261116' AND Deleted=0
AND CONVERT(varchar(64),HASHBYTES('SHA2_256',DraftPayload),2)=@hash;
'@
  $null=$cmd.Parameters.Add('@payload',[Data.SqlDbType]::NVarChar,-1)
  $cmd.Parameters['@payload'].Value=$payload
  $null=$cmd.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier)
  $cmd.Parameters['@id'].Value=$targetId
  $null=$cmd.Parameters.Add('@hash',[Data.SqlDbType]::VarChar,64)
  $cmd.Parameters['@hash'].Value=$expectedR9
  if($cmd.ExecuteNonQuery() -ne 1){throw 'No unique V2 r9 Draft row updated'}
  $cmd.Dispose()
  if((ReadSql $targetId) -cne $payload){throw 'r10 readback differs from tested JSON'}
  if((ReadSql $sourceId) -cne $v19){throw 'Original V19 changed; abort'}
  $q=$cn.CreateCommand();$q.Transaction=$tx
  $q.CommandText='SELECT Revision FROM dbo.DigitalTwinScenes WHERE Id=@id'
  $null=$q.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier);$q.Parameters['@id'].Value=$targetId
  if([long]$q.ExecuteScalar() -ne 10){throw 'Revision after transaction update must be r10'}
  $q.Dispose()
  $tx.Commit()
  Write-Output "STUDIO_V2_R10_SAVED=YES sha256=$(HashSql $payload)"
  Write-Output "PUBLISHED_V19_UNCHANGED=YES sha256=$expectedV19"
  Write-Output 'SIMULATION_ONLY=YES ; UPSTREAM_AND_DOWNSTREAM_MAIN_LOOP_HANDOFF=NOT_VERIFIED'
}catch{
  if($tx){try{$tx.Rollback()}catch{}}
  throw
}finally{
  if($tx){$tx.Dispose()}
  $cn.Dispose()
}
