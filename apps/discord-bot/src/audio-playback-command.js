import { access, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { downloadAttachment, validateSource } from './cover.js';
import { bindProcessCancellation, killProcessTree } from './process-control.js';
import { OperationRegistry } from './operations.js';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDirectory, '..', '..', '..');
const MAX_PLAYBACK_SECONDS = 10 * 60;

export const audioPlaybackCommand = new SlashCommandBuilder()
  .setName('vr-tocar')
  .setDescription('Reproduz um arquivo de áudio na sua call')
  .addAttachmentOption((option) => option
    .setName('arquivo')
    .setDescription('MP3/WAV/FLAC/OGG/OPUS/M4A/AAC/WEBM, até 25 MiB e 10 minutos')
    .setRequired(true));

async function findFfmpeg() {
  if (process.env.FFMPEG_PATH) {
    const configured = resolve(process.env.FFMPEG_PATH);
    await access(configured).catch(() => {
      throw new Error('FFMPEG_PATH não aponta para um executável existente.');
    });
    return configured;
  }
  const directory = join(repositoryRoot, '.cover-venv', 'Lib', 'site-packages',
    'imageio_ffmpeg', 'binaries');
  const executable = (await readdir(directory).catch(() => []))
    .find((name) => /^ffmpeg.*\.exe$/i.test(name));
  if (!executable) {
    throw new Error('FFmpeg não encontrado. Execute `instalar-cover.ps1` ou configure FFMPEG_PATH.');
  }
  return join(directory, executable);
}
export async function convertAudioToPcm(inputPath, outputPath, { signal } = {}) {
  signal?.throwIfAborted();
  const ffmpeg = await findFfmpeg();
  signal?.throwIfAborted();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-protocol_whitelist', 'file,pipe', '-i', inputPath,
      '-t', String(MAX_PLAYBACK_SECONDS), '-map_metadata', '-1',
      '-vn', '-sn', '-dn', '-ar', '48000', '-ac', '2',
      '-c:a', 'pcm_s16le', '-f', 's16le', outputPath,
    ], { windowsHide: true });
    const removeCancellation = bindProcessCancellation(child, signal);
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => killProcessTree(child), 10 * 60_000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      removeCancellation();
      callback();
    };
    child.once('error', (error) => settle(() => reject(error)));
    child.once('close', (code) => settle(() => {
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolvePromise(outputPath);
      else reject(new Error(`FFmpeg não conseguiu converter o áudio. ${stderr.trim().slice(-1200)}`));
    }));
  });
}

export function createAudioPlaybackHandler({
  voiceChannelFor,
  sessions,
  busyGuilds,
  playPcm,
  operations = new OperationRegistry(),
  download = downloadAttachment,
  convert = convertAudioToPcm,
  outputRoot = resolve(process.env.PLAYBACK_OUTPUT_DIR || 'outputs/playback'),
}) {
  return async function handleAudioPlayback(interaction) {
    const source = validateSource({
      attachment: interaction.options.getAttachment('arquivo', true),
    });
    const guildId = interaction.guild.id;
    if (busyGuilds.has(guildId)) throw new Error('Já existe um áudio sendo processado ou reproduzido neste servidor.');
    const voiceChannel = voiceChannelFor(interaction);
    if (!voiceChannel) throw new Error('Entre em um canal de voz antes de usar `/vr-tocar`.');
    const recorder = sessions.get(guildId);
    if (recorder && recorder.voiceChannel.id !== voiceChannel.id) {
      throw new Error(`Durante uma gravação, o áudio só pode ser reproduzido em ${recorder.voiceChannel}.`);
    }
    const missing = voiceChannel.permissionsFor(interaction.client.user)?.missing([
      PermissionFlagsBits.ViewChannel,
      PermissionFlagsBits.Connect,
      PermissionFlagsBits.Speak,
    ]) ?? ['Ver canal', 'Conectar', 'Falar'];
    if (missing.length) throw new Error('Preciso das permissões **Ver canal**, **Conectar** e **Falar** nessa call.');

    const task = operations.start({ guildId, userId: interaction.user.id, kind: 'Reprodução de áudio' });
    busyGuilds.add(guildId);
    let directory;
    try {
      await mkdir(outputRoot, { recursive: true });
      directory = await mkdtemp(join(outputRoot, 'job-'));
      const inputPath = join(directory, `input${source.extension}`);
      const pcmPath = join(directory, 'audio.pcm');
      task.stage = 'Baixando anexo';
      await interaction.editReply('⬇️ Baixando e validando o áudio…');
      await download(source.attachmentUrl, inputPath, { signal: task.signal });
      task.stage = 'Convertendo áudio';
      await interaction.editReply('🎛️ Convertendo o áudio para reprodução…');
      await convert(inputPath, pcmPath, { signal: task.signal });
      task.signal.throwIfAborted();
      task.stage = 'Reproduzindo na call';
      await interaction.editReply(`🔊 Reproduzindo **${interaction.options.getAttachment('arquivo', true).name}** na call…`);
      await playPcm({
        guild: interaction.guild,
        voiceChannel,
        pcmPath,
        existingConnection: recorder?.connection,
        signal: task.signal,
      });
      await interaction.editReply('✅ Áudio reproduzido na call.');
    } finally {
      busyGuilds.delete(guildId);
      operations.finish(task);
      if (directory) await rm(directory, { recursive: true, force: true })
        .catch((error) => console.error('[audio playback cleanup]', error));
    }
  };
}
