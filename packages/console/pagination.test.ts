import { describe, expect, it } from "bun:test";
import {
  hrefForPage,
  outOfRange,
  pageCount,
  pageFromHash,
} from "./pagination.js";

describe("pageFromHash", () => {
  it("returns 1 when absent", () => {
    expect(pageFromHash("#/")).toBe(1);
    expect(pageFromHash("")).toBe(1);
    expect(pageFromHash("#/project/Operator%20console")).toBe(1);
  });
  it("parses ?page=N", () => {
    expect(pageFromHash("#/?page=2")).toBe(2);
    expect(pageFromHash("#/project/Operator%20console?page=2")).toBe(2);
    expect(pageFromHash("#/?page=25")).toBe(25);
  });
  it("returns 1 for non-numeric or < 1", () => {
    expect(pageFromHash("#/?page=abc")).toBe(1);
    expect(pageFromHash("#/?page=0")).toBe(1);
    expect(pageFromHash("#/?page=-3")).toBe(1);
    expect(pageFromHash("#/?page=")).toBe(1);
    expect(pageFromHash("#/?page=1.9")).toBe(1);
    expect(pageFromHash("#/?page=NaN")).toBe(1);
  });
  it("ignores other query params", () => {
    expect(pageFromHash("#/?project=X&page=2")).toBe(2);
    expect(pageFromHash("#/?page=2&x=1")).toBe(2);
  });
});

describe("hrefForPage", () => {
  it("returns base for page 1", () => {
    expect(hrefForPage("#/", 1)).toBe("#/");
    expect(hrefForPage("#/project/Operator%20console", 1)).toBe(
      "#/project/Operator%20console",
    );
  });
  it("appends ?page for page > 1", () => {
    expect(hrefForPage("#/", 2)).toBe("#/?page=2");
    expect(hrefForPage("#/project/Operator%20console", 2)).toBe(
      "#/project/Operator%20console?page=2",
    );
  });
});

describe("outOfRange", () => {
  it("false when total is 0 (empty factory)", () => {
    expect(outOfRange(1, 0, 25)).toBe(false);
    expect(outOfRange(2, 0, 25)).toBe(false);
  });
  it("true when (page-1)*limit >= total", () => {
    expect(outOfRange(2, 25, 25)).toBe(true);
    expect(outOfRange(2, 26, 25)).toBe(false);
    expect(outOfRange(99, 27, 25)).toBe(true);
    expect(outOfRange(1, 25, 25)).toBe(false);
  });
});

describe("pageCount", () => {
  it("computes ceiling", () => {
    expect(pageCount(0, 25)).toBe(0);
    expect(pageCount(25, 25)).toBe(1);
    expect(pageCount(26, 25)).toBe(2);
    expect(pageCount(27, 25)).toBe(2);
    expect(pageCount(50, 25)).toBe(2);
    expect(pageCount(51, 25)).toBe(3);
  });
});
