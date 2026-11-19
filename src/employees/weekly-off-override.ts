// Purpose: a person's own weekly offs (Employee > Attendance), replacing their department's. This checks and normalises what HR sends.
// Shape (the same as Department.weeklyOffs): weekday numbers 0=Sunday..6=Saturday, or { day, occurrences } for a day off only on
// some weeks (the 2nd and 4th Saturday: { day: 6, occurrences: [2, 4] }). An empty list or null clears it (follow the department).
import { BadRequestException } from '@nestjs/common';

export type WeeklyOffOverrideEntry = number | { day: number; occurrences: number[] };

export function normalizeWeeklyOffsOverride(value: unknown): WeeklyOffOverrideEntry[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new BadRequestException('Weekly offs must be a list of days.');
  if (value.length === 0) return null;
  if (value.length > 7) throw new BadRequestException('A week has at most 7 days off.');
  const days = new Set<number>();
  const out: WeeklyOffOverrideEntry[] = [];
  for (const v of value) {
    const day = typeof v === 'number' ? v : (v as { day?: unknown } | null)?.day;
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 0 || day > 6) {
      throw new BadRequestException('Each weekly off must be a day from 0 (Sunday) to 6 (Saturday).');
    }
    if (days.has(day)) throw new BadRequestException('A day is listed more than once.');
    days.add(day);
    if (typeof v === 'number') {
      out.push(day);
      continue;
    }
    const occ = (v as { occurrences?: unknown }).occurrences;
    if (!Array.isArray(occ) || occ.length === 0 || !occ.every((o) => Number.isInteger(o) && o >= 1 && o <= 5)) {
      throw new BadRequestException('Off only on some weeks needs the week numbers (1 to 5), for example the 2nd and 4th.');
    }
    out.push({ day, occurrences: [...new Set(occ as number[])].sort((a, b) => a - b) });
  }
  return out;
}
