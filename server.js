#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './lib/store.js';
import { searchOpenLibrary } from './lib/openlibrary.js';
import { discover, invalidateDiscoverCache } from './lib/recommend.js';
import { ReadingFiles } from './lib/reading-file.js';
import { BookSource } from './lib/book-source.js';
import { FileJobs } from './lib/file-jobs.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const BODY_LIMIT = 8 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const store = new Store(path.join(DATA_DIR, 'library.json'));
await store.init();
const readingFiles = new ReadingFiles(path.join(DATA_DIR, 'reading-files'));
const bookSource = new BookSource(process.env.BOOK_MCP_ENTRY, path.join(DATA_DIR, 'mcp-downloads'));
const fileJobs = new FileJobs();
let fileChanges = Promise.resolve();

function changeFiles(task) {
  const result = fileChanges.then(task);
  fileChanges = result.catch(() => {});
  return result;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

function fail(res, status, message) {
  sendJson(res, status, { error: message });
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) {
      const err = new Error('Requête trop volumineuse.');
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('Corps JSON invalide.');
    err.status = 400;
    throw err;
  }
}

/** Full snapshot returned by every mutation, so the client never drifts. */
function snapshot() {
  return { ...store.state(), stats: store.stats(), bookSourceAvailable: bookSource.enabled };
}

function commitReadingFile(bookId, save) {
  return changeFiles(() => {
    store.bookIdentity(bookId);
    return save();
  });
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

async function handleApi(req, res, url) {
  const method = req.method;
  const segments = url.pathname.split('/').filter(Boolean); // ["api", ...]
  const rest = segments.slice(1);
  const [head, id, sub, subId] = rest;

  if (head === 'health' && method === 'GET') {
    return sendJson(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
  }

  if (head === 'state' && method === 'GET') return sendJson(res, 200, snapshot());

  if (head === 'stats' && method === 'GET') return sendJson(res, 200, store.stats());

  if (head === 'books') {
    if (!id && method === 'POST') {
      const body = await readBody(req);
      const book = await store.createBook(body);
      return sendJson(res, 201, { book, ...snapshot() });
    }
    if (id && !sub && method === 'PATCH') {
      const body = await readBody(req);
      const book = await store.updateBook(id, body);
      return sendJson(res, 200, { book, ...snapshot() });
    }
    if (id && !sub && method === 'DELETE') {
      const result = await changeFiles(async () => {
        const deleted = await store.deleteBook(id);
        await readingFiles.remove(id);
        return deleted;
      });
      return sendJson(res, 200, { ...result, ...snapshot() });
    }
    if (id && sub === 'file') {
      const bookId = decodeURIComponent(id);
      const book = store.bookIdentity(bookId);
      if (method === 'GET' && subId === 'job') {
        const job = fileJobs.get(bookId);
        return sendJson(res, 200, { job: job?.id === url.searchParams.get('id') ? job : null });
      }
      if (method === 'POST' && ['search', 'acquire', 'find-pdf'].includes(subId)) {
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
          return fail(res, 415, 'Cette demande doit être envoyée en JSON.');
        }
        const body = await readBody(req);
        const attach = (source, row) =>
          readingFiles.attachDownload(source, book, row.format, (save) => commitReadingFile(bookId, save));
        const ref = typeof body?.ref === 'string' ? body.ref.slice(0, 512) : undefined;
        const run = async () => {
          if (subId === 'search') return bookSource.search(book);
          if (subId === 'find-pdf') return bookSource.findPdf(book, attach);
          return { file: await bookSource.acquire(bookId, ref, attach) };
        };
        if (url.searchParams.has('background')) {
          return sendJson(res, 202, { job: fileJobs.start(bookId, subId, ref, run) });
        }
        return sendJson(res, 200, await run());
      }
      if (subId) return fail(res, 404, 'Route de fichier inconnue.');
      if (method === 'PUT') {
        const info = await readingFiles.upload(req, book, (save) => commitReadingFile(bookId, save));
        return sendJson(res, 200, { file: info });
      }
      if (method === 'DELETE') {
        await changeFiles(() => {
          store.bookIdentity(bookId);
          return readingFiles.remove(bookId);
        });
        return sendJson(res, 200, { file: null });
      }
      if (method === 'GET' || method === 'HEAD') {
        if (method === 'GET' && url.searchParams.has('info')) {
          const info = await readingFiles.describe(bookId, book.totalPages);
          return sendJson(res, 200, { file: info, job: fileJobs.get(bookId) });
        }
        const served = await readingFiles.withFile(bookId, async (file, metadata) => {
          await readingFiles.serve(req, res, file, metadata, book.title, url.searchParams.has('download'));
          return true;
        });
        if (!served) return fail(res, 404, 'Fichier de lecture introuvable.');
        return;
      }
    }
    if (id && sub === 'sessions' && method === 'POST') {
      const body = await readBody(req);
      const result = await store.addSession(id, body);
      return sendJson(res, 201, { ...result, ...snapshot() });
    }
    if (id && sub === 'sessions' && subId && method === 'DELETE') {
      const book = await store.deleteSession(id, subId);
      return sendJson(res, 200, { book, ...snapshot() });
    }
    if (id && sub === 'progress' && method === 'POST') {
      const body = await readBody(req);
      const result = await store.setProgress(id, body);
      return sendJson(res, 200, { ...result, ...snapshot() });
    }
  }

  if (head === 'settings' && method === 'PATCH') {
    const body = await readBody(req);
    const settings = await store.updateSettings(body);
    return sendJson(res, 200, { settings, ...snapshot() });
  }

  if (head === 'search' && method === 'GET') {
    const q = url.searchParams.get('q') || '';
    const limit = Number(url.searchParams.get('limit') || 10);
    const results = await searchOpenLibrary(q, Number.isFinite(limit) ? limit : 10);
    return sendJson(res, 200, { results });
  }

  if (head === 'discover') {
    if (!id && method === 'GET') {
      const data = await discover(store.state(), {
        refresh: url.searchParams.get('refresh') === '1',
      });
      return sendJson(res, 200, data);
    }
    if (id === 'dismiss' && method === 'POST') {
      const body = await readBody(req);
      const key = typeof body.key === 'string' ? body.key.trim().slice(0, 40) : '';
      if (!key) return fail(res, 400, 'Clé de recommandation manquante.');
      const current = store.state().settings.dismissed || [];
      const settings = await store.updateSettings({ dismissed: [...current, key] });
      invalidateDiscoverCache();
      return sendJson(res, 200, { settings, ...snapshot() });
    }
    return fail(res, 404, 'Route de découverte inconnue.');
  }

  if (head === 'export' && method === 'GET') {
    const payload = JSON.stringify(store.exportData(), null, 2);
    const stamp = new Date().toISOString().slice(0, 10);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="lectures-${stamp}.json"`,
      'Content-Length': Buffer.byteLength(payload),
      'Cache-Control': 'no-store',
    });
    return res.end(payload);
  }

  if (head === 'import' && method === 'POST') {
    const body = await readBody(req);
    const result = await changeFiles(() => store.importData(body));
    return sendJson(res, 200, { ...result, ...snapshot() });
  }

  return fail(res, 404, 'Route API inconnue.');
}

/* ------------------------------------------------------------------ */
/* static files                                                        */
/* ------------------------------------------------------------------ */

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return fail(res, 405, 'Méthode non autorisée.');
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';

  // Resolve inside PUBLIC_DIR only — no path traversal.
  const target = path.resolve(PUBLIC_DIR, `.${rel}`);
  if (!target.startsWith(PUBLIC_DIR + path.sep) && target !== PUBLIC_DIR) {
    return fail(res, 403, 'Accès refusé.');
  }

  let data;
  try {
    data = await fs.readFile(target);
  } catch {
    // SPA-ish fallback for unknown non-file paths.
    if (path.extname(rel)) return fail(res, 404, 'Fichier introuvable.');
    try {
      data = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
    } catch {
      return fail(res, 404, 'Introuvable.');
    }
  }

  const ext = path.extname(target).toLowerCase() || '.html';
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': data.length,
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

/* ------------------------------------------------------------------ */
/* server                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer((req, res) => {
  const started = Date.now();
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  const run = url.pathname.startsWith('/api/')
    ? handleApi(req, res, url)
    : serveStatic(req, res, url);

  Promise.resolve(run)
    .catch((err) => {
      const status = err.status || 500;
      if (status >= 500) console.error(`[api] ${req.method} ${url.pathname}`, err);
      if (!res.headersSent) {
        fail(res, status, err.status ? err.message : 'Erreur interne du serveur.');
      } else {
        res.end();
      }
    })
    .finally(() => {
      if (process.env.LOG_REQUESTS) {
        console.error(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
      }
    });
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;
  console.error(`Suivi de lectures — ${url}`);
  console.error(`Données : ${store.file}`);
  if (HOST === '0.0.0.0') {
    console.error('Écoute sur toutes les interfaces : ouvrez cette URL depuis votre téléphone (même Wi-Fi).');
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    bookSource.close().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}
