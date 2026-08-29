import { createWriteStream, mkdirSync, openSync, closeSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ResilientOpusDecoder } from './resilient-opus-decoder.js';
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;

function safeName(value) {
  return value.normalize('NFKD').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'usuario';
}

function wavHeader(dataSize) {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8);
  const blockAlign = CHANNELS * (BITS_PER_SAMPLE / 8);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);
  return header;
}

export class GuildRecorder {
  constructor({ guild, voiceChannel, textChannel, outputDir, startedBy }) {
    this.guild = guild;
    this.voiceChannel = voiceChannel;
    this.textChannel = textChannel;
    this.outputDir = outputDir;
    this.startedBy = startedBy;
    this.startedAt = new Date();
    this.users = new Map();
    this.pendingUsers = new Set();
    this.stopping = false;
    mkdirSync(outputDir, { recursive: true });
  }

  async start() {
    this.connection = joinVoiceChannel({
      channelId: this.voiceChannel.id,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });

    await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
    this.onSpeakingStart = (userId) => this.capture(userId).catch((error) => {
      this.pendingUsers.delete(userId);
      console.error(`Falha ao iniciar captura de ${userId}: ${error.message}`);
    });
    this.connection.receiver.speaking.on('start', this.onSpeakingStart);
    console.log(`Gravação iniciada em ${this.guild.name} / ${this.voiceChannel.name}.`);
  }

  async capture(userId) {
    if (this.stopping || this.users.has(userId) || this.pendingUsers.has(userId)) return;

    // Subscribe synchronously on the first speaking packet. The readable stream
    // buffers Opus frames while member metadata/file setup is completed.
    this.pendingUsers.add(userId);
    const opusStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });
    opusStream.on('error', (error) => {
      if (!this.stopping) console.error(`Erro ao receber áudio de ${userId}: ${error.message}`);
    });

    const member = this.guild.members.cache.get(userId)
      ?? await this.guild.members.fetch(userId).catch(() => null);
    if (!member || member.user.bot || this.stopping) {
      opusStream.destroy();
      this.pendingUsers.delete(userId);
      return;
    }

    const filename = `${safeName(member.displayName)}-${userId}.wav`;
    const filePath = join(this.outputDir, filename);
    const output = createWriteStream(filePath);
    output.write(Buffer.alloc(44));

    const decoder = new ResilientOpusDecoder({
      rate: SAMPLE_RATE,
      channels: CHANNELS,
      frameSize: 960,
    });

    const entry = {
      userId,
      username: member.user.username,
      displayName: member.displayName,
      filename,
      filePath,
      firstAudioAt: new Date(),
      bytes: 0,
      invalidPackets: 0,
      opusStream,
      decoder,
      output,
    };

    decoder.on('data', (chunk) => {
      entry.bytes += chunk.length;
    });
    decoder.on('invalidPacket', () => {
      entry.invalidPackets += 1;
      if (entry.invalidPackets === 1 || entry.invalidPackets % 100 === 0) {
        console.warn(`Áudio de ${userId}: ${entry.invalidPackets} pacote(s) Opus inválido(s) descartado(s); captura continua.`);
      }
    });
    decoder.on('error', (error) => {
      console.error(`Erro ao decodificar áudio de ${userId}:`, error);
    });
    output.on('error', (error) => {
      console.error(`Erro ao salvar áudio de ${userId}:`, error);
    });

    this.users.set(userId, entry);
    this.pendingUsers.delete(userId);
    opusStream.pipe(decoder).pipe(output);
    console.log(`Capturando ${member.user.tag} em ${filename}.`);
  }

  async stop(stoppedBy) {
    if (this.stopping) return;
    this.stopping = true;
    this.connection.receiver.speaking.off('start', this.onSpeakingStart);

    const stoppedAt = new Date();
    this.connection.destroy();
    await Promise.all([...this.users.values()].map((entry) => this.finishUser(entry)));
    console.log(`Gravação encerrada em ${this.guild.name}; ${this.users.size} participante(s).`);

    return {
      guildId: this.guild.id,
      guildName: this.guild.name,
      voiceChannelId: this.voiceChannel.id,
      voiceChannelName: this.voiceChannel.name,
      textChannelId: this.textChannel.id,
      startedAt: this.startedAt.toISOString(),
      stoppedAt: stoppedAt.toISOString(),
      startedBy: this.startedBy,
      stoppedBy,
      users: [...this.users.values()].map((entry) => ({
        userId: entry.userId,
        username: entry.username,
        displayName: entry.displayName,
        filename: entry.filename,
        firstAudioAt: entry.firstAudioAt.toISOString(),
        pcmBytes: entry.bytes,
        invalidPackets: entry.invalidPackets,
      })),
    };
  }

  finishUser(entry) {
    return new Promise((resolve) => {
      let finished = false;
      const finalize = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);

        try {
          const fd = openSync(entry.filePath, 'r+');
          writeSync(fd, wavHeader(entry.bytes), 0, 44, 0);
          closeSync(fd);
        } catch (error) {
          console.error(`Não foi possível finalizar ${entry.filename}:`, error);
        }
        resolve();
      };

      const timeout = setTimeout(() => {
        console.warn(`Tempo esgotado ao fechar ${entry.filename}; forçando encerramento.`);
        entry.output.destroy();
        setTimeout(finalize, 250);
      }, 5_000);

      entry.output.once('close', finalize);
      entry.output.once('error', () => finalize());

      entry.opusStream.unpipe(entry.decoder);
      entry.opusStream.destroy();
      entry.decoder.unpipe(entry.output);
      entry.decoder.destroy();
      entry.output.end();
    });
  }
}
