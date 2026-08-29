import prism from 'prism-media';

// A malformed Opus packet must not destroy the stream for the entire call.
// Delegate decoding and cleanup to prism; tolerate only this known packet error.
export class ResilientOpusDecoder extends prism.opus.Decoder {
  _transform(chunk, encoding, done) {
    super._transform(chunk, encoding, (error) => {
      if (error && /Decode error: Invalid packet/i.test(error.message)) {
        this.emit('invalidPacket', error);
        done();
      } else {
        done(error);
      }
    });
  }
}
