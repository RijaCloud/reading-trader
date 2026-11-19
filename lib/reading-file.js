import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { pagesMatch } from './edition-match.js';

const MAX_READING_FILE_SIZE = 50 * 1024 * 1024;
const TYPES = { pdf: 'application/pdf', epub: 'application/epub+zip' };
const pdfInfo = promisify(execFile);

function fileError(status, message) {
  return Object.assign(new Error(message), { status });
}

function tooLarge() {
  return fileError(413, 'Le fichier dépasse 50 Mo.');
}

async function pdfPages(filename) {
  const { stdout } = await pdfInfo('pdfinfo', [filename], {
    env: { PATH: process.env.PATH || '/usr/bin:/bin', LC_ALL: 'C' },
    timeout: 8_000,
    killSignal: 'SIGKILL',
    maxBuffer: 128 * 1024,
  });
  const pages = Number(/^Pages:\s+(\d+)\s*$/m.exec(stdout)?.[1]);
  if (!Number.isSafeInteger(pages) || pages < 1) throw new Error('Invalid PDF page count');
  return pages;
}

function formatOf(header) {
  if (header.subarray(0, 5).toString() === '%PDF-') return 'pdf';
  // EPUB starts with a ZIP entry named "mimetype", stored uncompressed.
  if (header.length >= 58 && header.readUInt32LE(0) === 0x04034b50 &&
      header.readUInt16LE(8) === 0 && header.readUInt16LE(26) === 8 &&
      header.readUInt16LE(28) === 0 && header.subarray(30, 58).toString() === 'mimetypeapplication/epub+zip') {
    return 'epub';
  }
  return null;
}

async function inspect(file) {
  const stat = await file.stat();
  const { size } = stat;
  if (!stat.isFile()) throw fileError(415, 'Fichier de lecture invalide.');
  if (size > MAX_READING_FILE_SIZE) throw tooLarge();
  const header = Buffer.alloc(58);
  const { bytesRead } = await file.read(header, 0, header.length, 0);
  const format = formatOf(header.subarray(0, bytesRead));
  if (!format) throw fileError(415, 'Choisis un fichier PDF ou EPUB valide.');
  return { format, size };
}

function rangeOf(range, size) {
  if (!range) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return start <= end && start < size ? { start, end } : null;
}

export class ReadingFiles {
  constructor(dir) {
    this.dir = dir;
  }

  pathFor(id) {
    // Imported book IDs can contain characters that are unsafe in paths.
    const key = createHash('sha256').update(id).digest('hex');
    return path.join(this.dir, key);
  }

  async withFile(id, task) {
    let file;
    try {
      file = await fs.open(this.pathFor(id), 'r');
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    try {
      return await task(file, await inspect(file));
    } finally {
      await file.close();
    }
  }

  describe(id, expectedPages) {
    return this.withFile(id, async (_file, info) => {
      if (info.format !== 'pdf') return info;
      const pages = await pdfPages(this.pathFor(id)).catch(() => null);
      return { ...info, pages, pageMismatch: pages !== null && !pagesMatch(pages, expectedPages) };
    });
  }

  async upload(req, book, commit) {
    const type = req.headers['content-type'];
    if (!Object.values(TYPES).includes(type)) throw fileError(415, 'Choisis un fichier PDF ou EPUB.');
    if (Number(req.headers['content-length']) > MAX_READING_FILE_SIZE) throw tooLarge();

    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temp = path.join(this.dir, `.upload-${randomUUID()}`);
    try {
      const file = await fs.open(temp, 'wx+', 0o600);
      let info;
      try {
        let size = 0;
        // An oversized chunked upload must still receive the 413 response.
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > MAX_READING_FILE_SIZE) throw tooLarge();
          await file.writeFile(chunk);
        }
        if (!req.complete) throw fileError(400, 'Envoi interrompu.');
        info = await inspect(file);
      } finally {
        req.resume();
        await file.close();
      }
      if (TYPES[info.format] !== type) throw fileError(415, 'Le contenu ne correspond pas au format choisi.');
      if (info.format === 'pdf') {
        info.pages = await pdfPages(temp).catch(() => null);
        info.pageMismatch = info.pages !== null && !pagesMatch(info.pages, book.totalPages);
      }
      await commit(() => fs.rename(temp, this.pathFor(book.id)));
      return info;
    } finally {
      await fs.rm(temp, { force: true });
    }
  }

  remove(id) {
    return fs.rm(this.pathFor(id), { force: true });
  }

  async attachDownload(source, book, format, commit) {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const temp = path.join(this.dir, `.download-${randomUUID()}`);
    const file = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await inspect(file);
      if (info.format !== format) throw fileError(415, 'Le fichier reçu est dans un autre format.');
      await pipeline(
        file.createReadStream({ start: 0, end: info.size - 1, autoClose: false }),
        createWriteStream(temp, { flags: 'wx', mode: 0o600 }),
      );
      if (info.format === 'pdf') {
        try {
          info.pages = await pdfPages(temp);
        } catch (error) {
          if (error.code === 'ENOENT') throw fileError(503, 'Le service de vérification des PDF est indisponible.');
          throw fileError(422, 'Impossible de vérifier les pages de ce PDF.');
        }
        if (!pagesMatch(info.pages, book.totalPages)) {
          throw fileError(422, `Ce PDF contient ${info.pages} page${info.pages === 1 ? '' : 's'}, pour ${book.totalPages} sur la fiche. Il n’a pas été ajouté.`);
        }
      }
      await commit(() => fs.rename(temp, this.pathFor(book.id)));
      return info;
    } finally {
      await file.close();
      await fs.rm(temp, { force: true });
    }
  }

  async serve(req, res, file, { format, size }, title, download) {
    const range = rangeOf(req.headers.range, size);
    const headers = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    };
    if (!range) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
      return res.end();
    }

    const { start, end } = range;
    const partial = Boolean(req.headers.range);
    const mode = download || format === 'epub' ? 'attachment' : 'inline';
    const name = title.replace(/[\u0000-\u001f\u007f/\\]/g, ' ').trim().toWellFormed() || 'livre';
    const encoded = encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16)}`);
    res.writeHead(partial ? 206 : 200, {
      ...headers,
      'Content-Type': TYPES[format],
      'Content-Length': end - start + 1,
      'Content-Disposition': `${mode}; filename="livre.${format}"; filename*=UTF-8''${encoded}.${format}`,
      ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') return res.end();
    await pipeline(file.createReadStream({ start, end, autoClose: false }), res);
  }
}
