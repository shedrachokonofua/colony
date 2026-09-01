import { describe, expect, it } from "bun:test";
import { ansi, colorEnabled, renderTable } from "./render.js";

describe("renderTable", () => {
  it("pads columns to the widest cell", () => {
    expect(
      renderTable(
        ["id", "state"],
        [
          ["col-1", "active"],
          ["col-22", "done"],
        ],
      ),
    ).toBe(["id      state", "col-1   active", "col-22  done"].join("\n"));
  });

  it("uses the header width when rows are narrower", () => {
    expect(renderTable(["long-header"], [["x"]])).toBe(
      ["long-header", "x"].join("\n"),
    );
  });

  it("renders only the header when there are no rows", () => {
    expect(renderTable(["a", "b"], [])).toBe("a  b");
  });

  it("tolerates ragged rows", () => {
    expect(renderTable(["a", "b"], [["only-a"]])).toBe(
      ["a       b", "only-a"].join("\n"),
    );
  });
});

describe("ansi", () => {
  it("wraps the string only when color is enabled", () => {
    expect(ansi(true, 31, "blocked")).toBe("\u001b[31mblocked\u001b[0m");
    expect(ansi(false, 31, "blocked")).toBe("blocked");
  });
});

describe("colorEnabled", () => {
  it("requires a TTY and no NO_COLOR", () => {
    expect(colorEnabled(true, undefined)).toBe(true);
    expect(colorEnabled(false, undefined)).toBe(false);
  });

  it("respects NO_COLOR", () => {
    expect(colorEnabled(true, true)).toBe(false);
    expect(colorEnabled(true, false)).toBe(true);
  });
});
