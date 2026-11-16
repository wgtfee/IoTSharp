#Requires -Version 7.0
# One-time isolated development SQL Server Studio V2 Draft r14 -> Draft r15.
# Never modifies original Published V19 or sends PLC/MES/robot commands.
# Full-span right/down -> west across floor -> left/down return already existed
# logically. Adds two PHYSICAL 90° connections without changing main route.
param([string]$Candidate='ClientApp/.tmp-studio-v2-full-span-square-elbows-r15-candidate.json')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$v2=[guid]'d7c2dfdf-39bf-4e69-a2c4-587cfaf63c94'
$v19=[guid]'69a6b03a-0a0c-45e9-b3c1-f29bcaeb142e'
$r14Hash='38334FB421D0BF55BC6590988D298EDC9E5BBA34106ADBAE99877680F8B47B74'
$v19Hash='470C08343F35E5671B38455D3018CA15C1A726FD8AB7E2AD4D93A1DD24393B66'
if(-not(Test-Path $Candidate)){throw "No browser-tested r15 JSON: $Candidate"}
$payload=[IO.File]::ReadAllText((Resolve-Path $Candidate).Path)
$m=$payload|ConvertFrom-Json
$full=@($m.objects|Where-Object objectId -eq 'reference-conveyor-ref-empty-return-merge')
$right=@($m.objects|Where-Object objectId -eq 'reference-conveyor-ref-empty-return-down')
$left=@($m.objects|Where-Object objectId -eq 'reference-conveyor-ref-return-edge-outer-down')
$merger=@($m.objects|Where-Object objectId -eq 'reference-gantry-merger')
$blue=@($m.objects|Where-Object objectId -eq 'reference-conveyor-ref-edge-loaded-upper-right-in')
$red=@($m.objects|Where-Object objectId -eq 'studio-v2-surplus-silk-empty-return-roller')
$main=@($m.routes|Where-Object routeId -eq 'component-route-d045206d')
$local=@($m.routes|Where-Object routeId -eq 'studio-v2-surplus-silk-bidirectional-handoff')
$init=@($m.runtime.routePalletInitializers|Where-Object routeId -eq 'component-route-d045206d')
if([guid]$m.sceneId -ne $v2 -or $m.objects.Count -ne 58 -or
  $m.connections.Count -ne 55 -or $m.routes.Count -ne 5 -or
  $full.Count -ne 1 -or $right.Count -ne 1 -or $left.Count -ne 1 -or
  $merger.Count -ne 1 -or $blue.Count -ne 1 -or $red.Count -ne 1 -or
  $main.Count -ne 1 -or $local.Count -ne 1 -or $init.Count -ne 1 -or
  $main[0].points.Count -ne 42 -or $main[0].edges.Count -ne 46 -or
  $local[0].points.Count -ne 7 -or $local[0].edges.Count -ne 6 -or
  $init[0].simulationDefaultCount -ne 108) {
  throw 'Candidate differs from tested r15 object/route counts, abort'
}
if($full[0].component.componentType -ne 'roller-conveyor' -or
  $full[0].component.properties.fullSpanTwoSquareElbows -ne $true -or
  $full[0].component.properties.squareCornerSequence -ne 'right-down-west-left-down' -or
  $full[0].component.properties.emptySmallPalletOnly -ne $true -or
  $merger[0].component.properties.emptyReturnSquareThirdInput -ne $true -or
  [math]::Abs([double]$full[0].component.properties.length-25.4) -gt .00001 -or
  [math]::Abs([double]$right[0].transform.position[0]-10.8) -gt .00001 -or
  [math]::Abs([double]$right[0].transform.position[2]-7.9) -gt .00001 -or
  [math]::Abs([double]$left[0].transform.position[0]+14.6) -gt .00001 -or
  [math]::Abs([double]$left[0].transform.position[2]-12.1) -gt .00001 -or
  [math]::Abs([double]$red[0].component.properties.length-
    [double]$blue[0].component.properties.length/2) -gt .00001) {
  throw 'Physical right/left 90° corner or local half-red geometry invalid'
}
$links=@(
  @('reference-conveyor-ref-empty-return-down','output','reference-conveyor-ref-empty-return-merge','square-right-input'),
  @('reference-conveyor-ref-empty-return-merge','output','reference-gantry-merger','empty-return-square-input')
)
foreach($spec in $links) {
  $c=@($m.connections|Where-Object { $_.from.objectId -eq $spec[0] -and
    $_.from.portId -eq $spec[1] -and $_.to.objectId -eq $spec[2] -and
    $_.to.portId -eq $spec[3] })
  if($c.Count -ne 1){throw "Right-angle physical connection missing: $($spec -join ':')"}
}
function Sha([string]$value) {
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::Unicode.GetBytes($value)))
}
$connection=[Data.SqlClient.SqlConnection]::new(
  'Server=DESKTOP-2ALRK02\MSSQ;Database=IOTSharp;Integrated Security=True;Encrypt=False;TrustServerCertificate=True')
$tx=$null
function ReadScene([guid]$id) {
  $q=$connection.CreateCommand();$q.Transaction=$tx
  $q.CommandText='SELECT DraftPayload FROM dbo.DigitalTwinScenes WITH(UPDLOCK,HOLDLOCK) WHERE Id=@id AND Deleted=0'
  $null=$q.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier)
  $q.Parameters['@id'].Value=$id
  try {return [string]$q.ExecuteScalar()} finally {$q.Dispose()}
}
try {
  $connection.Open()
  $tx=$connection.BeginTransaction([Data.IsolationLevel]::Serializable)
  $protected=ReadScene $v19
  $old=ReadScene $v2
  if((Sha $protected) -cne $v19Hash){throw 'Published V19 SHA changed; refuse write'}
  if((Sha $old) -cne $r14Hash){throw 'Studio V2 Draft r14 SHA changed; refuse stale update'}
  $q=$connection.CreateCommand();$q.Transaction=$tx
  $q.CommandText=@'
UPDATE dbo.DigitalTwinScenes SET DraftPayload=@payload,
  Revision=Revision+1,UpdatedAt=SYSUTCDATETIME(),
  UpdatedBy='studio-v2-r15-full-span-two-square-elbows'
WHERE Id=@id AND Status='Draft' AND Revision=14
  AND SceneKey='studio-v2-copy-reference-v19-20261116'
  AND Deleted=0
  AND CONVERT(varchar(64),HASHBYTES('SHA2_256',DraftPayload),2)=@hash;
'@
  $null=$q.Parameters.Add('@payload',[Data.SqlDbType]::NVarChar,-1)
  $q.Parameters['@payload'].Value=$payload
  $null=$q.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier)
  $q.Parameters['@id'].Value=$v2
  $null=$q.Parameters.Add('@hash',[Data.SqlDbType]::VarChar,64)
  $q.Parameters['@hash'].Value=$r14Hash
  if($q.ExecuteNonQuery() -ne 1){throw 'Exactly one V2 Draft r14 update expected'}
  $q.Dispose()
  if((ReadScene $v2) -cne $payload){throw 'r15 transaction readback differs from browser-tested candidate'}
  if((ReadScene $v19) -cne $protected){throw 'Original V19 modified; rollback'}
  $q=$connection.CreateCommand();$q.Transaction=$tx
  $q.CommandText='SELECT Revision FROM dbo.DigitalTwinScenes WHERE Id=@id'
  $null=$q.Parameters.Add('@id',[Data.SqlDbType]::UniqueIdentifier)
  $q.Parameters['@id'].Value=$v2
  if([long]$q.ExecuteScalar() -ne 15){throw 'Expected r15 revision after update'}
  $q.Dispose()
  $tx.Commit()
  Write-Output "STUDIO_V2_R15_SAVED=YES hash=$(Sha $payload)"
  Write-Output "PUBLISHED_V19_UNCHANGED=YES hash=$v19Hash"
  Write-Output 'FULL_SPAN_EMPTY_PALLET_SQUARE_CORNERS=2; ROBOT_LOWER_RED_HALF_PRESERVED=YES; MAIN_108_HANDOFF=NOT_VERIFIED'
}catch{
  if($tx){try{$tx.Rollback()}catch{}}
  throw
}finally{
  if($tx){$tx.Dispose()}
  $connection.Dispose()
}
