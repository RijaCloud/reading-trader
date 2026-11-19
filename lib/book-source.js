import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { rankEditions } from './edition-match.js';

const sourceError = (status, message) => Object.assign(new Error(message), { status });
const messages = {
  ref_unavailable: [409, 'Cette recherche a expiré. Relance-la et choisis à nouveau le fichier.'],
  provider_timeout: [504, 'La source met trop de temps à répondre.'],
  credentials_missing: [503, 'Cette source nécessite un compte configuré sur le serveur.'],
  quota_exhausted: [429, 'Le quota de téléchargement de cette source est atteint.'],
  provider_unreachable: [502, 'La source du livre est injoignable pour le moment.'],
  provider_error: [502, 'La source n’a pas remis le fichier demandé. Essaie une autre édition.'],
  output_refused: [502, 'Ce fichier n’a pas pu être enregistré. Essaie une autre édition.'],
};

export class BookSource {
  #connection;
  #selections = new Map();
  #acquiring = new Set();

  constructor(entry, output) {
    this.entry = entry && path.resolve(entry);
    this.output = output;
  }

  get enabled() {
    return Boolean(this.entry);
  }

  async #connect() {
    const resolve = createRequire(this.entry).resolve;
    const [{ Client }, { StdioClientTransport }] = await Promise.all([
      import(pathToFileURL(resolve('@modelcontextprotocol/sdk/client/index.js'))),
      import(pathToFileURL(resolve('@modelcontextprotocol/sdk/client/stdio.js'))),
    ]);
    const runtime = path.join(path.dirname(this.output), 'mcp-runtime');
    await fs.mkdir(runtime, { recursive: true, mode: 0o700 });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [this.entry],
      cwd: runtime,
      env: {
        ...process.env,
        ZLIBRARY_OUTPUT_ROOT: this.output,
        ZLIBRARY_UNRESTRICTED_OUTPUT: '0',
      },
      stderr: 'pipe',
    });
    // Provider diagnostics can contain account details; avoid forwarding them to logs.
    transport.stderr?.resume();
    const client = new Client({ name: 'reading-tracker', version: '1.0.0' });
    try {
      await client.connect(transport, { timeout: 10_000 });
    } catch (error) {
      await transport.close().catch(() => {});
      throw error;
    }
    client.onclose = () => {
      this.#selections.clear();
      this.#connection = undefined;
    };
    return client;
  }

  async #call(name, args, timeout) {
    if (!this.enabled) throw sourceError(503, 'Le serveur de livres est indisponible.');
    this.#connection ??= this.#connect().catch(() => {
      this.#connection = undefined;
      throw sourceError(503, 'Le serveur de livres n’a pas pu démarrer.');
    });
    const client = await this.#connection;
    let response;
    try {
      response = await client.callTool({ name, arguments: args }, undefined, { timeout });
    } catch {
      throw sourceError(502, 'Le serveur de livres n’a pas répondu à la demande.');
    }
    const data = response.structuredContent;
    if (response.isError || data?.error) {
      const code = data?.error?.code;
      const [status, message] = Object.hasOwn(messages, code) ? messages[code] :
        [502, 'La source n’a pas pu terminer la demande. Tu peux choisir une autre édition.'];
      throw sourceError(status, message);
    }
    if (!data) throw sourceError(502, 'Réponse illisible du serveur de livres.');
    return data;
  }

  async search(book, { pdfOnly = false, timeout = 185_000 } = {}) {
    const { id, title, author } = book;
    const result = await this.#call('search', {
      query: title,
      ...(author ? { author } : {}),
      formats: pdfOnly ? ['pdf'] : ['pdf', 'epub'],
      limit: 25,
    }, timeout);
    if (!Array.isArray(result.rows)) throw sourceError(502, 'Résultats de recherche indisponibles.');

    const available = result.rows
      .filter((row) => row.ref && row.download_available !== false &&
        ['pdf', 'epub'].includes(row.format) && !(row.size_mb > 50))
      .map(({ ref, title, author, source, format, year, language, size_mb, pages }) => ({
        ref, title, author, source, format, year, language, sizeMb: size_mb, pages,
      }));
    const { rows, ignored } = rankEditions(book, available);
    this.#selections.delete(id);
    this.#selections.set(id, new Map(rows.map((row) => [row.ref, row])));
    if (this.#selections.size > 64) this.#selections.delete(this.#selections.keys().next().value);
    return { rows, ignored, complete: result.all_answered };
  }

  async acquire(id, ref, attach, { timeout = 225_000 } = {}) {
    const row = typeof ref === 'string' && this.#selections.get(id)?.get(ref);
    if (!row) {
      throw sourceError(409, 'Relance la recherche avant de télécharger ce fichier.');
    }
    if (this.#acquiring.has(id)) throw sourceError(409, 'Un téléchargement est déjà en cours pour ce livre.');
    this.#acquiring.add(id);
    try {
      const deadline = performance.now() + timeout;
      const outputDir = createHash('sha256').update(id).digest('hex');
      const args = { ref, output_dir: outputDir };
      if (row.source === 'libgen') {
        const detail = await this.#call('get_book', { ref }, Math.min(timeout, 10_000));
        const md5 = detail.identifiers?.md5;
        if (typeof md5 === 'string' && /^[a-f0-9]{32}$/i.test(md5)) {
          args.filename = `${md5.toLowerCase()}.${row.format}`;
        }
      }
      const result = await this.#call('download', args, Math.max(1, Math.floor(deadline - performance.now())));
      if (typeof result.path !== 'string' || !path.isAbsolute(result.path)) {
        throw sourceError(502, 'Le serveur de livres n’a fourni aucun fichier.');
      }
      const root = await fs.realpath(this.output);
      const downloaded = await fs.realpath(result.path);
      const expected = path.join(root, outputDir) + path.sep;
      if (!downloaded.startsWith(expected)) throw sourceError(502, 'Emplacement du fichier invalide.');
      return await attach(downloaded, row);
    } finally {
      this.#acquiring.delete(id);
    }
  }

  async findPdf(book, attach) {
    if (!book.totalPages) throw sourceError(422, 'Renseigne le nombre de pages sur la fiche pour vérifier le PDF.');
    const deadline = performance.now() + 210_000;
    const search = await this.search(book, { pdfOnly: true, timeout: 75_000 });
    // The automatic path only tries the source that does not spend account quota.
    const candidates = search.rows.filter((row) =>
      row.source === 'libgen' && row.format === 'pdf' && row.compatible).slice(0, 3);
    const rejected = new Set();
    let checked = 0;
    for (const candidate of candidates) {
      const timeout = Math.min(55_000, Math.floor(deadline - performance.now()));
      if (timeout < 5_000) break;
      try {
        const file = await this.acquire(book.id, candidate.ref, attach, { timeout });
        return { file };
      } catch (error) {
        if (![413, 415, 422, 502, 504].includes(error.status)) throw error;
        if ([413, 415, 422].includes(error.status)) rejected.add(candidate.ref);
        checked += 1;
      }
    }
    search.rows = search.rows.filter((row) => !rejected.has(row.ref));
    search.ignored += rejected.size;
    return {
      search,
      message: checked
        ? `Aucun PDF correspondant n’a été confirmé parmi ${checked} fichier${checked > 1 ? 's' : ''} essayé${checked > 1 ? 's' : ''}.`
        : 'Aucun PDF pouvant être vérifié automatiquement. Consulte les éditions proposées.',
    };
  }

  async close() {
    await (await this.#connection)?.close();
  }
}
