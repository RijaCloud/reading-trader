// Local-date helpers. Everything user-facing is a plain "YYYY-MM-DD" string,
// which keeps the data timezone-stable and human readable in the JSON file.

export function toISODate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function todayISO() {
  return toISODate(new Date());
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidISODate(value) {
  if (typeof value !== 'string' || !ISO_RE.test(value)) return false;
  const d = new Date(`${value}T12:00:00`);
  return !Number.isNaN(d.getTime()) && toISODate(d) === value;
}

/** Normalise coarse-relative wording a client may send; today when unusable. */
export function safeDate(value) {
  return isValidISODate(value) ? value : todayISO();
}

/** Add (or subtract) whole days to an ISO date string. */
export function shiftDays(iso, days) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** Every ISO date from `from` to `to` inclusive. */
export function dateRange(from, to) {
  const out = [];
  let cursor = from;
  // Guard against a reversed range producing an unbounded loop.
  for (let i = 0; i <= 4000; i += 1) {
    out.push(cursor);
    if (cursor === to) break;
    cursor = shiftDays(cursor, 1);
  }
  return out;
}

/** Whole days between two ISO dates (b - a). */
export function daysBetween(a, b) {
  const ms =
    new Date(`${b}T12:00:00`).getTime() - new Date(`${a}T12:00:00`).getTime();
  return Math.round(ms / 86_400_000);
}
