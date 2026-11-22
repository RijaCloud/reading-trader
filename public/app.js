import { FILE_LIMIT_MIB } from './file-limits.js';

/* ------------------------------------------------------------------ */
/* tiny helpers                                                        */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);

const nf = new Intl.NumberFormat('fr-FR');
const fmtNum = (n) => nf.format(Math.round(Number(n) || 0));

function icon(name, size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

const STATUS = {
  want: 'À lire',
  reading: 'En cours',
  finished: 'Terminé',
  paused: 'En pause',
  dropped: 'Abandonné',
};

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function parseISO(iso) {
  return new Date(`${iso}T12:00:00`);
}

function fmtDate(iso) {
  if (!iso) return '';
  return parseISO(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function relDate(iso) {
  if (!iso) return '';
  const days = Math.round((parseISO(localToday()) - parseISO(iso)) / 86_400_000);
  if (days <= 0) return "aujourd'hui";
  if (days === 1) return 'hier';
  if (days < 7) return `il y a ${days} j`;
  return fmtDate(iso);
}

function fmtMinutes(total) {
  const m = Math.round(Number(total) || 0);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} h ${String(rest).padStart(2, '0')}` : `${h} h`;
}

function debounce(fn, wait = 550) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

const state = {
  settings: { name: '', yearlyGoal: 12, theme: 'dark', interests: [] },
  books: [],
  bookSourceAvailable: false,
  stats: null,
  view: 'reading',
  filter: 'all',
  query: '',
  sheet: null, // { kind: 'book'|'add'|'rec', id?: string, key?: string }
  discover: { data: null, loading: false, error: null },
  loading: true,
  error: null,
};

let searchResults = [];

/* ------------------------------------------------------------------ */
/* api                                                                 */
/* ------------------------------------------------------------------ */

async function api(path, { method = 'GET', body, file, contentType, signal } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: file ? { 'Content-Type': contentType } :
        body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: file ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
  } catch {
    throw new Error('Serveur injoignable. Vérifiez que celui-ci tourne toujours.');
  }
  const raw = await res.text();
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = {};
    }
  }
  if (!res.ok) throw Object.assign(new Error(data.error || `Erreur ${res.status}.`), { status: res.status });
  return data;
}

function mergeSnapshot(payload) {
  if (payload.settings) state.settings = payload.settings;
  if (Array.isArray(payload.books)) state.books = payload.books;
  if (payload.stats) state.stats = payload.stats;
  if (typeof payload.bookSourceAvailable === 'boolean') state.bookSourceAvailable = payload.bookSourceAvailable;
}

/* ------------------------------------------------------------------ */
/* theme + toast                                                       */
/* ------------------------------------------------------------------ */

function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'light' ? '#f7f4ee' : '#0b1016');
}

let toastTimer;
function showToast(message, tone = 'ok') {
  const el = $('#toast');
  el.textContent = message;
  el.dataset.tone = tone;
  el.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.dataset.show = 'false';
  }, tone === 'error' ? 4200 : 2200);
}

/* ------------------------------------------------------------------ */
/* derived book helpers                                                */
/* ------------------------------------------------------------------ */

const byId = (id) => state.books.find((b) => b.id === id) || null;

function initials(title) {
  return String(title || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

function hueOf(text) {
  let hash = 0;
  for (const ch of String(text || '')) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
  return hash;
}

function coverHtml(book, size = 'md') {
  const hue = hueOf(book.title);
  const style = `background:linear-gradient(160deg,hsl(${hue} 34% 30%),hsl(${(hue + 26) % 360} 40% 17%));color:#fff`;
  return `<div class="cover cover-${size}" style="${style}"><span>${esc(initials(book.title))}</span>${coverImg(book.coverUrl, 'M')}</div>`;
}

/**
 * Open Library serves a blank/404 image for ids it has no cover for, so the
 * initials stay underneath and the <img> removes itself on error.
 */
function coverImg(url) {
  if (!url) return '';
  return `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />`;
}

function statusPill(book) {
  return `<span class="pill" data-status="${book.status}">${STATUS[book.status] || book.status}</span>`;
}

function isActive(book) {
  return book.status === 'reading';
}

/* ------------------------------------------------------------------ */
/* rendering: shared pieces                                            */
/* ------------------------------------------------------------------ */

function renderBookCard(book) {
  const pages = book.totalPages
    ? `${fmtNum(book.pagesRead)} / ${fmtNum(book.totalPages)} p.`
    : `${fmtNum(book.pagesRead)} p.`;
  return `
    <article class="book-card ${book.status === 'finished' ? 'finished' : ''}" data-action="open-book" data-id="${book.id}" role="button" tabindex="0" aria-label="${esc(book.title)}${book.author ? `, ${esc(book.author)}` : ''}, ${book.percent}%">
      ${coverHtml(book, 'md')}
      <div class="body">
        <h3>${esc(book.title)}</h3>
        ${book.author ? `<div class="tiny muted truncate">${esc(book.author)}</div>` : ''}
        <div class="bar ${book.status === 'finished' ? 'ok' : ''}"><i style="width:${book.percent}%"></i></div>
        <div class="row-between">
          <div class="meta">
            ${statusPill(book)}
            <span class="truncate">${book.totalPages ? pages : `${fmtNum(book.pagesRead)} p. lues`}</span>
          </div>
          <span class="pct">${book.percent}%</span>
        </div>
      </div>
    </article>`;
}

function renderEmpty({ title, text, cta = true }) {
  return `
    <div class="card empty">
      <div class="icon">${icon('book', 28)}</div>
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      ${cta ? `<button class="btn btn-primary" data-action="add">${icon('plus', 18)} Ajouter un livre</button>` : ''}
    </div>`;
}

/* ------------------------------------------------------------------ */
/* view: en cours                                                      */
/* ------------------------------------------------------------------ */

function viewReading() {
  const stats = state.stats;
  const books = [...state.books];
  const reading = books
    .filter((b) => b.status === 'reading')
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  if (!books.length) {
    return `
      ${renderEmpty({
        title: 'Votre bibliothèque est vide',
        text: 'Ajoutez un livre, indiquez le nombre de pages, puis enregistrez votre progression au fil des pages.',
      })}
      ${renderTodayStrip(stats)}`;
  }

  if (!reading.length) {
    const suggestions = books.filter((b) => b.status === 'want').slice(0, 4);
    return `
      ${renderEmpty({
        title: 'Aucune lecture en cours',
        text:
          suggestions.length > 0
            ? 'Ouvrez un livre de votre pile « à lire » pour commencer à suivre votre progression.'
            : 'Tous vos livres sont terminés. Il est temps d’en ajouter un !',
        cta: false,
      })}
      ${suggestions.length ? `<div class="section-title"><h2>À commencer</h2></div>${suggestions.map(renderBookCard).join('')}` : ''}
      ${renderTodayStrip(stats)}
      <button class="btn btn-block btn-primary" data-action="add">${icon('plus', 18)} Ajouter un livre</button>`;
  }

  const hero = reading[0];
  const others = reading.slice(1);
  const eta = stats?.readingBooks?.find((r) => r.id === hero.id)?.etaDays ?? null;

  const sessions = collectSessions().slice(0, 6);

  return `
    <section class="hero">
      <div class="hero-top">
        ${coverHtml(hero, 'lg')}
        <div class="grow">
          <div class="row" style="gap:6px;margin-bottom:6px;flex-wrap:wrap">
            ${statusPill(hero)}
            ${eta && eta > 0 ? `<span class="pill">${icon('clock', 12)} ~${eta} j</span>` : ''}
          </div>
          <h2>${esc(hero.title)}</h2>
          ${hero.author ? `<p class="author">${esc(hero.author)}</p>` : ''}
        </div>
      </div>
      <div class="hero-progress">
        <div class="labels">
          <b>${hero.percent}%</b>
          <span class="muted">${fmtNum(hero.pagesRead)} / ${hero.totalPages ? fmtNum(hero.totalPages) : '?'} pages</span>
        </div>
        <div class="bar"><i style="width:${hero.percent}%"></i></div>
      </div>
      <div class="hero-actions">
        <button class="btn btn-primary" data-action="open-book" data-id="${hero.id}">Continuer</button>
        <button class="btn" data-action="quick-plus" data-id="${hero.id}" data-pages="10">+10 p.</button>
      </div>
    </section>

    ${renderTodayStrip(stats)}

    ${
      others.length
        ? `<div class="section-title"><h2>Autres lectures</h2><span class="hint">${others.length}</span></div>
           ${others.map(renderBookCard).join('')}`
        : ''
    }

    ${
      sessions.length
        ? `<div class="section-title"><h2>Dernières sessions</h2></div>
           <ul class="card feed">
             ${sessions
               .map(
                 (s) => `<li>
                   <span class="dot"></span>
                   <div class="grow">
                     <div class="truncate">${fmtNum(s.pages)} page${s.pages > 1 ? 's' : ''}${s.minutes ? ` · ${fmtMinutes(s.minutes)}` : ''}</div>
                     <div class="tiny faint truncate">${esc(s.bookTitle)}</div>
                   </div>
                   <span class="when">${relDate(s.date)}</span>
                 </li>`,
               )
               .join('')}
           </ul>`
        : ''
    }`;
}

function renderTodayStrip(stats) {
  if (!stats) return '';
  return `
    <div class="strip">
      <div class="cell"><b>${fmtNum(stats.pagesToday)}</b><span>aujourd’hui</span></div>
      <div class="cell"><b>${stats.streak}</b><span>jours de suite</span></div>
      <div class="cell"><b>${fmtNum(stats.pacePerDay)}</b><span>pages / jour</span></div>
    </div>`;
}

function collectSessions() {
  const all = [];
  for (const book of state.books) {
    for (const s of book.sessions || []) {
      all.push({ ...s, bookId: book.id, bookTitle: book.title });
    }
  }
  return all.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/* ------------------------------------------------------------------ */
/* view: bibliothèque                                                  */
/* ------------------------------------------------------------------ */

function viewLibrary() {
  const filters = [
    ['all', 'Tous'],
    ['reading', 'En cours'],
    ['want', 'À lire'],
    ['finished', 'Terminés'],
    ['paused', 'En pause'],
    ['dropped', 'Abandonnés'],
  ];

  const q = state.query.trim().toLowerCase();
  const list = state.books
    .filter((b) => (state.filter === 'all' ? true : b.status === state.filter))
    .filter((b) =>
      q ? `${b.title} ${b.author} ${(b.tags || []).join(' ')}`.toLowerCase().includes(q) : true,
    )
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));

  return `
    <div class="field">
      <div style="position:relative">
        <input type="search" id="librarySearch" placeholder="Rechercher un titre, un auteur…" value="${esc(state.query)}" aria-label="Rechercher dans la bibliothèque" style="padding-left:42px" />
        <span style="position:absolute;left:14px;top:50%;transform:translateY(-50%);color:var(--faint);pointer-events:none">${icon('search', 17)}</span>
      </div>
    </div>

    <div class="chips" role="group" aria-label="Filtrer par statut">
      ${filters
        .map(
          ([value, label]) =>
            `<button class="chip" data-action="filter" data-filter="${value}" aria-pressed="${state.filter === value}">${label}${
              value === 'all' ? '' : ` <span style="opacity:.6">${countByStatus(value)}</span>`
            }</button>`,
        )
        .join('')}
    </div>

    ${
      list.length
        ? `<div class="section-title"><h2>${list.length} livre${list.length > 1 ? 's' : ''}</h2></div>
           ${list.map(renderBookCard).join('')}`
        : renderEmpty({
            title: q || state.filter !== 'all' ? 'Aucun résultat' : 'Aucun livre',
            text:
              q || state.filter !== 'all'
                ? 'Essayez un autre filtre ou une autre recherche.'
                : 'Ajoutez votre premier livre pour commencer à suivre vos lectures.',
            cta: !q && state.filter === 'all',
          })
    }`;
}

function countByStatus(status) {
  return state.books.filter((b) => b.status === status).length;
}

/* ------------------------------------------------------------------ */
/* view: stats                                                         */
/* ------------------------------------------------------------------ */

function viewStats() {
  const stats = state.stats;
  if (!stats) return renderEmpty({ title: 'Pas encore de données', text: 'Ajoutez un livre et une première session.', cta: true });

  const goal = stats.goal;
  const circumference = 2 * Math.PI * 38;
  const offset = circumference * (1 - Math.min(1, goal.percent / 100));

  const max30 = Math.max(1, ...stats.days30.map((d) => d.pages));
  const max7 = Math.max(1, ...stats.days7.map((d) => d.pages));
  const today = localToday();

  return `
    <div class="card goal-card">
      <div class="ring">
        <svg viewBox="0 0 88 88" aria-hidden="true">
          <circle class="track" cx="44" cy="44" r="38" fill="none" stroke-width="7" />
          <circle class="fill" cx="44" cy="44" r="38" fill="none" stroke-width="7"
            stroke-dasharray="${circumference.toFixed(2)}"
            stroke-dashoffset="${offset.toFixed(2)}" />
        </svg>
        <div class="center"><b>${goal.done}</b><span>sur ${goal.target}</span></div>
      </div>
      <div class="grow">
        <div class="section-title" style="margin-top:0"><h2>Objectif ${new Date().getFullYear()}</h2></div>
        <p style="font-size:14px;margin-top:4px">
          <b style="font-size:17px">${goal.done}</b> livre${goal.done > 1 ? 's' : ''} terminé${goal.done > 1 ? 's' : ''}
          sur ${goal.target} <span class="muted">(${goal.percent}%)</span>
        </p>
        <p class="tiny faint" style="margin-top:2px">${
          goal.target && goal.done >= goal.target
            ? 'Objectif atteint. Bravo !'
            : goal.target
              ? `Encore ${Math.max(0, goal.target - goal.done)} à lire cette année.`
              : 'Définissez un objectif dans les réglages.'
        }</p>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat">
        <div class="label">${icon('book', 13)} Aujourd’hui</div>
        <div class="value">${fmtNum(stats.pagesToday)}<small>p.</small></div>
        <div class="tiny faint">${stats.today.minutes ? fmtMinutes(stats.today.minutes) : 'aucune session'}</div>
      </div>
      <div class="stat">
        <div class="label">${icon('flame', 13)} Série</div>
        <div class="value">${stats.streak}<small>j</small></div>
        <div class="tiny faint">${stats.activeDays30} jours actifs / 30</div>
      </div>
      <div class="stat">
        <div class="label">${icon('clock', 13)} Temps de lecture</div>
        <div class="value" style="font-size:22px">${fmtMinutes(stats.totals.minutes)}</div>
        <div class="tiny faint">${fmtNum(stats.totals.sessions)} sessions</div>
      </div>
      <div class="stat">
        <div class="label">${icon('target', 13)} Volume</div>
        <div class="value">${fmtNum(stats.totals.pages)}<small>p.</small></div>
        <div class="tiny faint">${stats.totals.finished} livres terminés</div>
      </div>
    </div>

    <div class="section-title"><h2>7 derniers jours</h2><span class="hint">${fmtNum(stats.days7.reduce((a, d) => a + d.pages, 0))} p.</span></div>
    <div class="card week-bars">
      ${stats.days7
        .map((d) => {
          const h = Math.max(4, Math.round((d.pages / max7) * 100));
          const label = parseISO(d.date).toLocaleDateString('fr-FR', { weekday: 'narrow' });
          return `<div class="col ${d.date === today ? 'today' : ''}">
            <span class="num">${d.pages || ''}</span>
            <div class="fill" style="height:${h}%"></div>
            <span class="day">${label}</span>
          </div>`;
        })
        .join('')}
    </div>

    <div class="section-title"><h2>30 derniers jours</h2></div>
    <div class="card heatmap">
      ${stats.days30
        .map((d) => {
          const level = d.pages === 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((d.pages / max30) * 4)));
          return `<div class="heat ${d.date === today ? 'today' : ''}" data-level="${level}" title="${fmtDate(d.date)} : ${d.pages} page${d.pages > 1 ? 's' : ''}"></div>`;
        })
        .join('')}
    </div>

    ${
      stats.readingBooks.length
        ? `<div class="section-title"><h2>Progression en cours</h2></div>
           <ul class="card feed">
             ${stats.readingBooks
               .slice(0, 6)
               .map(
                 (r) => `<li>
                   <div class="grow">
                     <div class="truncate" style="font-weight:600">${esc(r.title)}</div>
                     <div class="bar" style="margin-top:6px"><i style="width:${r.percent}%"></i></div>
                     <div class="tiny faint" style="margin-top:4px">${r.pagesRead}${r.totalPages ? ` / ${r.totalPages}` : ''} p.${r.etaDays ? ` · fin estimée dans ~${r.etaDays} j` : ''}</div>
                   </div>
                   <span class="pct" style="font-weight:700;color:var(--accent);font-size:13px">${r.percent}%</span>
                 </li>`,
               )
               .join('')}
           </ul>`
        : ''
    }`;
}

/* ------------------------------------------------------------------ */
/* view: découvrir (recommandations)                                   */
/* ------------------------------------------------------------------ */

async function loadDiscover({ refresh = false, silent = false } = {}) {
  state.discover.loading = true;
  state.discover.error = null;
  if (!silent && state.view === 'discover') render();
  try {
    const data = await api(`/api/discover${refresh ? '?refresh=1' : ''}`);
    state.discover.data = data;
  } catch (err) {
    state.discover.error = err.message;
  } finally {
    state.discover.loading = false;
    if (state.view === 'discover') render();
  }
}

function viewDiscover() {
  const d = state.discover;

  if (d.loading && !d.data) {
    return `
      <div class="section-title"><h2>Vos genres</h2></div>
      <div class="skeleton" style="height:44px"></div>
      <div class="section-title"><h2>Pour vous</h2></div>
      <div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
  }

  if (d.error && !d.data) {
    return `
      <div class="card empty">
        <div class="icon">${icon('compass', 28)}</div>
        <h3>Suggestions indisponibles</h3>
        <p>${esc(d.error)}</p>
        <button class="btn btn-primary" data-action="refresh-recs">${icon('refresh', 18)} Réessayer</button>
      </div>`;
  }

  const data = d.data;
  if (!data) return '';

  const selected = new Set(state.settings.interests || []);
  const recs = data.recommendations || [];
  // The full genre grid is 26 chips tall: keep it collapsed once the user has
  // chosen something, so recommendations stay above the fold.
  const pickerOpen = state.discover.pickerOpen || selected.size === 0;
  const chosen = (data.interests || []).filter((i) => selected.has(i.id));

  const picker = pickerOpen
    ? `<div class="interest-grid">
         ${(data.interests || [])
           .map(
             (i) =>
               `<button class="chip" data-action="toggle-interest" data-id="${i.id}" aria-pressed="${selected.has(i.id)}">${esc(i.label)}</button>`,
           )
           .join('')}
       </div>
       <button class="link-btn" data-action="toggle-picker" style="align-self:flex-start">Masquer la liste</button>`
    : `<div class="row-between" style="gap:10px">
         <div class="chips grow">
           ${
             chosen.length
               ? chosen
                   .map((i) => `<span class="pill" data-status="reading">${esc(i.label)}</span>`)
                   .join('')
               : `<span class="tiny faint">Aucun genre choisi</span>`
           }
         </div>
         <button class="link-btn" data-action="toggle-picker">Modifier</button>
       </div>`;

  return `
    <div class="section-title">
      <h2>Vos genres</h2>
      <span class="hint">${
        selected.size
          ? `${selected.size} genre${selected.size > 1 ? 's' : ''} suivi${selected.size > 1 ? 's' : ''}`
          : 'touchez pour choisir'
      }</span>
    </div>
    ${picker}

    <div class="section-title" style="margin-top:8px">
      <h2>Pour vous</h2>
      ${
        recs.length
          ? `<button class="link-btn" data-action="refresh-recs" ${d.loading ? 'disabled' : ''}>${icon('refresh', 14)} Rafraîchir</button>`
          : ''
      }
    </div>

    ${
      d.loading
        ? `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`
        : recs.length
          ? recs.map(renderRecCard).join('')
          : `<div class="card empty">
               <div class="icon">${icon('sparkles', 28)}</div>
               <h3>${selected.size || state.books.length ? 'Rien pour le moment' : 'Choisissez vos genres'}</h3>
               <p>${
                 selected.size || state.books.length
                   ? 'Aucune suggestion ne correspond encore. Essayez d’ajouter un genre ou de rafraîchir.'
                   : 'Sélectionnez quelques genres ci-dessus, ou ajoutez des livres : les auteurs et vos tags serviront aussi de pistes.'
               }</p>
               ${
                 selected.size || state.books.length
                   ? `<button class="btn" data-action="refresh-recs">${icon('refresh', 18)} Rafraîchir</button>`
                   : ''
               }
             </div>`
    }

    ${
      data.seeds?.length
        ? `<p class="tiny faint" style="text-align:center;padding:4px 0">
             Suggestions issues de ${data.seeds.map((s) => esc(s.label)).join(', ')} · catalogue Open Library
           </p>`
        : ''
    }`;
}

function renderRecCard(rec) {
  const meta = [rec.author, rec.year, rec.pages ? `${fmtNum(rec.pages)} p.` : null]
    .filter(Boolean)
    .map((v) => esc(String(v)))
    .join(' · ');
  return `
    <article class="rec-card" data-action="open-rec" data-key="${esc(rec.key)}" role="button" tabindex="0"
      aria-label="${esc(rec.title)}, ${esc(rec.author || 'auteur inconnu')}">
      <div class="cover cover-md" style="background:linear-gradient(160deg,hsl(${hueOf(rec.title)} 34% 30%),hsl(${(hueOf(rec.title) + 26) % 360} 40% 17%));color:#fff">
        <span>${esc(initials(rec.title))}</span>${coverImg(rec.coverUrl)}
      </div>
      <div class="grow">
        <h3>${esc(rec.title)}</h3>
        <div class="tiny muted truncate">${meta || 'Métadonnées incomplètes'}</div>
        <div class="rec-reason">${icon('sparkles', 12)} ${esc(rec.reasons?.[0] || rec.reason || '')}</div>
      </div>
      <button class="rec-add" data-action="add-rec" data-key="${esc(rec.key)}" aria-label="Ajouter ${esc(rec.title)} à ma bibliothèque">
        ${icon('plus', 18)}
      </button>
    </article>`;
}

function renderRecSheet() {
  const key = state.sheet?.key;
  const rec = (state.discover.data?.recommendations || []).find((r) => r.key === key);
  if (!rec) {
    closeSheet();
    return;
  }

  const meta = [rec.year, rec.pages ? `${fmtNum(rec.pages)} pages` : null]
    .filter(Boolean)
    .map((v) => esc(String(v)))
    .join(' · ');

  const body = `
    <div class="row" style="gap:14px;align-items:flex-start">
      <div class="cover cover-lg" style="background:linear-gradient(160deg,hsl(${hueOf(rec.title)} 34% 30%),hsl(${(hueOf(rec.title) + 26) % 360} 40% 17%));color:#fff">
        <span>${esc(initials(rec.title))}</span>${coverImg(rec.coverLargeUrl || rec.coverUrl)}
      </div>
      <div class="grow">
        <h3 style="font-size:17px;font-weight:700;line-height:1.3">${esc(rec.title)}</h3>
        ${rec.author ? `<p class="small muted" style="margin-top:3px">${esc(rec.author)}</p>` : ''}
        <div class="row" style="gap:6px;margin-top:9px;flex-wrap:wrap">
          ${meta ? `<span class="pill">${meta}</span>` : ''}
          ${rec.rating ? `<span class="pill">${icon('star', 12)} ${rec.rating.toFixed(1)}/5</span>` : ''}
        </div>
      </div>
    </div>

    <div class="card" style="padding:14px">
      <div class="tiny faint" style="text-transform:uppercase;letter-spacing:.06em;font-weight:650">Pourquoi cette suggestion</div>
      <p style="margin-top:6px;font-size:14px">${(rec.reasons || [rec.reason]).map((r) => esc(r)).join(' · ')}</p>
    </div>

    ${
      rec.subjects?.length
        ? `<div class="chips" style="flex-wrap:wrap;overflow:visible">
             ${rec.subjects.slice(0, 4).map((s) => `<span class="pill">${esc(s)}</span>`).join('')}
           </div>`
        : ''
    }

    <button class="btn btn-primary btn-block" data-action="add-rec" data-key="${esc(rec.key)}" style="min-height:50px">
      ${icon('plus', 20)} Ajouter à ma bibliothèque
    </button>
    <button class="btn btn-ghost btn-block" data-action="dismiss-rec" data-key="${esc(rec.key)}">
      ${icon('x', 18)} Ne plus me proposer ce livre
    </button>
    <p class="tiny faint" style="text-align:center">Les pages seront à confirmer après l’ajout si Open Library ne les connaît pas.</p>`;

  $('#sheetRoot').innerHTML = sheetShell({ title: 'Suggestion', body, label: rec.title });
}

function dropRecommendation(key) {
  const data = state.discover.data;
  if (!data) return;
  data.recommendations = (data.recommendations || []).filter((r) => r.key !== key);
}

/* ------------------------------------------------------------------ */
/* view: réglages                                                      */
/* ------------------------------------------------------------------ */

function viewSettings() {
  const t = state.stats?.totals;
  return `
    <div class="card settings-card">
      <div class="field">
        <label for="setName">Votre nom</label>
        <input type="text" id="setName" placeholder="Optionnel" value="${esc(state.settings.name)}" maxlength="60" />
      </div>
      <div class="field">
        <label for="setGoal">Objectif de livres par an</label>
        <input type="number" id="setGoal" min="0" max="1000" inputmode="numeric" value="${state.settings.yearlyGoal}" />
      </div>
      <div class="switch">
        <div>
          <div class="label">Apparence claire</div>
          <div class="tiny faint">Suivant votre préférence d’écran</div>
        </div>
        <button class="toggle" data-action="toggle-theme" aria-pressed="${state.settings.theme === 'light'}" aria-label="Basculer le thème clair"></button>
      </div>
      <div class="switch">
        <div>
          <div class="label">Genres suivis</div>
          <div class="tiny faint">${
            (state.settings.interests || []).length
              ? `${state.settings.interests.length} genre${state.settings.interests.length > 1 ? 's' : ''} sélectionné${state.settings.interests.length > 1 ? 's' : ''}`
              : 'Aucun — les suggestions seront plus larges'
          }</div>
        </div>
        <button class="btn btn-sm" data-action="nav" data-view="discover">Choisir</button>
      </div>
      <button class="btn btn-primary btn-block" data-action="save-settings">${icon('check', 18)} Enregistrer</button>
    </div>

    <div class="section-title"><h2>Données</h2></div>
    <div class="card settings-card">
      <div class="row-between">
        <div>
          <div class="label" style="font-size:14.5px;font-weight:600">Sauvegarde</div>
          <div class="tiny faint">${t ? `${t.books} livres · ${fmtNum(t.sessions)} sessions · ${fmtNum(t.pages)} pages` : ''}</div>
        </div>
      </div>
      <a class="btn btn-block" href="/api/export" download>${icon('download', 18)} Exporter en JSON</a>
      <label class="btn btn-block" for="importFile">${icon('upload', 18)} Restaurer une sauvegarde</label>
      <input type="file" id="importFile" class="sr-only" accept="application/json,.json" />
      <p class="tiny faint">L’import remplace toutes les données actuelles. Une copie de sécurité est créée à chaque écriture.</p>
    </div>

    <div class="card settings-card">
      <div class="row-between">
        <div>
          <div class="label" style="font-size:14.5px;font-weight:600">Installer sur l’écran d’accueil</div>
          <div class="tiny faint">iPhone : Partager → « Sur l’écran d’accueil ». Android : menu → « Installer l’application ».</div>
        </div>
      </div>
    </div>

    <p class="tiny faint" style="text-align:center;padding:6px 0 2px">
      Suivi de lectures · données stockées localement sur cet appareil
    </p>`;
}

/* ------------------------------------------------------------------ */
/* sheets                                                             */
/* ------------------------------------------------------------------ */

function openSheet(kind, value) {
  state.sheet = kind === 'rec' ? { kind, key: value } : { kind, id: value };
  document.body.style.overflow = 'hidden';
  if (kind === 'book') {
    renderBookSheet();
    if (state.sheet) loadReadingFile(state.sheet);
  } else if (kind === 'rec') renderRecSheet();
  else renderAddSheet();
  if (!history.state?.sheet) history.pushState({ sheet: true }, '');
}

function closeSheet({ fromPop = false } = {}) {
  if (!state.sheet) return;
  state.sheet = null;
  $('#sheetRoot').innerHTML = '';
  document.body.style.overflow = '';
  if (!fromPop && history.state?.sheet) {
    history.back();
  }
}

function sheetShell({ title, body, label }) {
  return `
    <div class="sheet">
      <div class="sheet-backdrop" data-action="close-sheet"></div>
      <div class="sheet-panel" role="dialog" aria-modal="true" aria-label="${esc(label || title)}">
        <div class="sheet-grab"><span></span></div>
        <div class="sheet-head">
          <h2 class="truncate">${esc(title)}</h2>
          <button class="icon-btn" data-action="close-sheet" aria-label="Fermer">${icon('x', 19)}</button>
        </div>
        <div class="sheet-body">${body}</div>
      </div>
    </div>`;
}

/* ------------------------------- book sheet ----------------------- */

function readingFileUrl(id) {
  return `/api/books/${encodeURIComponent(id)}/file`;
}

const sourceNames = { libgen: 'Library Genesis', zlibrary: 'Z-Library', annas: 'Anna’s Archive' };

function sourceStatus(line) {
  if (line.reason === 'credentials_missing') return 'Compte requis';
  if (line.reason === 'route_off') return 'Source inactive';
  if (line.state === 'rows') return 'Résultats reçus';
  if (line.state === 'empty') return 'Aucun résultat';
  if (line.state === 'failed') return 'Erreur de la source';
  if (line.state === 'late') return 'Délai dépassé';
  if (line.reason === 'not_requested' || line.reason === 'not_in_default_order') return 'Non consultée';
  return 'Indisponible';
}

function catalogueEditions(catalogue) {
  if (!catalogue) return '';
  return `
    <p class="small muted">Éditions dans le catalogue Open Library</p>
    ${catalogue.editions.length ? `<ul class="source-editions" aria-label="Éditions Open Library">
      ${catalogue.editions.map((edition) => {
        const metadata = [edition.publisher, edition.date, edition.pages ? `${fmtNum(edition.pages)} p.` : '']
          .filter(Boolean).map(esc).join(' · ');
        return `<li>
          <div class="grow">
            <strong>${esc(edition.title)}</strong>
            ${metadata ? `<p class="tiny muted">${metadata}</p>` : ''}
          </div>
          <a class="btn btn-ghost" href="${esc(edition.url)}" target="_blank" rel="noopener">Consulter</a>
        </li>`;
      }).join('')}
    </ul>` : ''}
    <a class="btn btn-ghost" href="${esc(catalogue.url)}" target="_blank" rel="noopener">
      ${catalogue.editions.length ? 'Toutes les éditions sur Open Library' : 'Rechercher sur Open Library'}
    </a>`;
}

function sourceEditions(sheet) {
  const search = sheet.fileSearch;
  if (!search) return '';
  if (search.loading) return '<p class="small muted" role="status">Recherche des éditions…</p>';
  if (search.error) return `<p class="small muted" role="status">${esc(search.error)}</p>`;
  const ignored = search.ignored
    ? `<p class="small muted">${fmtNum(search.ignored)} résultat${search.ignored === 1 ? '' : 's'} écarté${search.ignored === 1 ? '' : 's'} (extrait ou fichier incompatible).</p>`
    : '';

  const sources = search.sources?.map((line) =>
    `${esc(sourceNames[line.source] || line.source)} · ${esc(sourceStatus(line))}`);
  return `
    ${sources?.length ? `<p class="small muted">${sources.join('<br>')}</p>` : ''}
    ${search.fileSourceError && !sources?.length ? `<p class="small muted">${esc(search.fileSourceError)}</p>` : ''}
    ${search.rows.length ? `<ul class="source-editions" aria-label="Éditions disponibles">
      ${search.rows.map((row) => {
        const metadata = [row.author, row.format.toUpperCase(), row.language, row.year,
          row.pages ? `${fmtNum(row.pages)} p. annoncées` : row.format === 'pdf' ? 'Pagination inconnue' : null,
          row.sizeMb ? `${row.sizeMb} Mo` : null, sourceNames[row.source] || row.source]
          .filter(Boolean).map(esc).join(' · ');
        return `<li>
          <div class="grow">
            <strong>${esc(row.title || 'Édition sans titre')}</strong>
            <p class="tiny muted">${metadata}</p>
          </div>
          ${row.downloadable === false ? '<span class="tiny muted">Téléchargement indisponible</span>' :
            `<button class="btn btn-primary" type="button" data-action="acquire-reading-file"
              data-ref="${esc(row.ref)}" ${sheet.fileBusy ? 'disabled' : ''}>Récupérer</button>`}
        </li>`;
      }).join('')}
    </ul>` : '<p class="small muted">Aucun fichier récupérable dans les résultats.</p>'}
    ${ignored}
    ${catalogueEditions(search.catalogue)}`;
}

function readingFileContent(sheet) {
  const { file, fileError, fileBusy, id } = sheet;
  const expected = byId(id)?.totalPages;
  if (fileError) {
    return `<p class="small muted">${esc(fileError)}</p>
      <button class="btn btn-ghost" type="button" data-action="reload-reading-file">Réessayer</button>`;
  }
  if (file === undefined) return '<p class="small muted" role="status">Chargement…</p>';

  const url = esc(readingFileUrl(id));
  const detail = file
    ? `${file.format.toUpperCase()} · ${new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 }).format(
        file.size >= 1024 * 1024 ? file.size / (1024 * 1024) : Math.max(0.1, file.size / 1024),
      )} ${file.size >= 1024 * 1024 ? 'Mo' : 'Ko'}${file.pages ? ` · ${fmtNum(file.pages)} p. dans le PDF` : ''}`
    : `PDF jusqu’à ${FILE_LIMIT_MIB.pdf} Mo · EPUB jusqu’à ${FILE_LIMIT_MIB.epub} Mo.`;
  return `
    <p class="small muted" role="status">${fileBusy || detail}</p>
    ${file?.pageMismatch && expected ? `<p class="small muted">La fiche indique ${fmtNum(expected)} pages. Ce PDF est peut-être un extrait ou une autre édition.</p>` : ''}
    <div class="reading-file-actions">
      ${file?.format === 'pdf'
        ? `<a class="btn btn-primary" href="/reader.html?book=${esc(encodeURIComponent(id))}">${icon('book')} Lire le PDF</a>`
        : ''}
      ${file
        ? `<a class="btn ${file.format === 'pdf' ? 'btn-ghost' : 'btn-primary'}" href="${url}?download=1" download>${icon('download')} Télécharger</a>`
        : ''}
      ${state.bookSourceAvailable && expected ? `<button class="btn ${!file || file.pageMismatch ? 'btn-primary' : 'btn-ghost'}" type="button"
        data-action="find-reading-pdf" ${fileBusy || sheet.fileSearch?.loading ? 'disabled' : ''}>
        ${icon('search')} Trouver le PDF
      </button>` : ''}
      <button class="btn ${file || (state.bookSourceAvailable && expected) ? 'btn-ghost' : 'btn-primary'}" type="button"
        data-action="search-reading-file" ${fileBusy || sheet.fileSearch?.loading ? 'disabled' : ''}>
        ${icon('search')} Chercher une édition
      </button>
      <button class="btn ${file || state.bookSourceAvailable ? 'btn-ghost' : 'btn-primary'}" type="button" data-action="pick-reading-file" ${fileBusy ? 'disabled' : ''}>
        ${icon('upload')} ${file ? 'Remplacer' : 'Ajouter un fichier'}
      </button>
      ${file ? `<button class="btn btn-ghost" type="button" data-action="remove-reading-file" ${fileBusy ? 'disabled' : ''}>Retirer</button>` : ''}
    </div>
    ${sheet.fileMessage ? `<p class="small muted" role="status">${esc(sheet.fileMessage)}</p>` : ''}
    ${sourceEditions(sheet)}
    <input type="file" accept=".pdf,.epub,application/pdf,application/epub+zip" data-reading-file-input hidden>`;
}

function refreshReadingFile(sheet) {
  if (state.sheet !== sheet) return;
  const section = $('[data-reading-file]');
  if (section) section.innerHTML = readingFileContent(sheet);
}

const readingJobLabels = {
  search: 'Recherche des éditions…',
  acquire: 'Téléchargement depuis la source…',
  'find-pdf': 'Recherche et vérification de la pagination…',
};

function applyReadingJob(sheet, job, updateFile = true) {
  if (job.status === 'failed') {
    sheet.fileMessage = job.error;
    if (job.operation === 'acquire' && [413, 415, 422].includes(job.errorStatus) && sheet.fileSearch?.rows) {
      sheet.fileSearch.rows = sheet.fileSearch.rows.filter((row) => row.ref !== job.ref);
      sheet.fileSearch.ignored = (sheet.fileSearch.ignored || 0) + 1;
    }
    return;
  }
  const result = job.result;
  if (job.operation === 'search') {
    sheet.fileSearch = result;
  } else if (result.search) {
    sheet.fileSearch = result.search;
    sheet.fileMessage = result.message;
  } else if (updateFile && result.file) {
    sheet.file = result.file;
    sheet.fileSearch = undefined;
    showToast(job.operation === 'find-pdf' ? 'PDF vérifié et ajouté' : 'Fichier récupéré');
  }
}

async function followReadingJob(sheet, job) {
  if (job.status === 'running') {
    sheet.fileBusy = job.message || readingJobLabels[job.operation];
    refreshReadingFile(sheet);
  }
  let failures = 0;
  while (job?.status === 'running' && state.sheet === sheet) {
    await new Promise((resolve) => setTimeout(resolve, failures ? 4000 : 2000));
    if (state.sheet !== sheet) return;
    try {
      const payload = await api(`${readingFileUrl(sheet.id)}/job?id=${encodeURIComponent(job.id)}`, {
        signal: AbortSignal.timeout(10_000),
      });
      job = payload.job;
      if (job?.status === 'running' && job.message && job.message !== sheet.fileBusy) {
        sheet.fileBusy = job.message;
        refreshReadingFile(sheet);
      }
      failures = 0;
    } catch (error) {
      if (++failures < 5 && (!error.status || error.status >= 500)) continue;
      sheet.fileMessage = 'Le suivi a été interrompu. Rouvre la fiche pour reprendre le suivi.';
      job = null;
    }
  }
  if (state.sheet !== sheet) return;
  if (job) applyReadingJob(sheet, job);
  else sheet.fileMessage ||= 'Cette opération n’est plus disponible. Rouvre la fiche pour voir le fichier actuel.';
  sheet.fileBusy = false;
  refreshReadingFile(sheet);
}

async function startReadingJob(sheet, operation, body = {}) {
  sheet.fileBusy = readingJobLabels[operation];
  sheet.fileMessage = null;
  if (operation === 'search') sheet.fileSearch = undefined;
  refreshReadingFile(sheet);
  try {
    const { job } = await api(`${readingFileUrl(sheet.id)}/${operation}?background=1`, {
      method: 'POST', body, signal: AbortSignal.timeout(10_000),
    });
    await followReadingJob(sheet, job);
  } catch (error) {
    sheet.fileMessage = error.status ? error.message : 'La réponse de démarrage a été interrompue. Rouvre la fiche pour vérifier si l’opération est en cours.';
    sheet.fileBusy = false;
    refreshReadingFile(sheet);
  }
}

async function loadReadingFile(sheet) {
  sheet.fileError = null;
  refreshReadingFile(sheet);
  try {
    const payload = await api(`${readingFileUrl(sheet.id)}?info=1`);
    sheet.file = payload.file;
    if (payload.search) sheet.fileSearch = payload.search;
    if (payload.job?.status === 'running') {
      followReadingJob(sheet, payload.job);
      return;
    }
    if (payload.job) applyReadingJob(sheet, payload.job, false);
  } catch (err) {
    sheet.fileError = err.message;
  }
  refreshReadingFile(sheet);
}

async function saveReadingFile(sheet, options, message) {
  sheet.fileBusy = 'Enregistrement…';
  sheet.fileMessage = null;
  refreshReadingFile(sheet);
  try {
    const payload = await api(readingFileUrl(sheet.id), options);
    sheet.file = payload.file;
    showToast(message);
  } catch (err) {
    sheet.fileMessage = err.message;
    showToast(err.message, 'error');
  } finally {
    sheet.fileBusy = false;
    refreshReadingFile(sheet);
  }
}

function renderBookSheet() {
  const book = byId(state.sheet?.id);
  if (!book) {
    closeSheet();
    return;
  }

  const hasPages = Boolean(book.totalPages);
  const current = book.pagesRead;
  const sessions = [...(book.sessions || [])].sort((a, b) => (a.date < b.date ? 1 : -1));

  const body = `
    <div class="row" style="align-items:flex-start;gap:14px">
      ${coverHtml(book, 'lg')}
      <div class="grow">
        <h3 style="font-size:17px;font-weight:700;line-height:1.3">${esc(book.title)}</h3>
        ${book.author ? `<p class="small muted" style="margin-top:3px">${esc(book.author)}</p>` : ''}
        <div class="row" style="gap:6px;margin-top:9px;flex-wrap:wrap">
          ${statusPill(book)}
          ${book.rating ? `<span class="pill">${icon('star', 12)} ${book.rating}/5</span>` : ''}
          ${book.tags?.length ? `<span class="pill">${esc(book.tags.join(' · '))}</span>` : ''}
        </div>
      </div>
    </div>

    <section class="card reading-file" aria-labelledby="readingFileHeading">
      <h3 id="readingFileHeading">Fichier de lecture</h3>
      <div data-reading-file>${readingFileContent(state.sheet)}</div>
    </section>

    <div class="card" style="padding:15px;display:flex;flex-direction:column;gap:11px">
      <div class="row-between">
        <div class="label tiny faint" style="text-transform:uppercase;letter-spacing:.06em;font-weight:650">Progression</div>
        <div style="font-weight:750;color:var(--accent)">${book.percent}%</div>
      </div>
      <div class="bar" style="height:9px"><i style="width:${book.percent}%"></i></div>
      <div class="row-between tiny faint">
        <span>${fmtNum(current)}${hasPages ? ` / ${fmtNum(book.totalPages)}` : ''} pages lues</span>
        <span>${hasPages ? `${fmtNum(book.remaining)} restantes` : 'pages non renseignées'}</span>
      </div>

      ${
        hasPages
          ? `<input type="range" min="0" max="${book.totalPages}" step="1" value="${Math.min(current, book.totalPages)}" data-progress-range data-id="${book.id}" aria-label="Page actuelle" />
             <div class="row-between tiny faint" style="margin-top:-6px"><span>p. 1</span><span id="rangeOut" style="color:var(--text);font-weight:700">${Math.min(current, book.totalPages)}</span><span>p. ${fmtNum(book.totalPages)}</span></div>`
          : ''
      }

      <form data-form="progress" data-id="${book.id}" class="field-inline" style="gap:8px;align-items:center">
        <input type="number" name="page" min="0" max="${hasPages ? book.totalPages : 100000}" inputmode="numeric" value="${current}" aria-label="Page actuelle" style="flex:1" />
        <button class="btn btn-primary btn-sm" type="submit" style="min-height:46px">Mettre à jour</button>
      </form>
    </div>

    <div class="field">
      <label>Enregistrer une session</label>
      <div class="quick-pages">
        <button type="button" data-action="quick-session" data-id="${book.id}" data-pages="5">+5</button>
        <button type="button" data-action="quick-session" data-id="${book.id}" data-pages="10">+10</button>
        <button type="button" data-action="quick-session" data-id="${book.id}" data-pages="20">+20</button>
        <button type="button" data-action="quick-session" data-id="${book.id}" data-pages="30">+30</button>
      </div>
    </div>

    <form class="card" style="padding:14px;display:flex;flex-direction:column;gap:11px" data-form="session" data-id="${book.id}">
      <div class="field-inline">
        <div class="field grow">
          <label for="sessPages">Pages lues</label>
          <input type="number" id="sessPages" name="pages" min="1" max="100000" inputmode="numeric" placeholder="0" required />
        </div>
        <div class="field grow">
          <label for="sessMinutes">Minutes</label>
          <input type="number" id="sessMinutes" name="minutes" min="0" max="1440" inputmode="numeric" placeholder="—" />
        </div>
      </div>
      <div class="field">
        <label for="sessDate">Date</label>
        <input type="date" id="sessDate" name="date" value="${localToday()}" max="${localToday()}" />
      </div>
      <div class="field">
        <label for="sessNote">Note (optionnel)</label>
        <input type="text" id="sessNote" name="note" maxlength="200" placeholder="Chapitre 4, très bon passage…" />
      </div>
      <button class="btn btn-primary btn-block" type="submit">${icon('check', 18)} Enregistrer la session</button>
    </form>

    <div class="field">
      <label>Statut</label>
      <div class="seg">
        ${['want', 'reading', 'finished', 'paused', 'dropped']
          .map(
            (s) =>
              `<button type="button" data-action="set-status" data-id="${book.id}" data-status="${s}" data-active="${book.status === s}">${STATUS[s]}</button>`,
          )
          .join('')}
      </div>
    </div>

    <div class="field">
      <label>Note</label>
      <div class="rating">
        ${[1, 2, 3, 4, 5]
          .map(
            (n) =>
              `<button type="button" data-action="rate" data-id="${book.id}" data-value="${n}" aria-pressed="${(book.rating || 0) >= n}" aria-label="${n} étoile${n > 1 ? 's' : ''}">${icon('star', 19)}</button>`,
          )
          .join('')}
      </div>
    </div>

    ${
      sessions.length
        ? `<div class="field">
             <label>Sessions (${sessions.length})</label>
             <ul class="session-list card" style="padding:4px 13px">
               ${sessions
                 .slice(0, 40)
                 .map(
                   (s) => `<li>
                     <div class="grow">
                       <div><b>${fmtNum(s.pages)}</b> page${s.pages > 1 ? 's' : ''}${s.minutes ? ` · ${fmtMinutes(s.minutes)}` : ''}</div>
                       ${s.note ? `<div class="tiny faint truncate">${esc(s.note)}</div>` : ''}
                     </div>
                     <span class="tiny faint">${relDate(s.date)}</span>
                     <button class="del" data-action="del-session" data-id="${book.id}" data-session="${s.id}" aria-label="Supprimer cette session">${icon('trash', 15)}</button>
                   </li>`,
                 )
                 .join('')}
             </ul>
           </div>`
        : ''
    }

    <div class="field">
      <label for="bookNotes">Notes de lecture</label>
      <textarea id="bookNotes" data-notes data-id="${book.id}" placeholder="Citations, réflexions, pages à relire…" maxlength="20000">${esc(book.notes || '')}</textarea>
      <span class="tiny faint" data-notes-status></span>
    </div>

    <div class="field">
      <label for="bookPages">Nombre de pages</label>
      <input type="number" id="bookPages" data-total-pages data-id="${book.id}" min="0" max="100000" inputmode="numeric" value="${book.totalPages ?? ''}" placeholder="Inconnu" />
    </div>

    <div class="danger-zone">
      <div class="row-between">
        <div>
          <div style="font-weight:650;font-size:14px">Supprimer ce livre</div>
          <div class="tiny faint">Sessions, notes et fichier de lecture compris.</div>
        </div>
        <button class="btn btn-danger btn-sm" data-action="del-book" data-id="${book.id}">${icon('trash', 16)} Supprimer</button>
      </div>
    </div>`;

  $('#sheetRoot').innerHTML = sheetShell({ title: book.title, body, label: book.title });
  wireSheetInputs(book);
}

function wireSheetInputs(book) {
  const range = $('[data-progress-range]');
  const out = $('#rangeOut');
  if (range && out) {
    range.addEventListener('input', () => {
      out.textContent = fmtNum(range.value);
    });
    range.addEventListener('change', async () => {
      try {
        const payload = await api(`/api/books/${book.id}/progress`, {
          method: 'POST',
          body: { page: Number(range.value), date: localToday() },
        });
        mergeSnapshot(payload);
        render({ rerenderSheet: true });
        showToast('Progression enregistrée');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  const notes = $('[data-notes]');
  if (notes) {
    const status = $('[data-notes-status]');
    const save = debounce(async () => {
      try {
        if (status) status.textContent = 'Enregistrement…';
        const payload = await api(`/api/books/${book.id}`, {
          method: 'PATCH',
          body: { notes: notes.value },
        });
        mergeSnapshot(payload);
        if (status) status.textContent = 'Notes enregistrées';
        setTimeout(() => {
          if (status) status.textContent = '';
        }, 1600);
      } catch (err) {
        if (status) status.textContent = '';
        showToast(err.message, 'error');
      }
    }, 700);
    notes.addEventListener('input', save);
  }

  const pagesField = $('[data-total-pages]');
  if (pagesField) {
    pagesField.addEventListener('change', async () => {
      try {
        const payload = await api(`/api/books/${book.id}`, {
          method: 'PATCH',
          body: { totalPages: pagesField.value === '' ? null : Number(pagesField.value) },
        });
        mergeSnapshot(payload);
        render({ rerenderSheet: true });
        showToast('Nombre de pages mis à jour');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }
}

/* ------------------------------- add sheet ------------------------ */

function renderAddSheet() {
  const body = `
    <form class="field" data-form="search">
      <label for="olQuery">Chercher dans Open Library</label>
      <div class="field-inline">
        <input type="search" id="olQuery" name="q" placeholder="Titre, auteur, ISBN…" autocomplete="off" style="flex:1" />
        <button class="btn btn-primary btn-sm" type="submit" style="min-height:46px">${icon('search', 17)}</button>
      </div>
      <span class="tiny faint">Catalogue ouvert et gratuit : titre, auteur, pages et couverture sont préremplis.</span>
    </form>

    <div id="addResults"></div>

    <div class="row" style="gap:10px;color:var(--faint);font-size:12px;margin:2px 0">
      <span style="flex:1;height:1px;background:var(--line)"></span>
      <span>ou saisie manuelle</span>
      <span style="flex:1;height:1px;background:var(--line)"></span>
    </div>

    <form data-form="add" style="display:flex;flex-direction:column;gap:12px">
      <div class="field">
        <label for="addTitle">Titre *</label>
        <input type="text" id="addTitle" name="title" required maxlength="300" placeholder="Titre du livre" />
      </div>
      <div class="field">
        <label for="addAuthor">Auteur</label>
        <input type="text" id="addAuthor" name="author" maxlength="200" placeholder="Nom de l’auteur" />
      </div>
      <div class="field-inline">
        <div class="field grow">
          <label for="addPages">Pages</label>
          <input type="number" id="addPages" name="totalPages" min="0" max="100000" inputmode="numeric" placeholder="—" />
        </div>
        <div class="field grow">
          <label for="addCurrent">Page actuelle</label>
          <input type="number" id="addCurrent" name="currentPage" min="0" max="100000" inputmode="numeric" placeholder="0" />
        </div>
      </div>
      <div class="field">
        <label for="addStatus">Statut</label>
        <select id="addStatus" name="status">
          <option value="want">À lire</option>
          <option value="reading">En cours</option>
          <option value="finished">Terminé</option>
        </select>
      </div>
      <input type="hidden" name="coverUrl" id="addCover" />
      <input type="hidden" name="externalId" id="addExternal" />
      <button class="btn btn-primary btn-block" type="submit" style="min-height:50px">${icon('plus', 20)} Ajouter à ma bibliothèque</button>
    </form>`;

  $('#sheetRoot').innerHTML = sheetShell({ title: 'Ajouter un livre', body, label: 'Ajouter un livre' });

  const searchForm = $('[data-form="search"]');
  searchForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const q = String(new FormData(searchForm).get('q') || '').trim();
    const box = $('#addResults');
    if (q.length < 2) {
      showToast('Saisissez au moins 2 caractères.', 'error');
      return;
    }
    box.innerHTML = `<div class="skeleton" style="height:64px"></div>`;
    try {
      const { results } = await api(`/api/search?q=${encodeURIComponent(q)}&limit=12`);
      searchResults = results || [];
      if (!searchResults.length) {
        box.innerHTML = `<p class="tiny faint" style="padding:8px 2px">Aucun résultat. Essayez un autre titre, ou saisissez le livre à la main.</p>`;
        return;
      }
      box.innerHTML = `<div class="card" style="padding:6px;display:flex;flex-direction:column;gap:2px">
        ${searchResults
          .map(
            (r, i) => `<div class="result-row" data-action="pick-result" data-index="${i}" role="button" tabindex="0">
              <div class="cover cover-sm" style="background:linear-gradient(160deg,hsl(${hueOf(r.title)} 34% 30%),hsl(${(hueOf(r.title) + 26) % 360} 40% 17%));color:#fff">
                <span>${esc(initials(r.title))}</span>${coverImg(r.coverUrl)}
              </div>
              <div class="grow">
                <div class="truncate" style="font-weight:620;font-size:14px">${esc(r.title)}</div>
                <div class="tiny faint truncate">${esc(r.author || 'Auteur inconnu')}${r.year ? ` · ${r.year}` : ''}${r.pages ? ` · ${r.pages} p.` : ''}</div>
              </div>
              ${icon('plus', 17)}
            </div>`,
          )
          .join('')}
      </div>`;
    } catch (err) {
      box.innerHTML = `<p class="tiny" style="padding:8px 2px;color:var(--danger)">${esc(err.message)}</p>`;
    }
  });
}

/* ------------------------------------------------------------------ */
/* main render                                                         */
/* ------------------------------------------------------------------ */

let renderQueued = false;
function render({ rerenderSheet = false } = {}) {
  applyTheme(state.settings.theme);

  const navMap = { reading: 'reading', library: 'library', discover: 'discover', stats: 'stats', settings: 'settings' };
  $$('.nav button').forEach((btn) => {
    if (btn.dataset.view === navMap[state.view]) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });

  const brandTitle = state.settings.name ? `Lectures de ${state.settings.name}` : 'Mes lectures';
  $('#brandTitle').textContent = brandTitle;

  const stats = state.stats;
  $('#brandSub').textContent = stats
    ? `${stats.readingBooks.length} en cours · ${stats.goal.done}/${stats.goal.target} cette année`
    : 'Suivi de progression';
  $('#goalChipText').innerHTML = stats
    ? `<b>${stats.goal.done}</b> / ${stats.goal.target}`
    : '—';

  // The add button is noise on the discovery, stats and settings screens,
  // where it overlaps content that already has its own actions.
  const fab = $('.fab');
  if (fab) fab.classList.toggle('is-hidden', ['settings', 'discover', 'stats'].includes(state.view));

  const view = $('#view');
  let html;
  if (state.error) {
    html = renderEmpty({ title: 'Connexion impossible', text: state.error, cta: false });
  } else if (state.loading) {
    html = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
  } else if (state.view === 'reading') html = viewReading();
  else if (state.view === 'library') html = viewLibrary();
  else if (state.view === 'discover') html = viewDiscover();
  else if (state.view === 'stats') html = viewStats();
  else html = viewSettings();

  view.innerHTML = html;

  if (state.view === 'library') {
    const input = $('#librarySearch');
    if (input) {
      input.addEventListener('input', () => {
        state.query = input.value;
        const pos = input.selectionStart;
        render();
        const next = $('#librarySearch');
        if (next) {
          next.focus();
          next.setSelectionRange(pos, pos);
        }
      });
    }
  }

  if (rerenderSheet && state.sheet?.kind === 'book') renderBookSheet();
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
    });
  }
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

async function withBusy(button, fn) {
  if (button) button.disabled = true;
  try {
    await fn();
  } finally {
    if (button) button.disabled = false;
  }
}

const actions = {
  nav(button) {
    state.view = button.dataset.view;
    state.query = '';
    window.scrollTo(0, 0);
    render();
    if (state.view === 'discover' && !state.discover.data && !state.discover.loading) {
      loadDiscover();
    }
  },

  add() {
    openSheet('add');
  },

  'close-sheet'() {
    closeSheet();
  },

  'open-book'(button) {
    openSheet('book', button.dataset.id);
  },

  'reload-reading-file'() {
    loadReadingFile(state.sheet);
  },

  'pick-reading-file'() {
    $('[data-reading-file-input]')?.click();
  },

  'search-reading-file'() {
    startReadingJob(state.sheet, 'search');
  },

  'find-reading-pdf'() {
    const sheet = state.sheet;
    if (sheet.file && !sheet.file.pageMismatch && !window.confirm('Remplacer le fichier de lecture si un PDF compatible est trouvé ?')) return;
    startReadingJob(sheet, 'find-pdf');
  },

  'acquire-reading-file'(button) {
    const sheet = state.sheet;
    if (sheet.file && !window.confirm('Remplacer le fichier de lecture joint par cette édition ?')) return;
    startReadingJob(sheet, 'acquire', { ref: button.dataset.ref });
  },

  'remove-reading-file'() {
    if (window.confirm('Retirer le fichier de lecture de ce livre ?')) {
      saveReadingFile(state.sheet, { method: 'DELETE' }, 'Fichier retiré');
    }
  },

  async 'quick-plus'(button) {
    const id = button.dataset.id;
    const pages = Number(button.dataset.pages || 10);
    await withBusy(button, async () => {
      try {
        const payload = await api(`/api/books/${id}/progress`, {
          method: 'POST',
          body: { page: (byId(id)?.pagesRead || 0) + pages, date: localToday() },
        });
        mergeSnapshot(payload);
        render();
        showToast(`+${pages} pages`);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  },

  async 'quick-session'(button) {
    const id = button.dataset.id;
    const pages = Number(button.dataset.pages || 10);
    await withBusy(button, async () => {
      try {
        const payload = await api(`/api/books/${id}/sessions`, {
          method: 'POST',
          body: { pages, date: localToday() },
        });
        mergeSnapshot(payload);
        render({ rerenderSheet: true });
        showToast(`+${pages} pages`);
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  },

  async 'set-status'(button) {
    const { id, status } = button.dataset;
    try {
      const payload = await api(`/api/books/${id}`, { method: 'PATCH', body: { status } });
      mergeSnapshot(payload);
      render({ rerenderSheet: true });
      showToast(`Statut : ${STATUS[status]}`);
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  async rate(button) {
    const { id } = button.dataset;
    const value = Number(button.dataset.value);
    const book = byId(id);
    const next = book?.rating === value ? null : value;
    try {
      const payload = await api(`/api/books/${id}`, { method: 'PATCH', body: { rating: next } });
      mergeSnapshot(payload);
      render({ rerenderSheet: true });
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  async 'del-session'(button) {
    const { id, session } = button.dataset;
    try {
      const payload = await api(`/api/books/${id}/sessions/${session}`, { method: 'DELETE' });
      mergeSnapshot(payload);
      render({ rerenderSheet: true });
      showToast('Session supprimée');
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  async 'del-book'(button) {
    const id = button.dataset.id;
    const book = byId(id);
    if (!book) return;
    if (!window.confirm(`Supprimer « ${book.title} » et tout son historique ?`)) return;
    try {
      const payload = await api(`/api/books/${id}`, { method: 'DELETE' });
      mergeSnapshot(payload);
      closeSheet();
      render();
      showToast('Livre supprimé');
    } catch (err) {
      showToast(err.message, 'error');
    }
  },

  filter(button) {
    state.filter = button.dataset.filter;
    render();
  },

  async 'toggle-interest'(button) {
    const id = button.dataset.id;
    const current = new Set(state.settings.interests || []);
    if (current.has(id)) current.delete(id);
    else current.add(id);

    // Keep the grid open while the user is picking several genres.
    state.discover.pickerOpen = true;

    // Optimistic: the chip must answer the tap immediately, the network
    // round-trip (and the recommendation refresh) can take seconds.
    button.setAttribute('aria-pressed', String(current.has(id)));
    state.settings.interests = [...current];

    try {
      const payload = await api('/api/settings', {
        method: 'PATCH',
        body: { interests: [...current] },
      });
      mergeSnapshot(payload);
      render();
      await loadDiscover({ refresh: true, silent: true });
    } catch (err) {
      showToast(err.message, 'error');
      // Resync from the server so the chip cannot drift from what was saved.
      try {
        mergeSnapshot(await api('/api/state'));
      } catch {
        /* keep the optimistic value if even that fails */
      }
      render();
    }
  },

  'toggle-picker'() {
    const selectedCount = (state.settings.interests || []).length;
    state.discover.pickerOpen = !(state.discover.pickerOpen || selectedCount === 0);
    render();
  },

  async 'refresh-recs'(button) {
    await withBusy(button, () => loadDiscover({ refresh: true }));
  },

  'open-rec'(button) {
    openSheet('rec', button.dataset.key);
  },

  async 'add-rec'(button) {
    const key = button.dataset.key;
    const rec = (state.discover.data?.recommendations || []).find((r) => r.key === key);
    if (!rec) return;
    await withBusy(button, async () => {
      try {
        const payload = await api('/api/books', {
          method: 'POST',
          body: {
            title: rec.title,
            author: rec.author,
            totalPages: rec.pages || null,
            coverUrl: rec.coverLargeUrl || rec.coverUrl || '',
            externalId: rec.key,
            source: 'openlibrary',
            status: 'want',
          },
        });
        mergeSnapshot(payload);
        dropRecommendation(key);
        if (state.sheet) closeSheet();
        render();
        showToast('Ajouté à votre bibliothèque');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  },

  async 'dismiss-rec'(button) {
    const key = button.dataset.key;
    await withBusy(button, async () => {
      try {
        const payload = await api('/api/discover/dismiss', {
          method: 'POST',
          body: { key },
        });
        mergeSnapshot(payload);
        dropRecommendation(key);
        if (state.sheet) closeSheet();
        render();
        showToast('Suggestion ignorée');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  },

  'pick-result'(button) {
    const row = searchResults[Number(button.dataset.index)];
    if (!row) return;
    const title = $('#addTitle');
    const author = $('#addAuthor');
    const pages = $('#addPages');
    const cover = $('#addCover');
    const external = $('#addExternal');
    if (title) title.value = row.title;
    if (author) author.value = row.author || '';
    if (pages) pages.value = row.pages || '';
    if (cover) cover.value = row.coverLargeUrl || row.coverUrl || '';
    if (external) external.value = row.externalId || '';
    const status = $('#addStatus');
    if (status) status.value = 'want';
    title?.focus();
    title?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    showToast('Détails préremplis');
  },

  async 'toggle-theme'(button) {
    const next = state.settings.theme === 'light' ? 'dark' : 'light';
    applyTheme(next);
    state.settings.theme = next;
    button.setAttribute('aria-pressed', String(next === 'light'));
    try {
      await api('/api/settings', { method: 'PATCH', body: { theme: next } });
    } catch {
      /* theme is cosmetic; keep it locally even if the save fails */
    }
  },

  async 'save-settings'(button) {
    const name = $('#setName')?.value ?? '';
    const yearlyGoal = Number($('#setGoal')?.value ?? 12);
    await withBusy(button, async () => {
      try {
        const payload = await api('/api/settings', {
          method: 'PATCH',
          body: { name, yearlyGoal },
        });
        mergeSnapshot(payload);
        render();
        showToast('Réglages enregistrés');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  },
};

/* ------------------------------------------------------------------ */
/* forms                                                               */
/* ------------------------------------------------------------------ */

async function submitProgress(form) {
  const id = form.dataset.id;
  const page = Number(new FormData(form).get('page'));
  if (!Number.isFinite(page)) {
    showToast('Indiquez une page valide.', 'error');
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  await withBusy(button, async () => {
    try {
      const payload = await api(`/api/books/${id}/progress`, {
        method: 'POST',
        body: { page, date: localToday() },
      });
      mergeSnapshot(payload);
      render({ rerenderSheet: true });
      showToast(payload.delta > 0 ? `+${payload.delta} pages` : 'Position mise à jour');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

async function submitSession(form) {
  const id = form.dataset.id;
  const data = Object.fromEntries(new FormData(form));
  const pages = Number(data.pages);
  if (!Number.isFinite(pages) || pages <= 0) {
    showToast('Indiquez un nombre de pages.', 'error');
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  await withBusy(button, async () => {
    try {
      const payload = await api(`/api/books/${id}/sessions`, {
        method: 'POST',
        body: {
          pages,
          minutes: data.minutes ? Number(data.minutes) : 0,
          date: data.date || localToday(),
          note: data.note || '',
        },
      });
      mergeSnapshot(payload);
      render({ rerenderSheet: true });
      showToast('Session enregistrée');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

async function submitAdd(form) {
  const raw = Object.fromEntries(new FormData(form));
  if (!String(raw.title || '').trim()) {
    showToast('Le titre est obligatoire.', 'error');
    return;
  }
  const button = form.querySelector('button[type="submit"]');
  await withBusy(button, async () => {
    try {
      const payload = await api('/api/books', {
        method: 'POST',
        body: {
          title: raw.title,
          author: raw.author,
          totalPages: raw.totalPages ? Number(raw.totalPages) : null,
          currentPage: raw.currentPage ? Number(raw.currentPage) : 0,
          status: raw.status || 'want',
          coverUrl: raw.coverUrl || '',
          externalId: raw.externalId || '',
          source: raw.externalId ? 'openlibrary' : 'manual',
        },
      });
      mergeSnapshot(payload);
      closeSheet();
      state.view = 'library';
      state.filter = 'all';
      render();
      showToast('Livre ajouté');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}

/* ------------------------------------------------------------------ */
/* events                                                             */
/* ------------------------------------------------------------------ */

document.addEventListener('click', (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const handler = actions[target.dataset.action];
  if (!handler) return;
  event.preventDefault();
  handler(target);
});

document.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const kind = form.dataset.form;
  if (kind === 'progress') submitProgress(form);
  else if (kind === 'session') submitSession(form);
  else if (kind === 'add') submitAdd(form);
});

document.addEventListener('change', async (event) => {
  const readingInput = event.target.closest('[data-reading-file-input]');
  if (readingInput) {
    const file = readingInput.files?.[0];
    readingInput.value = '';
    if (!file || state.sheet?.kind !== 'book' || state.sheet.fileBusy) return;
    const extension = file.name.split('.').pop().toLowerCase();
    const contentType = extension === 'pdf' ? 'application/pdf' : 'application/epub+zip';
    if (!['pdf', 'epub'].includes(extension)) {
      showToast('Choisis un fichier PDF ou EPUB.', 'error');
    } else if (file.size > FILE_LIMIT_MIB[extension] * 1024 * 1024) {
      showToast(`Le fichier dépasse ${FILE_LIMIT_MIB[extension]} Mo.`, 'error');
    } else {
      saveReadingFile(state.sheet, { method: 'PUT', file, contentType }, 'Fichier enregistré');
    }
    return;
  }
  const input = event.target.closest('#importFile');
  if (!input || !input.files?.length) return;
  const file = input.files[0];
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    if (!window.confirm('Remplacer toutes les données actuelles par cette sauvegarde ?')) {
      input.value = '';
      return;
    }
    const result = await api('/api/import', { method: 'POST', body: payload });
    mergeSnapshot(result);
    render();
    showToast(`${result.imported} livres importés`);
  } catch (err) {
    showToast(`Import impossible : ${err.message}`, 'error');
  } finally {
    input.value = '';
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.sheet) closeSheet();
});

// role="button" elements need Enter/Space, since they are not native buttons.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const el = event.target.closest('[role="button"][data-action]');
  if (!el) return;
  event.preventDefault();
  el.click();
});

window.addEventListener('popstate', () => {
  if (state.sheet) closeSheet({ fromPop: true });
});

/* ------------------------------------------------------------------ */
/* boot                                                               */
/* ------------------------------------------------------------------ */

async function boot() {
  // Apply a cached theme immediately to avoid a flash of the wrong palette.
  try {
    const cached = localStorage.getItem('reading-theme');
    if (cached) applyTheme(cached);
  } catch {
    /* private mode */
  }

  try {
    const payload = await api('/api/state');
    mergeSnapshot(payload);
    state.loading = false;
    try {
      localStorage.setItem('reading-theme', state.settings.theme);
    } catch {
      /* ignore */
    }
  } catch (err) {
    state.loading = false;
    state.error = err.message;
  }
  render();
  const url = new URL(location.href);
  const bookId = url.searchParams.get('book');
  if (bookId && byId(bookId)) {
    url.searchParams.delete('book');
    history.replaceState(null, '', url);
    openSheet('book', bookId);
  }
}

boot();
