// Recommendation engine.
//
// Signals, strongest first:
//   1. explicit genres chosen by the user (settings.interests)
//   2. authors of books already finished / well rated
//   3. tags the user put on their books
//
// Candidates come from the public Open Library search API. Each seed is queried
// independently with Open Library's relevance ordering (not `sort=rating`,
// which surfaces loosely-tagged bestsellers), then filtered locally for
// language, audience and author diversity before being merged and interleaved.

const OL_SEARCH = 'https://openlibrary.org/search.json';
const FIELDS =
  'key,title,author_name,first_publish_year,number_of_pages_median,cover_i,subject,ratings_average,edition_count,language';
const TIMEOUT_MS = 9_000;
const QUERY_TTL_MS = 10 * 60 * 1000;
const RESULT_TTL_MS = 5 * 60 * 1000;
const MAX_RESULTS = 24;
const MAX_PER_AUTHOR = 2;
const LANGUAGES = new Set(['eng', 'fre']);
const YOUNG_READER = /juvenile|children|young adult|picture book|board book|beginning reader|easy reader/;

export const INTERESTS = [
  { id: 'science-fiction', label: 'Science-fiction', phrase: 'la science-fiction', query: 'science fiction' },
  { id: 'fantasy', label: 'Fantasy', phrase: 'la fantasy', query: 'fantasy' },
  { id: 'policier', label: 'Policier & thriller', phrase: 'les polars et thrillers', query: 'detective and mystery fiction' },
  { id: 'horreur', label: 'Horreur', phrase: "l'horreur", query: 'horror' },
  { id: 'romance', label: 'Romance', phrase: 'la romance', query: 'romance' },
  { id: 'aventure', label: 'Aventure', phrase: "l'aventure", query: 'adventure' },
  { id: 'classiques', label: 'Classiques', phrase: 'les classiques', query: 'classic literature' },
  { id: 'litterature', label: 'Littérature', phrase: 'la littérature', query: 'literary fiction' },
  { id: 'histoire', label: 'Histoire', phrase: "l'histoire", query: 'history' },
  { id: 'philosophie', label: 'Philosophie', phrase: 'la philosophie', query: 'philosophy' },
  { id: 'sciences', label: 'Sciences', phrase: 'les sciences', query: 'science' },
  { id: 'psychologie', label: 'Psychologie', phrase: 'la psychologie', query: 'psychology' },
  { id: 'societe', label: 'Société & politique', phrase: 'les essais politiques', query: 'politics' },
  { id: 'economie', label: 'Économie', phrase: "l'économie", query: 'economics' },
  { id: 'biographie', label: 'Biographie', phrase: 'les biographies', query: 'biography' },
  { id: 'essais', label: 'Essais', phrase: 'les essais', query: 'essays' },
  { id: 'poesie', label: 'Poésie', phrase: 'la poésie', query: 'poetry' },
  { id: 'voyage', label: 'Voyage', phrase: 'les récits de voyage', query: 'travel' },
  { id: 'nature', label: 'Nature & écologie', phrase: "l'écologie", query: 'ecology' },
  { id: 'art', label: 'Art', phrase: "l'art", query: 'art' },
  { id: 'musique', label: 'Musique', phrase: 'la musique', query: 'music' },
  { id: 'cuisine', label: 'Cuisine', phrase: 'la cuisine', query: 'cooking' },
  { id: 'informatique', label: 'Informatique', phrase: "l'informatique", query: 'computer science' },
  { id: 'maths', label: 'Mathématiques', phrase: 'les mathématiques', query: 'mathematics' },
  { id: 'jeunesse', label: 'Jeunesse', phrase: 'la jeunesse', query: 'juvenile fiction', audience: 'young' },
  { id: 'bds', label: 'BD & comics', phrase: 'la BD et les comics', query: 'comic books, strips' },
];

const INTEREST_BY_ID = new Map(INTERESTS.map((i) => [i.id, i]));

export function validInterestIds(ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    if (INTEREST_BY_ID.has(id) && !out.includes(id)) out.push(id);
  }
  return out.slice(0, 12);
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const norm = (value) =>
  String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Whole-word match tolerating a plural suffix, so "art" is not found in "earth". */
function hasWord(haystack, word) {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}(s|es)?\\b`).test(haystack);
}

const lastWord = (value) => norm(String(value || '').split(',')[0]).split(' ').slice(-1)[0] || '';

function coverUrl(id, size) {
  return id ? `https://covers.openlibrary.org/b/id/${id}-${size}.jpg` : '';
}

/** Bounded-concurrency map; a failing item yields `{ error }` instead of rejecting. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        out[index] = await fn(items[index], index);
      } catch (error) {
        out[index] = { error };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ------------------------------------------------------------------ */
/* Open Library queries (cached, timeboxed, polite)                    */
/* ------------------------------------------------------------------ */

const queryCache = new Map();

async function olSearch(query, { limit }) {
  const url = new URL(OL_SEARCH);
  url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('fields', FIELDS);

  const key = url.toString();
  const cached = queryCache.get(key);
  if (cached && Date.now() - cached.at < QUERY_TTL_MS) return cached.docs;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'reading-tracker/1.0 (personal library app)' },
    });
    if (!response.ok) throw new Error(`Open Library ${response.status}`);
    const data = await response.json();
    const docs = Array.isArray(data?.docs) ? data.docs : [];

    if (queryCache.size > 240) {
      const oldest = [...queryCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) queryCache.delete(oldest[0]);
    }
    queryCache.set(key, { at: Date.now(), docs });
    return docs;
  } finally {
    clearTimeout(timer);
  }
}

function toCandidate(doc) {
  const key = String(doc.key || '').replace(/^\/works\//, '');
  if (!key) return null;
  const title = String(doc.title || '').trim();
  if (!title) return null;
  const subjects = Array.isArray(doc.subject) ? doc.subject.map(String) : [];
  return {
    key,
    title: title.slice(0, 300),
    author: Array.isArray(doc.author_name) ? doc.author_name.slice(0, 2).join(', ') : '',
    year: doc.first_publish_year || null,
    pages: doc.number_of_pages_median || null,
    coverUrl: coverUrl(doc.cover_i, 'M'),
    coverLargeUrl: coverUrl(doc.cover_i, 'L'),
    rating: typeof doc.ratings_average === 'number' ? doc.ratings_average : null,
    editions: doc.edition_count || 0,
    subjects: subjects.slice(0, 8),
    _subjects: subjects.join(' | ').toLowerCase(),
    _languages: Array.isArray(doc.language) ? doc.language : [],
  };
}

/** Drop translations we cannot read, children's books, and vanity records. */
function acceptable(candidate, seed) {
  const langs = candidate._languages;
  if (langs.length && !langs.some((l) => LANGUAGES.has(String(l).toLowerCase()))) return false;

  if (seed.id !== 'jeunesse' && YOUNG_READER.test(candidate._subjects)) return false;

  if (seed.kind === 'interest') {
    // Popularity floor: Open Library's subject tags are user-contributed and
    // include self-published or picture-book records that read as noise.
    if ((candidate.editions || 0) < 5) return false;
    if (candidate.pages && candidate.pages < 60) return false;
  }

  // The relevance ordering is already good; this is a backstop against loose
  // subject tags (e.g. a children's book matching "history and criticism").
  if (seed.kind === 'interest') {
    const tokens = norm(seed.query).split(' ').filter((t) => t.length > 2 && t !== 'and');
    if (tokens.length && !tokens.some((t) => hasWord(candidate._subjects, t))) return false;
  }

  return true;
}

/* ------------------------------------------------------------------ */
/* seeds                                                               */
/* ------------------------------------------------------------------ */

function buildSeeds(state) {
  const books = Array.isArray(state?.books) ? state.books : [];
  const settings = state?.settings || {};
  const seeds = [];

  for (const id of validInterestIds(settings.interests)) {
    const interest = INTEREST_BY_ID.get(id);
    seeds.push({
      kind: 'interest',
      id,
      label: interest.label,
      phrase: interest.phrase,
      query: `subject:"${interest.query}"`,
      limit: 20,
      weight: 3,
    });
  }

  // Authors: affinity grows with completion and rating, so a 5-star finished
  // book matters much more than something merely queued.
  const authors = new Map();
  for (const book of books) {
    const name = String(book.author || '').split(',')[0].trim();
    if (!name || name.length < 3) continue;
    const key = norm(name);
    if (!key) continue;
    const entry = authors.get(key) || { name, affinity: 0 };
    if (book.status === 'finished') entry.affinity += 3;
    else if (book.status === 'reading') entry.affinity += 1.5;
    else if (book.status === 'paused') entry.affinity += 0.5;
    if (book.rating >= 4) entry.affinity += 2;
    if (book.rating === 5) entry.affinity += 1;
    authors.set(key, entry);
  }

  for (const entry of [...authors.values()]
    .filter((a) => a.affinity >= 2)
    .sort((a, b) => b.affinity - a.affinity)
    .slice(0, 3)) {
    seeds.push({
      kind: 'author',
      id: norm(entry.name),
      label: entry.name,
      phrase: entry.name,
      query: `author:"${entry.name}"`,
      limit: 8,
      weight: Math.min(4, 1 + entry.affinity / 2),
    });
  }

  const tags = new Map();
  for (const book of books) {
    for (const tag of Array.isArray(book.tags) ? book.tags : []) {
      const label = String(tag || '').trim();
      if (label.length < 2) continue;
      const key = norm(label);
      if (!key) continue;
      tags.set(key, { label, count: (tags.get(key)?.count || 0) + 1 });
    }
  }
  for (const tag of [...tags.values()].sort((a, b) => b.count - a.count).slice(0, 2)) {
    seeds.push({
      kind: 'tag',
      id: norm(tag.label),
      label: tag.label,
      phrase: tag.label,
      query: tag.label,
      limit: 6,
      weight: 1.5,
    });
  }

  return seeds;
}

/* ------------------------------------------------------------------ */
/* scoring                                                             */
/* ------------------------------------------------------------------ */

function scoreOf(candidate, seed) {
  const rating = candidate.rating ? candidate.rating * 0.9 : 0;
  const reach = Math.log10(1 + (candidate.editions || 0)) * 1.2;
  const usable = candidate.pages ? 0.4 : 0; // a page count is usable in the tracker
  const cover = candidate.coverUrl ? 0.2 : 0;
  return seed.weight * 2 + rating + reach + usable + cover;
}

function reasonFor(seed) {
  if (seed.kind === 'interest') return `Parce que vous aimez ${seed.phrase}`;
  if (seed.kind === 'author') return `Parce que vous avez lu ${seed.label}`;
  return `Vos envies : ${seed.label}`;
}

/* ------------------------------------------------------------------ */
/* library matching                                                    */
/* ------------------------------------------------------------------ */

function libraryIndex(books) {
  const titles = new Set();
  const withAuthor = new Set();
  for (const book of books) {
    const title = norm(book.title);
    if (!title) continue;
    titles.add(title);
    const author = lastWord(book.author);
    if (author) withAuthor.add(`${title}|${author}`);
  }
  return { titles, withAuthor };
}

function alreadyOwned(candidate, index) {
  const title = norm(candidate.title);
  if (!title) return true;
  if (index.titles.has(title)) return true;
  const author = lastWord(candidate.author);
  return Boolean(author && index.withAuthor.has(`${title}|${author}`));
}

/* ------------------------------------------------------------------ */
/* public API                                                          */
/* ------------------------------------------------------------------ */

const resultCache = new Map();

export async function discover(state, { refresh = false } = {}) {
  const startedAt = Date.now();
  const seeds = buildSeeds(state);
  const books = Array.isArray(state?.books) ? state.books : [];
  const dismissed = new Set(Array.isArray(state?.settings?.dismissed) ? state.settings.dismissed : []);

  if (!seeds.length) {
    return {
      recommendations: [],
      seeds: [],
      interests: INTERESTS,
      selected: validInterestIds(state?.settings?.interests),
      empty: true,
      cached: false,
    };
  }

  const cacheKey = JSON.stringify({
    seeds: seeds.map((s) => `${s.kind}:${s.id}`),
    dismissed: [...dismissed].sort(),
    library: books.map((b) => norm(b.title)).sort(),
  });

  const cached = resultCache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.at < RESULT_TTL_MS) {
    return { ...cached.value, cached: true, ms: Date.now() - startedAt };
  }

  const responses = await mapLimit(seeds, 4, (seed) => olSearch(seed.query, { limit: seed.limit }));

  const index = libraryIndex(books);
  const merged = new Map();
  let answered = 0;

  responses.forEach((docs, i) => {
    const seed = seeds[i];
    if (!Array.isArray(docs)) return;
    answered += 1;

    // Cap how many books one author can contribute to a single seed, otherwise
    // a single prolific author fills the whole genre.
    const perAuthor = new Map();

    for (const doc of docs) {
      const candidate = toCandidate(doc);
      if (!candidate) continue;
      if (dismissed.has(candidate.key)) continue;
      if (alreadyOwned(candidate, index)) continue;
      if (!acceptable(candidate, seed)) continue;

      const authorKey = lastWord(candidate.author) || candidate.key;
      const seen = perAuthor.get(authorKey) || 0;
      if (seen >= MAX_PER_AUTHOR) continue;
      perAuthor.set(authorKey, seen + 1);

      const score = scoreOf(candidate, seed);
      const existing = merged.get(candidate.key);
      const reason = reasonFor(seed);
      if (existing) {
        // Multi-signal: the same book surfacing from two seeds outranks a
        // single-seed hit, and keeps both reasons.
        existing.score += score * 0.5;
        existing.signals += 1;
        if (score > existing.bestScore) {
          existing.bestScore = score;
          existing.reason = reason;
        }
        if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      } else {
        merged.set(candidate.key, {
          ...candidate,
          score,
          bestScore: score,
          signals: 1,
          reason,
          reasons: [reason],
          seed: { kind: seed.kind, label: seed.label },
        });
      }
    }
  });

  if (answered === 0) {
    const error = new Error('Open Library ne répond pas pour le moment. Réessayez dans un instant.');
    error.status = 503;
    throw error;
  }

  // One bucket per seed, best first, then round-robin so a single genre cannot
  // monopolise the page.
  const buckets = new Map();
  const seenTitles = new Set();
  for (const item of merged.values()) {
    const titleKey = `${norm(item.title)}|${lastWord(item.author)}`;
    if (seenTitles.has(titleKey)) continue; // same work, different record
    seenTitles.add(titleKey);
    const bucketKey = `${item.seed.kind}:${item.seed.label}`;
    if (!buckets.has(bucketKey)) buckets.set(bucketKey, []);
    buckets.get(bucketKey).push(item);
  }
  for (const bucket of buckets.values()) bucket.sort((a, b) => b.score - a.score);

  const ordered = [];
  const authorCount = new Map();
  const lists = [...buckets.values()];
  for (let round = 0; ordered.length < MAX_RESULTS; round += 1) {
    let pushed = false;
    for (const list of lists) {
      let candidate = null;
      for (const item of list) {
        if (item._used) continue;
        const authorKey = lastWord(item.author) || item.key;
        if ((authorCount.get(authorKey) || 0) >= MAX_PER_AUTHOR) continue;
        candidate = item;
        break;
      }
      if (!candidate) continue;
      candidate._used = true;
      const authorKey = lastWord(candidate.author) || candidate.key;
      authorCount.set(authorKey, (authorCount.get(authorKey) || 0) + 1);
      ordered.push(candidate);
      pushed = true;
      if (ordered.length >= MAX_RESULTS) break;
    }
    if (!pushed) break;
  }

  const value = {
    recommendations: ordered.map((item, i) => {
      const { _subjects, _languages, _used, bestScore, ...clean } = item;
      return {
        ...clean,
        rank: i + 1,
        score: Math.round(item.score * 10) / 10,
        reasons: item.reasons.slice(0, 2),
      };
    }),
    seeds: seeds.map((s) => ({ kind: s.kind, id: s.id, label: s.label })),
    interests: INTERESTS,
    selected: validInterestIds(state?.settings?.interests),
    empty: false,
  };

  if (resultCache.size > 40) resultCache.clear();
  resultCache.set(cacheKey, { at: Date.now(), value });

  return { ...value, cached: false, ms: Date.now() - startedAt };
}

/** Drop every cached recommendation batch (used after a dismissal). */
export function invalidateDiscoverCache() {
  resultCache.clear();
}
