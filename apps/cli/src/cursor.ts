/**
 * Cursor pagination over the server's page envelope
 * `{ events, has_more, oldest_id, newest_id }`. Pages walk backwards: each
 * round passes the previous page's oldest id as `before_id`.
 */

export interface CursorPage<T> {
  items: T[];
  hasMore: boolean;
  oldestId: number | null;
}

export async function* iterPages<T>(
  fetchPage: (beforeId?: number) => Promise<CursorPage<T>>,
): AsyncGenerator<T[]> {
  let beforeId: number | undefined;
  for (;;) {
    const page = await fetchPage(beforeId);
    yield page.items;
    if (!page.hasMore || page.oldestId === null) return;
    beforeId = page.oldestId;
  }
}

/** Adapt a raw envelope response into a CursorPage. */
export function toCursorPage<T>(envelope: {
  events: T[];
  has_more: boolean;
  oldest_id: number | null;
  newest_id?: number | null;
}): CursorPage<T> {
  return {
    items: envelope.events,
    hasMore: envelope.has_more,
    oldestId: envelope.oldest_id,
  };
}
