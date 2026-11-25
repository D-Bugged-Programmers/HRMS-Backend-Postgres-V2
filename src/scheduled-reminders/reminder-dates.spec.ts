// Purpose: Unit tests for the pure rules behind the scheduled reminder jobs.
import {
  isResignationReminderDue,
  dateOf,
  daysBetween,
  isEscalationDue,
  isProbationEndOrOverdueReminderDay,
  isTaxDeclarationReminderDay,
  leaveExpiryDaysLeft,
  monthLabel,
  taxDeclarationWindow,
  upcomingStatutoryDues,
  weekdayOf,
} from './reminder-dates';
import { escalationThresholdDays } from './approval-escalation.service';

describe('daysBetween / dateOf / monthLabel', () => {
  it('counts whole calendar days, across month and year ends', () => {
    expect(daysBetween('2026-11-10', '2026-11-17')).toBe(7);
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(3);
    expect(daysBetween('2026-11-10', '2026-11-08')).toBe(-2);
  });
  it('clamps the day to the month length and normalises month overflow', () => {
    expect(dateOf(2026, 2, 31)).toBe('2026-02-28');
    expect(dateOf(2026, 13, 15)).toBe('2027-01-15');
    expect(dateOf(2026, 0, 5)).toBe('2025-12-05');
  });
  it('labels a month', () => {
    expect(monthLabel('2026-10-05')).toBe('October 2026');
  });
});

describe('isEscalationDue', () => {
  it('fires at the threshold and every multiple of it, never before', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map((d) => isEscalationDue(d, 3))).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      true,
      true,
    ]);
  });
  it('is off when the threshold is 0', () => {
    expect(isEscalationDue(3, 0)).toBe(false);
  });
});

describe('escalationThresholdDays', () => {
  it('defaults to 3, accepts 0 (off) and ignores junk', () => {
    expect(escalationThresholdDays({})).toBe(3);
    expect(escalationThresholdDays({ APPROVAL_ESCALATION_DAYS: '5' })).toBe(5);
    expect(escalationThresholdDays({ APPROVAL_ESCALATION_DAYS: '0' })).toBe(0);
    expect(escalationThresholdDays({ APPROVAL_ESCALATION_DAYS: 'x' })).toBe(3);
  });
});

describe('upcomingStatutoryDues', () => {
  const none = new Set<string>();
  const all = new Set(['PF', 'ESI', 'PT', 'LWF']);
  const keys = (today: string, mods: Set<string>) =>
    upcomingStatutoryDues(today, mods).map(
      (d) => `${d.key}@${d.dueDate}/${d.daysLeft}`,
    );

  it('reminds PF and ESI 5 days and 1 day before the 15th, only when enabled', () => {
    expect(keys('2026-11-10', all)).toEqual(
      expect.arrayContaining(['PF@2026-11-15/5', 'ESI@2026-11-15/5']),
    );
    expect(keys('2026-11-14', all)).toEqual(
      expect.arrayContaining(['PF@2026-11-15/1', 'ESI@2026-11-15/1']),
    );
    expect(keys('2026-11-10', none).some((k) => k.startsWith('PF'))).toBe(
      false,
    );
  });
  it('always reminds the salary TDS deposit (7th) regardless of enabled modules', () => {
    expect(keys('2026-11-02', none)).toContain('TDS@2026-11-07/5');
  });
  it('reminds the quarterly 24Q return', () => {
    expect(keys('2026-07-26', none)).toContain('24Q@2026-07-31/5');
    expect(keys('2027-01-30', none)).toContain('24Q@2027-01-31/1');
  });
  it('names the quarterly TDS return Form 138 from 1-Apr-2026 and Form 24Q before', () => {
    const label = (today: string, due: string) =>
      upcomingStatutoryDues(today, none, [5, 1]).find((d) => d.key === '24Q' && d.dueDate === due)?.label;
    expect(label('2026-07-26', '2026-07-31')).toBe('TDS return (Form 138)'); // April-June 2026
    expect(label('2026-10-26', '2026-10-31')).toBe('TDS return (Form 138)');
    expect(label('2027-01-26', '2027-01-31')).toBe('TDS return (Form 138)'); // October-December 2026
    expect(label('2026-05-26', '2026-05-31')).toBe('TDS return (Form 24Q)'); // January-March 2026, still FY 2025-26
    expect(label('2026-01-26', '2026-01-31')).toBe('TDS return (Form 24Q)'); // October-December 2025
  });
  it("March's TDS deposit is due on 30 April, not 7 April; other months on the 7th", () => {
    const tds = (today: string) => upcomingStatutoryDues(today, none, [-30, -20, -10, 0, 5, 1, 10, 20]).filter((d) => d.key === 'TDS');
    expect(tds('2026-04-10').map((d) => d.dueDate)).not.toContain('2026-04-07'); // not the 7th for March
    expect(tds('2026-04-10').map((d) => d.dueDate)).toContain('2026-04-30');
    const march = upcomingStatutoryDues('2026-04-25', none, [5]).find((d) => d.key === 'TDS' && d.dueDate === '2026-04-30');
    expect(march?.period).toBe('March 2026');
    expect(march?.months).toEqual(['2026-03']);
    expect(upcomingStatutoryDues('2026-05-02', none, [5]).find((d) => d.key === 'TDS')?.dueDate).toBe('2026-05-07'); // April's tax
  });
  it('reminds Maharashtra LWF for the half-years (15 Jul and 15 Jan), only when enabled', () => {
    expect(keys('2026-07-10', all)).toContain('LWF@2026-07-15/5');
    expect(keys('2027-01-10', all)).toContain('LWF@2027-01-15/5');
    expect(keys('2026-07-10', none).some((k) => k.startsWith('LWF'))).toBe(
      false,
    );
  });
  it('puts PT on the last day of the following month, even across a year end', () => {
    expect(keys('2026-11-25', all)).toContain('PT@2026-11-30/5');
    expect(keys('2027-01-26', all)).toContain('PT@2027-01-31/5');
  });
  it('returns nothing on an ordinary day', () => {
    expect(keys('2026-11-20', none)).toEqual([]);
  });
});

describe('leaveExpiryDaysLeft', () => {
  it('is due exactly 30 days before, then only on Mondays, never after the lapse date', () => {
    expect(weekdayOf('2026-12-07')).toBe(1); // Monday
    expect(leaveExpiryDaysLeft('2026-12-01', '2026-12-31')).toBe(30); // 30 days out (a Tuesday)
    expect(leaveExpiryDaysLeft('2026-12-02', '2026-12-31')).toBeNull(); // Wednesday
    expect(leaveExpiryDaysLeft('2026-12-07', '2026-12-31')).toBe(24); // Monday
    expect(leaveExpiryDaysLeft('2026-11-30', '2026-12-31')).toBeNull(); // 31 days out
    expect(leaveExpiryDaysLeft('2027-01-04', '2026-12-31')).toBeNull(); // already lapsed
  });
});

describe('taxDeclarationWindow', () => {
  it('opens on the first day of the financial year and closes on 31 January for an April start', () => {
    const w = taxDeclarationWindow('2026-06-15', 4);
    expect(w).toEqual({
      financialYear: '2026-27',
      opens: '2026-04-01',
      deadline: '2027-01-31',
    });
    // January still belongs to the previous financial year.
    expect(taxDeclarationWindow('2027-01-10', 4).financialYear).toBe('2026-27');
  });
  it('reminds on the opening day and every 7 days until the deadline, not after', () => {
    const w = taxDeclarationWindow('2026-06-15', 4);
    expect(isTaxDeclarationReminderDay('2026-04-01', w)).toBe(true);
    expect(isTaxDeclarationReminderDay('2026-04-05', w)).toBe(false);
    expect(isTaxDeclarationReminderDay('2026-04-08', w)).toBe(true);
    expect(isTaxDeclarationReminderDay('2026-03-25', w)).toBe(false); // before it opens
    expect(isTaxDeclarationReminderDay('2027-02-04', w)).toBe(false); // after the deadline
  });
  it('respects a non-April financial-year start', () => {
    expect(taxDeclarationWindow('2026-02-10', 1).opens).toBe('2026-01-01');
    expect(taxDeclarationWindow('2026-02-10', 1).deadline).toBe('2026-10-31');
  });
});

describe('isProbationEndOrOverdueReminderDay', () => {
  it('fires on the end date, then the day after and every 7 days from there', () => {
    expect(isProbationEndOrOverdueReminderDay(0)).toBe(true);
    expect(isProbationEndOrOverdueReminderDay(-1)).toBe(true);
    expect(isProbationEndOrOverdueReminderDay(-8)).toBe(true);
    expect(isProbationEndOrOverdueReminderDay(-15)).toBe(true);
  });
  it('stays quiet on the other days', () => {
    for (const d of [15, 7, 1, -2, -7, -9]) expect(isProbationEndOrOverdueReminderDay(d)).toBe(false);
  });
});

describe('isResignationReminderDue', () => {
  it('from day 2, then every 2 days', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 8].map(isResignationReminderDue)).toEqual([false, false, true, false, true, false, true, true]);
  });
});
