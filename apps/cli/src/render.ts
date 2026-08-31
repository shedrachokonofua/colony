/** Pure table rendering and ANSI color helpers. Nothing here writes out. */

export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, col) =>
    Math.max(header.length, ...rows.map((row) => cell(row, col).length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((text, col) => text.padEnd(widths[col]))
      .join("  ")
      .trimEnd();
  return [
    line(headers),
    ...rows.map((row) => line(headers.map((_, col) => cell(row, col)))),
  ].join("\n");
}

export function ansi(enabled: boolean, code: number, s: string): string {
  return enabled ? `\u001b[${code}m${s}\u001b[0m` : s;
}

export function colorEnabled(
  isTty: boolean,
  noColor: boolean | undefined,
): boolean {
  if (noColor === true) return false;
  return isTty;
}

function cell(row: string[], col: number): string {
  return row[col] ?? "";
}
