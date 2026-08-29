import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import OpusScript from 'opusscript';
import { ResilientOpusDecoder } from '../src/resilient-opus-decoder.js';

test('pacote inválido entre dois pacotes reais não encerra a decodificação', async () => {
  const encoder = new OpusScript(48_000, 2, OpusScript.Application.AUDIO);
  try {
    const packet = encoder.encode(Buffer.alloc(960 * 2 * 2), 960);
    const decoder = new ResilientOpusDecoder({ rate: 48_000, channels: 2, frameSize: 960 });
    let invalidPackets = 0;
    let pcmBytes = 0;
    decoder.on('invalidPacket', () => { invalidPackets += 1; });
    await pipeline(
      Readable.from([packet, Buffer.from([0xff]), packet]),
      decoder,
      new Writable({ write(chunk, encoding, done) { pcmBytes += chunk.length; done(); } }),
    );
    assert.equal(invalidPackets, 1);
    assert.equal(pcmBytes, 2 * 960 * 2 * 2);
  } finally {
    encoder.delete();
  }
});

test('erros internos do decoder continuam sendo propagados', async () => {
  const decoder = new ResilientOpusDecoder({ rate: 48_000, channels: 2, frameSize: 960 });
  decoder._decode = () => { throw new Error('Decode error: Invalid state'); };
  await assert.rejects(pipeline(Readable.from([Buffer.from([1])]), decoder,
    new Writable({ write(chunk, encoding, done) { done(); } })), /Invalid state/);
});
