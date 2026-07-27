$ErrorActionPreference = "Stop"

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Here

if (-not (Get-Command py -ErrorAction SilentlyContinue)) {
  throw "Python Launcher (py.exe) is required to build the simulator."
}

py -3.12 -m venv .venv
& .\.venv\Scripts\python.exe -m pip install --upgrade pip pyinstaller
& .\.venv\Scripts\pyinstaller.exe `
  --noconfirm `
  --clean `
  --onefile `
  --windowed `
  --name ClaimGuardSchemeSimulator `
  simulator.py

Copy-Item schemes.example.json dist\schemes.example.json -Force
Write-Host "Built dist\ClaimGuardSchemeSimulator.exe"
Write-Host "Copy schemes.example.json to schemes.json and configure the scheme profiles before running."
