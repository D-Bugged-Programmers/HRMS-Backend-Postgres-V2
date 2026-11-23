// Purpose: reading an employee code that someone typed (e.g. in the bulk-import sheet) against an ID format such as 'SIS2-{0000}'.
// Responsibilities: tell whether a code fits a format, and which number it carries (so a series can continue after it).
// Important: a code must fit the format exactly - the same prefix and at least as many digits as the format has; no extra text.

const DATE_TOKEN_RE = /\{(YYYYMM|MONTH_YYYY|MON_YYYY|MONTH|MON|DD_MM_YYYY|MM_YYYY|YYYY|MM|DD|EMPID|EMPNAME|FIRSTNAME)\}/;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The number inside `code` when it fits `format`, or null when it does not.
 * Only the counter token `{000}` carries a number; any other token ({YYYY}, {MM}...) matches any text there.
 */
export function codeNumberFor(format: string | null | undefined, code: string): number | null {
  if (!format || !code) return null;
  const parts = format.split(/(\{[^}]*\})/);
  let pattern = '^';
  let counterSeen = false;
  for (const part of parts) {
    if (!part) continue;
    const digits = /^\{(\d+)\}$/.exec(part);
    if (digits && !counterSeen) {
      pattern += `(\\d{${digits[1].length},})`;
      counterSeen = true;
    } else if (DATE_TOKEN_RE.test(part) || /^\{[^}]*\}$/.test(part)) {
      pattern += '.+?';
    } else {
      pattern += escapeRe(part);
    }
  }
  pattern += '$';
  const m = new RegExp(pattern).exec(code);
  if (!m) return null;
  const n = counterSeen ? parseInt(m[1], 10) : 0;
  return Number.isFinite(n) ? n : null;
}

export const codeFitsFormat = (format: string | null | undefined, code: string): boolean => codeNumberFor(format, code) !== null;
