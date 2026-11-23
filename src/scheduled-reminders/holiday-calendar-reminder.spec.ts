import { Role } from '@prisma/client';
import { HolidayCalendarReminderService } from './holiday-calendar-reminder.service';

// Fakes: holidays per year, and a notifier that records who was told what.
function build(counts: Record<number, number>, policies: unknown = {}) {
  const sent: { to: string; title: string; vars: Record<string, string> }[] = [];
  // The service counts by date range (the holiday year may span two calendar years): the year is read off the range's first day.
  const prisma = {
    organization: { findFirst: async () => ({ policies }) },
    holiday: { count: async ({ where }: { where: { date: { gte: string } } }) => counts[Number(where.date.gte.slice(0, 4))] ?? 0 },
  };
  const notifier = {
    activeUsers: async () => [
      { id: 'a', name: 'Admin', email: 'a@x.test', role: Role.ADMIN, reportingManagerId: null, notificationPreferences: null },
      { id: 'h', name: 'HR', email: 'h@x.test', role: Role.HR, reportingManagerId: null, notificationPreferences: null },
      { id: 'e', name: 'Emp', email: 'e@x.test', role: Role.EMPLOYEE, reportingManagerId: null, notificationPreferences: null },
    ],
    send: async (i: { user: { id: string }; title: string; variables: Record<string, string> }) => {
      sent.push({ to: i.user.id, title: i.title, vars: i.variables });
      return true;
    },
  };
  return { svc: new HolidayCalendarReminderService(prisma as never, notifier as never), sent };
}

describe('HolidayCalendarReminderService', () => {
  it('asks HR and Admin (not employees) on 1 November when next year has fewer holidays than this year', async () => {
    const { svc, sent } = build({ 2026: 12, 2027: 4 });
    expect(await svc.remindForOrg('org', '2026-11-01')).toBe(2);
    expect(sent.map((s) => s.to).sort()).toEqual(['a', 'h']);
    expect(sent[0].title).toBe("Add 2027's holidays: 4 so far");
    expect(sent[0].vars).toMatchObject({ nextYear: '2027', holidayCount: '4' });
  });
  it('asks when next year is empty', async () => {
    const { svc } = build({ 2026: 0, 2027: 0 });
    expect(await svc.remindForOrg('org', '2026-12-01')).toBe(2);
  });
  it('stays quiet when the calendar is complete, outside the window, or on a non-reminder day', async () => {
    expect(await build({ 2026: 12, 2027: 12 }).svc.remindForOrg('org', '2026-11-01')).toBe(0);
    expect(await build({ 2026: 12, 2027: 0 }).svc.remindForOrg('org', '2026-10-01')).toBe(0);
    expect(await build({ 2026: 12, 2027: 0 }).svc.remindForOrg('org', '2026-11-02')).toBe(0);
  });
  it('follows an April-March holiday year: asks in February and March, not November', async () => {
    const april = { holidayYearStartMonth: 4 };
    // 1 Feb 2027 is in the 2026 holiday year (Apr 2026 - Mar 2027); next year is 2027.
    const { svc, sent } = build({ 2026: 12, 2027: 4 }, april);
    expect(await svc.remindForOrg('org', '2027-02-01')).toBe(2);
    expect(sent[0].title).toBe("Add 2027-28's holidays: 4 so far");
    expect(await build({ 2026: 12, 2027: 4 }, april).svc.remindForOrg('org', '2026-11-01')).toBe(0);
  });
});
