/** Plain-text tables and key/value blocks for human-readable output. */

export type Cell = string | number | boolean | null | undefined;

export function cell(value: Cell): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  // Keep one row per line whatever the data holds.
  return String(value).replace(/[\r\n\t]+/g, ' ');
}

/** `2026-09-27T10:11:12.345Z` -> `2026-09-27 10:11Z`. */
export function shortTime(iso: string | null | undefined): string {
  if (!iso) return '-';
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}Z`;
}

export function table(headers: string[], rows: Cell[][]): string {
  const cells = rows.map((r) => r.map(cell));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => r[i]!.length)));
  const line = (values: string[]) =>
    values
      .map((v, i) => (i === values.length - 1 ? v : v.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();
  return [line(headers), ...cells.map(line)].join('\n') + '\n';
}

export function keyValues(pairs: Array<[string, Cell]>): string {
  const width = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${`${k}:`.padEnd(width + 1)} ${cell(v)}`).join('\n') + '\n';
}
