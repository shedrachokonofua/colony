/** @param {string} hash */
export function pageFromHash(hash) {
  const q = String(hash).split("?")[1];
  if (!q) return 1;
  const value = new URLSearchParams(q).get("page");
  if (value === null || value === "") return 1;
  const n = Number(value);
  if (!Number.isFinite(n)) return 1;
  const page = Math.floor(n);
  if (page < 1) return 1;
  return page;
}

/** @param {string} base @param {number} page */
export function hrefForPage(base, page) {
  if (page === 1) return base;
  return `${base}?page=${page}`;
}

/** @param {number} page @param {number} total @param {number} limit */
export function outOfRange(page, total, limit) {
  return total > 0 && (page - 1) * limit >= total;
}

/** @param {number} total @param {number} limit */
export function pageCount(total, limit) {
  return Math.ceil(total / limit);
}
