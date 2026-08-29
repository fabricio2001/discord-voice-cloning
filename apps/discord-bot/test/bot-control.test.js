import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { spawn } from 'node:child_process';
import { OperationRegistry } from '../src/operations.js';
import { JobQueue } from '../src/job-queue.js';
import { createBotControlHandler, botControlCommands } from '../src/bot-control.js';
import { bindProcessCancellation } from '../src/process-control.js';
import { acknowledgeCommand } from '../src/interaction-response.js';
import { playWav, prepareVoice } from '../src/voice-cloning.js';

function fixture(commandName = 'vr-cancelar-processo', userId = 'owner') {
  const operations = new OperationRegistry();
  const sessions = new Map();
  const replies = [];
  const interaction = {
    commandName, guild: { id: 'guild' }, user: { id: userId },
    client: { isReady: () => true, ws: { ping: 25 } },
    reply: async (payload) => replies.push(payload),
    editReply: async (payload) => replies.push(payload),
    deferReply: async () => { interaction.deferred = true; },
  };
  const handler = createBotControlHandler({ operations, sessions, queue: new JobQueue(),
    canManage: async () => false, build: 'test' });
  const start = (guildId = 'guild') => operations.start({ guildId, userId: 'owner', kind: 'TTS' });
  return { operations, sessions, interaction, replies, handler, start };
}

test('status informa conexão, gravação e processo sem revelar outro servidor', async () => {
  const f = fixture('vr-status-bot');
  f.start();
  f.start('other').kind = 'SECRET';
  f.sessions.set('guild', { voiceChannel: { id: 'call' }, users: new Map([['one', {}]]) });
  assert.equal(await f.handler(f.interaction), true);
  const { content, allowedMentions } = f.replies[0];
  assert.match(content, /conectado/);
  assert.match(content, /25 ms/);
  assert.match(content, /ativa em <#call> \(1 participante/);
  assert.match(content, /TTS/);
  assert.match(content, /não inclui Python\/GPU/);
  assert.doesNotMatch(content, /SECRET/);
  assert.deepEqual(allowedMentions, { parse: [] });
});

test('status ocioso e cancelamento sem trabalho respondem sem erro', async () => {
  const f = fixture('vr-status-bot');
  await f.handler(f.interaction);
  assert.match(f.replies[0].content, /Processo deste servidor: nenhum/);
  f.interaction.commandName = 'vr-cancelar-processo';
  await f.handler(f.interaction);
  assert.match(f.replies[1].content, /Não há processamento/);
  assert.equal(await f.handler({ ...f.interaction, commandName: 'vr-tts' }), false);
  assert.equal(botControlCommands.length, 2);
});

test('autor cancela após defer sem interromper gravação ou outro servidor', async () => {
  const f = fixture();
  const task = f.start();
  const other = f.start('other');
  f.sessions.set('guild', { active: true });
  await acknowledgeCommand(f.interaction);
  await f.handler(f.interaction);
  assert.equal(f.interaction.deferred, true);
  assert.equal(task.signal.aborted, true);
  assert.equal(other.signal.aborted, false);
  assert.deepEqual(f.sessions.get('guild'), { active: true });
  assert.match(f.replies[0].content, /solicitado/);
  assert.equal(f.operations.current('guild'), task);
  assert.throws(() => f.start(), /Já existe/);
  await f.handler(f.interaction);
  assert.match(f.replies[1].content, /já está sendo cancelado/);
  f.operations.finish(task);
  assert.equal(f.operations.current('guild'), undefined);
});

test('outro membro não cancela; moderador pode cancelar', async () => {
  const f = fixture('vr-cancelar-processo', 'moderator');
  const task = f.start();
  await f.handler(f.interaction);
  assert.equal(task.signal.aborted, false);
  assert.match(f.replies[0].content, /Gerenciar canais/);
  const moderatorHandler = createBotControlHandler({ operations: f.operations, canManage: async () => true });
  await moderatorHandler(f.interaction);
  assert.equal(task.signal.aborted, true);
});

test('checagem assíncrona de permissão não cancela tarefa substituta', async () => {
  const f = fixture('vr-cancelar-processo', 'moderator');
  const old = f.start();
  let replacement;
  const handler = createBotControlHandler({ operations: f.operations, canManage: async () => {
    f.operations.finish(old);
    replacement = f.start();
    return true;
  } });
  await handler(f.interaction);
  f.operations.finish(old);
  assert.equal(f.operations.current('guild'), replacement);
  assert.equal(replacement.signal.aborted, false);
  assert.equal(f.operations.cancel(old), false);
});

test('cancelar pendente remove da fila sem executar; próximo continua', async () => {
  const queue = new JobQueue();
  let release;
  const first = queue.submit(() => new Promise((resolve) => { release = resolve; }));
  await Promise.resolve();
  const controller = new AbortController();
  let called = false;
  const second = queue.submit(() => { called = true; }, { signal: controller.signal });
  const third = queue.submit(() => 'next');
  controller.abort(new Error('cancelled'));
  await assert.rejects(second.done, /cancelled/);
  assert.equal(queue.size, 2);
  assert.equal(queue.waiting, 1);
  release();
  await first.done;
  assert.equal(await third.done, 'next');
  assert.equal(called, false);
});

test('cancelar ativo só libera GPU depois do encerramento real do worker', async () => {
  const queue = new JobQueue();
  const controller = new AbortController();
  let release;
  const first = queue.submit(() => new Promise((resolve) => { release = resolve; }), { signal: controller.signal });
  let called = false;
  const second = queue.submit(() => { called = true; });
  await Promise.resolve();
  controller.abort(new Error('cancelled'));
  await Promise.resolve();
  assert.equal(queue.size, 2);
  assert.equal(called, false);
  release();
  await assert.rejects(first.done, /cancelled/);
  await second.done;
  assert.equal(called, true);
  assert.equal(queue.size, 0);
  assert.throws(() => queue.submit(() => {}, { signal: controller.signal }), /cancelled/);
});

test('cancelamento de subprocesso usa somente o handle vinculado e remove listener', () => {
  const child = new EventEmitter();
  const controller = new AbortController();
  const killed = [];
  bindProcessCancellation(child, controller.signal, (target) => killed.push(target));
  controller.abort();
  assert.deepEqual(killed, [child]);
  const finished = new AbortController();
  bindProcessCancellation(child, finished.signal, () => assert.fail('already closed'));
  child.emit('close');
  finished.abort();
  bindProcessCancellation(child, controller.signal, (target) => killed.push(target));
  assert.deepEqual(killed, [child, child]);
  child.emit('close');
});

test('cancelar espera de conexão do TTS preserva conexão usada pela gravação', async () => {
  const connection = new EventEmitter();
  connection.state = { status: 'connecting' };
  connection.destroy = () => assert.fail('não pode destruir a conexão da gravação');
  const controller = new AbortController();
  const playback = playWav({ existingConnection: connection, signal: controller.signal });
  controller.abort(new Error('cancelled'));
  await assert.rejects(playback, /cancelled/);
  assert.equal(connection.listenerCount('ready'), 0);
});

test('clonagem e reprodução já canceladas não iniciam trabalho', async () => {
  const controller = new AbortController();
  controller.abort(new Error('cancelled'));
  await assert.rejects(prepareVoice('missing.wav', 'unused.wav', undefined, { signal: controller.signal }), /cancelled/);
  await assert.rejects(playWav({ signal: controller.signal }), /cancelled/);
});

test('cancelamento encerra um subprocesso real criado exclusivamente pelo teste', { timeout: 10000 }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' });
  const closed = once(child, 'close');
  const controller = new AbortController();
  bindProcessCancellation(child, controller.signal);
  try {
    await once(child, 'spawn');
    controller.abort();
    await closed;
    assert.ok(child.exitCode !== null || child.signalCode !== null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
});
