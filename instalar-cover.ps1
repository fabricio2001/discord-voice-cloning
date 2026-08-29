$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$seedRevision = '51383efd921027683c89e5348211d93ff12ac2a8'
Push-Location -LiteralPath $projectDir
try {
    if (!(Test-Path -LiteralPath '.cover-venv\Scripts\python.exe')) {
        & py -3.12 -m venv .cover-venv
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao criar o ambiente Python 3.12.' }
    }
    if (!(Test-Path -LiteralPath 'engines\seed-vc')) {
        & git clone https://github.com/Plachtaa/seed-vc.git engines/seed-vc
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao baixar Seed-VC.' }
        & git -C engines/seed-vc checkout $seedRevision
        if ($LASTEXITCODE -ne 0) { throw 'Falha ao selecionar a revisão testada.' }
    }
    $revision = & git -C engines/seed-vc rev-parse HEAD
    if ($revision -ne $seedRevision) { throw 'A instalação Seed-VC tem outra revisão. Não será alterada automaticamente.' }
    & .\.cover-venv\Scripts\python.exe -m pip install --upgrade pip --timeout 180
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao preparar pip.' }
    & .\.cover-venv\Scripts\python.exe -m pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cu124 --timeout 180
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar PyTorch CUDA.' }
    & .\.cover-venv\Scripts\python.exe -m pip install -r cover-requirements.txt --timeout 180
    if ($LASTEXITCODE -ne 0) { throw 'Falha ao instalar dependências de cover.' }
    & .\.cover-venv\Scripts\python.exe verificar-cover.py
    if ($LASTEXITCODE -ne 0) { throw 'A verificação do ambiente falhou.' }
    Write-Output 'Runtime de cover instalado. Os modelos serão baixados no primeiro processamento.'
} finally {
    Pop-Location
}
