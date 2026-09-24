/**
 * The first `end` UTF-16 code units of `text`, one fewer when the cut would split a surrogate
 * pair: a lone high surrogate is not valid Unicode, and the API rejects or mangles it.
 */
export function sliceWhole(text: string, end: number): string {
  if (end <= 0) return '';
  if (end >= text.length) return text;
  const last = text.charCodeAt(end - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, end - 1) : text.slice(0, end);
}
