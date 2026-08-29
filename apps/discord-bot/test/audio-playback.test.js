import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  audioPlaybackCommand,
  createAudioPlaybackHandler,
} from '../src/audio-playback-command.js';
import { OperationRegistry } from '../src/operations.js';

const attachment = {
  name: 'meu-cover.mp3',
  size: 123,
  url: 'https://cdn.discordapp.com/attachments/123/456/meu-cover.mp3?ex=abc',
};

test('comando exige um arquivo de áudio', () => {
  const command = audioPlaybackCommand.toJSON();
  assert.equal(command.name, 'vr-tocar');
  assert.equal(command.options[0].name, 'arquivo');
  assert.equal(command.options[0].required, true);
});
test('baixa, converte, reproduz e limpa o anexo', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vr-playback-'));
  const operations = new OperationRegistry();
  const busyGuilds = new Set();
  const replies = [];
  const voiceChannel = {
    id: 'voice',
    permissionsFor: () => ({ missing: () => [] }),
  };
  const interaction = {
    guild: { id: 'guild' },
    user: { id: 'user' },
    client: { user: { id: 'bot' } },
    options: { getAttachment: () => attachment },
    async editReply(message) { replies.push(message); },
  };
  const handler = createAudioPlaybackHandler({
    voiceChannelFor: () => voiceChannel,
    sessions: new Map(),
    busyGuilds,
    operations,
    outputRoot: root,
    async download(url, target) {
      assert.equal(url, attachment.url);
      await writeFile(target, 'download');
    },
    async convert(input, output) {
      assert.equal(await readFile(input, 'utf8'), 'download');
      await writeFile(output, 'pcm');
    },
    async playPcm({ pcmPath, voiceChannel: selected }) {
      assert.equal(selected, voiceChannel);
      assert.equal(await readFile(pcmPath, 'utf8'), 'pcm');
    },
  });

  try {
    await handler(interaction);
    assert.equal(replies.at(-1), '✅ Áudio reproduzido na call.');
    assert.equal(busyGuilds.has('guild'), false);
    assert.equal(operations.current('guild'), undefined);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('exige que o usuário esteja em uma call', async () => {
  const handler = createAudioPlaybackHandler({
    voiceChannelFor: () => null,
    sessions: new Map(), busyGuilds: new Set(), playPcm: async () => {},
  });
  const interaction = {
    guild: { id: 'guild' }, user: { id: 'user' },
    options: { getAttachment: () => attachment },
  };
  await assert.rejects(handler(interaction), /Entre em um canal de voz/);
});
