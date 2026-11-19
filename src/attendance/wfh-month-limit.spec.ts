import { AttendanceService } from './attendance.service';

// withWfhMonthLimit only reads the org policy and approved WFH days, so a two-table stub is enough.
function build(limit: number | null, approved: { employeeId: string; date: string }[]) {
  const service = Object.create(AttendanceService.prototype) as any;
  service.scopedPrisma = {
    organization: { findFirst: async () => ({ policies: limit === null ? {} : { wfhDaysPerMonth: limit } }) },
    attendance: { findMany: async () => approved },
  };
  return service as { withWfhMonthLimit: (rows: any[], org: string) => Promise<any[]> };
}

describe('WFH monthly limit warning', () => {
  it('returns rows unchanged when no limit is set', async () => {
    const rows = [{ employeeId: 'e1', date: '2026-11-10' }];
    expect(await build(null, []).withWfhMonthLimit(rows, 'o')).toEqual(rows);
  });

  it('counts approved days first, then waiting days in date order', async () => {
    const approved = ['01', '02', '03'].map((d) => ({ employeeId: 'e1', date: `2026-11-${d}` }));
    const rows = [
      { employeeId: 'e1', date: '2026-11-12' },
      { employeeId: 'e1', date: '2026-11-11' },
      { employeeId: 'e2', date: '2026-11-11' },
    ];
    const out = await build(4, approved).withWfhMonthLimit(rows, 'o');
    const by = (e: string, d: string) => out.find((r) => r.employeeId === e && r.date === d).wfhMonthLimit;
    expect(by('e1', '2026-11-11')).toEqual({ allowed: 4, ordinal: 4, over: false });
    expect(by('e1', '2026-11-12')).toEqual({ allowed: 4, ordinal: 5, over: true });
    expect(by('e2', '2026-11-11')).toEqual({ allowed: 4, ordinal: 1, over: false });
  });

  it('keeps each month separate', async () => {
    const approved = ['01', '02'].map((d) => ({ employeeId: 'e1', date: `2026-10-${d}` }));
    const out = await build(2, approved).withWfhMonthLimit([{ employeeId: 'e1', date: '2026-11-05' }], 'o');
    expect(out[0].wfhMonthLimit).toEqual({ allowed: 2, ordinal: 1, over: false });
  });
});
