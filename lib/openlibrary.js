// Open Library metadata lookup — an open, public catalogue.
// Docs: https://openlibrary.org/dev/docs/api/search
// Used for bibliographic metadata and links to editions.

import { rankEditions } from './edition-match.js';

const ENDPOINT = 'https://openlibrary.org/search.json';
const ORIGIN = 'https://openlibrary.org';
const TIMEOUT_MS = 8_000;

function coverUrl(coverId, size = 'M') {
  if (!coverId) return '';
  return `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`;
}

/** Strip the site's work key into something stable (`/works/OL1W` -> `OL1W`). */
function workId(key) {
  if (typeof key !== 'string') return '';
  return key.replace(/^\/works\//, '').trim().slice(0, 40);
}

async function fetchCatalogue(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'User-Agent': 'reading-tracker/1.0 (personal library app)' },
  }).catch((error) => {
    const message = ['TimeoutError', 'AbortError'].includes(error.name)
      ? "Open Library n'a pas répondu à temps."
      : 'Open Library est injoignable.';
    throw Object.assign(new Error(message, { cause: error }), { status: 503 });
  });
  if (!response.ok) throw Object.assign(new Error(`Open Library a répondu ${response.status}.`), { status: 502 });
  return response.json();
}

export async function searchOpenLibrary(query, limit = 10) {
  const q = String(query || '').trim();
  if (q.length < 2) {
    const err = new Error('Recherche trop courte (2 caractères minimum).');
    err.status = 400;
    throw err;
  }

  const url = new URL(ENDPOINT);
  url.searchParams.set('q', q);
  url.searchParams.set('limit', String(Math.min(Math.max(limit, 1), 20)));
  url.searchParams.set(
    'fields',
    'key,title,author_name,first_publish_year,number_of_pages_median,cover_i,edition_count',
  );

  const data = await fetchCatalogue(url);
  const docs = Array.isArray(data?.docs) ? data.docs : [];

  return docs.slice(0, 20).map((doc) => ({
    title: String(doc.title || '').slice(0, 300),
    author: Array.isArray(doc.author_name) ? doc.author_name.slice(0, 3).join(', ') : '',
    year: doc.first_publish_year || null,
    pages: doc.number_of_pages_median || null,
    coverUrl: coverUrl(doc.cover_i, 'M'),
    coverLargeUrl: coverUrl(doc.cover_i, 'L'),
    externalId: workId(doc.key),
  })).filter((row) => row.title);
}

export async function listOpenLibraryEditions(book) {
  const query = [book.title, book.author].filter(Boolean).join(' ');
  const fallback = new URL('/search', ORIGIN);
  fallback.searchParams.set('q', query);
  let url = fallback.href;
  try {
    let olid = workId(book.externalId);
    if (!/^OL\d+W$/.test(olid)) {
      const { rows } = rankEditions(book, await searchOpenLibrary(query, 5));
      olid = rows.find((row) => row.compatible && /^OL\d+W$/.test(row.externalId))?.externalId;
    }
    if (!/^OL\d+W$/.test(olid)) return { url, editions: [] };

    url = `${ORIGIN}/works/${olid}`;
    const data = await fetchCatalogue(`${url}/editions.json?limit=12`);
    const entries = Array.isArray(data?.entries) ? data.entries : [];
    const editions = entries.filter((edition) => /^\/books\/OL\d+M$/.test(edition.key) && edition.title)
      .map((edition) => ({
        url: ORIGIN + edition.key,
        title: String(edition.title).slice(0, 300),
        publisher: edition.publishers?.[0],
        date: edition.publish_date,
        pages: Number.isInteger(edition.number_of_pages) && edition.number_of_pages > 0 ? edition.number_of_pages : null,
      }));
    return { url, editions };
  } catch {
    return { url, editions: [], unavailable: true };
  }
}
