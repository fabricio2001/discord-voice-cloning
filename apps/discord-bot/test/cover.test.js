import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobQueue } from '../src/job-queue.js';
import { downloadAttachment, normalizeYouTubeUrl, validateSource } from '../src/cover.js';
import { createCoverHandler } from '../src/cover-command.js';
import { OperationRegistry } from '../src/operations.js';

const url = 'https://www.youtube.com/watch?v=abcdefghijk';
const attachment = { name: 'musica.MP3', size: 123, url: 'https://cdn.discordapp.com/attachments/123/456/song.mp3?ex=abc' };
const ephemeralAttachment = { ...attachment,
  url: 'https://cdn.discordapp.com/ephemeral-attachments/123/456/song.mp3?ex=abc&is=def&hm=signature' };

test('normaliza apenas vídeos YouTube e rejeita outros hosts, credenciais e playlists', () => {
  for (const input of [url, 'https://youtu.be/abcdefghijk?t=30', 'https://m.youtube.com/shorts/abcdefghijk']) {
    assert.equal(normalizeYouTubeUrl(input), url);
  }
  for (const input of ['https://youtube.com.evil.test/watch?v=abcdefghijk', 'https://127.0.0.1/watch?v=abcdefghijk',
    'http://youtu.be/abcdefghijk', 'https://user:password@youtu.be/abcdefghijk', `${url}&list=PLabc`,
    'https://youtu.be:8443/abcdefghijk', 'file:///etc/passwd', 'https://youtube.com/playlist?list=PLabc']) {
    assert.throws(() => normalizeYouTubeUrl(input));
  }
});

test('exige fonte única e anexo de áudio do CDN com tamanho limitado', () => {
  assert.deepEqual(validateSource({ attachment }), { attachmentUrl: attachment.url, extension: '.mp3' });
  assert.deepEqual(validateSource({ link: url }), { youtube: url });
  for (const input of [{}, { link: url, attachment }, { attachment: { ...attachment, name: 'script.exe' } },
    { attachment: { ...attachment, size: 26 * 1024 * 1024 } },
    { attachment: { ...attachment, url: 'https://localhost/a.mp3' } }]) assert.throws(() => validateSource(input));
});

test('aceita anexos normais e temporários nos dois CDNs sem remover a assinatura', () => {
  for (const hostname of ['cdn.discordapp.com', 'media.discordapp.net']) {
    for (const prefix of ['attachments', 'ephemeral-attachments']) {
      const signedUrl = `https://${hostname}/${prefix}/123/456/m%C3%BAsica.mp3?ex=abc&is=def&hm=signature`;
      assert.deepEqual(validateSource({ attachment: { ...attachment, url: signedUrl } }),
        { attachmentUrl: signedUrl, extension: '.mp3' });
    }
  }
});

test('anexos temporários continuam rejeitando hosts externos e URLs malformadas', () => {
  for (const invalidUrl of [
    'https://cdn.discordapp.com.evil.test/ephemeral-attachments/123/456/song.mp3',
    'https://evil.test/ephemeral-attachments/123/456/song.mp3',
    'https://127.0.0.1/ephemeral-attachments/123/456/song.mp3',
    'http://cdn.discordapp.com/ephemeral-attachments/123/456/song.mp3',
    'https://user:pass@cdn.discordapp.com/ephemeral-attachments/123/456/song.mp3',
    'https://cdn.discordapp.com:8443/ephemeral-attachments/123/456/song.mp3',
    'https://cdn.discordapp.com/ephemeral-attachments/123/456/',
    'https://cdn.discordapp.com/ephemeral-attachments/no-id/456/song.mp3',
    'https://cdn.discordapp.com/other/123/456/song.mp3',
    'not-a-url',
  ]) {
    assert.throws(() => validateSource({ attachment: { ...attachment, url: invalidUrl } }));
  }
});

test('download limita bytes reais mesmo sem Content-Length e remove parcial', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cover-download-'));
  const file = join(directory, 'input.mp3');
  try {
    let options;
    const fetchImpl = async (_, opts) => { options = opts; return new Response(new Uint8Array([1, 2, 3])); };
    await assert.rejects(downloadAttachment(attachment.url, file, { fetchImpl, maxBytes: 2 }), /limite/);
    assert.deepEqual(await readdir(directory), []);
    await downloadAttachment(attachment.url, file, { fetchImpl, maxBytes: 3 });
    assert.deepEqual([...await readFile(file)], [1, 2, 3]);
    assert.equal(options.redirect, 'error');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cancelamento durante download interrompe stream e remove arquivo parcial', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cover-cancel-download-'));
  const controller = new AbortController();
  let streamCancelled = false;
  let receivedSignal;
  const fetchImpl = async (_, { signal }) => {
    receivedSignal = signal;
    return new Response(new ReadableStream({
      start(stream) { stream.enqueue(new Uint8Array([1, 2, 3])); },
      cancel() { streamCancelled = true; },
    }));
  };
  try {
    const downloading = downloadAttachment(attachment.url, join(directory, 'input.mp3'),
      { fetchImpl, signal: controller.signal });
    // Let the pipeline attach to the response body before aborting it.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort(new Error('cancelled'));
    await assert.rejects(downloading, { name: 'AbortError' });
    assert.equal(receivedSignal.aborted, true);
    assert.equal(streamCancelled, true);
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const phase of ['download', 'generation', 'queue']) {
  test(`cover cancelado em ${phase} limpa temporários e libera novo pedido`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cover-cancel-handler-'));
    const reference = join(directory, 'voice.wav');
    await writeFile(reference, 'reference');
    const queue = new JobQueue();
    const operations = new OperationRegistry();
    let reached;
    const ready = new Promise((resolve) => { reached = resolve; });
    const waitForCancellation = (signal) => new Promise((resolve, reject) => {
      signal.throwIfAborted();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      reached();
    });
    let releaseBlocker;
    const blocker = phase === 'queue'
      ? queue.submit(() => new Promise((resolve) => { releaseBlocker = resolve; })) : null;
    let cancelling = true;
    let generations = 0;
    const edits = [];
    const handler = createCoverHandler({
      queue, operations, sessions: new Map(), busyGuilds: new Set(),
      findVoice: async () => ({ referencePath: reference }), runtimeCheck: async () => {},
      outputRoot: join(directory, 'jobs'),
      download: async (_, destination, { signal }) => {
        await writeFile(destination, 'partial');
        if (cancelling && phase === 'download') await waitForCancellation(signal);
      },
      generate: async ({ signal, directory: jobDirectory }) => {
        generations += 1;
        if (cancelling) await waitForCancellation(signal);
        const mp3 = join(jobDirectory, 'cover.mp3');
        await writeFile(mp3, 'result');
        return { mp3 };
      },
    });
    const interaction = {
      id: 'cancel-test', guild: { id: 'guild' }, user: { id: 'owner' }, client: { user: {} },
      options: {
        getBoolean: (key) => key === 'autorizado',
        getString: (key) => key === 'link' ? (phase === 'download' ? null : url) : 'voice',
        getAttachment: () => phase === 'download' ? attachment : null,
      },
      deferReply: async () => {},
      editReply: async () => { if (phase === 'queue') reached(); },
      channel: { isThread: () => false, permissionsFor: () => ({ missing: () => [] }),
        send: async () => ({ url: 'status-url', edit: async (payload) => edits.push(payload) }) },
    };
    try {
      const pending = handler(interaction);
      await ready;
      const task = operations.current('guild');
      assert.ok(task);
      assert.equal(operations.cancel(task), true);
      await pending;
      assert.match(edits.at(-1).content, /Cover cancelado/);
      assert.equal(operations.current('guild'), undefined);
      assert.deepEqual(await readdir(join(directory, 'jobs')), []);
      assert.equal(await readFile(reference, 'utf8'), 'reference');
      if (blocker) {
        assert.equal(generations, 0);
        assert.equal(queue.size, 1);
        releaseBlocker();
        await blocker.done;
      }
      cancelling = false;
      await handler(interaction);
      assert.ok(edits.some((payload) => payload.files));
      assert.equal(queue.size, 0);
      assert.equal(operations.current('guild'), undefined);
      assert.deepEqual(await readdir(join(directory, 'jobs')), []);
    } finally {
      operations.cancelAll();
      releaseBlocker?.();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test('fila serializa modelos, limita pedidos e continua depois de falha', async () => {
  const queue = new JobQueue(2);
  const order = [];
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  const one = queue.submit(async () => { order.push('start'); await gate; throw new Error('failed'); });
  const two = queue.submit(async () => { order.push('second'); return 42; });
  assert.equal(two.position, 2);
  assert.throws(() => queue.submit(() => {}), /cheia/);
  await Promise.resolve();
  assert.deepEqual(order, ['start']);
  unblock();
  await assert.rejects(one.done, /failed/);
  assert.equal(await two.done, 42);
  assert.equal(queue.size, 0);
  queue.close();
  assert.throws(() => queue.submit(() => {}), /encerrando/);
});

test('fechar fila impede início de trabalhos pendentes', async () => {
  const queue = new JobQueue();
  let called = false;
  const job = queue.submit(() => { called = true; });
  queue.close();
  await assert.rejects(job.done, /cancelado/);
  assert.equal(called, false);
  assert.equal(queue.size, 0);
});

test('reserva servidor antes de awaits e exige confirmação de autorização', async () => {
  let unblock;
  const gate = new Promise((resolve) => { unblock = resolve; });
  let authorized = false;
  const handler = createCoverHandler({ queue: new JobQueue(), findVoice: async () => null });
  const interaction = {
    guild: { id: 'guild' },
    options: { getBoolean: () => authorized, getString: () => url, getAttachment: () => null },
    deferReply: () => gate,
  };
  await assert.rejects(handler(interaction), /autorizado:true/);
  authorized = true;
  const first = handler(interaction);
  await assert.rejects(handler(interaction), /Já existe um cover/);
  unblock();
  await assert.rejects(first, /Voz não encontrada/);
  await assert.rejects(handler(interaction), /Voz não encontrada/);
});

test('cover entrega via mensagem durável, limpa arquivos e permite novo pedido após falha', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cover-handler-'));
  const reference = join(directory, 'voice.wav');
  await writeFile(reference, 'reference');
  const edits = [];
  let fail = false;
  let useAttachment = false;
  let shouldPlay = false;
  let plays = 0;
  const call = { id: 'call', permissionsFor: () => ({ has: () => true }) };
  const handler = createCoverHandler({
    queue: new JobQueue(), findVoice: async () => ({ referencePath: reference }),
    voiceChannelFor: () => call, sessions: new Map(), busyGuilds: new Set(),
    playWav: async () => { plays += 1; }, runtimeCheck: async () => {},
    download: async (sourceUrl, target) => { assert.equal(sourceUrl, ephemeralAttachment.url); await writeFile(target, 'download'); },
    outputRoot: join(directory, 'jobs'),
    generate: async ({ directory: jobDir, referencePath, onProgress }) => {
      assert.equal(await readFile(referencePath, 'utf8'), 'reference');
      if (useAttachment) assert.equal(await readFile(join(jobDir, 'input.mp3'), 'utf8'), 'download');
      if (fail) throw new Error('test error');
      onProgress('Mixando');
      const mp3 = join(jobDir, 'cover.mp3');
      await writeFile(mp3, 'audio');
      return { mp3 };
    },
  });
  const interaction = {
    id: '1', guild: { id: 'guild' }, user: { id: 'user' }, client: { user: {} },
    attachmentSizeLimit: 1024,
    options: { getBoolean: (key) => key === 'autorizado' || shouldPlay,
      getString: (key) => key === 'link' ? (useAttachment ? null : url) : 'voice',
      getAttachment: () => useAttachment ? ephemeralAttachment : null },
    deferReply: async () => {}, editReply: async () => {},
    channel: { isThread: () => false, permissionsFor: () => ({ missing: () => [] }),
      send: async () => ({ url: 'https://discord.com/channels/guild/channel/message', edit: async (payload) => {
        if (payload.files) assert.equal(await readFile(payload.files[0].attachment, 'utf8'), 'audio');
        edits.push(payload);
      } }),
    },
  };
  try {
    await handler(interaction);
    assert.equal(edits.filter((e) => e.files).length, 1);
    assert.equal(plays, 0);
    assert.deepEqual(await readdir(join(directory, 'jobs')), []);
    fail = true;
    await handler(interaction);
    assert.match(edits.at(-1).content, /não concluído/);
    assert.deepEqual(await readdir(join(directory, 'jobs')), []);
    fail = false;
    await handler(interaction);
    assert.equal(edits.filter((e) => e.files).length, 2);
    useAttachment = true;
    shouldPlay = true;
    await handler(interaction);
    assert.equal(plays, 1);
    assert.equal(edits.filter((e) => e.files).length, 3);
    assert.deepEqual(await readdir(join(directory, 'jobs')), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
