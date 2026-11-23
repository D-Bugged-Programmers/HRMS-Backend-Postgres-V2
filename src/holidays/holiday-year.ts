// Purpose: the company's holiday year - the twelve months its holiday calendar is grouped into (January-December by default,
//   or e.g. April-March) - and the date maths every place that groups holidays by year shares.
// Responsibilities: which holiday year a date belongs to, the first and last day of a holiday year, its label, and the months in which
//   the next year's calendar should be prepared. Pure functions only; HolidaysService reads the setting.
// Important: a holiday year is named by the calendar year it STARTS in, so with April as the start month "2026" is 1 Apr 2026 - 31 Mar 2027
//   (labelled 2026-27). With January it is the plain calendar year, exactly as before. Holidays keep their own date; only the grouping moves.

export const DEFAULT_HOLIDAY_YEAR_START_MONTH = 1;

/** The value stored in the setting when the holiday year is linked to the financial year ("Same as financial year"). */
export const HOLIDAY_YEAR_SAME_AS_FINANCIAL = 'FY';

/** True when the holiday year is linked to the financial year, so it starts in whatever month that does. */
export function holidayYearFollowsFinancialYear(policies: unknown): boolean {
  return (policies as { holidayYearStartMonth?: unknown } | null | undefined)?.holidayYearStartMonth === HOLIDAY_YEAR_SAME_AS_FINANCIAL;
}

/** The company's financial year start month (1-12) from its policies; April when unset, like the rest of the app. */
export function readFinancialYearStartMonth(policies: unknown): number {
  const n = Number((policies as { financialYearStartMonth?: unknown } | null | undefined)?.financialYearStartMonth);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : 4;
}

/** The start month from stored policies (1-12): the chosen month, or the financial year's when linked to it; anything else reads as January. */
export function readHolidayYearStartMonth(policies: unknown): number {
  if (holidayYearFollowsFinancialYear(policies)) return readFinancialYearStartMonth(policies);
  const raw = (policies as { holidayYearStartMonth?: unknown } | null | undefined)?.holidayYearStartMonth;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : DEFAULT_HOLIDAY_YEAR_START_MONTH;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The holiday year a YYYY-MM-DD date falls in. */
export function holidayYearOf(ymd: string, startMonth: number): number {
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(5, 7));
  return month >= startMonth ? year : year - 1;
}

/** First and last day (YYYY-MM-DD, inclusive) of a holiday year. */
export function holidayYearRange(year: number, startMonth: number): { from: string; to: string } {
  const from = `${year}-${pad(startMonth)}-01`;
  if (startMonth === 1) return { from, to: `${year}-12-31` };
  // The day before the next holiday year starts: day 0 of the start month in the following calendar year.
  const lastDay = new Date(Date.UTC(year + 1, startMonth - 1, 0));
  return { from, to: lastDay.toISOString().slice(0, 10) };
}

/** "2026" for a calendar-year company, "2026-27" for one whose year runs across two calendar years. */
export function holidayYearLabel(year: number, startMonth: number): string {
  return startMonth === 1 ? String(year) : `${year}-${String(year + 1).slice(2)}`;
}

/** Months into the holiday year (0 = its first month) that a date is in. */
export const monthsIntoHolidayYear = (ymd: string, startMonth: number): number => (Number(ymd.slice(5, 7)) - startMonth + 12) % 12;

/** The last two months of the holiday year: when the next year's calendar should be prepared (November and December for January). */
export const inHolidayPrepWindow = (ymd: string, startMonth: number): boolean => monthsIntoHolidayYear(ymd, startMonth) >= 10;

/** The same day and month in another year, or null when it does not exist there (29 February). */
export function sameDayInYear(ymd: string, year: number): string | null {
  const date = `${year}${ymd.slice(4)}`;
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date ? null : date;
}

/** Month/day (MM-DD) of the reminder days: the start of each of the last two months, and a last call on the 20th of the final month. */
export function holidayReminderDays(startMonth: number): string[] {
  const secondLast = ((startMonth + 9) % 12) + 1;
  const last = ((startMonth + 10) % 12) + 1;
  return [`${pad(secondLast)}-01`, `${pad(last)}-01`, `${pad(last)}-20`];
}
