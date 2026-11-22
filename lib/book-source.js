import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { automaticPdfCandidates, rankEditions } from './edition-match.js';
import { FILE_LIMIT_MIB } from '../public/file-limits.js';

const sourceError = (status, message) => Object.assign(new Error(message), { status });
const MCP_REQUEST_TIMEOUT = -32001;
const SEARCH_CACHE_LIMIT = 32;
const SEARCH_TTL = 3 * 60_000;
const PARTIAL_SEARCH_TTL = 25_000;
const REJECTED_TTL = 30 * 60_000;
const CATALOGUE_SOURCES = ['libgen', 'zlibrary', 'annas'];
const messages = {
  ref_unavailable: [409, 'Cette recherche a expiré. Relance-la et choisis à nouveau le fichier.'],
  provider_timeout: [504, 'La source met trop de temps à répondre.'],
  credentials_missing: [503, 'Cette source nécessite un compte configuré sur le serveur.'],
  quota_exhausted: [429, 'Le quota de téléchargement de cette source est atteint.'],
  provider_unreachable: [502, 'La source du livre est injoignable pour le moment.'],
  provider_error: [502, 'La source n’a pas remis le fichier demandé. Essaie une autre édition.'],
  output_refused: [502, 'Ce fichier n’a pas pu être enregistré. Essaie une autre édition.'],
};

function downloadTimeout(row, automatic = false) {
  const minimum = automatic ? 55_000 : 225_000;
  if (row.format !== 'pdf') return minimum;
  if (!(row.sizeMb > 0)) return automatic ? 120_000 : 10 * 60_000;
  // Allow about eight seconds per MiB on a slow upstream, plus setup time.
  return Math.min(25 * 60_000, Math.max(minimum, 45_000 + Math.ceil(row.sizeMb * 8_000)));
}

function availableEditions(result, formats, showCopies = false) {
  const rows = showCopies ? result.rows.flatMap((row) => [
    row,
    ...(row.other_copies ?? []).filter((copy) => !copy.filter || copy.filter === 'pass').map((copy) => ({
      ...row, ...copy, download_available: copy.download_available,
    })),
  ]) : result.rows;
  const seen = new Set();
  return rows
    .filter((row) => {
      if (!row.ref || seen.has(row.ref) || (!showCopies && row.download_available === false) ||
          !formats.includes(row.format) || row.size_mb > FILE_LIMIT_MIB[row.format]) return false;
      seen.add(row.ref);
      return true;
    })
    .map(({ ref, title, author, source, format, year, language, size_mb, pages, download_available }) => ({
      ref, title, author, source, format, year, language, sizeMb: size_mb, pages,
      downloadable: download_available !== false,
    }));
}

function sourceLines(lines) {
  if (!lines || typeof lines !== 'object') return [];
  const entries = Array.isArray(lines) ? lines : Object.entries(lines).map(([source, line]) => ({ ...line, source }));
  return entries
    .filter((line) => line && CATALOGUE_SOURCES.includes(line.source))
    .map(({ source, state, reason, code }) => ({ source, state, reason, code }));
}

export class BookSource {
  #connection;
  #searchCache = new Map();
  #selections = new Map();
  #acquiring = new Set();
  #rejected = new Map();

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
      this.#searchCache.clear();
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
    } catch (error) {
      if (error.code === MCP_REQUEST_TIMEOUT) {
        throw sourceError(504, 'La source a dépassé le délai de transfert.');
      }
      throw sourceError(502, 'Le serveur de livres n’a pas répondu à la demande.');
    }
    const data = response.structuredContent;
    if (response.isError || data?.error) {
      const code = data?.error?.code;
      if (code === 'ref_unavailable') this.#searchCache.clear();
      const [status, message] = Object.hasOwn(messages, code) ? messages[code] :
        [502, 'La source n’a pas pu terminer la demande. Tu peux choisir une autre édition.'];
      const error = sourceError(status, message);
      error.sources = sourceLines(data?.error?.attempts);
      throw error;
    }
    if (!data) throw sourceError(502, 'Réponse illisible du serveur de livres.');
    return data;
  }

  #searchCatalog(args, timeout) {
    const key = JSON.stringify(args);
    const cached = this.#searchCache.get(key);
    this.#searchCache.delete(key);
    if (cached?.expires > Date.now()) {
      this.#searchCache.set(key, cached);
      return cached.result;
    }

    const entry = { expires: Infinity };
    entry.result = this.#call('search', args, timeout).then((result) => {
      if (!Array.isArray(result.rows)) throw sourceError(502, 'Résultats de recherche indisponibles.');
      const freshFor = result.all_answered && result.rows.length ? SEARCH_TTL : PARTIAL_SEARCH_TTL;
      entry.expires = Date.now() + freshFor;
      return result;
    }).catch((error) => {
      if (this.#searchCache.get(key) === entry) this.#searchCache.delete(key);
      throw error;
    });
    this.#searchCache.set(key, entry);
    if (this.#searchCache.size > SEARCH_CACHE_LIMIT) this.#searchCache.delete(this.#searchCache.keys().next().value);
    return entry.result;
  }

  async search(book, { pdfOnly = false, allSources = false, timeout = 185_000 } = {}) {
    const { id, title, author } = book;
    const args = {
      query: title,
      ...(author ? { author } : {}),
      formats: pdfOnly ? ['pdf'] : ['pdf', 'epub'],
      limit: 25,
      ...(allSources ? { sources: CATALOGUE_SOURCES } : {}),
    };
    let result;
    if (pdfOnly) {
      const broadArgs = { ...args, formats: ['pdf', 'epub'] };
      const recent = this.#searchCache.get(JSON.stringify({ ...broadArgs, sources: CATALOGUE_SOURCES }))
        ?? this.#searchCache.get(JSON.stringify(broadArgs));
      // A recent general search is enough when it already includes an eligible PDF.
      if (recent && recent.expires !== Infinity && recent.expires > Date.now()) {
        const broadResult = await recent.result;
        const { rows } = rankEditions(book, availableEditions(broadResult, args.formats));
        if (automaticPdfCandidates(book, rows).length >= 3) result = broadResult;
      }
    }
    result ??= await this.#searchCatalog(args, timeout);

    const { rows, ignored } = rankEditions(book, availableEditions(result, args.formats, allSources));
    this.#selections.delete(id);
    this.#selections.set(id, new Map(rows.filter((row) => row.downloadable).map((row) => [row.ref, row])));
    if (this.#selections.size > 64) this.#selections.delete(this.#selections.keys().next().value);
    return { rows, ignored, complete: result.all_answered, sources: sourceLines(result.sources) };
  }

  async acquire(id, ref, attach, { timeout, background = false } = {}) {
    const row = typeof ref === 'string' && this.#selections.get(id)?.get(ref);
    if (!row) {
      throw sourceError(409, 'Relance la recherche avant de télécharger ce fichier.');
    }
    return this.#acquireRow(id, row, attach, { timeout, background });
  }

  async #acquireRow(id, row, attach, { timeout, background = false, expectedPages, onProgress }) {
    if (this.#acquiring.has(id)) throw sourceError(409, 'Un téléchargement est déjà en cours pour ce livre.');
    this.#acquiring.add(id);
    try {
      timeout ??= background ? downloadTimeout(row) : 225_000;
      const deadline = performance.now() + timeout;
      const outputDir = createHash('sha256').update(id).digest('hex');
      const { ref } = row;
      const args = { ref, output_dir: outputDir };
      let rejectKey;
      if (row.source === 'libgen') {
        const detail = await this.#call('get_book', { ref }, Math.min(timeout, 10_000));
        const md5 = detail.identifiers?.md5;
        if (typeof md5 === 'string' && /^[a-f0-9]{32}$/i.test(md5)) {
          args.filename = `${md5.toLowerCase()}.${row.format}`;
          if (expectedPages) rejectKey = `${args.filename}:${expectedPages}`;
        }
      }
      if (rejectKey && this.#rejected.get(rejectKey) > Date.now()) return null;
      onProgress?.('download');
      const result = await this.#call('download', args, Math.max(1, Math.floor(deadline - performance.now())));
      if (typeof result.path !== 'string' || !path.isAbsolute(result.path)) {
        throw sourceError(502, 'Le serveur de livres n’a fourni aucun fichier.');
      }
      const root = await fs.realpath(this.output);
      const downloaded = await fs.realpath(result.path);
      const expected = path.join(root, outputDir) + path.sep;
      if (!downloaded.startsWith(expected)) throw sourceError(502, 'Emplacement du fichier invalide.');
      onProgress?.('verify');
      try {
        return await attach(downloaded, row);
      } catch (error) {
        if (rejectKey && [413, 415, 422].includes(error.status)) {
          this.#rejected.delete(rejectKey);
          this.#rejected.set(rejectKey, Date.now() + REJECTED_TTL);
          if (this.#rejected.size > 128) this.#rejected.delete(this.#rejected.keys().next().value);
        }
        throw error;
      }
    } finally {
      this.#acquiring.delete(id);
    }
  }

  async findPdf(book, attach, { background = false, report } = {}) {
    if (!book.totalPages) throw sourceError(422, 'Renseigne le nombre de pages sur la fiche pour vérifier le PDF.');
    const deadline = performance.now() + (background ? 25 * 60_000 : 210_000);
    report?.('Recherche des éditions PDF…');
    const search = await this.search(book, { pdfOnly: true, timeout: 75_000 });
    // The automatic path only tries the source that does not spend account quota.
    const candidates = automaticPdfCandidates(book, search.rows);
    const rejected = new Set();
    let checked = 0;
    for (const candidate of candidates) {
      if (checked >= 3) break;
      const candidateBudget = background ? downloadTimeout(candidate, true) : 55_000;
      const timeout = Math.min(candidateBudget, Math.floor(deadline - performance.now()));
      if (timeout < 5_000) break;
      try {
        const current = checked + 1;
        const file = await this.#acquireRow(book.id, candidate, attach, {
          timeout,
          expectedPages: book.totalPages,
          onProgress(stage) {
            if (stage === 'verify') report?.(`Édition ${current} · vérification des pages…`);
            else {
              const size = candidate.sizeMb > 0 ? ` · ${Math.round(candidate.sizeMb * 10) / 10} Mo` : '';
              report?.(`Édition ${current} · téléchargement${size}…`);
            }
          },
        });
        if (!file) {
          rejected.add(candidate.ref);
          continue;
        }
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
