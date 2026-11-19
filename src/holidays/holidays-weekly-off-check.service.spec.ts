import { BadRequestException } from '@nestjs/common';
import { Role } from '@prisma/client';
import { HolidaysService } from './holidays.service';

type Row = Record<string, any>;

// The calendar and the tracker use one rule: a department's own weekly offs, else the organization's default (here Sat + Sun).
function build(o: { departments?: Row[]; withoutDepartment?: number; orgPrefs?: Row } = {}) {
  const departments = o.departments ?? [];
  const prisma: Row = {
    organization: { findFirst: async () => ({ attendancePayrollPrefs: o.orgPrefs ?? { weekendDays: [0, 6] } }) },
    department: {
      findMany: async () => departments,
      findFirst: async (a: { where: { id: string } }) => departments.find((d) => d.id === a.where.id) ?? null,
    },
    user: { count: async () => o.withoutDepartment ?? 0 },
  };
  return new HolidaysService(prisma as never, {} as never, {} as never);
}

const eng = { id: 'd-eng', name: 'Engineering', weeklyOffs: [0] }; // works Saturdays
const sales = { id: 'd-sales', name: 'Sales', weeklyOffs: [0, 6] };
const ops = { id: 'd-ops', name: 'Operations', weeklyOffs: [0, { day: 6, occurrences: [2, 4] }] }; // 2nd and 4th Saturday off
const hr = { role: Role.HR, departmentId: null };

// 2026-11-14: 2nd Saturday. 2026-11-07: 1st Saturday. 2026-11-15: Sunday. 2026-11-16: Monday.
describe('HolidaysService.weeklyOffCheck', () => {
  it('HR sees each department: off for some, a working day (an extra day off) for others', async () => {
    const r = await build({ departments: [eng, sales, ops] }).weeklyOffCheck('2026-11-14,2026-11-07', hr, 'org');
    expect(r.self).toBe(false);
    expect(r.days['2026-11-14'].off.map((g) => g.name)).toEqual(['Sales', 'Operations']);
    expect(r.days['2026-11-14'].working.map((g) => g.name)).toEqual(['Engineering']);
    // the 1st Saturday is worked by Operations (alternate Saturdays)
    expect(r.days['2026-11-07'].off.map((g) => g.name)).toEqual(['Sales']);
    expect(r.days['2026-11-07'].working.map((g) => g.name)).toEqual(['Engineering', 'Operations']);
  });

  it('a Sunday is everyone\'s weekly off and a Monday nobody\'s', async () => {
    const r = await build({ departments: [eng, sales, ops] }).weeklyOffCheck('2026-11-15,2026-11-16', hr, 'org');
    expect(r.days['2026-11-15'].working).toEqual([]);
    expect(r.days['2026-11-16'].off).toEqual([]);
  });

  it('people without a department follow the organization default, listed only when there are such people', async () => {
    const withThem = await build({ departments: [eng], withoutDepartment: 3 }).weeklyOffCheck('2026-11-14', hr, 'org');
    expect(withThem.days['2026-11-14'].off.map((g) => g.name)).toEqual(['People without a department']); // org default Sat + Sun
    const without = await build({ departments: [eng], withoutDepartment: 0 }).weeklyOffCheck('2026-11-14', hr, 'org');
    expect(without.days['2026-11-14'].off).toEqual([]);
    // with no departments at all the organization default is everyone's
    const none = await build({ departments: [], withoutDepartment: 0 }).weeklyOffCheck('2026-11-14', hr, 'org');
    expect(none.days['2026-11-14'].off.map((g) => g.name)).toEqual(['People without a department']);
  });

  it('follows the organization setting: Saturday worked when it is not a weekend day', async () => {
    const r = await build({ departments: [], orgPrefs: { weekendDays: [0] } }).weeklyOffCheck('2026-11-14', hr, 'org');
    expect(r.days['2026-11-14'].off).toEqual([]);
    expect(r.days['2026-11-14'].working).toHaveLength(1);
  });

  it('an employee sees only their own schedule, without department names', async () => {
    const svc = build({ departments: [eng, sales] });
    const r = await svc.weeklyOffCheck('2026-11-14', { role: Role.EMPLOYEE, departmentId: 'd-eng' }, 'org');
    expect(r.self).toBe(true);
    expect(r.days['2026-11-14'].working.map((g) => g.name)).toEqual(['Your schedule']);
    const sal = await svc.weeklyOffCheck('2026-11-14', { role: Role.MANAGER, departmentId: 'd-sales' }, 'org');
    expect(sal.days['2026-11-14'].off.map((g) => g.name)).toEqual(['Your schedule']);
  });

  it('refuses a bad date list with a plain message', async () => {
    await expect(build().weeklyOffCheck('nope', hr, 'org')).rejects.toBeInstanceOf(BadRequestException);
  });
});
