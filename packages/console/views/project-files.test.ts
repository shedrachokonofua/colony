// Unit tests for <project-files>, under happy-dom: the file list, the upload
// form, and the two-step delete / inline replace flows — every one of them
// emitting the colony-file-* event the shell's handleEvent routes.
// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { sharedDom } from "../elements/test-dom.js";

sharedDom();

await import("./project-files.js");

const PROJECT = { name: "Operator console" };

function file(id, overrides = {}) {
  return {
    id,
    filename: `${id}.md`,
    media_type: "text/markdown",
    byte_size: 12,
    ...overrides,
  };
}

function pageOf(overrides = {}) {
  return {
    name: PROJECT.name,
    project: PROJECT,
    files: [file("f1"), file("f2")],
    total: 2,
    offset: 0,
    page: 1,
    ...overrides,
  };
}

function makeFiles(page = pageOf(), props = {}) {
  const el = document.createElement("project-files");
  el.filesPage = page;
  for (const [key, value] of Object.entries(props)) el[key] = value;
  document.body.append(el);
  return el;
}

function eventsOf(el) {
  const seen = [];
  for (const type of [
    "colony-file-confirm",
    "colony-file-replace-toggle",
    "colony-file-replace",
    "colony-file-delete",
    "colony-file-upload",
    "colony-navigate",
    "colony-page",
  ]) {
    el.addEventListener(type, (event) => seen.push([type, event.detail]));
  }
  return seen;
}

/** Buttons within one file row; rows carry their own confirm state. */
function rowButtons(el, fileId) {
  const row = [...el.querySelectorAll(".file-row")].find((r) =>
    r.querySelector(".file-row-name")?.textContent.startsWith(fileId),
  );
  return [...row.querySelectorAll("button")];
}

function rowButton(el, fileId, label) {
  return rowButtons(el, fileId).find((b) => b.textContent.trim() === label);
}

function submit(form) {
  form.dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true }),
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("project-files structure", () => {
  it("renders the head, one row per file, and the upload form", async () => {
    const el = makeFiles();
    await el.updateComplete;
    expect(el.querySelector(".board-title")?.textContent).toBe(
      "Operator console · files",
    );
    const rows = el.querySelectorAll(".file-row");
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector(".file-row-name")?.textContent).toBe("f1.md");
    expect(rows[0].querySelector(".file-row-meta")?.textContent).toContain(
      "text/markdown · 12 bytes",
    );
    const back = el.querySelector(".board-head a.btn-quiet");
    expect(back?.getAttribute("href")).toBe("#/project/Operator%20console");
    expect(el.querySelector("aside.card .card-head")?.textContent).toContain(
      "Add a file",
    );
    expect(el.querySelector('input[name="filename"]')).toBeTruthy();
  });

  it("shows the not-found state and the empty state", async () => {
    const ghost = makeFiles({ name: "Ghost", project: null, files: [] });
    await ghost.updateComplete;
    expect(ghost.querySelector(".board-title")).toBeNull();
    expect(ghost.querySelector(".rack-empty")?.textContent).toContain(
      "No project named",
    );

    const empty = makeFiles(pageOf({ files: [], total: 0 }));
    await empty.updateComplete;
    expect(empty.querySelector(".file-row")).toBeNull();
    expect(empty.querySelector(".project-files .rack-empty")?.textContent).toBe(
      "No reference files yet.",
    );
  });

  it("renders nothing before a page arrives", async () => {
    const el = makeFiles(null);
    await el.updateComplete;
    expect(el.querySelector(".project-page")).toBeNull();
  });
});

describe("project-files delete flow", () => {
  it("Delete arms the confirm, Confirm delete then emits colony-file-delete", async () => {
    const el = makeFiles();
    const seen = eventsOf(el);
    await el.updateComplete;
    rowButton(el, "f1", "Delete").click();
    expect(seen).toEqual([["colony-file-confirm", { fileId: "f1" }]]);

    // The shell echoes the armed id back down; only that row swaps to the
    // executing button, and only that button actually deletes.
    el.confirmFile = "f1";
    await el.updateComplete;
    seen.length = 0;
    expect(rowButton(el, "f1", "Delete")).toBeUndefined();
    // Its neighbour is untouched: arming one row must not arm every row.
    expect(rowButton(el, "f2", "Delete")).toBeTruthy();
    expect(rowButton(el, "f2", "Confirm delete")).toBeUndefined();
    rowButton(el, "f1", "Confirm delete").click();
    expect(seen).toEqual([["colony-file-delete", { fileId: "f1" }]]);
  });
});

describe("project-files replace flow", () => {
  it("Replace toggles the inline form and submitting it emits the payload", async () => {
    const el = makeFiles();
    const seen = eventsOf(el);
    await el.updateComplete;
    expect(el.querySelector("form.composer .file-row")).toBeNull();
    rowButton(el, "f1", "Replace").click();
    expect(seen).toEqual([["colony-file-replace-toggle", { fileId: "f1" }]]);

    el.replaceFileId = "f1";
    await el.updateComplete;
    seen.length = 0;
    const form = el.querySelector(".file-row form.composer");
    expect(form).toBeTruthy();
    expect(rowButton(el, "f1", "Cancel replace")).toBeTruthy();
    // The replace form preselects the file's own media type.
    expect(form.querySelector('select[name="media_type"]')?.value).toBe(
      "text/markdown",
    );
    form.querySelector('textarea[name="content"]').value = "new content";
    submit(form);
    expect(seen).toEqual([
      [
        "colony-file-replace",
        { fileId: "f1", media_type: "text/markdown", content: "new content" },
      ],
    ]);
  });

  it("a text/plain file preselects text/plain", async () => {
    const el = makeFiles(
      pageOf({ files: [file("f1", { media_type: "text/plain" })] }),
      { replaceFileId: "f1" },
    );
    await el.updateComplete;
    expect(
      el.querySelector('.file-row select[name="media_type"]')?.value,
    ).toBe("text/plain");
  });
});

describe("project-files upload", () => {
  it("submitting the upload form emits colony-file-upload with its fields", async () => {
    const el = makeFiles();
    const seen = eventsOf(el);
    await el.updateComplete;
    const form = el.querySelector("aside.card form.composer");
    form.querySelector('input[name="filename"]').value = "AGENTS.md";
    form.querySelector('select[name="media_type"]').value = "text/markdown";
    form.querySelector('textarea[name="content"]').value = "body";
    submit(form);
    expect(seen).toEqual([
      [
        "colony-file-upload",
        {
          filename: "AGENTS.md",
          media_type: "text/markdown",
          content: "body",
        },
      ],
    ]);
  });

  it("the upload form's filename is required and capped at 255 chars", async () => {
    const el = makeFiles();
    await el.updateComplete;
    const input = el.querySelector('input[name="filename"]');
    expect(input.required).toBe(true);
    expect(input.getAttribute("maxlength")).toBe("255");
    expect(input.getAttribute("placeholder")).toBe("AGENTS.md");
  });
});

describe("project-files navigation", () => {
  it("Back to project bubbles colony-navigate", async () => {
    const el = makeFiles();
    const seen = eventsOf(el);
    await el.updateComplete;
    el.querySelector(".board-head a.btn-quiet").click();
    expect(seen).toEqual([
      ["colony-navigate", { href: "#/project/Operator%20console" }],
    ]);
  });

  it("paginates with colony-page on the files surface", async () => {
    const el = makeFiles(pageOf({ total: 100, page: 3 }));
    const seen = eventsOf(el);
    await el.updateComplete;
    const links = [...el.querySelectorAll(".pager a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      "#/project/Operator%20console/files?page=2",
      "#/project/Operator%20console/files?page=4",
    ]);
    links[0].click();
    links[1].click();
    expect(seen).toEqual([
      ["colony-page", { page: 2, surface: "files" }],
      ["colony-page", { page: 4, surface: "files" }],
    ]);
  });

  it("offers the past-the-last-page escape back to page 1", async () => {
    const el = makeFiles(pageOf({ files: [], total: 40, page: 3 }));
    await el.updateComplete;
    const empty = el.querySelector(".project-files .rack-empty");
    expect(empty?.textContent).toContain("Past the last page.");
    expect(empty?.querySelector("a")?.getAttribute("href")).toBe(
      "#/project/Operator%20console/files",
    );
  });
});
