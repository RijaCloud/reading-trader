// Open Library metadata lookup — an open, public catalogue.
// Docs: https://openlibrary.org/dev/docs/api/search
// Used only to prefill title/author/pages/cover; nothing is downloaded.

const ENDPOINT = 'https://openlibrary.org/search.json';
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'reading-tracker/1.0 (personal library app)' },
    });
  } catch (err) {
    const problem = new Error(
      err.name === 'AbortError'
        ? "Open Library n'a pas répondu à temps. Réessayez ou saisissez le livre à la main."
        : "Open Library est injoignable. Vérifiez votre connexion ou saisissez le livre à la main.",
    );
    problem.status = 503;
    problem.cause = err;
    throw problem;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const problem = new Error(`Open Library a répondu ${response.status}.`);
    problem.status = 502;
    throw problem;
  }

  const data = await response.json();
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
