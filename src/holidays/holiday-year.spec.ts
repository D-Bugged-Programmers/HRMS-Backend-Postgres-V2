import {
  holidayReminderDays,
  holidayYearLabel,
  holidayYearOf,
  holidayYearRange,
  inHolidayPrepWindow,
  readHolidayYearStartMonth,
  sameDayInYear,
} from './holiday-year';
import { calendarStatus } from './holiday-calendar-status';

describe('holiday year', () => {
  it('is the calendar year when it starts in January (nothing changes by default)', () => {
    expect(readHolidayYearStartMonth(undefined)).toBe(1);
    expect(readHolidayYearStartMonth({ holidayYearStartMonth: 'x' })).toBe(1);
    expect(holidayYearOf('2026-12-31', 1)).toBe(2026);
    expect(holidayYearRange(2026, 1)).toEqual({ from: '2026-01-01', to: '2026-12-31' });
    expect(holidayYearLabel(2026, 1)).toBe('2026');
  });
  it('runs April to March when it starts in April', () => {
    expect(readHolidayYearStartMonth({ holidayYearStartMonth: 4 })).toBe(4);
    expect(holidayYearOf('2026-04-01', 4)).toBe(2026);
    expect(holidayYearOf('2027-03-31', 4)).toBe(2026);
    expect(holidayYearOf('2027-04-01', 4)).toBe(2027);
    expect(holidayYearOf('2026-01-26', 4)).toBe(2025);
    expect(holidayYearRange(2026, 4)).toEqual({ from: '2026-04-01', to: '2027-03-31' });
    expect(holidayYearLabel(2026, 4)).toBe('2026-27');
  });
  it('handles a December start (ends in November) and a leap-year end', () => {
    expect(holidayYearRange(2026, 12)).toEqual({ from: '2026-12-01', to: '2027-11-30' });
    expect(holidayYearRange(2027, 3)).toEqual({ from: '2027-03-01', to: '2028-02-29' });
  });
  it('asks for next year in the last two months of the holiday year', () => {
    expect(inHolidayPrepWindow('2026-11-05', 1)).toBe(true);
    expect(inHolidayPrepWindow('2026-10-31', 1)).toBe(false);
    expect(inHolidayPrepWindow('2027-02-10', 4)).toBe(true);
    expect(inHolidayPrepWindow('2026-11-05', 4)).toBe(false);
    expect(holidayReminderDays(1)).toEqual(['11-01', '12-01', '12-20']);
    expect(holidayReminderDays(4)).toEqual(['02-01', '03-01', '03-20']);
  });
  it('builds the status for an April year', () => {
    expect(calendarStatus('2027-02-10', 3, 12, 4)).toMatchObject({ nextYear: 2027, due: true });
    expect(calendarStatus('2026-11-10', 3, 12, 4).due).toBe(false);
    expect(calendarStatus('2026-11-10', 3, 12)).toMatchObject({ nextYear: 2027, due: true });
  });
  it('copies a day into another year, refusing 29 February where it does not exist', () => {
    expect(sameDayInYear('2026-10-02', 2027)).toBe('2027-10-02');
    expect(sameDayInYear('2028-02-29', 2029)).toBeNull();
  });
});
