import { pickShiftRule } from './shift-rules';

// A shift rule made inside a work schedule follows that schedule's departments, and does nothing while it has none.
const rule = (over: Record<string, unknown> = {}) => ({
  gender: 'FEMALE' as const,
  startTime: '10:00',
  endTime: '18:00',
  breakMinutes: null,
  departmentIds: [] as string[],
  isActive: true,
  ...over,
});

describe('schedule-owned shift rules', () => {
  const person = { id: 'p1', gender: 'FEMALE' as const, departmentId: 'd1' };
  it('applies to the departments the schedule is assigned to', () => {
    const owned = rule({ workScheduleId: 's1', departmentIds: ['d1'] });
    expect(pickShiftRule([owned], person)).toBe(owned);
    expect(
      pickShiftRule([owned], { ...person, departmentId: 'd2' }),
    ).toBeNull();
  });
  it('is ignored while the schedule has no department (never "every department")', () => {
    const owned = rule({ workScheduleId: 's1', departmentIds: [] });
    expect(pickShiftRule([owned], person)).toBeNull();
  });
  it('an ordinary company-wide rule (no schedule) still applies to everyone of that gender', () => {
    const wide = rule();
    expect(pickShiftRule([wide], person)).toBe(wide);
  });
  it("a schedule's rule for named people still applies even though the schedule has no department yet", () => {
    const named = rule({
      gender: null,
      workScheduleId: 's1',
      employeeIds: ['p1'],
      departmentIds: [],
    });
    expect(pickShiftRule([named], person)).toBe(named);
  });
});
