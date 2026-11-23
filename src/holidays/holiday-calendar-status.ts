// Purpose: when to nudge HR/Admin that next year's holiday calendar is still empty or thin, and the numbers behind the nudge.
// Important: holidays are entered by hand each year (floating festivals change date), nothing rolls over by itself, and
//   attendance / leave / payroll treat a missing holiday as a working day. So in the last two months of the holiday year (November and
//   December for a January-December year) we ask for next year's list.
//   Pure functions only; HolidaysService reads the counts.
import { DEFAULT_HOLIDAY_YEAR_START_MONTH, holidayReminderDays, holidayYearOf, inHolidayPrepWindow } from './holiday-year';

export interface CalendarStatus {
  /** The year being prepared (this year + 1). */
  nextYear: number;
  /** Holidays that count for next year / for this year (active, or reference holidays). */
  nextYearCount: number;
  thisYearCount: number;
  /** True in November and December while next year has no holidays, or fewer than this year. */
  due: boolean;
}

/** November and December: the months to prepare the coming year's calendar. */
export const inPrepWindow = (month: number): boolean => month === 11 || month === 12;

/** Thin = none yet, or fewer than this year has (the list is clearly incomplete). */
export const calendarLooksIncomplete = (nextYearCount: number, thisYearCount: number): boolean =>
  nextYearCount === 0 || nextYearCount < thisYearCount;

export function calendarStatus(
  todayYmd: string,
  nextYearCount: number,
  thisYearCount: number,
  startMonth: number = DEFAULT_HOLIDAY_YEAR_START_MONTH,
): CalendarStatus {
  const year = holidayYearOf(todayYmd, startMonth);
  return {
    nextYear: year + 1,
    nextYearCount,
    thisYearCount,
    due: inHolidayPrepWindow(todayYmd, startMonth) && calendarLooksIncomplete(nextYearCount, thisYearCount),
  };
}

/** The days the reminder is sent (MM-DD): the start of each of the last two months of the holiday year, and a last call on the 20th of the final one. */
export const REMINDER_DAYS = ['11-01', '12-01', '12-20'];
export const isReminderDay = (todayYmd: string, startMonth: number = DEFAULT_HOLIDAY_YEAR_START_MONTH): boolean =>
  holidayReminderDays(startMonth).includes(todayYmd.slice(5, 10));
