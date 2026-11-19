import { isLeaveFrozen, leaveFreezeCutoff, leaveFreezeDayOf } from './leave-freeze';

describe('leave freeze', () => {
  it('reads only a whole day 1-28', () => {
    expect(leaveFreezeDayOf(2)).toBe(2);
    expect(leaveFreezeDayOf('2')).toBe(2);
    expect([leaveFreezeDayOf(0), leaveFreezeDayOf(29), leaveFreezeDayOf(null), leaveFreezeDayOf(''), leaveFreezeDayOf(1.5)]).toEqual([null, null, null, null, null]);
  });
  it('keeps last month open through the freeze day, then freezes it', () => {
    expect(leaveFreezeCutoff('2026-11-02', 2)).toBe('2026-10-01');
    expect(leaveFreezeCutoff('2026-11-03', 2)).toBe('2026-11-01');
    expect(isLeaveFrozen('2026-10-31', '2026-11-02', 2)).toBe(false);
    expect(isLeaveFrozen('2026-10-31', '2026-11-03', 2)).toBe(true);
    expect(isLeaveFrozen('2026-11-01', '2026-11-30', 2)).toBe(false);
    expect(isLeaveFrozen('2026-09-30', '2026-11-02', 2)).toBe(true);
  });
  it('rolls over the year and does nothing when unset', () => {
    expect(leaveFreezeCutoff('2027-01-01', 2)).toBe('2026-12-01');
    expect(leaveFreezeCutoff('2027-01-05', 2)).toBe('2027-01-01');
    expect(isLeaveFrozen('2020-01-01', '2026-11-30', null)).toBe(false);
  });
});
