# Clonagem local de voz

Este projeto usa o Chatterbox Multilingual para gerar TTS local a partir de uma
referência WAV. O script prepara automaticamente até 10 segundos de fala limpa
antes da síntese.

## Executar

```powershell
.\executar.ps1
```

Para usar outro texto:

```powershell
.\executar.ps1 --text "Cole aqui o texto da narração."
```

O bot em `apps/discord-bot` também chama este script diretamente:

- `--prepare-only` limpa uma gravação e cria uma referência de até 10 segundos;
- `--skip-prepare` reutiliza uma referência já pronta;
- `--discord-audio` gera PCM estéreo de 48 kHz para reprodução na call.

Os arquivos gerados ficam em `outputs`. Use apenas vozes próprias ou com
autorização explícita do locutor.

## Covers de música

O motor de canto fica separado do Chatterbox:

```powershell
.\instalar-cover.ps1
.\.cover-venv\Scripts\python.exe verificar-cover.py
```

Requer Python 3.12, Git e Node.js (para o extrator do YouTube). O instalador usa
PyTorch CUDA 12.4 para NVIDIA, Seed-VC na revisão
`51383efd921027683c89e5348211d93ff12ac2a8` e as dependências de
`cover-requirements.txt`. Reserva vários GB para ambiente/modelos. Não altera `.venv`.

Teste de um arquivo autorizado:

```powershell
.\.cover-venv\Scripts\python.exe cover_pipeline.py --input musica.mp3 --reference referencia.wav --output-dir outputs\meu-cover
```

Troque `--input musica.mp3` por `--youtube https://youtu.be/ID_DO_VIDEO` para um
vídeo. O fluxo do YouTube baixa o áudio, converte o download em `youtube.mp3`
local (192 kbps) e valida sua duração antes de separar e converter a voz.
Não há processamento de voz diretamente do link. MP3 não elimina restrições
de acesso nem bloqueios de download do YouTube.
A saída é `cover.mp3` e `cover.wav` (PCM 16-bit, estéreo, 48 kHz). No uso
direto pela CLI, os intermediários ficam na pasta de saída; no bot, são temporários.
Limites padrão: 25 MiB, 300 segundos, 30 etapas de difusão. Só o vocal é convertido,
com duração original preservada; depois ele é misturado ao instrumental.

Os modelos oficiais são baixados na primeira execução: Demucs em
`models/cover-torch`; Seed-VC e auxiliares em `engines/seed-vc/checkpoints`,
incluindo `hf_cache`. Não carregue checkpoints recebidos de usuários.
Repositórios: [Seed-VC](https://github.com/Plachtaa/seed-vc) (GPL-3.0),
[Demucs](https://github.com/adefossez/demucs) (MIT),
[yt-dlp](https://github.com/yt-dlp/yt-dlp). Consulte também as licenças dos modelos
e de FFmpeg antes de redistribuir o conjunto.

Testes sem GPU/modelos: `.\.cover-venv\Scripts\python.exe -m unittest test_cover_pipeline.py -v`.
Para o comando Discord e as regras da fila, veja `apps/discord-bot/README.md`.
