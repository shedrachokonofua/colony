import { describe, expect, it } from "bun:test";
import { iterPages, toCursorPage, type CursorPage } from "./cursor.js";

function pages(...specs: { items: number[]; hasMore: boolean }[]): {
  fetchPage: (beforeId?: number) => Promise<CursorPage<number>>;
  seen: (number | undefined)[];
} {
  const seen: (number | undefined)[] = [];
  return {
    seen,
    fetchPage: async (beforeId?: number) => {
      seen.push(beforeId);
      const spec = specs[seen.length - 1];
      if (!spec) throw new Error("fetchPage called too many times");
      return {
        items: spec.items,
        hasMore: spec.hasMore,
        oldestId: spec.items[0] ?? null,
      };
    },
  };
}

describe("iterPages", () => {
  it("starts without a cursor then walks backwards by oldestId", async () => {
    const { fetchPage, seen } = pages(
      { items: [3, 4], hasMore: true },
      { items: [1, 2], hasMore: false },
    );
    const collected: number[][] = [];
    for await (const page of iterPages(fetchPage)) collected.push(page);
    expect(collected).toEqual([
      [3, 4],
      [1, 2],
    ]);
    expect(seen).toEqual([undefined, 3]);
  });

  it("stops as soon as a page reports hasMore false", async () => {
    const { fetchPage, seen } = pages({ items: [7], hasMore: false });
    const collected: number[][] = [];
    for await (const page of iterPages(fetchPage)) collected.push(page);
    expect(collected).toEqual([[7]]);
    expect(seen).toEqual([undefined]);
  });

  it("stops when a page is empty even if the server claims more", async () => {
    const { fetchPage, seen } = pages({ items: [], hasMore: true });
    const collected: number[][] = [];
    for await (const page of iterPages(fetchPage)) collected.push(page);
    expect(collected).toEqual([[]]);
    expect(seen).toEqual([undefined]);
  });

  it("adapts the server envelope shape", () => {
    expect(
      toCursorPage({ events: [1, 2], has_more: true, oldest_id: 1, newest_id: 2 }),
    ).toEqual({ items: [1, 2], hasMore: true, oldestId: 1 });
  });
});
