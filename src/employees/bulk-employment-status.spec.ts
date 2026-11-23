import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { EmployeesService } from './employees.service';
import { BulkUpdateEmployeesDto } from './dto/bulk-update-employees.dto';

type Row = Record<string, any>;

// bulkUpdate hands each person to the same update() a single edit uses; the stub stands in for it and records who it was called for.
function build(statuses: Record<string, string>, failFor: string[] = []) {
  const updated: Row[] = [];
  const svc = Object.create(EmployeesService.prototype) as any;
  svc.scopedPrisma = {
    user: { findFirst: async (a: Row) => ({ employmentStatus: statuses[a.where.id] ?? 'CONFIRMED', name: `Name ${a.where.id}` }) },
  };
  svc.update = async (id: string, dto: Row) => {
    if (failFor.includes(id)) throw new Error('Not allowed.');
    updated.push({ id, ...dto });
  };
  return { svc: svc as EmployeesService, updated };
}

const hr = { id: 'h1', role: 'HR' } as never;

describe('bulk employment status', () => {
  it('sets a working status on everyone through the normal single-edit path', async () => {
    const { svc, updated } = build({});
    const res = await svc.bulkUpdate({ employeeIds: ['e1', 'e2'], employmentStatus: 'CONFIRMED' } as never, hr, 'org');
    expect(res).toEqual({ updated: 2, failed: [] });
    expect(updated).toEqual([{ id: 'e1', employmentStatus: 'CONFIRMED' }, { id: 'e2', employmentStatus: 'CONFIRMED' }]);
  });

  it('skips people serving notice or who have left, with the reason, so a bulk change never cancels a resignation or reinstates them', async () => {
    const { svc, updated } = build({ e2: 'TERMINATED', e3: 'RESIGNED' });
    const res = await svc.bulkUpdate({ employeeIds: ['e1', 'e2', 'e3'], employmentStatus: 'PROBATION' } as never, hr, 'org');
    expect(updated.map((u) => u.id)).toEqual(['e1']);
    expect(res.updated).toBe(1);
    expect(res.failed.map((f) => f.employeeId)).toEqual(['e2', 'e3']);
    expect(res.failed[0].error).toMatch(/leaving or has left/i);
  });

  it("reports a person the normal rules refuse, and carries on with the others", async () => {
    const { svc, updated } = build({}, ['e1']);
    const res = await svc.bulkUpdate({ employeeIds: ['e1', 'e2'], employmentStatus: 'ON_HOLD' } as never, hr, 'org');
    expect(res.updated).toBe(1);
    expect(res.failed).toMatchObject([{ employeeId: 'e1', error: 'Not allowed.' }]);
    expect(updated.map((u) => u.id)).toEqual(['e2']);
  });

  it('does not look at status when only other fields change', async () => {
    const { svc, updated } = build({ e1: 'TERMINATED' });
    const res = await svc.bulkUpdate({ employeeIds: ['e1'], designation: 'Analyst' } as never, hr, 'org');
    expect(res.updated).toBe(1);
    expect(updated[0]).toEqual({ id: 'e1', designation: 'Analyst' });
  });
});

describe('BulkUpdateEmployeesDto employmentStatus', () => {
  const check = async (status: string) =>
    (await validate(plainToInstance(BulkUpdateEmployeesDto, { employeeIds: ['5e49772d-4a30-4eba-81df-df1d4d09e5ce'], employmentStatus: status }))).length;
  it('accepts the working statuses and refuses the exit ones', async () => {
    for (const ok of ['ON_HOLD', 'ONBOARDING', 'PROBATION', 'EXTENDED_PROBATION', 'CONFIRMED']) expect(await check(ok)).toBe(0);
    for (const bad of ['RESIGNED', 'RELEASED', 'TERMINATED', 'ABSCONDED', 'NOPE']) expect(await check(bad)).toBeGreaterThan(0);
  });
});
