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

export function hrefForPage(base, page) {
  if (page === 1) return base;
  return `${base}?page=${page}`;
}

export function outOfRange(page, total, limit) {
  return total > 0 && (page - 1) * limit >= total;
}

export function pageCount(total, limit) {
  return Math.ceil(total / limit);
}
