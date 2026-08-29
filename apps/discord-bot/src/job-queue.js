// Never advance until the active worker has actually exited.
export class JobQueue {
  #pending = [];
  #active = null;
  #closed = false;

  constructor(limit = 6) { this.limit = limit; }
  get size() { return this.#pending.length + (this.#active ? 1 : 0); }
  get waiting() { return this.#pending.length; }
  close() {
    this.#closed = true;
    for (const item of this.#pending.splice(0)) {
      item.cleanup();
      item.reject(new Error('Processamento cancelado: o bot está encerrando.'));
    }
  }

  submit(work, { signal } = {}) {
    if (this.#closed) throw new Error('O bot está encerrando. Tente novamente depois.');
    signal?.throwIfAborted();
    if (this.size >= this.limit) throw new Error('A fila de processamento está cheia. Tente novamente depois.');
    const position = this.size + 1;
    let resolve, reject;
    const done = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    const item = { work, signal, resolve, reject };
    const abort = () => {
      const index = this.#pending.indexOf(item);
      if (index < 0) return;
      this.#pending.splice(index, 1);
      item.cleanup();
      reject(signal.reason);
    };
    item.cleanup = () => signal?.removeEventListener('abort', abort);
    signal?.addEventListener('abort', abort, { once: true });
    this.#pending.push(item);
    queueMicrotask(() => this.#drain());
    return { position, done };
  }

  #drain() {
    if (this.#closed || this.#active || !this.#pending.length) return;
    const item = this.#pending.shift();
    this.#active = item;
    const finish = (error, result) => {
      item.cleanup();
      this.#active = null;
      if (error) item.reject(error);
      else if (item.signal?.aborted) item.reject(item.signal.reason);
      else item.resolve(result);
      queueMicrotask(() => this.#drain());
    };
    try {
      item.signal?.throwIfAborted();
      Promise.resolve(item.work()).then((value) => finish(null, value), (error) => finish(error));
    } catch (error) { finish(error); }
  }
}
