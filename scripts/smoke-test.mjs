#!/usr/bin/env node
/**
 * End-to-end API smoke test.
 *
 *   node scripts/smoke-test.mjs [baseUrl]
 *
 * Runs against a throwaway DATA_DIR, so it never touches real reading data:
 *   PORT=8788 DATA_DIR=/tmp/rt-smoke node server.js
 */

const BASE = process.argv[2] || 'http://127.0.0.1:8788';

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `attendu ${JSON.stringify(expected)}, reçu ${JSON.stringify(actual)}`);
}

async function call(path, { method = 'GET', body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, body: json, headers: res.headers };
}

/* ------------------------------------------------------------------ */

console.log(`\nSmoke test → ${BASE}\n`);

// 1. health + static
{
  const health = await call('/api/health');
  check('GET /api/health → 200', health.status === 200);
  check('health.ok', health.body?.ok === true);

  for (const asset of ['/', '/styles.css', '/app.js', '/manifest.webmanifest', '/icons/icon.svg']) {
    const r = await fetch(`${BASE}${asset}`);
    check(`GET ${asset} → 200`, r.status === 200, `reçu ${r.status}`);
  }
}

// 2. path traversal must be refused
{
  const r = await fetch(`${BASE}/../server.js`, { redirect: 'manual' });
  check('path traversal refused', r.status === 403 || r.status === 404, `reçu ${r.status}`);
}

// 3. empty state
{
  const { body } = await call('/api/state');
  eq('state.books vide', body.books, []);
  check('state.stats présent', typeof body.stats?.streak === 'number');
}

// 4. validation
{
  const r = await call('/api/books', { method: 'POST', body: { author: 'X' } });
  check('POST /api/books sans titre → 400', r.status === 400, `reçu ${r.status}`);
}

// 5. create
let id;
{
  const r = await call('/api/books', {
    method: 'POST',
    body: { title: 'La Horde du Contrevent', author: 'Alain Damasio', totalPages: 704, status: 'reading' },
  });
  id = r.body?.book?.id;
  check('POST /api/books → 201', r.status === 201, `reçu ${r.status}`);
  check('livre créé avec id', typeof id === 'string' && id.startsWith('b_'));
  eq('pages lues à 0', r.body.book.pagesRead, 0);
  eq('statut reading', r.body.book.status, 'reading');
  check('stats incluses dans la réponse', r.body.stats?.totals?.books === 1);
}

// 6. session
{
  const r = await call(`/api/books/${id}/sessions`, {
    method: 'POST',
    body: { pages: 48, minutes: 55, note: 'Chapitre 1' },
  });
  eq('session: pages lues', r.body.book.pagesRead, 48);
  eq('session: pourcentage', r.body.book.percent, 7);
  eq('session: pages aujourd’hui', r.body.stats.pagesToday, 48);
  eq('session: série', r.body.stats.streak, 1);
}

// 7. session validation
{
  const r = await call(`/api/books/${id}/sessions`, { method: 'POST', body: { pages: 0 } });
  check('session 0 pages → 400', r.status === 400, `reçu ${r.status}`);
}

// 8. progress forward
{
  const r = await call(`/api/books/${id}/progress`, { method: 'POST', body: { page: 130 } });
  eq('progress: delta', r.body.delta, 82);
  eq('progress: page', r.body.book.pagesRead, 130);
}

// 9. progress backwards → correction, not a negative session
{
  const r = await call(`/api/books/${id}/progress`, { method: 'POST', body: { page: 100 } });
  eq('correction: delta 0', r.body.delta, 0);
  eq('correction: page', r.body.book.pagesRead, 100);
  check(
    'aucune session négative',
    r.body.book.sessions.every((s) => s.pages > 0),
  );
}

// 10. auto-finish at last page
{
  const r = await call(`/api/books/${id}/progress`, { method: 'POST', body: { page: 704 } });
  eq('fin auto: statut', r.body.book.status, 'finished');
  eq('fin auto: 100%', r.body.book.percent, 100);
  check('fin auto: date de fin', /^\d{4}-\d{2}-\d{2}$/.test(r.body.book.finishedAt || ''));
  eq('objectif annuel compté', r.body.stats.goal.done, 1);
}

// 11. going back reopens the book
{
  const r = await call(`/api/books/${id}/progress`, { method: 'POST', body: { page: 300 } });
  eq('retour arrière: de nouveau en cours', r.body.book.status, 'reading');
  eq('retour arrière: fin effacée', r.body.book.finishedAt, null);
}

// 12. delete a session
{
  const state = await call('/api/state');
  const target = state.body.books[0].sessions[0];
  const r = await call(`/api/books/${id}/sessions/${target.id}`, { method: 'DELETE' });
  check('session supprimée', r.status === 200);
  check(
    'session absente',
    !r.body.book.sessions.some((s) => s.id === target.id),
  );
  const missing = await call(`/api/books/${id}/sessions/nope`, { method: 'DELETE' });
  check('session inconnue → 404', missing.status === 404, `reçu ${missing.status}`);
}

// 13. metadata update
{
  const r = await call(`/api/books/${id}`, {
    method: 'PATCH',
    body: { totalPages: 700, rating: 5, tags: 'SF, roman', notes: 'Une pépite.' },
  });
  eq('totalPages mis à jour', r.body.book.totalPages, 700);
  eq('note 5/5', r.body.book.rating, 5);
  eq('tags normalisés', r.body.book.tags, ['SF', 'roman']);
  eq('notes enregistrées', r.body.book.notes, 'Une pépite.');
}

// 14. status transitions
{
  const paused = await call(`/api/books/${id}`, { method: 'PATCH', body: { status: 'paused' } });
  eq('statut paused', paused.body.book.status, 'paused');
  const bad = await call(`/api/books/${id}`, { method: 'PATCH', body: { status: 'nonsense' } });
  eq('statut invalide ignoré', bad.body.book.status, 'paused');
}

// 14b. a manual "Terminé" must survive partial page tracking
{
  const created = await call('/api/books', {
    method: 'POST',
    body: { title: 'Lu en papier', author: 'Anonyme', totalPages: 300 },
  });
  const paperId = created.body.book.id;
  await call(`/api/books/${paperId}/sessions`, { method: 'POST', body: { pages: 50 } });
  const finished = await call(`/api/books/${paperId}`, {
    method: 'PATCH',
    body: { status: 'finished', finishedAt: '2026-03-14' },
  });
  eq('marquage manuel terminé', finished.body.book.status, 'finished');
  eq('date de fin manuelle conservée', finished.body.book.finishedAt, '2026-03-14');

  const after = await call('/api/state');
  const reread = after.body.books.find((b) => b.id === paperId);
  eq('« terminé » manuel non écrasé', reread.status, 'finished');

  // Another mutation must not quietly reopen it either.
  await call(`/api/books/${paperId}`, { method: 'PATCH', body: { notes: 'Relu plus tard.' } });
  const after2 = await call('/api/state');
  eq(
    '« terminé » manuel stable après édition',
    after2.body.books.find((b) => b.id === paperId).status,
    'finished',
  );
  await call(`/api/books/${paperId}`, { method: 'DELETE' });
}

// 15. settings
{
  const r = await call('/api/settings', { method: 'PATCH', body: { name: 'Rija', yearlyGoal: 20 } });
  eq('réglages: nom', r.body.settings.name, 'Rija');
  eq('réglages: objectif', r.body.settings.yearlyGoal, 20);
  eq('objectif propagé aux stats', r.body.stats.goal.target, 20);
}

// 16. persistence + export/import
{
  const exported = await call('/api/export');
  check('export: 200', exported.status === 200);
  check('export: contient les livres', Array.isArray(exported.body?.books) && exported.body.books.length === 1);
  check(
    'export: nom de fichier',
    /attachment; filename="lectures-\d{4}-\d{2}-\d{2}\.json"/.test(exported.headers.get('content-disposition') || ''),
  );

  const wiped = await call('/api/import', { method: 'POST', body: { books: [] } });
  eq('import vide', wiped.body.books.length, 0);

  const restored = await call('/api/import', { method: 'POST', body: exported.body });
  eq('import restaure les livres', restored.body.books.length, 1);
  eq('import restaure le titre', restored.body.books[0].title, 'La Horde du Contrevent');

  const invalid = await call('/api/import', { method: 'POST', body: { nope: true } });
  check('import invalide → 400', invalid.status === 400, `reçu ${invalid.status}`);
}

// 17. ordering + derived fields
{
  await call('/api/books', { method: 'POST', body: { title: 'Zzz', author: 'Test', totalPages: 100 } });
  const { body } = await call('/api/state');
  check('les livres sont triés par mise à jour', body.books[0].title === 'Zzz');
  check(
    'champs dérivés présents',
    ['pagesRead', 'percent', 'remaining'].every((k) => k in body.books[0]),
  );
  eq('livre neuf à 0%', body.books[0].percent, 0);
  eq('livre neuf « want »', body.books[0].status, 'want');
}

// 18. delete book
{
  const { body } = await call('/api/state');
  const target = body.books[0];
  const r = await call(`/api/books/${target.id}`, { method: 'DELETE' });
  check('livre supprimé', r.status === 200);
  check('livre absent', !r.body.books.some((b) => b.id === target.id));
  const missing = await call(`/api/books/${target.id}`, { method: 'DELETE' });
  check('livre inconnu → 404', missing.status === 404, `reçu ${missing.status}`);
}

// 19. unknown routes
{
  const r = await call('/api/unknown');
  check('route API inconnue → 404', r.status === 404, `reçu ${r.status}`);
  const m = await call('/api/books', { method: 'PUT', body: {} });
  check('méthode non gérée → 404', m.status === 404, `reçu ${m.status}`);
}

// 20. malformed JSON
{
  const res = await fetch(`${BASE}/api/books`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{broken',
  });
  check('JSON invalide → 400', res.status === 400, `reçu ${res.status}`);
}

// 21. Open Library search (network-dependent, non-blocking)
{
  const r = await call('/api/search?q=dune&limit=3');
  if (r.status === 200 && Array.isArray(r.body?.results) && r.body.results.length > 0) {
    const first = r.body.results[0];
    check('search: résultats non vides', true);
    check('search: forme des résultats', Boolean(first.title), JSON.stringify(first));
    check(
      'search: champs attendus',
      ['title', 'author', 'coverUrl', 'pages', 'externalId'].every((k) => k in first),
    );
  } else {
    console.log(`  ⚠ Open Library indisponible (${r.status}) — test réseau ignoré`);
  }
  const short = await call('/api/search?q=a');
  check('search: requête trop courte → 400', short.status === 400, `reçu ${short.status}`);
}

/* ------------------------------------------------------------------ */

// 22. recommandations (réseau ; dégradation propre si Open Library est muet)
{
  const bare = await call('/api/discover');
  check('discover: 200', bare.status === 200);
  check('discover: catalogue de genres', Array.isArray(bare.body?.interests) && bare.body.interests.length > 15);
  check('discover: genres validés par le serveur', Array.isArray(bare.body?.selected));

  const invalid = await call('/api/settings', {
    method: 'PATCH',
    body: { interests: ['science-fiction', 'nope', 42, 'science-fiction', 'histoire'] },
  });
  eq('settings: genres invalides filtrés', invalid.body.settings.interests, ['science-fiction', 'histoire']);

  const rec = await call('/api/discover?refresh=1');
  if (rec.status === 200 && Array.isArray(rec.body?.recommendations)) {
    const list = rec.body.recommendations;
    check('discover: suggestions non vides', list.length > 0, `${list.length} suggestions`);
    check(
      'discover: forme des suggestions',
      list.every((r) => r.key && r.title && (r.reason || r.reasons?.length)),
    );
    check('discover: clés uniques', new Set(list.map((r) => r.key)).size === list.length);
    check('discover: rangs séquentiels', list.every((r, i) => r.rank === i + 1));
    check(
      'discover: signaux exposés',
      Array.isArray(rec.body.seeds) &&
        rec.body.seeds.filter((s) => s.kind === 'interest').length === 2 &&
        rec.body.seeds.every((s) => ['interest', 'author', 'tag'].includes(s.kind)),
      JSON.stringify(rec.body.seeds),
    );

    const titles = new Set(list.map((r) => r.title.toLowerCase()));
    const library = await call('/api/state');
    const owned = library.body.books.map((b) => b.title.toLowerCase());
    check(
      'discover: exclut les livres déjà possédés',
      owned.every((t) => !titles.has(t)),
      `collision: ${owned.filter((t) => titles.has(t)).join(', ')}`,
    );

    const authorCounts = new Map();
    for (const r of list) {
      const a = (r.author || '').toLowerCase();
      if (a) authorCounts.set(a, (authorCounts.get(a) || 0) + 1);
    }
    check(
      'discover: pas plus de 2 livres par auteur',
      [...authorCounts.values()].every((n) => n <= 2),
      JSON.stringify([...authorCounts.entries()].filter(([, n]) => n > 2)),
    );

    const victim = list[0].key;
    const dismissed = await call('/api/discover/dismiss', { method: 'POST', body: { key: victim } });
    check('discover: rejet enregistré', dismissed.status === 200);
    check(
      'discover: clé ajoutée aux rejets',
      (dismissed.body.settings.dismissed || []).includes(victim),
    );
    const after = await call('/api/discover?refresh=1');
    check(
      'discover: livre rejeté absent ensuite',
      !after.body.recommendations.some((r) => r.key === victim),
    );

    const bad = await call('/api/discover/dismiss', { method: 'POST', body: {} });
    check('discover: rejet sans clé → 400', bad.status === 400, `reçu ${bad.status}`);
  } else {
    console.log(`  ⚠ recommandations indisponibles (${rec.status}) — test réseau ignoré`);
  }

  // nettoyage : on ne laisse ni genres ni rejets derrière soi
  await call('/api/settings', { method: 'PATCH', body: { interests: [], dismissed: [] } });
}

/* ------------------------------------------------------------------ */

console.log(`\n${passed} réussis, ${failed} échoués\n`);
if (failed) {
  console.log('Échecs :');
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
