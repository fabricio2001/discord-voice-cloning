export class OperationRegistry {
  #tasks = new Map();

  start({ guildId, userId, kind }) {
    if (this.#tasks.has(guildId)) throw new Error('Já existe um processo neste servidor. Aguarde ou use `/vr-cancelar-processo`.');
    const controller = new AbortController();
    const task = { guildId, userId, kind, controller, signal: controller.signal,
      startedAt: Date.now(), stage: 'Preparando' };
    this.#tasks.set(guildId, task);
    return task;
  }

  current(guildId) { return this.#tasks.get(guildId); }
  finish(task) {
    if (this.current(task.guildId) === task) this.#tasks.delete(task.guildId);
  }
  cancel(task) {
    // Never cancel a replacement that started while permissions were checked.
    if (this.current(task.guildId) !== task || task.signal.aborted) return false;
    task.stage = 'Cancelando; aguardando encerramento e limpeza';
    task.controller.abort(new Error('Processamento cancelado pelo usuário.'));
    return true;
  }
  cancelAll() { for (const task of this.#tasks.values()) this.cancel(task); }
}
