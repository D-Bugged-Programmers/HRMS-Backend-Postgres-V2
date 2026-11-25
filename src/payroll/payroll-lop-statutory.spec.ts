// PF and ESI in a month with LOP (loss of pay), through the real payroll engine. September 2026 is a 30-day month with
// Sundays off. LOP days: the pay is cut for those days, so the contributions are worked out on the earned wages. Whether an
// employee is covered by ESI is decided on the full-month wage rate, so LOP never moves someone in or out of ESI.
import { AttendanceStatus as S } from '@prisma/client';
import { att, defaultSettings, fixed, line, makeEngine, makeWorld, type World } from './testing/engine-harness';

function monthRows(year: number, month: number, over: Record<string, S> = {}) {
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const rows: ReturnType<typeof att>[] = [];
  for (let d = 1; d <= days; d++) {
    const date = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const sunday = new Date(`${date}T00:00:00Z`).getUTCDay() === 0;
    rows.push(att(date, over[date] ?? (sunday ? S.WEEKLY_OFF : S.PRESENT)));
  }
  return rows;
}

const run = (over: Partial<World>) =>
  makeEngine(makeWorld({ attendance: monthRows(2026, 9), ...over }), '2026-10-10').calc(9, 2026);

// 3 absent working days (Wed 2, Thu 3, Fri 4 Sep): 27 of 30 days are paid.
const threeAbsent = monthRows(2026, 9, { '2026-09-02': S.ABSENT, '2026-09-03': S.ABSENT, '2026-09-04': S.ABSENT });
const settings = defaultSettings({ pfEnabled: true, esiEnabled: true });

describe('PF with LOP', () => {
  it('Basic 12,000, 3 LOP days: PF is 12% of the earned Basic 10,800 = 1,296 on both sides', async () => {
    const r = await run({ settings, overrides: [fixed('BASIC', 12000)], attendance: threeAbsent });
    expect(line(r.earnings, 'BASIC')).toBe(10800);
    expect(line(r.deductions, 'PF')).toBe(1296);
    expect(line(r.employerContributions, 'PF_EMPLOYER')).toBe(1296);
  });

  it('Basic 30,000, 3 LOP days: earned Basic 27,000 is still above the 15,000 ceiling, so PF stays 1,800', async () => {
    const r = await run({ settings, overrides: [fixed('BASIC', 30000)], attendance: threeAbsent });
    expect(line(r.earnings, 'BASIC')).toBe(27000);
    expect(line(r.deductions, 'PF')).toBe(1800);
  });

  it('Basic 16,000, 6 LOP days: earned Basic drops below the ceiling, so PF falls (12,800 x 12% = 1,536)', async () => {
    const r = await run({
      settings,
      overrides: [fixed('BASIC', 16000)],
      attendance: monthRows(2026, 9, {
        '2026-09-02': S.ABSENT, '2026-09-03': S.ABSENT, '2026-09-04': S.ABSENT,
        '2026-09-08': S.ABSENT, '2026-09-09': S.ABSENT, '2026-09-10': S.ABSENT,
      }),
    });
    expect(line(r.earnings, 'BASIC')).toBe(12800);
    expect(line(r.deductions, 'PF')).toBe(1536);
  });
});

describe('ESI with LOP', () => {
  it('covered employee (gross 21,000), 3 LOP days: both shares are worked out on the earned 18,900', async () => {
    const r = await run({ settings, overrides: [fixed('BASIC', 15000)], attendance: threeAbsent });
    expect(r.grossSalary).toBe(18900);
    expect(line(r.deductions, 'ESI')).toBe(Math.ceil((18900 * 0.75) / 100)); // 141.75 -> 142
    expect(line(r.employerContributions, 'ESI_EMPLOYER')).toBe(Math.ceil((18900 * 3.25) / 100)); // 614.25 -> 615 (rounded up)
  });

  it('not covered (full-month gross 23,800): LOP that brings the month under 21,000 does not bring ESI in', async () => {
    const r = await run({
      settings,
      overrides: [fixed('BASIC', 17000)],
      attendance: monthRows(2026, 9, {
        '2026-09-02': S.ABSENT, '2026-09-03': S.ABSENT, '2026-09-04': S.ABSENT, '2026-09-08': S.ABSENT, '2026-09-09': S.ABSENT, '2026-09-10': S.ABSENT, '2026-09-11': S.ABSENT,
      }),
    });
    expect(r.grossSalary).toBeLessThan(21000); // the month paid out under the limit...
    expect(line(r.deductions, 'ESI') ?? 0).toBe(0); // ...but ESI still does not apply
    expect(line(r.employerContributions, 'ESI_EMPLOYER') ?? 0).toBe(0);
  });

  it('a month of full LOP: no wages, so no PF and no ESI on either side', async () => {
    const all: Record<string, S> = {};
    for (let d = 1; d <= 30; d++) all[`2026-09-${String(d).padStart(2, '0')}`] = S.ABSENT;
    const r = await run({ settings, overrides: [fixed('BASIC', 15000)], attendance: monthRows(2026, 9, all) });
    expect(r.grossSalary).toBe(0);
    expect(line(r.deductions, 'PF') ?? 0).toBe(0);
    expect(line(r.deductions, 'ESI') ?? 0).toBe(0);
    expect(line(r.employerContributions, 'PF_EMPLOYER') ?? 0).toBe(0);
    expect(line(r.employerContributions, 'ESI_EMPLOYER') ?? 0).toBe(0);
  });
});
