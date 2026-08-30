// @ts-nocheck
import { describe, expect, it } from "bun:test";
import {
  escapeHtml,
  mdFragment,
  mdInline,
  renderMarkdown,
} from "./markdown.js";

describe("escapeHtml", () => {
  it("escapes every HTML-significant character", () => {
    expect(escapeHtml('<script>alert("x")</script>&')).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;",
    );
  });

  it("stringifies non-strings", () => {
    expect(escapeHtml(5)).toBe("5");
  });
});

describe("renderMarkdown", () => {
  it("renders headings with level + 1 (source h1 becomes h2)", () => {
    expect(renderMarkdown("# Title")).toBe("<h2>Title</h2>");
    expect(renderMarkdown("## Sub")).toBe("<h3>Sub</h3>");
    expect(renderMarkdown("#### Deep")).toBe("<h5>Deep</h5>");
  });

  it("renders unordered and ordered lists, closing them between blocks", () => {
    expect(renderMarkdown("- a\n- b")).toBe(
      "<ul>\n<li>a</li>\n<li>b</li>\n</ul>",
    );
    expect(renderMarkdown("1. a\n2) b")).toBe(
      "<ol>\n<li>a</li>\n<li>b</li>\n</ol>",
    );
    expect(renderMarkdown("- a\n\npara")).toBe(
      "<ul>\n<li>a</li>\n</ul>\n<p>para</p>",
    );
  });

  it("renders fenced code blocks without inline processing inside", () => {
    expect(renderMarkdown("```ts\nlet a = 1;\n```")).toBe(
      '<pre class="md-code"><code>let a = 1;</code></pre>',
    );
    expect(renderMarkdown("```\n**not bold**\n```")).toContain("**not bold**");
  });

  it("closes an unterminated fence at end of input", () => {
    expect(renderMarkdown("```\nunterminated")).toBe(
      '<pre class="md-code"><code>unterminated</code></pre>',
    );
  });

  it("renders blockquotes per line", () => {
    expect(renderMarkdown("> quoted")).toBe("<blockquote>quoted</blockquote>");
  });

  it("renders horizontal rules", () => {
    expect(renderMarkdown("---")).toBe("<hr />");
    expect(renderMarkdown("***")).toBe("<hr />");
  });

  it("wraps plain paragraphs", () => {
    expect(renderMarkdown("hello\n\nworld")).toBe("<p>hello</p>\n<p>world</p>");
  });

  it("escapes XSS vectors before rebuilding markup", () => {
    const html = renderMarkdown("<img src=x onerror=alert(1)>");
    expect(html).toBe("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
    expect(html).not.toContain("<img");
    expect(renderMarkdown("<script>bad()</script>")).not.toContain("<script>");
    expect(renderMarkdown('quote " and amp & and < tag')).toBe(
      "<p>quote &quot; and amp &amp; and &lt; tag</p>",
    );
    expect(renderMarkdown("[click](javascript:alert(1))")).not.toContain("<a ");
  });

  it("keeps link/inline grammar working on escaped input", () => {
    expect(
      renderMarkdown("[docs](https://example.com) with `code` and **bold**"),
    ).toBe(
      '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">docs</a> with <code>code</code> and <strong>bold</strong></p>',
    );
  });
});

describe("mdInline", () => {
  it("converts code, bold, italic, and links", () => {
    expect(mdInline("`x` **y** *z*")).toBe(
      "<code>x</code> <strong>y</strong> <em>z</em>",
    );
    expect(mdInline("[a](https://x.io)")).toBe(
      '<a href="https://x.io" target="_blank" rel="noopener noreferrer">a</a>',
    );
  });

  it("never links non-http schemes", () => {
    expect(mdInline("[a](javascript:alert(1))")).toBe(
      "[a](javascript:alert(1))",
    );
  });
});

describe("mdFragment", () => {
  it("parses rendered markdown into detached template content", () => {
    const frag = mdFragment("# Hi\n\n- one");
    expect(frag.querySelectorAll("h2")).toHaveLength(1);
    expect(frag.querySelectorAll("li")).toHaveLength(1);
    expect(frag.querySelector("li")?.textContent).toBe("one");
  });

  it("never materializes raw agent-authored markup", () => {
    const frag = mdFragment("<img src=x onerror=alert(1)>");
    expect(frag.querySelectorAll("img")).toHaveLength(0);
    expect(frag.textContent).toContain("<img");
  });
});
