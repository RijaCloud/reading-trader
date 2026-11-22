function normalized(text = '') {
  return String(text).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

export function pagesMatch(actual, expected) {
  if (!expected) return true;
  const tolerance = Math.max(expected <= 30 ? 2 : 8, Math.round(expected * 0.2));
  return Math.abs(actual - expected) <= tolerance;
}

const excerpt = /\b(extrait|extraits|apercu|resume|condense|preview|sample|abridged|excerpt|summary)\b/;

export function rankEditions(book, rows) {
  const title = normalized(book.title);
  const author = normalized(book.author);
  const authorWords = author.split(' ').filter(Boolean);
  const editions = [];
  let ignored = 0;

  for (const row of rows) {
    const editionTitle = normalized(row.title);
    const editionAuthor = normalized(row.author);
    const pages = Number(row.pages);
    const knownPages = Number.isInteger(pages) && pages > 0 ? pages : null;
    if ((!excerpt.test(title) && excerpt.test(editionTitle)) ||
        (row.format === 'pdf' && knownPages && !pagesMatch(knownPages, book.totalPages))) {
      ignored += 1;
      continue;
    }
    const titleMatch = editionTitle === title || editionTitle.startsWith(title + ' ');
    const matchesAuthor = !author || authorWords.every((word) => editionAuthor.split(' ').includes(word));
    const compatible = Boolean(titleMatch && matchesAuthor);
    editions.push({ ...row, pages: knownPages, compatible });
  }

  const pageDistance = (row) => row.pages && book.totalPages ? Math.abs(row.pages - book.totalPages) : Number.MAX_SAFE_INTEGER;
  editions.sort((a, b) =>
    Number(b.compatible) - Number(a.compatible) ||
    Number(b.format === 'pdf') - Number(a.format === 'pdf') ||
    pageDistance(a) - pageDistance(b));
  return { rows: editions, ignored };
}

export function automaticPdfCandidates(book, rows) {
  const closePages = Math.max(4, Math.round(book.totalPages * 0.05));
  function confidence(row) {
    if (!row.pages) return 2;
    return Math.abs(row.pages - book.totalPages) <= closePages ? 0 : 1;
  }
  const transferSize = (row) => row.sizeMb > 0 ? row.sizeMb : Number.MAX_SAFE_INTEGER;
  return rows
    .filter((row) => row.source === 'libgen' && row.format === 'pdf' && row.compatible)
    .sort((a, b) => confidence(a) - confidence(b) || transferSize(a) - transferSize(b));
}
