import { describe, expect, it } from "bun:test";
import { traceHref } from "./trace-link.js";

describe("traceHref", () => {
  it("substitutes a {trace_id} placeholder, url-encoding the id", () => {
    expect(
      traceHref(
        {
          trace_ui_base_url:
            'https://g.example/explore?left={"queries":[{"query":"{trace_id}"}]}',
        },
        { trace_id: "abc/123" },
      ),
    ).toBe(
      'https://g.example/explore?left={"queries":[{"query":"abc%2F123"}]}',
    );
  });

  it("substitutes every occurrence of the placeholder", () => {
    expect(
      traceHref(
        { trace_ui_base_url: "https://t.io/{trace_id}?hl={trace_id}" },
        { trace_id: "x1" },
      ),
    ).toBe("https://t.io/x1?hl=x1");
  });

  it("concatenates base url and trace id without a placeholder", () => {
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
