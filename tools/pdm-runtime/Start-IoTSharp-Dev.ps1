# Start the IoTSharp development web host under Windows Task Scheduler.
# Safety: localhost only. Existing IoTSharp internal work orders can be
# queried and managed against the isolated development database. P1 live
# evaluation, automatic order creation and Feishu sending remain disabled.
# No secrets are written into this script or the scheduled task.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dll = Join-Path $root 'IoTSharp\bin\Debug\net10.0\IoTSharp.dll'
if (-not (Test-Path -LiteralPath $dll)) {
    throw "Build IoTSharp .NET 10 before starting the PdM development host."
}
$env:ASPNETCORE_ENVIRONMENT = 'Development'
$env:ASPNETCORE_URLS = 'http://127.0.0.1:5088'
$env:Database__AutoMigrate = 'false'
$env:PredictiveMaintenance__Enabled = 'false'
$env:PredictiveMaintenance__WorkOrders__Enabled = 'true'
$env:PredictiveMaintenance__WorkOrders__SchemaReady = 'true'
$env:PredictiveMaintenance__WorkOrders__AutoCreateEnabled = 'false'
$env:PredictiveMaintenance__WorkOrders__ManualCreateEnabled = 'false'
$env:PredictiveMaintenance__WorkOrders__Feishu__Enabled = 'false'
$env:ConnectionStrings__PdmWorkOrders = 'Server=.\MSSQ;Database=IoTSharpPdmDev;Integrated Security=True;TrustServerCertificate=True'
$log = Join-Path $env:LOCALAPPDATA 'IoTSharp-PdM-Dev'
[void](New-Item -ItemType Directory -Force -Path $log)
Push-Location (Split-Path -Parent $dll)
try {
    & dotnet $dll --environment Development --urls http://127.0.0.1:5088 --Database:AutoMigrate false --PredictiveMaintenance:Enabled false --PredictiveMaintenance:WorkOrders:Enabled true --PredictiveMaintenance:WorkOrders:SchemaReady true --PredictiveMaintenance:WorkOrders:AutoCreateEnabled false --PredictiveMaintenance:WorkOrders:ManualCreateEnabled false --PredictiveMaintenance:WorkOrders:Feishu:Enabled false *> (Join-Path $log 'web-host.log')
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
