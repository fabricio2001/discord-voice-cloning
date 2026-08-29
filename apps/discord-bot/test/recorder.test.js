import test from 'node:test';
import assert from 'node:assert/strict';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { GuildRecorder } from '../src/recorder.js';

test('finishUser fecha o arquivo e finaliza o cabeçalho WAV', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vr-recorder-'));
  const filePath = join(directory, 'usuario.wav');

  try {
    const output = createWriteStream(filePath);
    output.write(Buffer.alloc(44));
    output.write(Buffer.from([1, 2, 3, 4]));

    const entry = {
      filename: 'usuario.wav',
      filePath,
      bytes: 4,
      opusStream: new PassThrough(),
      decoder: new PassThrough(),
      output,
    };

    const recorder = Object.create(GuildRecorder.prototype);
    await recorder.finishUser(entry);

    const contents = await readFile(filePath);
    assert.equal(contents.subarray(0, 4).toString(), 'RIFF');
    assert.equal(contents.subarray(8, 12).toString(), 'WAVE');
    assert.equal(contents.readUInt32LE(40), 4);
    assert.deepEqual([...contents.subarray(44)], [1, 2, 3, 4]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
