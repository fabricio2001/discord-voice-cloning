import { copyFile, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { checkCoverRuntime, downloadAttachment, runCover, validateSource } from './cover.js';
import { OperationRegistry } from './operations.js';

export const coverCommand = new SlashCommandBuilder()
  .setName('vr-cover')
  .setDescription('Gera um cover por IA usando uma voz autorizada e uma música de até 5 minutos')
  .addStringOption((o) => o.setName('voz').setDescription('Referência de voz deste servidor').setRequired(true).setAutocomplete(true))
  .addBooleanOption((o) => o.setName('autorizado').setDescription('Confirmo autorização para usar esta voz e processar a música').setRequired(true))
  .addStringOption((o) => o.setName('link').setDescription('Link HTTPS de um único vídeo do YouTube').setMaxLength(500))
  .addAttachmentOption((o) => o.setName('arquivo').setDescription('Música em MP3/WAV/FLAC/OGG/OPUS/M4A/AAC/WEBM, até 25 MiB'))
  .addBooleanOption((o) => o.setName('tocar').setDescription('Também reproduzir na sua call ao terminar (padrão: não)'));

export function createCoverHandler({ queue, findVoice, voiceChannelFor, sessions, busyGuilds, playWav,
  runtimeCheck = checkCoverRuntime, generate = runCover, download = downloadAttachment,
  outputRoot = resolve(process.env.COVER_OUTPUT_DIR || 'outputs/covers'),
  operations = new OperationRegistry(),
}) {
  const pendingGuilds = new Set();
  return async function handleCover(interaction) {
    if (!interaction.options.getBoolean('autorizado', true)) {
      throw new Error('Confirme `autorizado:true` somente se tiver autorização para a voz e a música.');
    }
    const source = validateSource({ link: interaction.options.getString('link'), attachment: interaction.options.getAttachment('arquivo') });
    const guildId = interaction.guild.id;
    if (pendingGuilds.has(guildId)) throw new Error('Já existe um cover na fila ou em processamento neste servidor.');
    // Reserve before the first await, so simultaneous submissions cannot race.
    pendingGuilds.add(guildId);
    let directory;
    let status;
    let task;
    try {
      await interaction.deferReply({ ephemeral: true });
      task = operations.start({ guildId, userId: interaction.user?.id, kind: 'Cover' });
      const { signal } = task;
      const voice = await findVoice(guildId, interaction.options.getString('voz', true));
      signal.throwIfAborted();
      if (!voice) throw new Error('Voz não encontrada. Prepare uma referência com `/vr-clonar-voz`.');
      const channel = interaction.channel;
      const missing = channel?.permissionsFor(interaction.client.user)?.missing([
        PermissionFlagsBits.ViewChannel,
        channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.AttachFiles,
      ]) ?? ['canal'];
      if (missing.length) throw new Error('Preciso de Ver canal, Enviar mensagens e Anexar arquivos neste canal.');
      const shouldPlay = interaction.options.getBoolean('tocar') ?? false;
      const requestedChannel = shouldPlay ? voiceChannelFor(interaction) : null;
      if (shouldPlay && !requestedChannel) throw new Error('Entre na call para usar `tocar:true`.');
      await runtimeCheck();
      signal.throwIfAborted();
      if (queue.size >= queue.limit) throw new Error('A fila de processamento está cheia. Tente novamente depois.');
      await mkdir(outputRoot, { recursive: true });
      directory = await mkdtemp(join(outputRoot, 'job-'));
      // Snapshot the reference; catalog updates cannot change a queued job.
      const referencePath = join(directory, 'reference.wav');
      await copyFile(voice.referencePath, referencePath);
      status = await channel.send({
        content: `🎵 Cover por IA solicitado por <@${interaction.user.id}> — preparando entrada. O resultado será enviado neste canal.`,
        allowedMentions: { parse: [] },
      });
      const update = (content, files) => status.edit({ content, ...(files ? { files } : {}), allowedMentions: { parse: [] } });
      // Download now: don't let a signed attachment URL expire while queued.
      if (source.attachmentUrl) {
        task.stage = 'Baixando anexo';
        await download(source.attachmentUrl, join(directory, `input${source.extension}`), { signal });
      }
      signal.throwIfAborted();
      let updates = Promise.resolve();
      const progress = (stage) => {
        if (signal.aborted) return;
        task.stage = stage;
        updates = updates.then(() => update(`🎵 **Cover gerado por IA** — ${stage}.`)).catch(() => {});
      };
      const job = queue.submit(async () => {
        try {
          progress('Processando cover');
          const result = await generate({ source, referencePath, directory, onProgress: progress, signal });
          signal.throwIfAborted();
          await updates;
          const limit = interaction.attachmentSizeLimit ?? 8 * 1024 * 1024;
          if ((await stat(result.mp3)).size > limit) throw new Error('O resultado excede o limite de anexos deste servidor. Tente uma música menor.');
          await update('✅ **Cover gerado por IA** — voz sintética, não é uma gravação real da pessoa.',
            [{ attachment: result.mp3, name: `cover-ia-${interaction.id}.mp3` }]);
          if (shouldPlay) {
            const currentChannel = voiceChannelFor(interaction);
            const recorder = sessions.get(guildId);
            const canPlay = currentChannel?.id === requestedChannel.id && !busyGuilds.has(guildId)
              && (!recorder || recorder.voiceChannel.id === currentChannel.id)
              && currentChannel.permissionsFor(interaction.client.user)?.has([
                PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak,
              ]);
            if (!canPlay) {
              await update('✅ **Cover gerado por IA** anexado. Reprodução omitida: você saiu/mudou de call, ela está ocupada ou faltam permissões.');
            } else {
              busyGuilds.add(guildId);
              task.stage = 'Reproduzindo cover na call';
              try {
                await playWav({ guild: interaction.guild, voiceChannel: currentChannel, wavPath: result.wav,
                  existingConnection: recorder?.connection, signal });
              } catch (error) {
                if (signal.aborted) throw signal.reason;
                console.error('[cover playback]', error);
                await update('✅ **Cover gerado por IA** anexado. Não foi possível reproduzir na call.');
              } finally { busyGuilds.delete(guildId); }
            }
          }
        } catch (error) {
          await updates;
          await update(`❌ Não foi possível gerar o cover. ${error.message.slice(0, 400)}`).catch(() => {});
          throw error;
        }
      }, { signal });
      // Cancellation can settle while the Discord acknowledgment is still in flight.
      void job.done.catch(() => {});
      progress(`Na fila (posição inicial ${job.position})`);
      // Do not hold or reuse the interaction webhook for long jobs (15-minute expiry).
      await interaction.editReply(`Pedido aceito. Acompanhe o andamento e o MP3 em ${status.url}.`).catch(() => {});
      try { await job.done; } finally { await updates; }
    } catch (error) {
      if (status) {
        console.error(`[cover] ${error.message}`);
        // Also handles queue cancellation before the worker was started.
        await status.edit({ content: task?.signal.aborted
          ? '⏹️ Cover cancelado. Processamento interrompido; arquivos temporários serão removidos.'
          : `❌ Cover não concluído. ${error.message.slice(0, 400)}`, allowedMentions: { parse: [] } }).catch(() => {});
        await interaction.editReply('Não foi possível concluir o cover. Veja a mensagem de andamento no canal.').catch(() => {});
      } else throw error;
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true }).catch((error) => console.error('[cover cleanup]', error));
      if (task) operations.finish(task);
      pendingGuilds.delete(guildId);
    }
  };
}
