import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deleteRecordings,
  findRecording,
  listRecordings,
  listVoices,
  saveVoice,
} from '../src/voice-catalog.js';

test('catálogo encontra gravações por servidor e persiste uma voz', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vr-catalog-'));
  const recordingsRoot = join(root, 'recordings');
  const voicesRoot = join(root, 'voices');
  const session = join(recordingsRoot, 'Servidor-123', '2026-01-02T03-04-05Z');
  await mkdir(session, { recursive: true });
  await writeFile(join(session, 'Pessoa-456.wav'), Buffer.alloc(44 + 600_000));
  await writeFile(join(session, 'manifest.json'), JSON.stringify({
    guildId: '123',
    startedAt: '2026-01-02T03:04:05.000Z',
    users: [{
      userId: '456',
      username: 'pessoa',
      displayName: 'Pessoa',
      filename: 'Pessoa-456.wav',
      pcmBytes: 600_000,
    }],
  }));

  try {
    const recordings = await listRecordings(recordingsRoot, '123');
    assert.equal(recordings.length, 1);
    assert.equal(recordings[0].key, '2026-01-02T03-04-05Z|456');
    assert.equal(recordings[0].usableForCloning, true);
    assert.equal((await findRecording(recordingsRoot, '123', recordings[0].key))?.userId, '456');

    const saved = await saveVoice(
      voicesRoot, '123', recordings[0], { userId: '789', username: 'mod' },
    );
    const voices = await listVoices(voicesRoot, '123');
    assert.equal(voices.length, 1);
    assert.equal(voices[0].displayName, 'Pessoa');
    assert.equal(voices[0].createdBy.userId, '789');
    assert.equal(saved.referencePath, join(voicesRoot, '123', '456.wav'));
    assert.equal(voices[0].referencePath, join(voicesRoot, '123', '456.wav'));

    const persisted = JSON.parse(await readFile(join(voicesRoot, '123', '456.json'), 'utf8'));
    assert.equal(persisted.referenceFile, '456.wav');
    assert.equal('referencePath' in persisted, false);

    // Legacy catalogs may contain an absolute path from before the project moved.
    persisted.referencePath = 'C:\\antiga\\pasta\\voices\\456.wav';
    await writeFile(join(voicesRoot, '123', '456.json'), JSON.stringify(persisted));
    assert.equal(
      (await listVoices(voicesRoot, '123'))[0].referencePath,
      join(voicesRoot, '123', '456.wav'),
    );

    const deleted = await deleteRecordings(recordingsRoot, '123', 'pessoa', '456');
    assert.deepEqual(deleted, { files: 1, sessions: 1 });
    assert.equal((await listRecordings(recordingsRoot, '123')).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
