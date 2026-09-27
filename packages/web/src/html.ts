/**
 * A tiny HTML templating helper. `html` is a tagged template that escapes every
 * interpolated value unless it is itself an `Html` fragment, so user input can
 * only ever end up in a page as text. Attribute values must always be quoted
 * ("..."); quotes are escaped too.
 */
export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export type Interpolation = Html | string | number | boolean | null | undefined | readonly Interpolation[];

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"'`]/g, (c) => ESCAPES[c]!);
}

function render(value: Interpolation): string {
  if (value instanceof Html) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escapeHtml(String(value));
}

export function html(strings: TemplateStringsArray, ...values: Interpolation[]): Html {
  let out = strings[0]!;
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1]!;
  return new Html(out);
}
