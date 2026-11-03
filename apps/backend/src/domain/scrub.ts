/**
 * Free text from Hermes (agent summaries, errors, event payloads) can contain absolute host paths such as the task
 * workspace or the attachment store. Those must never reach a client. Absolute paths are reduced to
 * `<path>/<basename>`; URLs and relative paths are left alone.
 */
const ABS_PATH = /(?<![\w:/.~-])(?:\/(?:[\w.@+~-]+)){2,}\/?|(?<![\w:/.~-])~\/(?:[\w.@+~-]+\/?)+|(?<![\w])[A-Za-z]:\\(?:[^\\\s"'<>|]+\\?)+/g;

export function scrubPaths(text: string): string {
  return text.replace(ABS_PATH, (m) => {
    const parts = m.split(/[\\/]/).filter(Boolean);
    const last = parts[parts.length - 1] ?? '';
    return last ? `<path>/${last}` : '<path>';
  });
}

export function scrub(text: string | null | undefined, max = 4000): string | null {
  if (text == null || text === '') return null;
  const s = scrubPaths(text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** A safe download file name: no directories, no control characters, no quotes. */
export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').replace(/^\.+/, '').trim();
  return cleaned.slice(0, 200) || 'download';
}
