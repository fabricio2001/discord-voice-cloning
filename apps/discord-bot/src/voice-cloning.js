import { createReadStream, mkdirSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindProcessCancellation } from './process-control.js';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDirectory, '..', '..', '..');
const cloneProject = resolve(process.env.VOICE_CLONING_DIR || repositoryRoot);
const pythonExecutable = resolve(
  process.env.VOICE_CLONING_PYTHON || join(cloneProject, '.venv', 'Scripts', 'python.exe'),
);
const cloneScript = resolve(process.env.VOICE_CLONING_SCRIPT || join(cloneProject, 'clone_sample.py'));
const pythonTemp = resolve(process.env.VOICE_CLONING_TEMP || '.tmp/python');

function runPython(argumentsList, onLine = () => {}, { signal } = {}) {
  return new Promise((resolvePromise, reject) => {
    signal?.throwIfAborted();
    mkdirSync(pythonTemp, { recursive: true });
    const child = spawn(pythonExecutable, [cloneScript, ...argumentsList], {
      cwd: cloneProject,
      windowsHide: true,
      env: {
        ...process.env,
        HF_HOME: process.env.HF_HOME || join(cloneProject, 'models', 'huggingface'),
        TORCH_HOME: process.env.TORCH_HOME || join(cloneProject, 'models', 'torch'),
        PYTHONUTF8: '1',
        TEMP: pythonTemp,
        TMP: pythonTemp,
      },
    });
    const removeCancellation = bindProcessCancellation(child, signal);
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const emitUsefulLines = (chunk) => chunk
      .split(/[\r\n]+/)
      .filter((line) => line && !/^(Sampling|Fetching \d+ files):/.test(line.trim()))
      .forEach(onLine);
    child.stdout.on('data', emitUsefulLines);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      emitUsefulLines(chunk);
    });
    child.once('error', (error) => { removeCancellation(); reject(error); });
    child.once('close', (code) => {
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolvePromise();
      else {
        const clean = stderr.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
        const firstTraceback = clean.indexOf('Traceback (most recent call last):');
        const nextTraceback = firstTraceback >= 0
          ? clean.indexOf('Traceback (most recent call last):', firstTraceback + 1)
          : -1;
        const detail = firstTraceback >= 0
          ? clean.slice(firstTraceback, nextTraceback >= 0 ? nextTraceback : undefined)
          : clean.split(/[\r\n]+/).filter((line) => (
            line && !/^(Sampling|Fetching \d+ files):/.test(line.trim())
          )).slice(-12).join('\n');
        reject(new Error(`O clonador terminou com código ${code}. ${detail.trim().slice(-3000)}`));
      }
    });
  });
}

export function prepareVoice(sourcePath, referencePath, onLine, options) {
  return runPython([
    '--source', sourcePath,
    '--reference', referencePath,
    '--prepare-only',
  ], onLine, options);
}

export async function synthesizeVoice(referencePath, text, outputPath, onLine, options) {
  await mkdir(dirname(resolve(outputPath)), { recursive: true });
  await runPython([
    '--source', referencePath,
    '--text', text,
    '--output', outputPath,
    '--skip-prepare',
    '--discord-audio',
  ], onLine, options);
}

export async function playWav({ guild, voiceChannel, wavPath, existingConnection, signal }) {
  signal?.throwIfAborted();
  const ownsConnection = !existingConnection;
  const connection = existingConnection ?? joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });

  let player, pcm, subscription;
  const deadline = (ms) => signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : ms;
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, deadline(20_000));
    signal?.throwIfAborted();
    player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
    // Python emits 48 kHz stereo signed 16-bit PCM with a standard 44-byte WAV header.
    pcm = createReadStream(wavPath, { start: 44 });
    const resource = createAudioResource(pcm, { inputType: StreamType.Raw });
    subscription = connection.subscribe(player);
    player.play(resource);

    await entersState(player, AudioPlayerStatus.Playing, deadline(20_000));
    await entersState(player, AudioPlayerStatus.Idle, deadline(15 * 60_000));
    signal?.throwIfAborted();
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    throw error;
  } finally {
    subscription?.unsubscribe();
    player?.stop(true);
    pcm?.destroy();
    if (ownsConnection && connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
  }
}

export async function removeSynthesis(path) {
  await rm(path, { force: true }).catch(() => {});
}
