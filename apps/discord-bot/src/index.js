import 'dotenv/config';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import {
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { GuildRecorder } from './recorder.js';
import { acknowledgeCommand, logInteraction, replyToCommand } from './interaction-response.js';
import {
  deleteRecordings,
  findRecording,
  findVoice,
  listRecordings,
  listVoices,
  MIN_REFERENCE_SECONDS,
  saveVoice,
  voiceReferencePath,
} from './voice-catalog.js';
import { playPcm, playWav, prepareVoice, removeSynthesis, synthesizeVoice } from './voice-cloning.js';
import { JobQueue } from './job-queue.js';
import { coverCommand, createCoverHandler } from './cover-command.js';
import { stopCoverProcesses } from './cover.js';
import { OperationRegistry } from './operations.js';
import { botControlCommands, createBotControlHandler } from './bot-control.js';
import { audioPlaybackCommand, createAudioPlaybackHandler } from './audio-playback-command.js';

const { DISCORD_TOKEN, DISCORD_CLIENT_ID } = process.env;
const configuredGuildId = process.env.DISCORD_GUILD_ID?.trim();
const DISCORD_GUILD_ID = /^\d{17,20}$/.test(configuredGuildId || '')
  ? configuredGuildId
  : null;
if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  throw new Error('Preencha DISCORD_TOKEN e DISCORD_CLIENT_ID no arquivo .env.');
}
if (!/^\d{17,20}$/.test(DISCORD_CLIENT_ID)) {
  throw new Error('DISCORD_CLIENT_ID deve ser o Application ID numérico do bot.');
}

const recordingsRoot = resolve(process.env.RECORDINGS_DIR || 'recordings');
const voicesRoot = resolve(process.env.VOICES_DIR || 'voices');
const synthesisRoot = resolve(process.env.SYNTHESIS_DIR || 'outputs/tts');
const sessions = new Map();
const busyGuilds = new Set();
const gpuQueue = new JobQueue();
const operations = new OperationRegistry();
const BOT_BUILD = '2026-08-29.audio-playback.1';
const handleBotControl = createBotControlHandler({
  operations, queue: gpuQueue, sessions, canManage: canManageRecordings, build: BOT_BUILD,
});
const handleCover = createCoverHandler({
  queue: gpuQueue,
  findVoice: (guildId, id) => findVoice(voicesRoot, guildId, id),
  voiceChannelFor: memberVoiceChannel,
  sessions, busyGuilds, playWav, operations,
});
const handleAudioPlayback = createAudioPlaybackHandler({
  voiceChannelFor: memberVoiceChannel,
  sessions, busyGuilds, playPcm, operations,
});

const commands = [
  ...botControlCommands,
  coverCommand,
  audioPlaybackCommand,
  new SlashCommandBuilder()
    .setName('vr-gravar')
    .setDescription('Inicia a gravação individual dos participantes da sua call'),
  new SlashCommandBuilder()
    .setName('vr-parar')
    .setDescription('Finaliza a gravação desta call'),
  new SlashCommandBuilder()
    .setName('vr-status-gravacao')
    .setDescription('Mostra se existe uma gravação em andamento'),
  new SlashCommandBuilder()
    .setName('vr-listar-gravacoes')
    .setDescription('Lista as gravações individuais disponíveis para clonagem'),
  new SlashCommandBuilder()
    .setName('vr-clonar-voz')
    .setDescription('Cria ou atualiza uma voz usando uma gravação')
    .addStringOption((option) => option
      .setName('gravacao')
      .setDescription('Pessoa e sessão usadas como referência')
      .setAutocomplete(true)
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName('vr-listar-vozes')
    .setDescription('Lista as vozes clonadas disponíveis'),
  new SlashCommandBuilder()
    .setName('vr-tts')
    .setDescription('Faz o bot falar na call usando uma voz clonada')
    .addStringOption((option) => option
      .setName('voz')
      .setDescription('Voz clonada que será usada')
      .setAutocomplete(true)
      .setRequired(true))
    .addStringOption((option) => option
      .setName('texto')
      .setDescription('Texto que o bot deve falar')
      .setMaxLength(500)
      .setRequired(true)),
  new SlashCommandBuilder()
    .setName('vr-limpar-gravacoes')
    .setDescription('Apaga gravações finalizadas deste servidor')
    .addStringOption((option) => option
      .setName('escopo')
      .setDescription('O conjunto de gravações que será apagado')
      .setRequired(true)
      .addChoices(
        { name: 'Todas as gravações', value: 'todas' },
        { name: 'Um dia', value: 'dia' },
        { name: 'Uma sessão', value: 'sessao' },
        { name: 'Uma pessoa', value: 'pessoa' },
        { name: 'Um arquivo', value: 'arquivo' },
      ))
    .addBooleanOption((option) => option
      .setName('confirmar')
      .setDescription('Confirma que os arquivos devem ser apagados permanentemente')
      .setRequired(true))
    .addStringOption((option) => option
      .setName('alvo')
      .setDescription('Dia, sessão, pessoa ou arquivo; escolha pelo autocomplete')
      .setAutocomplete(true)),
].map((command) => command.toJSON());

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

function sessionFolder(guild) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return join(recordingsRoot, `${guild.name.replace(/[^a-zA-Z0-9_-]/g, '_')}-${guild.id}`, stamp);
}

function memberVoiceChannel(interaction) {
  return interaction.guild?.voiceStates.cache.get(interaction.user.id)?.channel ?? null;
}

async function canManageRecordings(interaction) {
  if (interaction.guild.ownerId === interaction.user.id) return true;
  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  return member?.permissions.has(PermissionFlagsBits.ManageChannels)
    ?? interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels)
    ?? false;
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Bot conectado como ${readyClient.user.tag}; PID=${process.pid}; Node=${process.version}.`);
  console.log(`Build do bot: ${BOT_BUILD} (TTS e covers locais com fila GPU).`);
  try {
    const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

    if (DISCORD_GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), {
        body: commands,
      });
      console.log(`Comandos registrados no servidor ${DISCORD_GUILD_ID}.`);
    } else if (readyClient.guilds.cache.size > 0) {
      if (configuredGuildId) {
        console.warn('DISCORD_GUILD_ID foi ignorado porque não é um ID numérico válido.');
      }
      for (const guild of readyClient.guilds.cache.values()) {
        await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, guild.id), {
          body: commands,
        });
        console.log(`Comandos registrados em ${guild.name} (${guild.id}).`);
      }
    } else {
      await rest.put(Routes.applicationCommands(DISCORD_CLIENT_ID), { body: commands });
      console.log('Comandos globais registrados. Eles podem levar algum tempo para aparecer.');
    }

  } catch (error) {
    console.error('Falha ao registrar os comandos do bot:', error);
    console.error('Confira DISCORD_CLIENT_ID, DISCORD_GUILD_ID e as permissões do convite.');
  }
});

client.on(Events.Error, (error) => console.error(`[Discord] ${error.name}: ${error.message}`));
client.on(Events.ShardDisconnect, (event, shardId) => console.warn(`[Discord] conexão ${shardId} encerrada; código ${event.code}.`));
client.on(Events.ShardReconnecting, (shardId) => console.warn(`[Discord] reconectando ${shardId}...`));
client.on(Events.ShardResume, (shardId) => console.log(`[Discord] conexão ${shardId} retomada.`));

client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand()) logInteraction(interaction, 'recebido pelo bot');
  if (!interaction.guild) {
    if (interaction.isChatInputCommand()) {
      await replyToCommand(interaction, {
        content: 'Use este comando em um canal de texto do servidor, não por mensagem privada.', ephemeral: true,
      }).catch((error) => console.error(`[Discord sem servidor] ${error.code ?? error.name}: ${error.message}`));
    }
    return;
  }

  if (interaction.isAutocomplete()) {
    const query = interaction.options.getFocused().toLocaleLowerCase('pt-BR');
    try {
      if (interaction.commandName === 'vr-clonar-voz') {
        const recordings = await listRecordings(recordingsRoot, interaction.guild.id);
        const choices = recordings
          .filter((item) => item.usableForCloning)
          .map((item) => ({
            name: `${item.displayName} — ${new Date(item.startedAt).toLocaleString('pt-BR')}`.slice(0, 100),
            value: item.key,
          }))
          .filter((item) => item.name.toLocaleLowerCase('pt-BR').includes(query))
          .slice(0, 25);
        await interaction.respond(choices);
      } else if (['vr-tts', 'vr-cover'].includes(interaction.commandName)) {
        const voices = await listVoices(voicesRoot, interaction.guild.id);
        const choices = voices
          .map((voice) => ({ name: `${voice.displayName} (${voice.username})`.slice(0, 100), value: voice.id }))
          .filter((item) => item.name.toLocaleLowerCase('pt-BR').includes(query))
          .slice(0, 25);
        await interaction.respond(choices);
      } else if (interaction.commandName === 'vr-limpar-gravacoes') {
        const scope = interaction.options.getString('escopo');
        const recordings = await listRecordings(recordingsRoot, interaction.guild.id);
        let choices = [];
        if (scope === 'dia') {
          choices = [...new Set(recordings.map((item) => item.startedAt.slice(0, 10)))]
            .map((day) => ({ name: day, value: day }));
        } else if (scope === 'sessao') {
          choices = [...new Set(recordings.map((item) => item.session))]
            .map((session) => ({ name: session, value: session }));
        } else if (scope === 'pessoa') {
          choices = [...new Map(recordings.map((item) => [item.userId, item])).values()]
            .map((item) => ({
              name: `${item.displayName} (${item.username})`.slice(0, 100),
              value: item.userId,
            }));
        } else if (scope === 'arquivo') {
          choices = recordings.map((item) => ({
            name: `${item.filename} — ${item.session}`.slice(0, 100),
            value: item.key,
          }));
        }
        await interaction.respond(choices
          .filter((item) => item.name.toLocaleLowerCase('pt-BR').includes(query))
          .slice(0, 25));
      }
    } catch (error) {
      console.error(`Falha no autocomplete: ${error.code ?? error.name}: ${error.message}`);
      await interaction.respond([]).catch(() => {});
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  try {
    await acknowledgeCommand(interaction);
    if (await handleBotControl(interaction)) return;
    if (interaction.commandName === 'vr-cover') {
      await handleCover(interaction);
      return;
    }
    if (interaction.commandName === 'vr-tocar') {
      await handleAudioPlayback(interaction);
      return;
    }

    if (interaction.commandName === 'vr-gravar') {
      if (sessions.has(interaction.guild.id)) {
        await replyToCommand(interaction, { content: 'Já existe uma gravação ativa neste servidor.', ephemeral: true });
        return;
      }

      const voiceChannel = memberVoiceChannel(interaction);
      if (!voiceChannel) {
        await replyToCommand(interaction, { content: 'Entre em um canal de voz antes de usar este comando.', ephemeral: true });
        return;
      }

      const botPermissions = voiceChannel.permissionsFor(interaction.client.user);
      const missingPermissions = botPermissions?.missing([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
      ]) ?? ['Ver canal', 'Conectar'];
      if (missingPermissions.length > 0) {
        await replyToCommand(interaction, {
          content: 'Não consigo entrar nessa call. Dê ao bot as permissões **Ver canal** e **Conectar**.',
          ephemeral: true,
        });
        return;
      }

      await interaction.deferReply();
      const outputDir = sessionFolder(interaction.guild);
      await mkdir(outputDir, { recursive: true });
      const recorder = new GuildRecorder({
        guild: interaction.guild,
        voiceChannel,
        textChannel: interaction.channel,
        outputDir,
        startedBy: { userId: interaction.user.id, username: interaction.user.username },
      });
      await recorder.start();
      sessions.set(interaction.guild.id, recorder);

      await interaction.editReply(
        `🔴 **Gravação iniciada em ${voiceChannel}.** Cada participante será salvo em um arquivo separado. ` +
        'Ao permanecer na chamada, os participantes confirmam que estão cientes da gravação. Use `/vr-parar` para encerrar.',
      );
      return;
    }

    if (interaction.commandName === 'vr-parar') {
      const recorder = sessions.get(interaction.guild.id);
      if (!recorder) {
        await replyToCommand(interaction, { content: 'Não existe uma gravação ativa neste servidor.', ephemeral: true });
        return;
      }
      const canStop = recorder.startedBy.userId === interaction.user.id
        || await canManageRecordings(interaction);
      if (!canStop) {
        await replyToCommand(interaction, {
          content: 'Somente quem iniciou a gravação ou um moderador pode encerrá-la.',
          ephemeral: true,
        });
        return;
      }

      sessions.delete(interaction.guild.id);
      const manifest = await recorder.stop({
        userId: interaction.user.id,
        username: interaction.user.username,
      });
      await writeFile(join(recorder.outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
      await interaction.editReply(
        `⏹️ **Gravação encerrada.** ${manifest.users.length} arquivo(s) de participante foram salvos.`,
      );
      return;
    }

    if (interaction.commandName === 'vr-status-gravacao') {
      const recorder = sessions.get(interaction.guild.id);
      await replyToCommand(interaction, {
        content: recorder
          ? `🔴 Gravando em ${recorder.voiceChannel} desde <t:${Math.floor(recorder.startedAt.getTime() / 1000)}:R>.`
          : 'Não existe uma gravação ativa neste servidor.',
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'vr-listar-gravacoes') {
      const recordings = (await listRecordings(recordingsRoot, interaction.guild.id))
        .filter((item) => item.usableForCloning);
      const groups = Map.groupBy(recordings, (item) => item.session);
      const sections = [];
      let shown = 0;
      for (const [session, items] of groups) {
        const section = `**${session}**\n${items.map((item) => (
          `- **${item.displayName}** — \`${item.filename.slice(0, 65)}\` — ${item.durationSeconds.toFixed(1)}s`
        )).join('\n')}`;
        if ([...sections, section].join('\n\n').length > 1750) break;
        sections.push(section);
        shown += items.length;
      }
      const suffix = shown < recordings.length ? `\n\n…e mais ${recordings.length - shown} arquivo(s).` : '';
      await replyToCommand(interaction, {
        content: recordings.length
          ? `**Gravações válidas (${recordings.length}), separadas por sessão:**\n\n${sections.join('\n\n')}${suffix}`
          : 'Ainda não há gravações com pelo menos 3 segundos de áudio neste servidor.',
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'vr-limpar-gravacoes') {
      if (!await canManageRecordings(interaction)) {
        await replyToCommand(interaction, {
          content: 'Somente um moderador com **Gerenciar canais** pode apagar gravações.',
          ephemeral: true,
        });
        return;
      }
      if (!interaction.options.getBoolean('confirmar', true)) {
        await replyToCommand(interaction, {
          content: 'Limpeza cancelada. Marque `confirmar` como verdadeiro para apagar.',
          ephemeral: true,
        });
        return;
      }
      const scope = interaction.options.getString('escopo', true);
      const target = interaction.options.getString('alvo')?.trim() ?? '';
      if (scope !== 'todas' && !target) {
        await replyToCommand(interaction, {
          content: 'Escolha um `alvo` pelo autocomplete para esse tipo de limpeza.',
          ephemeral: true,
        });
        return;
      }
      const result = await deleteRecordings(recordingsRoot, interaction.guild.id, scope, target);
      await replyToCommand(interaction, {
        content: result.files
          ? `🗑️ ${result.files} arquivo(s) removido(s). ${result.sessions} sessão(ões) vazia(s) removida(s).`
          : 'Nenhuma gravação corresponde ao filtro informado.',
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'vr-clonar-voz') {
      if (!await canManageRecordings(interaction)) {
        await replyToCommand(interaction, {
          content: 'Somente um moderador com **Gerenciar canais** pode criar ou atualizar vozes.',
          ephemeral: true,
        });
        return;
      }
      if (busyGuilds.has(interaction.guild.id) || gpuQueue.size > 0) {
        await replyToCommand(interaction, { content: 'Já existe um processamento de voz em andamento ou na fila. Aguarde para preparar a referência.', ephemeral: true });
        return;
      }

      const recording = await findRecording(
        recordingsRoot,
        interaction.guild.id,
        interaction.options.getString('gravacao', true),
      );
      if (!recording) {
        await replyToCommand(interaction, { content: 'Essa gravação não foi encontrada.', ephemeral: true });
        return;
      }
      if (!recording.usableForCloning) {
        await replyToCommand(interaction, {
          content: `A gravação de **${recording.displayName}** tem somente ${recording.durationSeconds.toFixed(1)}s de áudio. `
            + `Grave essa pessoa novamente falando por pelo menos ${MIN_REFERENCE_SECONDS} segundos.`,
          ephemeral: true,
        });
        return;
      }

      const task = operations.start({ guildId: interaction.guild.id, userId: interaction.user.id, kind: 'Clonagem' });
      const referencePath = voiceReferencePath(voicesRoot, interaction.guild.id, recording.userId);
      const temporaryReference = `${referencePath}.${interaction.id}.tmp.wav`;
      busyGuilds.add(interaction.guild.id);
      try {
        if (gpuQueue.size > 0) throw new Error('A GPU ficou ocupada. Aguarde o processamento atual e tente novamente.');
        task.stage = 'Preparando referência';
        await gpuQueue.submit(() => prepareVoice(recording.filePath, temporaryReference,
          (line) => console.log(`[clonador] ${line}`), { signal: task.signal }), { signal: task.signal }).done;
        task.signal.throwIfAborted();
        await rename(temporaryReference, referencePath);
        await saveVoice(voicesRoot, interaction.guild.id, recording, {
          userId: interaction.user.id,
          username: interaction.user.username,
        });
        await interaction.editReply(
          `✅ Voz de **${recording.displayName}** criada. Use \`/vr-tts\` para fazê-la falar na call.`,
        );
      } finally {
        await rm(temporaryReference, { force: true }).catch(() => {});
        operations.finish(task);
        busyGuilds.delete(interaction.guild.id);
      }
      return;
    }

    if (interaction.commandName === 'vr-listar-vozes') {
      const voices = await listVoices(voicesRoot, interaction.guild.id);
      const lines = voices.slice(0, 15).map((voice) => (
        `• **${voice.displayName}** (${voice.username}) — criada em ${new Date(voice.createdAt).toLocaleString('pt-BR')}`
      ));
      const suffix = voices.length > 15 ? `\n…e mais ${voices.length - 15}.` : '';
      await replyToCommand(interaction, {
        content: voices.length
          ? `**Vozes clonadas (${voices.length}):**\n${lines.join('\n')}${suffix}\nUse \`/vr-tts\` para escolher uma.`
          : 'Ainda não há vozes clonadas neste servidor.',
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'vr-tts') {
      if (busyGuilds.has(interaction.guild.id) || gpuQueue.size > 0) {
        await replyToCommand(interaction, { content: 'Já existe um processamento de voz em andamento ou na fila. Aguarde para usar TTS.', ephemeral: true });
        return;
      }
      const voiceChannel = memberVoiceChannel(interaction);
      if (!voiceChannel) {
        await replyToCommand(interaction, { content: 'Entre em um canal de voz antes de usar este comando.', ephemeral: true });
        return;
      }
      const recorder = sessions.get(interaction.guild.id);
      if (recorder && recorder.voiceChannel.id !== voiceChannel.id) {
        await replyToCommand(interaction, {
          content: `Durante uma gravação, o TTS só pode ser usado em ${recorder.voiceChannel}.`,
          ephemeral: true,
        });
        return;
      }
      const missingPermissions = voiceChannel.permissionsFor(interaction.client.user)?.missing([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
      ]) ?? ['Ver canal', 'Conectar', 'Falar'];
      if (missingPermissions.length > 0) {
        await replyToCommand(interaction, {
          content: 'Preciso das permissões **Ver canal**, **Conectar** e **Falar** nessa call.',
          ephemeral: true,
        });
        return;
      }
      const voice = await findVoice(
        voicesRoot,
        interaction.guild.id,
        interaction.options.getString('voz', true),
      );
      if (!voice) {
        await replyToCommand(interaction, { content: 'Essa voz clonada não foi encontrada.', ephemeral: true });
        return;
      }

      const text = interaction.options.getString('texto', true).trim();
      if (!text) {
        await replyToCommand(interaction, { content: 'O texto não pode estar vazio.', ephemeral: true });
        return;
      }
      const outputPath = join(synthesisRoot, interaction.guild.id, `${Date.now()}-${interaction.user.id}.wav`);
      const task = operations.start({ guildId: interaction.guild.id, userId: interaction.user.id, kind: 'TTS' });
      busyGuilds.add(interaction.guild.id);
      try {
        if (gpuQueue.size > 0) throw new Error('A GPU ficou ocupada. Aguarde o processamento atual e tente novamente.');
        task.stage = 'Gerando áudio';
        await gpuQueue.submit(() => synthesizeVoice(voice.referencePath, text, outputPath,
          (line) => console.log(`[tts] ${line}`), { signal: task.signal }), { signal: task.signal }).done;
        task.signal.throwIfAborted();
        task.stage = 'Reproduzindo na call';
        await interaction.editReply(`🔊 Reproduzindo na call com a voz de **${voice.displayName}**…`);
        await playWav({
          guild: interaction.guild,
          voiceChannel,
          wavPath: outputPath,
          existingConnection: recorder?.connection,
          signal: task.signal,
        });
        await interaction.editReply(`✅ Texto reproduzido com a voz de **${voice.displayName}**.`);
      } finally {
        busyGuilds.delete(interaction.guild.id);
        await removeSynthesis(outputPath);
        operations.finish(task);
      }
    }
  } catch (error) {
    // Never log the REST error object: it contains the interaction-token URL.
    console.error(`[/${interaction.commandName}] ${error.code ?? error.name}: ${error.message}`);
    if (error.code === 10062 || error.code === 40060) return;
    const detail = error instanceof Error ? ` Detalhe: ${error.message.slice(0, 1200)}` : '';
    const message = `Não foi possível concluir o comando.${detail}`;
    if (interaction.deferred || interaction.replied) await interaction.editReply(message).catch(() => {});
    else await replyToCommand(interaction, { content: message, ephemeral: true }).catch(() => {});
  }
});

async function shutdown(signal) {
  operations.cancelAll();
  gpuQueue.close();
  stopCoverProcesses();
  console.log(`Recebido ${signal}; finalizando gravações...`);
  for (const [guildId, recorder] of sessions) {
    sessions.delete(guildId);
    const manifest = await recorder.stop({ userId: null, username: signal });
    await writeFile(join(recorder.outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  }
  client.destroy();
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));

await client.login(DISCORD_TOKEN);
