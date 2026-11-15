$ErrorActionPreference = 'Stop'
$sourceConfig = Join-Path $PSScriptRoot '..\..\IoTSharp\appsettings.Development.json'
$mesConfig = 'H:\code\BS\Vue.NetCore-master\vol.api.sqlsugar\VOL.WebApi\appsettings.Local.json'
$keyFile = Join-Path $env:LOCALAPPDATA 'IoTSharpMesDevIntegration\sharedsecret.dpapi'
if (!(Test-Path $sourceConfig) -or !(Test-Path $mesConfig) -or !(Test-Path $keyFile)) {
    throw 'Real dev integration prerequisites are missing.'
}
$source = Get-Content $sourceConfig -Raw | ConvertFrom-Json -AsHashtable
$vol = Get-Content $mesConfig -Raw | ConvertFrom-Json -AsHashtable
$metadata = [System.Data.SqlClient.SqlConnectionStringBuilder]::new($source.ConnectionStrings.IoTSharp)
$metadata['Initial Catalog'] = 'IoTSharpPdmDev'
$secure = ConvertTo-SecureString ((Get-Content $keyFile -Raw).Trim())
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $shared = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
$env:IOTSHARP_MES_LIVE_DEV='YES'
$env:IOTSHARP_MES_PDM_CONNECTION=$metadata.ConnectionString
$env:IOTSHARP_MES_BUSINESS_CONNECTION=$vol.Connection[1].ConnectionString
$env:IOTSHARP_MES_SYSTEM_CONNECTION=$vol.Connection[0].ConnectionString
$env:IOTSHARP_MES_DEV_SHAREDSECRET=$shared
$env:IOTSHARP_MES_DEV_KEYID='iotsharp_dev_machine_20261115'
$env:IOTSHARP_MES_DEV_ENDPOINT='http://127.0.0.1:9991/api/integration/iotsharp/events'
$qaPath=Join-Path $env:LOCALAPPDATA 'IoTSharpMesDevIntegration\acceptance\test-user.json'
if(Test-Path $qaPath) {
    $qa=Get-Content $qaPath -Raw|ConvertFrom-Json
    if(!$qa.Disabled -and $qa.UserName -match '^iotqa_[a-f0-9]{12}$') {
        $env:IOTSHARP_MES_QA_RECIPIENT=$qa.UserName
    }
}
Write-Output 'Starting real IoTSharp risk+Outbox against local MES development HTTP/SQL (synthetic only)'
& dotnet run --project (Join-Path $PSScriptRoot 'IoTSharp.MesIntegration.LiveDev.csproj') --no-build --no-restore -c Debug
exit $LASTEXITCODE
