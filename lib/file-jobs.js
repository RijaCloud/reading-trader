import { randomUUID } from 'node:crypto';

const RETENTION = 30 * 60_000;
const MAX_JOBS = 64;

export class FileJobs {
  #jobs = new Map();

  get(bookId) {
    const job = this.#jobs.get(bookId);
    if (job?.expiresAt <= Date.now()) {
      this.#jobs.delete(bookId);
      return undefined;
    }
    return job?.state;
  }

  start(bookId, operation, ref, run) {
    const existing = this.get(bookId);
    if (existing?.status === 'running') return existing;

    for (const id of this.#jobs.keys()) this.get(id);
    if (this.#jobs.size >= MAX_JOBS && !this.#jobs.has(bookId)) {
      const settled = [...this.#jobs].find(([, job]) => job.state.status !== 'running');
      if (!settled) throw Object.assign(new Error('Trop de recherches sont en cours.'), { status: 503 });
      this.#jobs.delete(settled[0]);
    }

    const state = { id: randomUUID(), operation, status: 'running', ...(ref ? { ref } : {}) };
    const job = { state };
    this.#jobs.set(bookId, job);
    Promise.resolve().then(run).then(
      (result) => Object.assign(state, { status: 'done', result }),
      (error) => {
        if (!error.status || error.status >= 500) console.error('[file-job]', operation, error);
        Object.assign(state, { status: 'failed', error: error.status
          ? error.message : 'La récupération a échoué côté serveur.', errorStatus: error.status || 500 });
      },
    ).finally(() => { job.expiresAt = Date.now() + RETENTION; });
    return state;
  }
}
