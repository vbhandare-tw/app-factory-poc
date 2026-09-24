/** The pure part of render.js, plus applyKeeping (tested over a fake DOM); setHtml, patch, append, prepend are browser-only. */
export class SafeHtml {
  private constructor();
  readonly html: string;
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml;
export function markdown(source: string | null | undefined): SafeHtml;

export interface FieldLike {
  tagName: string;
  type?: string;
  dataset?: { keep?: string };
  value?: string;
  defaultValue?: string;
  checked?: boolean;
  defaultChecked?: boolean;
  options?: Iterable<{ selected: boolean; defaultSelected: boolean }>;
}

export function isDirty(el: FieldLike): boolean;
export function shouldReplace(el: FieldLike, active: unknown): boolean;
export function applyKeeping(target: unknown, fragment: unknown, active: unknown): boolean;
