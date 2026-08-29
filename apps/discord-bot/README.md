# Gravador e clonador de voz para Discord

Bot que grava cada participante da call em um WAV separado, prepara referências
de voz com Chatterbox Multilingual e reproduz TTS clonado no canal de voz.

> Use somente com o conhecimento e consentimento de todas as pessoas da chamada.
> O bot anuncia publicamente no canal de texto quando a gravação começa e termina.

## Preparação

1. Crie uma aplicação no [Discord Developer Portal](https://discord.com/developers/applications).
2. Na seção **Bot**, crie o bot e copie o token.
3. Em **OAuth2 > URL Generator**, marque `bot` e `applications.commands`.
4. Dê ao bot as permissões **View Channels**, **Connect**, **Speak** e **Send Messages**.
5. Convide o bot para o servidor.
6. Copie `.env.example` para `.env` e preencha o token e o Application ID.
   O Server ID é opcional: se ficar vazio ou inválido, os comandos serão
   registrados automaticamente em todos os servidores nos quais o bot estiver.
7. Configure o pipeline Python na raiz do monorepo, com a `.venv` e os modelos
   instalados. O bot encontra essa raiz automaticamente; para usar outro local,
   configure `VOICE_CLONING_*` no `.env`.
8. Instale e inicie:

```powershell
npm install
npm start
```

O projeto usa `opusscript`, evitando a necessidade de instalar compiladores C++
no Windows. Para servidores com muitas chamadas simultâneas, `@discordjs/opus`
pode ser usado no lugar dele para reduzir o consumo de CPU.

## Uso

- Entre em um canal de voz e execute `/vr-gravar` em um canal de texto.
- O bot publicará um aviso e começará a capturar os participantes.
- Execute `/vr-parar` para finalizar e fechar corretamente os arquivos.
- `/vr-status-gravacao` mostra a sessão em andamento.
- `/vr-status-bot` mostra conexão, tempo online, memória do bot, gravação,
  trabalho atual deste servidor e tamanho da fila global.
- `/vr-cancelar-processo` cancela o TTS, a clonagem ou o cover atual deste servidor,
  inclusive se estiver aguardando na fila, sem desligar o bot.
- `/vr-listar-gravacoes` mostra somente áudios válidos, agrupados por sessão.
- `/vr-clonar-voz` prepara/atualiza a referência da pessoa escolhida. Por
  segurança, requer a permissão **Gerenciar canais**.
- `/vr-listar-vozes` mostra o catálogo de vozes prontas.
- Entre na call e use `/vr-tts voz:... texto:...` para o bot sintetizar e falar.
- `/vr-cover voz:... autorizado:true link:...` gera um cover de um vídeo do YouTube.
- No lugar de `link`, use `arquivo` para enviar uma música; `tocar:true` também reproduz o resultado na call.
- `/vr-limpar-gravacoes` apaga gravações finalizadas por dia, sessão, pessoa,
  arquivo ou todas de uma vez. Requer **Gerenciar canais** e confirmação.

Qualquer participante pode iniciar uma gravação. Somente quem iniciou ou um membro
com **Gerenciar canais** pode encerrá-la. Os arquivos ficam em
`recordings/<servidor>/<data-hora>/`, acompanhados de um `manifest.json`.
As referências preparadas ficam em `voices/<servidor>/`. O áudio temporário de
TTS é apagado logo depois da reprodução.

### Status e cancelamento

Qualquer membro pode consultar `/vr-status-bot`. Para cancelar um trabalho, é
necessário ser quem o iniciou ou ter **Gerenciar canais (Manage Channels)**.
O cancelamento encerra o subprocesso Python e seus filhos no Windows, interrompe
downloads/reprodução desse trabalho e remove seus arquivos temporários. A fila
só avança quando o trabalho ativo termina; pedidos de outros servidores não são
cancelados. Uma referência já existente é preservada se sua preparação for
cancelada antes de a nova referência ser salva.

O bot permanece online e a gravação em andamento continua. Para encerrar uma
gravação, use `/vr-parar`. O comando não encerra processos arbitrários do computador.
Se o próprio bot estiver offline ou sem receber interações, esses comandos também
não responderão: nesse caso, é necessário verificar/reiniciar o bot no terminal.
Reinicie com `npm start` após atualizar os arquivos para registrar os novos comandos,
encerrando antes a instância antiga (e qualquer gravação ativa).

### Limpeza de gravações

Em `/vr-limpar-gravacoes`, escolha primeiro o `escopo`:

- `Todas as gravações`: não precisa preencher `alvo`;
- `Um dia`: o alvo é uma data no formato `AAAA-MM-DD`;
- `Uma sessão`: o alvo é o identificador ISO da sessão;
- `Uma pessoa`: remove os arquivos dessa pessoa em todas as sessões;
- `Um arquivo`: remove somente a entrada escolhida.

Para os quatro últimos filtros, use o autocomplete de `alvo`. A operação não
remove as referências de `voices/`, portanto vozes já clonadas continuam prontas
para TTS mesmo depois da limpeza das gravações originais.

Na primeira síntese após iniciar o bot, o Chatterbox pode demorar mais enquanto
carrega o modelo na GPU/CPU. O processamento seguinte também inicia um processo
Python novo, priorizando simplicidade e isolamento; uma futura evolução pode
manter o modelo carregado em um serviço local para reduzir a latência.

## Covers locais (YouTube ou arquivo)

Execute `instalar-cover.ps1` na raiz do monorepo uma vez e depois inicie o bot
com `npm start`. O comando `/vr-cover` será registrado na inicialização.
O ambiente `.cover-venv` é separado do TTS: Demucs separa voz/instrumental,
Seed-VC no modo canto converte o vocal e FFmpeg exporta o resultado em MP3.
As referências do catálogo existente são reutilizadas, sem treinamento por pessoa.

Exemplos (escolha a voz pelo autocomplete):

```text
/vr-cover voz:Fulano autorizado:true link:https://youtu.be/ID_DO_VIDEO
/vr-cover voz:Fulano autorizado:true arquivo:[anexo] tocar:true
```

- Informe **somente uma** fonte: `link` ou `arquivo`. São aceitos MP3, WAV,
  FLAC, OGG, OPUS, M4A, AAC e WEBM, até **25 MiB e 5 minutos**.
- Apenas links HTTPS de vídeos individuais do YouTube. Playlists, lives, Spotify,
  URLs arbitrárias e conteúdos que exijam autenticação não são suportados.
  Se o YouTube bloquear o download, envie um arquivo que você tenha autorização
  para processar. O bot não usa cookies da sua conta nem contorna restrições.
- Para YouTube, o bot primeiro baixa o áudio e converte em `youtube.mp3` local
  (192 kbps). Somente depois de validar o MP3 começa a separação e conversão da
  voz. A mensagem de andamento informa download, conversão e processamento.
  O MP3 de entrada fica na pasta temporária do pedido e é removido ao finalizar,
  junto aos demais intermediários; mudar o formato não garante todos os links.
- `autorizado:true` confirma autorização para usar a voz e processar a música.
  Não basta a pessoa ter consentido apenas com a gravação da call.
- A mensagem de andamento e o MP3 ficam **visíveis no canal onde o comando foi
  enviado**, identificados como gerados por IA. O bot precisa de **Anexar arquivos**,
  **Enviar mensagens** e **Ver canal**. A entrega não depende do token temporário
  da interação, portanto pode ocorrer depois de 15 minutos.
- Um cover pendente por servidor; fila global de até 6 trabalhos. Os modelos de
  TTS e cover não processam simultaneamente. Enquanto houver fila, novos comandos
  de TTS/preparação de referência pedem para aguardar.
- `tocar` é falso por padrão. Quando verdadeiro, o usuário deve continuar na mesma
  call e o bot precisa poder conectar/falar; gravações e reproduções existentes
  não são interrompidas para tocar o cover. O MP3 é entregue mesmo se a call falhar.
- Processamento limitado a 20 minutos por cover, além do tempo de fila. A primeira
  execução baixa modelos e pode demorar mais. CPU é possível, mas pode exceder esse
  prazo. NVIDIA CUDA é recomendada. A qualidade depende da música e da referência.
- Os arquivos intermediários e a cópia da referência são removidos ao concluir ou
  falhar. O MP3 enviado permanece no Discord. Se o processo for encerrado à força,
  podem restar pastas `outputs/covers/job-*`, que podem ser removidas com o bot parado.

Configurações opcionais: `COVER_PYTHON` aponta para o Python do cover;
`COVER_OUTPUT_DIR` muda a pasta temporária. `VOICE_CLONING_DIR` continua sendo a
raiz do projeto irmão. O TTS mantém seu Python/modelos anteriores.

Verificações locais: `npm run check` e `npm test`. Os testes do comando simulam o
Discord; um teste real de upload/reprodução exige uma chamada no servidor.

## Observações

- Cada WAV contém somente o áudio recebido daquele usuário. Pausas longas não são
  preenchidas com silêncio; para edição/mixagem, use os horários do manifesto.
- Se o bot ou o processo cair antes de `/vr-parar`, o arquivo WAV pode ficar sem o
  cabeçalho final. Sempre encerre a sessão pelo comando.
- O formato WAV tradicional tem limite próximo de 4 GB por arquivo.
- O bot anuncia publicamente quando grava. A listagem de arquivos, criação de voz
  e resultados do TTS são respostas privadas ao autor do comando.
