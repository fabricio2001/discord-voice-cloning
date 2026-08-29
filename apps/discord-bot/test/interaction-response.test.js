import test from 'node:test';
import assert from 'node:assert/strict';
import { MessageFlags } from 'discord.js';
import { acknowledgeCommand, replyToCommand } from '../src/interaction-response.js';

for (const name of ['vr-parar', 'vr-listar-gravacoes', 'vr-listar-vozes', 'vr-limpar-gravacoes', 'vr-clonar-voz', 'vr-tts']) {
  test(`${name} confirma primeiro e edita a resposta sem segundo reply`, async () => {
    const calls = [];
    const interaction = {
      commandName: name, deferred: false, replied: false,
      async deferReply(options) { calls.push(['defer', options]); this.deferred = true; },
      async editReply(options) { calls.push(['edit', options]); },
      async reply() { assert.fail('reply duplicado'); },
    };
    await acknowledgeCommand(interaction);
    calls.push(['trabalho em disco']);
    await replyToCommand(interaction, { content: 'OK', ephemeral: true });
    assert.deepEqual(calls, [
      ['defer', name === 'vr-parar' ? {} : { flags: MessageFlags.Ephemeral }],
      ['trabalho em disco'], ['edit', { content: 'OK' }],
    ]);
  });
}

test('cover e gravação mantêm seu próprio defer', async () => {
  for (const commandName of ['vr-cover', 'vr-gravar']) {
    await acknowledgeCommand({ commandName, deferReply() { assert.fail('defer duplicado'); } });
  }
});

test('falha ao confirmar propaga sem prosseguir com trabalho destrutivo', async () => {
  let worked = false;
  await assert.rejects(async () => {
    await acknowledgeCommand({ commandName: 'vr-limpar-gravacoes', async deferReply() { throw new Error('Unknown interaction'); } });
    worked = true;
  }, /Unknown interaction/);
  assert.equal(worked, false);
});
