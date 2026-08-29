import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, rm } from 'node:fs/promises';
import { dirname, resolve, join, extname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { bindProcessCancellation, killProcessTree } from './process-control.js';

export const MAX_INPUT_BYTES = 25 * 1024 * 1024;
export const MAX_SECONDS = 300;
const audioExtensions = new Set(['.mp3', '.wav', '.flac', '.ogg', '.opus', '.m4a', '.aac', '.webm']);
const processes = new Set();
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(moduleDirectory, '..', '..', '..');
const project = resolve(process.env.VOICE_CLONING_DIR || repositoryRoot);
const python = resolve(process.env.COVER_PYTHON || join(project, '.cover-venv', 'Scripts', 'python.exe'));
const script = join(project, 'cover_pipeline.py');

export function normalizeYouTubeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Informe um link válido do YouTube.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) {
    throw new Error('Use um link HTTPS do YouTube, sem credenciais ou porta alternativa.');
  }
  if (url.searchParams.has('list')) throw new Error('Playlists não são aceitas. Envie apenas o link do vídeo.');
  let id;
  if (url.hostname === 'youtu.be') id = url.pathname.slice(1);
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(url.hostname)) {
    id = url.pathname === '/watch' ? url.searchParams.get('v')
      : /^\/(?:shorts|embed)\/([\w-]{11})$/.exec(url.pathname)?.[1];
  }
  if (!/^[\w-]{11}$/.test(id || '')) throw new Error('Envie um link de vídeo do YouTube. Outros sites não são aceitos.');
  return `https://www.youtube.com/watch?v=${id}`;
}

export function validateSource({ link, attachment }) {
  if (Boolean(link) === Boolean(attachment)) throw new Error('Informe exatamente uma opção: `link` ou `arquivo`.');
  if (link) return { youtube: normalizeYouTubeUrl(link.trim()) };
  const extension = extname(attachment.name || '').toLowerCase();
  if (!audioExtensions.has(extension)) throw new Error('Envie MP3, WAV, FLAC, OGG, OPUS, M4A, AAC ou WEBM.');
  if (!Number.isSafeInteger(attachment.size) || attachment.size <= 0 || attachment.size > MAX_INPUT_BYTES) {
    throw new Error('O arquivo deve ter no máximo 25 MiB e não pode estar vazio.');
  }
  let url;
  try { url = new URL(attachment.url); } catch {
    throw new Error('O anexo não tem uma URL válida. Envie o arquivo novamente no campo `arquivo`.');
  }
  // Slash-command uploads may use ephemeral-attachments, not just attachments.
  // Preserve the signed query string and keep the CDN allowlist strict.
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || !['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)
      || !/^\/(?:attachments|ephemeral-attachments)\/\d+\/\d+\/[^/]+$/.test(url.pathname)) {
    throw new Error('O arquivo precisa ser um anexo enviado ao Discord.');
  }
  return { attachmentUrl: url.href, extension };
}

export async function downloadAttachment(url, destination, { fetchImpl = fetch, maxBytes = MAX_INPUT_BYTES, signal } = {}) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetchImpl(url, { redirect: 'error', signal: combined });
    if (!response.ok || !response.body) throw new Error('Não foi possível baixar o anexo. Envie o arquivo novamente.');
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body.cancel();
      throw new Error('Anexo acima do limite de tamanho.');
    }
    let received = 0;
    const limiter = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        callback(received > maxBytes ? new Error('Anexo acima do limite de tamanho.') : null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(destination, { flags: 'wx' }),
      { signal: combined });
    if (!received) throw new Error('O arquivo recebido está vazio.');
  } catch (error) {
    await rm(destination, { force: true });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkCoverRuntime() {
  try {
    await Promise.all([access(python), access(script), access(join(project, 'engines', 'seed-vc', 'inference.py'))]);
  } catch {
    throw new Error('O motor de cover não está instalado. Execute instalar-cover.ps1 na pasta VoiceCloning.');
  }
}

export function stopCoverProcesses() {
  for (const child of processes) killProcessTree(child);
}

export function runCover({ source, referencePath, directory, onProgress = () => {}, signal }) {
  signal?.throwIfAborted();
  const args = [script, '--reference', referencePath, '--output-dir', directory,
    '--max-seconds', String(MAX_SECONDS), '--max-bytes', String(MAX_INPUT_BYTES)];
  if (source.youtube) args.push('--youtube', source.youtube);
  else args.push('--input', join(directory, `input${source.extension}`));
  return new Promise((resolvePromise, reject) => {
    const child = spawn(python, args, {
      cwd: project, windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' },
    });
    processes.add(child);
    const removeCancellation = bindProcessCancellation(child, signal);
    let stderr = '';
    let buffered = '';
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; killProcessTree(child); }, 20 * 60_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop().slice(-8192);
      for (const line of lines) {
        if (line.startsWith('COVER_PROGRESS ')) {
          try { onProgress(JSON.parse(line.slice(15)).stage); } catch { /* malformed log */ }
        } else if (line.trim()) console.log(`[cover] ${line.slice(0, 1000)}`);
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12000); });
    child.once('error', (error) => {
      removeCancellation();
      clearTimeout(timeout);
      processes.delete(child);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      processes.delete(child);
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolvePromise({ mp3: join(directory, 'cover.mp3'), wav: join(directory, 'cover.wav') });
      else {
        console.error(`[cover] exit=${code} ${stderr}`);
        const reason = timedOut ? 'O processamento excedeu 20 minutos. Tente um trecho menor.'
          : /out of memory/i.test(stderr) ? 'Memória da GPU insuficiente. Feche outros programas e tente um trecho menor.'
            : /excede o limite|entre 1 e 300|limite de tamanho/i.test(stderr) ? 'A música excede 5 minutos ou 25 MiB.'
              : /ao vivo/i.test(stderr) ? 'Transmissões ao vivo não são aceitas.'
                : source.youtube && /DownloadError|HTTP Error|Sign in|bot|Requested format/i.test(stderr)
                  ? 'O YouTube não disponibilizou o áudio. Tente enviar um arquivo autorizado.'
                  : 'Falha no motor de cover. Consulte o console do bot; tente um áudio menor e uma referência limpa.';
        reject(new Error(reason));
      }
    });
  });
}
