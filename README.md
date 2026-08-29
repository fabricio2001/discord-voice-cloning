# Discord Voice Cloning

Monorepo de um bot do Discord que grava participantes separadamente, mantém um
catálogo local de referências autorizadas, sintetiza fala e gera covers usando
modelos executados localmente.

> Este projeto deve permanecer privado. Gravações e referências de voz são dados
> pessoais sensíveis: use somente vozes próprias ou com autorização explícita.

## Estrutura

```text
.
|-- apps/discord-bot/       Bot Node.js e testes
|-- docs/voice-cloning.md   Documentação do pipeline Python
|-- clone_sample.py         Pipeline local de TTS
|-- cover_pipeline.py       Pipeline local de covers
|-- instalar-cover.ps1      Instalador do motor de covers
`-- executar.ps1            Exemplo de execução local
```

Ambientes virtuais, modelos, motores baixados, gravações, vozes, resultados e
arquivos `.env` são mantidos somente na máquina e não entram no Git.

## Preparação

Requisitos principais:

- Windows e PowerShell;
- Node.js 22 ou superior;
- Python 3.12;
- Git;
- GPU NVIDIA compatível, recomendada para os modelos locais.

Configure primeiro o serviço Python conforme [docs/voice-cloning.md](docs/voice-cloning.md).
Depois configure o bot:

```powershell
cd apps\discord-bot
Copy-Item .env.example .env
npm install
npm test
npm start
```

Preencha `DISCORD_TOKEN` e `DISCORD_CLIENT_ID` apenas no arquivo `.env` local.
O bot encontra automaticamente o serviço Python na raiz deste repositório.

## Testes

```powershell
# Bot
npm --prefix apps\discord-bot test

# Pipeline Python, sem baixar modelos
.\.cover-venv\Scripts\python.exe -m unittest test_cover_pipeline.py -v
```

Mais detalhes do bot estão em [apps/discord-bot/README.md](apps/discord-bot/README.md).

## Componentes de terceiros

O instalador baixa o Seed-VC em uma revisão fixada, sem versioná-lo neste
repositório. Seed-VC, Demucs, Chatterbox, FFmpeg e os modelos utilizados possuem
licenças próprias, que devem ser verificadas antes de qualquer redistribuição.

