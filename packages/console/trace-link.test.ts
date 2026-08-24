import { describe, expect, it } from "bun:test";
import { traceHref } from "./trace-link.js";

describe("traceHref", () => {
  it("concatenates base url and trace id", () => {
    expect(
      traceHref(
        { trace_ui_base_url: "https://traces.example.com" },
        { trace_id: "abc123" },
      ),
    ).toBe("https://traces.example.comabc123");
  });

  it("returns null when trace_ui_base_url is empty or missing", () => {
    expect(traceHref({ trace_ui_base_url: "" }, { trace_id: "abc123" })).toBe(
      null,
    );
    expect(traceHref({}, { trace_id: "abc123" })).toBe(null);
    expect(traceHref({ trace_ui_base_url: null }, { trace_id: "abc123" })).toBe(
      null,
    );
  });

  it("returns null when trace_id is empty or missing", () => {
    expect(
      traceHref({ trace_ui_base_url: "https://t.io/" }, { trace_id: "" }),
    ).toBe(null);
    expect(
      traceHref({ trace_ui_base_url: "https://t.io/" }, { trace_id: null }),
    ).toBe(null);
    expect(traceHref({ trace_ui_base_url: "https://t.io/" }, {})).toBe(null);
  });
});
