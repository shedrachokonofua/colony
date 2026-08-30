// Markdown reader: safe subset renderer for agent-authored plan/spec text.
// Escapes EVERYTHING first, then rebuilds a small grammar: headings, fenced
// code, lists, blockquotes, bold/italic/inline code, http(s) links.

export function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function mdInline(text) {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
}

export function renderMarkdown(source) {
  const lines = escapeHtml(source).split("\n");
  const out = [];
  let list = null; // "ul" | "ol"
  let fence = false;
  let fenceBuf = [];
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of lines) {
    if (/^```/.test(raw.trim())) {
      if (fence) {
        out.push(
          `<pre class="md-code"><code>${fenceBuf.join("\n")}</code></pre>`,
        );
        fenceBuf = [];
        fence = false;
      } else {
        closeList();
        fence = true;
      }
      continue;
    }
    if (fence) {
      fenceBuf.push(raw);
      continue;
    }
    const line = raw;
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      const level = Math.min(h[1].length + 1, 5);
      out.push(`<h${level}>${mdInline(h[2])}</h${level}>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line.trim())) {
      closeList();
      out.push("<hr />");
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        out.push(`<${kind}>`);
        list = kind;
      }
      out.push(`<li>${mdInline((ul || ol)[1])}</li>`);
      continue;
    }
    if (/^\s*&gt;\s?/.test(line)) {
      closeList();
      out.push(
        `<blockquote>${mdInline(line.replace(/^\s*&gt;\s?/, ""))}</blockquote>`,
      );
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    closeList();
    out.push(`<p>${mdInline(line)}</p>`);
  }
  if (fence)
    out.push(`<pre class="md-code"><code>${fenceBuf.join("\n")}</code></pre>`);
  closeList();
  return out.join("\n");
}

export function mdFragment(markdown) {
  // Our renderer escapes all input before rebuilding markup, so this HTML is
  // console-authored, never agent-authored.
  const tpl = document.createElement("template");
  tpl.innerHTML = renderMarkdown(markdown);
  return tpl.content;
}