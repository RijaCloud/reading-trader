import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { safeDate, todayISO } from './dates.js';
import { validInterestIds } from './recommend.js';

export const STATUSES = ['want', 'reading', 'finished', 'paused', 'dropped'];

const MAX_TEXT = 500;
const MAX_NOTES = 20_000;
const MAX_PAGES = 100_000;
const MAX_SESSIONS = 5_000;

/* ------------------------------------------------------------------ */
/* small, strict coercion helpers                                      */
/* ------------------------------------------------------------------ */

function text(value, { max = MAX_TEXT, fallback = '' } = {}) {
  if (value === undefined || value === null) return fallback;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s.slice(0, max) || fallback;
}

function longText(value) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, MAX_NOTES);
}

function int(value, { min = 0, max = MAX_PAGES, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function statusOf(value, fallback = 'want') {
  return STATUSES.includes(value) ? value : fallback;
}

function ratingOf(value) {
  const n = int(value, { min: 0, max: 5, fallback: null });
  return n === 0 ? null : n;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/* ------------------------------------------------------------------ */
/* book shape                                                          */
/* ------------------------------------------------------------------ */

/**
 * A book stores an `offset` plus its sessions. Current page is therefore
 * `offset + sum(session.pages)`, which makes "log 30 pages" and "I'm on page
 * 120" the same underlying event and keeps corrections from creating
 * negative sessions.
 */
export function pagesReadOf(book) {
  const sum = book.sessions.reduce((acc, s) => acc + (s.pages || 0), 0);
  const raw = (book.offset || 0) + sum;
  return clamp(Math.round(raw), 0, book.totalPages || Math.max(raw, 0));
}

export function percentOf(book) {
  if (!book.totalPages) return 0;
  return clamp(Math.round((pagesReadOf(book) / book.totalPages) * 100), 0, 100);
}

export function withDerived(book) {
  const pagesRead = pagesReadOf(book);
  const percent = percentOf(book);
  const remaining = book.totalPages ? Math.max(0, book.totalPages - pagesRead) : null;
  const sessions = [...book.sessions].sort((a, b) => (a.date < b.date ? 1 : -1));
  const lastSession = sessions[0] || null;
  return { ...book, sessions, pagesRead, percent, remaining, lastSession };
}

function newBook(input) {
  const now = new Date().toISOString();
  const totalPages = int(input.totalPages, { min: 0, max: MAX_PAGES, fallback: null });
  const initial = int(input.currentPage, { min: 0, max: MAX_PAGES, fallback: 0 }) || 0;
  const status = statusOf(input.status, initial > 0 ? 'reading' : 'want');
  const book = {
    id: `b_${randomUUID().slice(0, 8)}`,
    title: text(input.title),
    author: text(input.author),
    coverUrl: text(input.coverUrl, { max: 2000 }),
    totalPages: totalPages && totalPages > 0 ? totalPages : null,
    offset: initial,
    status,
    startedAt: status === 'reading' ? safeDate(input.startedAt) : null,
    finishedAt: status === 'finished' ? safeDate(input.finishedAt) : null,
    rating: ratingOf(input.rating),
    tags: normalizeTags(input.tags),
    notes: longText(input.notes),
    source: text(input.source, { max: 40, fallback: 'manual' }),
    externalId: text(input.externalId, { max: 200 }),
    autoFinished: false,
    sessions: [],
    createdAt: now,
    updatedAt: now,
  };
  return book;
}

function normalizeTags(value) {
  const list = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];
  const out = [];
  for (const raw of list) {
    const tag = text(raw, { max: 40 });
    if (tag && !out.some((t) => t.toLowerCase() === tag.toLowerCase())) out.push(tag);
    if (out.length >= 12) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

function emptyState() {
  return {
    version: 1,
    settings: {
      name: '',
      yearlyGoal: 12,
      theme: 'dark',
      interests: [],
      dismissed: [],
      createdAt: new Date().toISOString(),
    },
    books: [],
  };
}

function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  const settings = {
    ...base.settings,
    ...(raw.settings && typeof raw.settings === 'object' ? raw.settings : {}),
  };
  settings.name = text(settings.name, { max: 60 });
  settings.yearlyGoal = int(settings.yearlyGoal, { min: 0, max: 1000, fallback: 12 });
  settings.theme = settings.theme === 'light' ? 'light' : 'dark';
  settings.interests = validInterestIds(settings.interests);
  settings.dismissed = Array.isArray(settings.dismissed)
    ? [...new Set(settings.dismissed.filter((v) => typeof v === 'string'))].slice(-500)
    : [];

  const books = [];
  const seen = new Set();
  for (const item of Array.isArray(raw.books) ? raw.books : []) {
    if (!item || typeof item !== 'object' || !text(item.title)) continue;
    let id = text(item.id, { max: 60, fallback: `b_${randomUUID().slice(0, 8)}` });
    if (seen.has(id)) id = `b_${randomUUID().slice(0, 8)}`;
    seen.add(id);

    const sessions = [];
    for (const s of Array.isArray(item.sessions) ? item.sessions.slice(-MAX_SESSIONS) : []) {
      if (!s || typeof s !== 'object') continue;
      const pages = int(s.pages, { min: 0, max: MAX_PAGES, fallback: 0 });
      if (!pages) continue;
      sessions.push({
        id: text(s.id, { max: 60, fallback: `s_${randomUUID().slice(0, 8)}` }),
        date: safeDate(s.date),
        pages,
        minutes: int(s.minutes, { min: 0, max: 1440, fallback: 0 }) || 0,
        note: text(s.note, { max: 500 }),
      });
    }
    sessions.sort((a, b) => (a.date < b.date ? -1 : 1));

    const totalPages = int(item.totalPages, { min: 0, max: MAX_PAGES, fallback: null });
    books.push({
      id,
      title: text(item.title),
      author: text(item.author),
      coverUrl: text(item.coverUrl, { max: 2000 }),
      totalPages: totalPages && totalPages > 0 ? totalPages : null,
      offset: int(item.offset, { min: -MAX_PAGES, max: MAX_PAGES, fallback: 0 }) || 0,
      status: statusOf(item.status),
      startedAt: item.startedAt ? safeDate(item.startedAt) : null,
      finishedAt: item.finishedAt ? safeDate(item.finishedAt) : null,
      rating: ratingOf(item.rating),
      tags: normalizeTags(item.tags),
      notes: longText(item.notes),
      source: text(item.source, { max: 40, fallback: 'manual' }),
      externalId: text(item.externalId, { max: 200 }),
      autoFinished: Boolean(item.autoFinished),
      sessions,
      createdAt: text(item.createdAt, { max: 40, fallback: new Date().toISOString() }),
      updatedAt: text(item.updatedAt, { max: 40, fallback: new Date().toISOString() }),
    });
  }
  return { version: 1, settings, books };
}

/* ------------------------------------------------------------------ */
/* store                                                               */
/* ------------------------------------------------------------------ */

export class Store {
  #file;
  #data = emptyState();
  #writeChain = Promise.resolve();

  constructor(file) {
    this.#file = file;
  }

  get file() {
    return this.#file;
  }

  async init() {
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    try {
      const raw = await fs.readFile(this.#file, 'utf8');
      this.#data = normalizeState(JSON.parse(raw));
    } catch (err) {
      if (err.code === 'ENOENT') {
        await this.#persist();
        return;
      }
      // Corrupt file: keep it for forensics, never silently discard it.
      const backup = `${this.#file}.corrupt-${Date.now()}`;
      await fs.rename(this.#file, backup).catch(() => {});
      console.error(`[store] ${this.#file} illisible (${err.message}); sauvegarde: ${backup}`);
      this.#data = emptyState();
      await this.#persist();
    }
  }

  /** Public snapshot: settings + derived books. */
  state() {
    return {
      settings: { ...this.#data.settings },
      books: this.#data.books
        .map(withDerived)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    };
  }

  stats() {
    return buildStats(this.#data);
  }

  bookIdentity(id) {
    const { title, author, totalPages, externalId } = this.#find(id);
    return { id, title, author, totalPages, externalId };
  }

  async #persist() {
    const tmp = `${this.#file}.${process.pid}.tmp`;
    const payload = JSON.stringify(this.#data, null, 2);
    await fs.writeFile(tmp, payload, 'utf8');
    await fs.rename(tmp, this.#file);
  }

  #save() {
    this.#writeChain = this.#writeChain.then(
      () => this.#persist(),
      () => this.#persist(),
    );
    return this.#writeChain;
  }

  #find(id) {
    const book = this.#data.books.find((b) => b.id === id);
    if (!book) {
      const err = new Error('Livre introuvable.');
      err.status = 404;
      throw err;
    }
    return book;
  }

  async createBook(input) {
    if (!text(input?.title)) {
      const err = new Error('Le titre est obligatoire.');
      err.status = 400;
      throw err;
    }
    const book = newBook(input || {});
    if (input?.currentPage && input.currentPage > 0) {
      // Honour "I'm already on page X" as a real reading event so it lands in
      // stats instead of vanishing into a silent offset.
      book.sessions.push({
        id: `s_${randomUUID().slice(0, 8)}`,
        date: safeDate(input.startedAt),
        pages: book.offset,
        minutes: 0,
        note: '',
      });
      book.offset = 0;
      book.startedAt = book.startedAt || safeDate(input.startedAt);
      book.status = book.status === 'want' ? 'reading' : book.status;
    }
    this.#data.books.unshift(book);
    this.#settle(book);
    await this.#save();
    return withDerived(book);
  }

  async updateBook(id, patch = {}) {
    const book = this.#find(id);
    if (patch.title !== undefined) {
      const title = text(patch.title);
      if (!title) {
        const err = new Error('Le titre ne peut pas être vide.');
        err.status = 400;
        throw err;
      }
      book.title = title;
    }
    if (patch.author !== undefined) book.author = text(patch.author);
    if (patch.coverUrl !== undefined) book.coverUrl = text(patch.coverUrl, { max: 2000 });
    if (patch.totalPages !== undefined) {
      const pages = int(patch.totalPages, { min: 0, max: MAX_PAGES, fallback: null });
      book.totalPages = pages && pages > 0 ? pages : null;
    }
    if (patch.notes !== undefined) book.notes = longText(patch.notes);
    if (patch.tags !== undefined) book.tags = normalizeTags(patch.tags);
    if (patch.rating !== undefined) book.rating = ratingOf(patch.rating);
    if (patch.status !== undefined) {
      const status = statusOf(patch.status, book.status);
      if (status === 'finished' && book.status !== 'finished') {
        book.finishedAt = safeDate(patch.finishedAt || book.finishedAt || todayISO());
      }
      if (status !== 'finished') book.finishedAt = null;
      if (status === 'reading' && !book.startedAt) book.startedAt = todayISO();
      // An explicit choice from the user is never second-guessed by the
      // page-count heuristics.
      book.autoFinished = false;
      book.status = status;
    }
    if (patch.startedAt !== undefined) {
      book.startedAt = patch.startedAt ? safeDate(patch.startedAt) : null;
    }
    book.updatedAt = new Date().toISOString();
    this.#settle(book);
    await this.#save();
    return withDerived(book);
  }

  async deleteBook(id) {
    const book = this.#find(id);
    this.#data.books = this.#data.books.filter((b) => b.id !== book.id);
    await this.#save();
    return { deleted: book.id };
  }

  /** Log N pages read (positive delta). */
  async addSession(id, input = {}) {
    const book = this.#find(id);
    // Validate before clamping: `int()` would turn 0 into its min of 1.
    const rawPages = Number(input.pages);
    const pages = Number.isFinite(rawPages) ? Math.min(MAX_PAGES, Math.round(rawPages)) : 0;
    if (!pages || pages < 1) {
      const err = new Error('Indiquez un nombre de pages supérieur à zéro.');
      err.status = 400;
      throw err;
    }
    const session = {
      id: `s_${randomUUID().slice(0, 8)}`,
      date: safeDate(input.date),
      pages,
      minutes: int(input.minutes, { min: 0, max: 1440, fallback: 0 }) || 0,
      note: text(input.note, { max: 500 }),
    };
    book.sessions.push(session);
    if (book.sessions.length > MAX_SESSIONS) {
      book.sessions = book.sessions.slice(-MAX_SESSIONS);
    }
    book.updatedAt = new Date().toISOString();
    this.#settle(book, session.date);
    await this.#save();
    return { session, book: withDerived(book) };
  }

  /** "I'm on page X" — becomes a session when moving forward, a correction otherwise. */
  async setProgress(id, input = {}) {
    const book = this.#find(id);
    const target = int(input.page, { min: 0, max: MAX_PAGES, fallback: null });
    if (target === null) {
      const err = new Error('Indiquez une page valide.');
      err.status = 400;
      throw err;
    }
    const current = pagesReadOf(book);
    const bounded = book.totalPages ? clamp(target, 0, book.totalPages) : Math.max(0, target);
    const date = safeDate(input.date);
    let delta = 0;
    if (bounded > current) {
      delta = bounded - current;
      book.sessions.push({
        id: `s_${randomUUID().slice(0, 8)}`,
        date,
        pages: delta,
        minutes: int(input.minutes, { min: 0, max: 1440, fallback: 0 }) || 0,
        note: text(input.note, { max: 500 }),
      });
      if (book.sessions.length > MAX_SESSIONS) book.sessions = book.sessions.slice(-MAX_SESSIONS);
    } else if (bounded < current) {
      const sum = book.sessions.reduce((acc, s) => acc + (s.pages || 0), 0);
      book.offset = bounded - sum;
      // Re-reading a book this class had auto-finished: reopen it. A book the
      // user finished by hand stays finished.
      if (book.status === 'finished' && book.autoFinished) {
        book.status = 'reading';
        book.finishedAt = null;
        book.autoFinished = false;
      }
    }
    book.updatedAt = new Date().toISOString();
    this.#settle(book, date);
    await this.#save();
    return { delta, book: withDerived(book) };
  }

  async deleteSession(id, sessionId) {
    const book = this.#find(id);
    const before = book.sessions.length;
    book.sessions = book.sessions.filter((s) => s.id !== sessionId);
    if (book.sessions.length === before) {
      const err = new Error('Session introuvable.');
      err.status = 404;
      throw err;
    }
    book.updatedAt = new Date().toISOString();
    await this.#save();
    return withDerived(book);
  }

  async updateSettings(patch = {}) {
    const s = this.#data.settings;
    if (patch.name !== undefined) s.name = text(patch.name, { max: 60 });
    if (patch.yearlyGoal !== undefined) {
      s.yearlyGoal = int(patch.yearlyGoal, { min: 0, max: 1000, fallback: s.yearlyGoal });
    }
    if (patch.theme !== undefined) s.theme = patch.theme === 'light' ? 'light' : 'dark';
    if (patch.interests !== undefined) s.interests = validInterestIds(patch.interests);
    if (patch.dismissed !== undefined) {
      s.dismissed = Array.isArray(patch.dismissed)
        ? [...new Set(patch.dismissed.filter((v) => typeof v === 'string'))].slice(-500)
        : [];
    }
    await this.#save();
    return { ...s };
  }

  exportData() {
    return {
      app: 'reading-tracker',
      exportedAt: new Date().toISOString(),
      ...this.#data,
    };
  }

  async importData(payload) {
    const incoming = normalizeState(payload);
    if (!Array.isArray(payload?.books)) {
      const err = new Error('Fichier invalide : "books" manquant.');
      err.status = 400;
      throw err;
    }
    const merge = payload?.merge === true;
    if (merge) {
      const existing = new Set(
        this.#data.books.map((b) => `${b.title.toLowerCase()}|${b.author.toLowerCase()}`),
      );
      for (const book of incoming.books) {
        const key = `${book.title.toLowerCase()}|${book.author.toLowerCase()}`;
        if (!existing.has(key)) {
          this.#data.books.push(book);
          existing.add(key);
        }
      }
      // merge: keep current settings, only fill blanks
      if (!this.#data.settings.name && incoming.settings.name) {
        this.#data.settings.name = incoming.settings.name;
      }
    } else {
      this.#data = incoming;
    }
    await this.#save();
    return { imported: incoming.books.length, merged: merge };
  }

  /**
   * Keep status/finish-date coherent with the page count. Runs after every
   * mutation so "finished" is never left stale or set prematurely.
   *
   * Only auto-finishing lives here. A manual "Terminé" (a paper copy, an
   * unrecorded page count) must never be reverted just because fewer pages are
   * logged than the book has; that reversal is handled in setProgress and only
   * for books this class finished itself (`autoFinished`).
   */
  #settle(book, date) {
    const read = pagesReadOf(book);
    if (read > 0 && book.status === 'want') {
      book.status = 'reading';
      book.startedAt = book.startedAt || date || todayISO();
    }
    if (book.totalPages && read >= book.totalPages && book.status !== 'finished') {
      book.status = 'finished';
      book.finishedAt = date || book.finishedAt || todayISO();
      book.autoFinished = true;
    }
  }
}

/* ------------------------------------------------------------------ */
/* statistics                                                          */
/* ------------------------------------------------------------------ */

export function buildStats(data) {
  const today = todayISO();
  const byDate = new Map();
  const perBook = new Map();

  for (const book of data.books) {
    let bookPages = 0;
    for (const s of book.sessions) {
      byDate.set(s.date, (byDate.get(s.date) || 0) + s.pages);
      bookPages += s.pages;
      const entry = perBook.get(book.id) || { pages: 0, minutes: 0 };
      entry.pages += s.pages;
      entry.minutes += s.minutes || 0;
      perBook.set(book.id, entry);
    }
    if (bookPages === 0 && book.offset) {
      byDate.set(today, byDate.get(today) || 0);
    }
  }

  const dayList = (days) => {
    const out = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const d = new Date(`${today}T12:00:00`);
      d.setDate(d.getDate() - i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(2, '0')}`;
      out.push({ date: iso, pages: byDate.get(iso) || 0 });
    }
    return out;
  };

  const days7 = dayList(7);
  const days30 = dayList(30);

  // Streak: count back from today; an untouched today does not break a streak
  // built yesterday, which is how reading apps usually behave.
  let streak = 0;
  {
    const start = byDate.get(today) ? 0 : 1;
    for (let i = start; i < 400; i += 1) {
      const d = new Date(`${today}T12:00:00`);
      d.setDate(d.getDate() - i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
        d.getDate(),
      ).padStart(2, '0')}`;
      if (byDate.get(iso)) streak += 1;
      else break;
    }
  }

  const year = today.slice(0, 4);
  const finishedThisYear = data.books.filter(
    (b) => b.status === 'finished' && (b.finishedAt || '').startsWith(year),
  ).length;

  const totalPages = [...byDate.values()].reduce((a, b) => a + b, 0);
  let totalMinutes = 0;
  let totalSessions = 0;
  for (const book of data.books) {
    for (const s of book.sessions) {
      totalMinutes += s.minutes || 0;
      totalSessions += 1;
    }
  }

  const activeDays = days30.filter((d) => d.pages > 0).length;
  const pagesLast30 = days30.reduce((a, d) => a + d.pages, 0);

  const byStatus = { want: 0, reading: 0, finished: 0, paused: 0, dropped: 0 };
  for (const b of data.books) byStatus[b.status] = (byStatus[b.status] || 0) + 1;

  // Estimated finish date per in-progress book, from the last 14 days of pace.
  const pacePerDay = (() => {
    const last14 = dayList(14);
    const total = last14.reduce((a, d) => a + d.pages, 0);
    const active = last14.filter((d) => d.pages > 0).length;
    if (!total) return 0;
    return total / Math.max(active, 1);
  })();

  const readingBooks = data.books
    .filter((b) => b.status === 'reading')
    .map((b) => {
      const read = pagesReadOf(b);
      const remaining = b.totalPages ? Math.max(0, b.totalPages - read) : null;
      const etaDays =
        remaining !== null && pacePerDay > 0 ? Math.ceil(remaining / pacePerDay) : null;
      return {
        id: b.id,
        title: b.title,
        author: b.author,
        percent: percentOf(b),
        pagesRead: read,
        totalPages: b.totalPages,
        remaining,
        etaDays,
      };
    })
    .sort((a, b) => b.percent - a.percent);

  let minutesToday = 0;
  for (const book of data.books) {
    for (const s of book.sessions) if (s.date === today) minutesToday += s.minutes || 0;
  }

  return {
    today: {
      pages: byDate.get(today) || 0,
      minutes: minutesToday,
    },
    streak,
    activeDays30: activeDays,
    pagesLast30,
    pagesToday: byDate.get(today) || 0,
    days7,
    days30,
    totals: {
      pages: totalPages,
      minutes: totalMinutes,
      sessions: totalSessions,
      books: data.books.length,
      finished: byStatus.finished,
      finishedThisYear,
      byStatus,
    },
    goal: {
      target: data.settings.yearlyGoal,
      done: finishedThisYear,
      percent: data.settings.yearlyGoal
        ? Math.min(100, Math.round((finishedThisYear / data.settings.yearlyGoal) * 100))
        : 0,
    },
    pacePerDay: Math.round(pacePerDay * 10) / 10,
    readingBooks,
  };
}
