import { parseCheckDates, weeklyOffDay, type OffGroup } from './weekly-off-check';

const sunOnly: OffGroup = { id: null, name: 'No department', weeklyOffs: [0] };
const satSun: OffGroup = { id: 'd-sales', name: 'Sales', weeklyOffs: [0, 6] };
const altSat: OffGroup = { id: 'd-ops', name: 'Operations', weeklyOffs: [0, { day: 6, occurrences: [2, 4] }] };

// 2026-11-14 is the 2nd Saturday of November, 2026-11-07 the 1st, 2026-11-15 a Sunday, 2026-11-16 a Monday.
describe('weeklyOffDay', () => {
  it('is a weekly off for everyone when Saturday and Sunday are off for every group', () => {
    const r = weeklyOffDay('2026-11-14', [satSun, { id: 'd-hr', name: 'HR', weeklyOffs: [0, 6] }]);
    expect(r.off.map((g) => g.name)).toEqual(['Sales', 'HR']);
    expect(r.working).toEqual([]);
  });

  it('splits the groups when a department works Saturdays', () => {
    const r = weeklyOffDay('2026-11-14', [satSun, sunOnly]);
    expect(r.off.map((g) => g.name)).toEqual(['Sales']);
    expect(r.working.map((g) => g.name)).toEqual(['No department']);
  });

  it('reads alternate Saturdays: the 2nd is off, the 1st is worked', () => {
    expect(weeklyOffDay('2026-11-14', [altSat]).off.map((g) => g.name)).toEqual(['Operations']);
    expect(weeklyOffDay('2026-11-07', [altSat]).working.map((g) => g.name)).toEqual(['Operations']);
  });

  it('is nobody\'s weekly off on an ordinary weekday', () => {
    const r = weeklyOffDay('2026-11-16', [satSun, altSat, sunOnly]);
    expect(r.off).toEqual([]);
    expect(r.working).toHaveLength(3);
  });

  it('every group is off on a Sunday', () => {
    expect(weeklyOffDay('2026-11-15', [satSun, altSat, sunOnly]).working).toEqual([]);
  });
});

describe('parseCheckDates', () => {
  it('keeps valid dates once each', () => {
    expect(parseCheckDates('2026-01-26, 2026-01-26,2026-08-15')).toEqual(['2026-01-26', '2026-08-15']);
  });
  it('refuses impossible, malformed, empty and too many dates', () => {
    expect(() => parseCheckDates('2026-02-30')).toThrow(/not a valid date/);
    expect(() => parseCheckDates('26-01-2026')).toThrow(/not a valid date/);
    expect(() => parseCheckDates(' , ')).toThrow(/at least one/);
    const many = Array.from({ length: 401 }, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)).join(',');
    expect(() => parseCheckDates(many)).toThrow(/at most 400/);
  });
});
