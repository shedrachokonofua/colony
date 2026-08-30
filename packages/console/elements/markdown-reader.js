// <markdown-reader>: light-DOM markdown pane. The markdown renders once per
// change via renderMarkdown (../markdown.js) straight into the host, so the
// wrapper keeps the monolith's .md typography hooks.
import { ColonyElement, html } from "../base.js";
import { renderMarkdown } from "../markdown.js";

export class MarkdownReader extends ColonyElement {
  static properties = {
    markdown: { type: String },
  };

  constructor() {
    super();
    this.markdown = "";
  }

  updated(changed) {
    super.updated(changed);
    // Render only on an actual markdown change: a poll that re-sends the
    // same text must not touch the DOM, or text selection would be lost.
    if (changed.has("markdown")) {
      this.innerHTML = renderMarkdown(this.markdown ?? "");
    }
  }
}

customElements.define("markdown-reader", MarkdownReader);
