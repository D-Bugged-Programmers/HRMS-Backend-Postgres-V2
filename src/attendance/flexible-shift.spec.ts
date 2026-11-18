import { AttendanceService } from './attendance.service';

// A flexible shift has no start or end: the hours worked decide Present / Half Day, and nobody is late or early-out.
const service = Object.create(AttendanceService.prototype) as unknown as {
  deriveDayOutcome(
    db: unknown,
    params: Record<string, unknown>,
  ): Promise<{
    status: string;
    workDurationMinutes: number;
    isLate: boolean;
    isEarlyOut: boolean;
  }>;
};

const flex = {
  shiftStartTime: '00:00',
  shiftEndTime: '23:59',
  lateInThresholdMinutes: 15,
  earlyOutThresholdMinutes: 15,
  minHoursForPresent: 8,
  minHoursForHalfDay: 4,
  breakMinutes: 0,
  weeklyOffs: [0],
  crossesMidnight: false,
  flexible: true,
  timezone: 'Asia/Kolkata',
};
const db = {
  holiday: { findFirst: async () => null },
  leave: { findFirst: async () => null },
};
const derive = (
  shiftConfig: Record<string, unknown>,
  inIso: string,
  outIso: string,
) =>
  service.deriveDayOutcome(db, {
    organizationId: 'org',
    employeeId: 'e1',
    employeeDepartmentId: null,
    shiftConfig,
    holiday: null,
    approvedLeave: null,
    dateStr: '2026-10-13', // a Tuesday
    inTime: new Date(inIso),
    outTime: new Date(outIso),
  });

afterEach(() => jest.useRealTimers());

describe('flexible shift', () => {
  it('is Present for a full day worked at any hour, and never late or early-out', async () => {
    // 14:00-22:30 IST: a late start for a 09:00 shift, but flexible has no start.
    const r = await derive(
      flex,
      '2026-10-13T08:30:00Z',
      '2026-10-13T17:00:00Z',
    );
    expect(r.status).toBe('PRESENT');
    expect(r.isLate).toBe(false);
    expect(r.isEarlyOut).toBe(false);
  });

  it('is a Half Day at the half-day hours', async () => {
    const r = await derive(
      flex,
      '2026-10-13T04:30:00Z',
      '2026-10-13T09:00:00Z',
    ); // 4.5h
    expect(r.status).toBe('HALF_DAY');
  });

  it('is Absent below the half-day hours', async () => {
    const r = await derive(
      flex,
      '2026-10-13T04:30:00Z',
      '2026-10-13T06:30:00Z',
    ); // 2h
    expect(r.status).toBe('ABSENT');
  });

  it('the same punches under a fixed shift ARE late', async () => {
    const fixed = {
      ...flex,
      flexible: false,
      shiftStartTime: '09:00',
      shiftEndTime: '18:00',
    };
    const r = await derive(
      fixed,
      '2026-10-13T08:30:00Z',
      '2026-10-13T17:00:00Z',
    );
    expect(r.isLate).toBe(true);
  });
});

describe('flexible shift with an allowed window', () => {
  const windowed = { ...flex, shiftStartTime: '07:00', shiftEndTime: '19:00' };
  it('counts only the time inside the window', async () => {
    // 05:00-14:00 IST = 9h on the clock, but only 07:00-14:00 = 7h inside the window -> Half Day, not Present.
    const r = await derive(
      windowed,
      '2026-10-12T23:30:00Z',
      '2026-10-13T08:30:00Z',
    );
    expect(r.workDurationMinutes).toBe(420);
    expect(r.status).toBe('HALF_DAY');
  });
  it('is Present when a full day falls inside the window', async () => {
    const r = await derive(
      windowed,
      '2026-10-13T03:30:00Z',
      '2026-10-13T12:00:00Z',
    ); // 09:00-17:30 IST
    expect(r.status).toBe('PRESENT');
    expect(r.isLate).toBe(false);
  });
});
