#Requires -Version 7.0
# One-time guarded update of Studio V2 Draft r13 -> Draft r14 (development SQL).
# Source V19 Published stays strictly read-only. Main 108-pallet RouteSlot
# identity handoff/occupancy is NOT implemented; simulation preview only.
param([string]$Candidate='ClientApp/.tmp-studio-v2-half-lower-square-up-r14-candidate.json')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$v2=[guid]'d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94'
$v19=[guid]'69a6b03a-0a0c-45e9-b3c1-f29bcaeb142e'
$r13Hash='EB32032A3BCC0B5166DC24002AA6375771FDFC7B16BE4D577079955F2959617F'
$v19Hash='470C08343F35E5671B38455D3018CA15C1A726FD8AB7E2AD4D93A1DD24393B66'
if(-not(Test-Path $Candidate)){throw "Missing reviewed r14 candidate $Candidate"}
$payload=[IO.File]::ReadAllText((Resolve-Path $Candidate).Path)
$manifest=$payload|ConvertFrom-Json
$blue=@($manifest.objects|Where-Object objectId -eq 'reference-conveyor-ref-edge-loaded-upper-right-in')
$red=@($manifest.objects|Where-Object objectId -eq 'studio-v2-surplus-silk-empty-return-roller')
$leftUp=@($manifest.objects|Where-Object objectId -eq 'studio-v2-cache-empty-left-square-up')
$oldLeft=@($manifest.objects|Where-Object objectId -eq 'reference-double-small-upper-left')
$route=@($manifest.routes|Where-Object routeId -eq 'studio-v2-surplus-silk-bidirectional-handoff')
$main=@($manifest.routes|Where-Object routeId -eq 'component-route-d045206d')
$init=@($manifest.runtime.routePalletInitializers|Where-Object routeId -eq 'component-route-d045206d')
if([guid]$manifest.sceneId -ne $v2 -or
  $manifest.objects.Count -ne 58 -or $manifest.connections.Count -ne 54 -or
  $manifest.routes.Count -ne 5 -or
  $blue.Count -ne 1 -or $red.Count -ne 1 -or $leftUp.Count -ne 1 -or
  $oldLeft.Count -ne 1 -or $route.Count -ne 1 -or $main.Count -ne 1 -or
  $init.Count -ne 1 -or $main[0].points.Count -ne 42 -or
  $main[0].edges.Count -ne 46 -or $route[0].points.Count -ne 7 -or
  $route[0].edges.Count -ne 6 -or $init[0].simulationDefaultCount -ne 108) {
  throw 'r14 candidate object graph is not the tested half-red-square-up layout'
}
$blueLen=[double]$blue[0].component.properties.length
$redLen=[double]$red[0].component.properties.length
if($blue[0].component.properties.cacheBranchOutput -ne $true -or
  $blue[0].component.properties.cacheReturnEntry -ne $true -or
  $red[0].component.properties.halfOfBlue -ne $true -or
  $red[0].component.properties.emptyPalletOnly -ne $true -or
  [math]::Abs($blueLen-15.7) -gt .00001 -or
  [math]::Abs($redLen-$blueLen/2) -gt .00001 -or
  [math]::Abs([double]$red[0].transform.position[0]-.975) -gt .00001 -or
  [math]::Abs([double]$red[0].transform.position[2]+3.4) -gt .00001 -or
  $leftUp[0].component.componentType -ne 'roller-conveyor' -or
  $leftUp[0].component.properties.squareRightAngleTransfer -ne $true -or
  $leftUp[0].component.properties.rounded -ne $false -or
  [math]::Abs([double]$leftUp[0].component.properties.length-1.9) -gt .00001 -or
  [math]::Abs([double]$leftUp[0].transform.position[0]+2.95) -gt .00001 -or
  [math]::Abs([double]$leftUp[0].transform.position[2]+4.35) -gt .00001 -or
  [math]::Abs([double]$leftUp[0].transform.rotation[1]-[math]::PI/2) -gt .00001) {
  throw 'r14 red length or left-side square up connector is invalid'
}
if(@($oldLeft[0].component.properties.routeTaps|Where-Object tapId -eq 'cache-empty-lower-return').Count -ne 0 -or
  @($manifest.connections|Where-Object connectionId -eq 'studio-v2-cache-red-lower-empty-return-to-left-downward-lane').Count -ne 0) {
  throw 'Obsolete long left return still exists'
}
$links=@(
  @('studio-v2-cache-red-west-to-left-square-up','studio-v2-surplus-silk-empty-return-roller','output','studio-v2-cache-empty-left-square-up','input'),
  @('studio-v2-cache-left-square-up-to-main-blue','studio-v2-cache-empty-left-square-up','output','reference-conveyor-ref-edge-loaded-upper-right-in','cache-return-entry')
)
foreach($spec in $links){
  $c=@($manifest.connections|Where-Object connectionId -eq $spec[0])
  if($c.Count -ne 1 -or $c[0].from.objectId -ne $spec[1] -or
    $c[0].from.portId -ne $spec[2] -or $c[0].to.objectId -ne $spec[3] -or
    $c[0].to.portId -ne $spec[4]){throw "Required 90-degree connector missing: $($spec[0])"}
}
function HashPayload([string]$s) {
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::Unicode.GetBytes($s)))
}
$cn=[Data.SqlClient.SqlConnection]::new(
  'Server=DESKTOP-2ALRK02\MSSQ;Database=IOTSharp;Integrated Security=True;Encrypt=False;TrustServerCertificate=True')
$tx=$null
function ReadScene([guid]$id) {
  $q=$cn.CreateCommand();$q.Transaction=$tx
  $q.CommandText='SELECT DraftPayload FROM dbo.DigitalTwinScenes WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id AND Deleted=0'
  $null=$q.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier)
  $q.Parameters['@id'].Value=$id
  try {return [string]$q.ExecuteScalar()} finally {$q.Dispose()}
}
try {
  $cn.Open()
  $tx=$cn.BeginTransaction([Data.IsolationLevel]::Serializable)
  $protected=ReadScene $v19
  $old=ReadScene $v2
  if((HashPayload $protected) -cne $v19Hash){throw 'Original V19 SHA changed; abort without write'}
  if((HashPayload $old) -cne $r13Hash){throw 'V2 Draft r13 changed; abort without overwrite'}
  $q=$cn.CreateCommand();$q.Transaction=$tx
  $q.CommandText=@'
UPDATE dbo.DigitalTwinScenes SET DraftPayload=@payload,
  Revision=Revision+1, UpdatedAt=SYSUTCDATETIME(),
  UpdatedBy='studio-v2-r14-half-red-left-square-up'
WHERE Id=@id AND Status='Draft' AND Revision=13
  AND SceneKey='studio-v2-copy-reference-v19-20261116'
  AND Deleted=0
  AND CONVERT(varchar(64),HASHBYTES('SHA2_256',DraftPayload),2)=@hash;
'@
  $null=$q.Parameters.Add('@payload',[Data.SqlDbType]::NVarChar,-1)
  $q.Parameters['@payload'].Value=$payload
  $null=$q.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier)
  $q.Parameters['@id'].Value=$v2
  $null=$q.Parameters.Add('@hash',[Data.SqlDbType]::VarChar,64)
  $q.Parameters['@hash'].Value=$r13Hash
  if($q.ExecuteNonQuery() -ne 1){throw 'Expected exactly one r13 V2 Draft update'}
  $q.Dispose()
  if((ReadScene $v2) -cne $payload){throw 'r14 SQL write-readback differs from browser candidate'}
  if((ReadScene $v19) -cne $protected){throw 'Original V19 modified; rollback'}
  $verify=$cn.CreateCommand();$verify.Transaction=$tx
  $verify.CommandText='SELECT Revision FROM dbo.DigitalTwinScenes WHERE Id=@id'
  $null=$verify.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier)
  $verify.Parameters['@id'].Value=$v2
  if([long]$verify.ExecuteScalar() -ne 14){throw 'Unexpected V2 revision after update'}
  $verify.Dispose()
  $tx.Commit()
  Write-Output "STUDIO_V2_R14_SAVED=YES hash=$(HashPayload $payload)"
  Write-Output "PUBLISHED_V19_R11_UNCHANGED=YES hash=$v19Hash"
  Write-Output 'LOWER_RED_HALF_UPPER_BLUE=YES; LEFT_90_DEGREE_UP_RETURN=YES; MAIN_108_HANDOFF=NOT_VERIFIED'
}catch{
  if($tx){try{$tx.Rollback()}catch{}}
  throw
}finally{
  if($tx){$tx.Dispose()}
  $cn.Dispose()
}
