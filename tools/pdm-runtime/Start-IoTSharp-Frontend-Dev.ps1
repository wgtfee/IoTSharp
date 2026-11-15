# Dedicated IoTSharp Vite frontend, independent from VOL.MES at 9990/9991.
# This is localhost-only and never changes PLC or production alarm switches.
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$client = Join-Path $root 'ClientApp'
$vite = Join-Path $client 'node_modules\vite\bin\vite.js'
if (-not (Test-Path -LiteralPath $vite)) {
    throw 'ClientApp node_modules/vite is missing. Use the existing offline environment.'
}
$env:VITE_PORT = '5173'
$env:VITE_OPEN = 'false'
$env:VITE_PUBLIC_PATH = '/iot/'
$env:VITE_API_PROXY_TARGET = 'http://127.0.0.1:5088'
$logs = Join-Path $env:LOCALAPPDATA 'IoTSharp-PdM-Dev'
[void](New-Item -ItemType Directory -Force -Path $logs)
Push-Location $client
try {
    & node $vite --mode development --host 127.0.0.1 --port 5173 --strictPort *> (Join-Path $logs 'vite-frontend.log')
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
