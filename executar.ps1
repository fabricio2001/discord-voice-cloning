$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectDir
$env:HF_HOME = Join-Path $projectDir 'models\huggingface'
$env:TORCH_HOME = Join-Path $projectDir 'models\torch'
& .\.venv\Scripts\python.exe .\clone_sample.py @args
