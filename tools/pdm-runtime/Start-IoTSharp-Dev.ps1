# Start the IoTSharp development web host under Windows Task Scheduler.
# Safety: localhost only; P1 live worker, automatic work orders and Feishu
# sending remain disabled until field mappings and delivery route are approved.
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
$env:PredictiveMaintenance__WorkOrders__Enabled = 'false'
$log = Join-Path $env:LOCALAPPDATA 'IoTSharp-PdM-Dev'
[void](New-Item -ItemType Directory -Force -Path $log)
Push-Location (Split-Path -Parent $dll)
try {
    & dotnet $dll --environment Development --urls http://127.0.0.1:5088 --Database:AutoMigrate false --PredictiveMaintenance:Enabled false --PredictiveMaintenance:WorkOrders:Enabled false *> (Join-Path $log 'web-host.log')
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
