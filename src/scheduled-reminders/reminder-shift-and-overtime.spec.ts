import { ApprovalEscalationService } from './approval-escalation.service';
import { CheckInReminderService } from './check-in-reminder.service';

// Any model the code asks for answers "nothing found"; overtime is the one we watch.
function escalationDb(prefs: unknown, overtimeComponents: number) {
  const overtimeFind = jest.fn().mockResolvedValue([]);
  const empty = () => ({ findMany: jest.fn().mockResolvedValue([]) });
  const db: any = new Proxy(
    {
      organization: { findFirst: jest.fn().mockResolvedValue({ orgPayrollAttendancePrefs: prefs }) },
      salaryComponent: { count: jest.fn().mockResolvedValue(overtimeComponents) },
      overtimeRecord: { findMany: overtimeFind },
    },
    { get: (t: any, k: string) => t[k] ?? (t[k] = empty()) },
  );
  return { db, overtimeFind };
}

describe('approval escalation: overtime', () => {
  const pending = (db: unknown) => (new ApprovalEscalationService(db as never, {} as never) as any).pendingRequests('org1');

  it('looks at pending overtime only when the company uses overtime pay', async () => {
    const on = escalationDb({}, 1);
    await pending(on.db);
    expect(on.overtimeFind).toHaveBeenCalledTimes(1);

    const switchedOff = escalationDb({ enableOvertime: false }, 1);
    await pending(switchedOff.db);
    expect(switchedOff.overtimeFind).not.toHaveBeenCalled();

    const noComponent = escalationDb({}, 0);
    await pending(noComponent.db);
    expect(noComponent.overtimeFind).not.toHaveBeenCalled();
  });
});

// A Wednesday, 09:15 UTC: the 15-minute reminder for the default 09:30 shift. The default weekly off is Sunday.
const NOW = new Date('2026-11-25T09:15:00Z');

function reminderRun(employee: Record<string, unknown>) {
  const create = jest.fn().mockResolvedValue({});
  const none = () => ({ findMany: jest.fn().mockResolvedValue([]) });
  const db: any = {
    organization: { findFirst: jest.fn().mockResolvedValue({ timezone: 'UTC', policies: {}, attendancePayrollPrefs: null, orgPayrollAttendancePrefs: {} }) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'u1', gender: null, departmentId: null, department: null, weeklyOffsOverride: null, ...employee }]) },
    shiftRule: none(),
    attendance: none(),
    leave: none(),
    holiday: none(),
    notification: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const svc = new CheckInReminderService(db, { create } as never);
  return { run: () => svc.remindForOrg('org1', NOW), create };
}

describe('check-in reminder: personal weekly offs and flexible shifts', () => {
  it('reminds someone on a normal working day', async () => {
    const r = reminderRun({});
    expect(await r.run()).toBe(1);
  });

  it("does not remind on the person's own weekly off (Wednesday), set by HR on the employee", async () => {
    const r = reminderRun({ weeklyOffsOverride: [3] });
    expect(await r.run()).toBe(0);
    expect(r.create).not.toHaveBeenCalled();
  });

  it('does not remind someone on a flexible shift (no start time)', async () => {
    const r = reminderRun({ department: { id: 'd1', isFlexibleShift: true } });
    expect(await r.run()).toBe(0);
  });
});
