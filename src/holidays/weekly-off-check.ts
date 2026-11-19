// Purpose: for a date, which groups of people have it as a weekly off and which work it - the answer behind the Holiday Calendar's
//   "falls on a weekly off" note.
// Important: it uses the same rule as the attendance tracker (a department's own weekly offs, else the organization's default,
//   including alternate days such as the 2nd and 4th Saturday), so the calendar and the tracker cannot disagree.
import { isWeeklyOff, type WeeklyOffEntry } from '../attendance/attendance-shift-config';

export interface OffGroup {
  /** A department's id, or null for people with no department (they follow the organization's default). */
  id: string | null;
  name: string;
  weeklyOffs: WeeklyOffEntry[];
}

export interface GroupRef {
  id: string | null;
  name: string;
}

export interface WeeklyOffDay {
  /** Groups for whom this date is a weekly off, so a holiday on it adds no extra day off. */
  off: GroupRef[];
  /** Groups who would work it, so the holiday gives them an extra day off. */
  working: GroupRef[];
}

export function weeklyOffDay(date: string, groups: OffGroup[]): WeeklyOffDay {
  const out: WeeklyOffDay = { off: [], working: [] };
  for (const g of groups) {
    (isWeeklyOff(date, g.weeklyOffs) ? out.off : out.working).push({ id: g.id, name: g.name });
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_CHECK_DATES = 400;

/** The valid, distinct dates in a comma-separated list. Anything else (a bad date, too many dates) is refused with a plain message. */
export function parseCheckDates(raw: string): string[] {
  const parts = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
  if (parts.length === 0) throw new Error('Give at least one date (YYYY-MM-DD).');
  if (parts.length > MAX_CHECK_DATES) throw new Error(`Check at most ${MAX_CHECK_DATES} dates at a time.`);
  for (const p of parts) {
    const d = new Date(`${p}T00:00:00.000Z`);
    if (!DATE_RE.test(p) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== p) {
      throw new Error(`"${p}" is not a valid date (use YYYY-MM-DD).`);
    }
  }
  return parts;
}
