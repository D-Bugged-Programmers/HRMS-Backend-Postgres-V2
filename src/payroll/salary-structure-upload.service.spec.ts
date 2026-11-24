import { todayInOrgTz } from '../common/org-date';
import { Role } from '@prisma/client';
import { SalaryStructureUploadService } from './salary-structure-upload.service';

// Fakes: two employees (one with a structure already), the calculator, and the per-employee save, which records what it was asked to do.
function build(components?: object[]) {
  const saved: { employeeId: string; lines: unknown[]; effectiveFrom: string }[] = [];
  const emp = (id: string, code: string, extra: object = {}) => ({ id, employeeId: code, name: `Person ${code}`, isActive: true, joiningDate: new Date('2026-04-01'), workLocationId: null, departmentId: null, employeeType: null, ...extra });
  const prisma = {
    organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata' }) },
    user: { findMany: async () => [emp('u1', 'E1'), emp('u2', 'E2'), emp('u3', 'E3', { isActive: false })] },
    employeeSalaryComponent: { groupBy: async () => [{ employeeId: 'u2', _count: { _all: 3 } }] },
  };
  const payroll = {
    structureContext: async () => ({ components: components ?? [{ code: 'BASIC', name: 'Basic Salary', isActive: true }, { code: 'HRA', name: 'House Rent Allowance', isActive: true }], settings: {}, today: '2026-11-23' }),
    contributionLinesForRows: async () => ({ employeeLines: [{ code: 'PF', name: 'Provident Fund', amount: 1800 }, { code: 'ESI', name: 'ESI', amount: 75 }], employerLines: [{ code: 'PF_EMPLOYER', name: 'Employer PF Contribution', amount: 2400 }, { code: 'ESI_EMPLOYER', name: 'Employer ESI', amount: 325 }] }),
    previewStructure: async (dto: { annualCtc?: number; monthlyGross?: number }) => ({
      lines: [{ componentCode: 'BASIC', valueType: 'FIXED', fixedAmount: 1, isEnabled: true }],
      grossMonthly: dto.monthlyGross ?? (dto.annualCtc as number) / 12,
      ctcAnnual: dto.annualCtc ?? (dto.monthlyGross as number) * 12,
      variableAnnual: 0,
      warnings: [],
    }),
  };
  // u2 earns ₹6,00,000 now; a revision dated before 2026-04-01 falls in a locked month.
  const employeeSalary = {
    listSalarySummaries: async () => [{ employeeId: 'u2', hasStructure: true, annualCtc: 600000, fixedMonthly: 50000, variableAnnual: 0 }],
    finalizedPayrollConflict: async (_id: string, date: string) => (date < '2026-04-01' ? `Cannot apply a salary revision effective ${date}: that payroll is already LOCKED.` : null),
    bulkSetStructure: async (employeeId: string, dto: { lines: unknown[]; effectiveFrom: string }) => { saved.push({ employeeId, ...dto }); return { count: 1, rows: [], failed: [], warnings: [] }; },
  };
  const audit = { log: async () => undefined };
  const svc = new SalaryStructureUploadService(prisma as never, payroll as never, employeeSalary as never, audit as never);
  return { svc, saved };
}
const actor = { id: 'hr1', role: Role.HR };

describe('SalaryStructureUploadService', () => {
  it('checks every row and saves nothing on a dry run', async () => {
    const { svc, saved } = build();
    const res = await svc.process({ rows: [{ employeeCode: 'E1', annualCtc: 600000 }], existing: 'SKIP', dryRun: true }, actor, 'org');
    expect(res.rows[0]).toMatchObject({ status: 'READY', monthlyGross: 50000, ctcAnnual: 600000, effectiveFrom: '2026-04-01' });
    expect(saved).toHaveLength(0);
  });
  it('skips or revises someone who already has a structure, as chosen', async () => {
    const skip = await build().svc.process({ rows: [{ employeeCode: 'E2', annualCtc: 600000 }], existing: 'SKIP', dryRun: true }, actor, 'org');
    expect(skip.rows[0].status).toBe('SKIPPED');
    const revise = await build().svc.process({ rows: [{ employeeCode: 'E2', annualCtc: 700000 }], existing: 'REVISE', dryRun: true }, actor, 'org');
    expect(revise.rows[0]).toMatchObject({ status: 'READY', revision: true, effectiveFrom: todayInOrgTz('Asia/Kolkata') });
  });
  it('reports each bad row clearly, and one bad row does not stop another', async () => {
    const one = async (row: Record<string, unknown>) => (await build().svc.process({ rows: [row as never], existing: 'SKIP', dryRun: true }, actor, 'org')).rows[0];
    expect((await one({ employeeCode: 'NOPE', annualCtc: 1 })).message).toMatch(/No employee has the code/);
    expect((await one({ employeeCode: 'E3', annualCtc: 1 })).message).toMatch(/not active/);
    expect((await one({ employeeCode: 'E1', annualCtc: 600000, monthlyGross: 50000 })).message).toMatch(/not both/);
    expect((await one({ employeeCode: 'E1', annualCtc: 'abc' })).message).toMatch(/must be amounts/);
    expect((await one({ employeeCode: 'E1', annualCtc: 600000, effectiveFrom: '31-02-2026' })).message).toMatch(/not a valid date/);
    expect((await one({ employeeCode: 'E1', components: { Nonexistent: 5 } })).message).toMatch(/Unknown salary component/);
    expect((await one({ employeeCode: 'E1' })).message).toMatch(/required/);
    const mixed = await build().svc.process({ rows: [{ employeeCode: 'NOPE', annualCtc: 1 }, { employeeCode: 'E1', monthlyGross: 40000 }], existing: 'SKIP', dryRun: true }, actor, 'org');
    expect(mixed.rows.map((r) => r.status)).toEqual(['FAILED', 'READY']);
  });
  it('refuses a duplicate code in the file', async () => {
    const { svc } = build();
    const res = await svc.process({ rows: [{ employeeCode: 'E1', annualCtc: 1 }, { employeeCode: 'E1', annualCtc: 2 }], existing: 'SKIP', dryRun: true }, actor, 'org');
    expect(res.rows[1].message).toMatch(/more than once/);
  });
  it('saves component amounts as fixed monthly lines, using the date in the row', async () => {
    const { svc, saved } = build();
    const res = await svc.process({ rows: [{ employeeCode: 'E1', components: { 'Basic Salary': 20000, hra: 8000 }, effectiveFrom: '2026-05-01' }], existing: 'SKIP' }, actor, 'org');
    expect(res.rows[0]).toMatchObject({ status: 'SAVED', monthlyGross: 28000 });
    expect(saved[0]).toMatchObject({ employeeId: 'u1', effectiveFrom: '2026-05-01' });
    expect(saved[0].lines).toEqual([
      { componentCode: 'BASIC', valueType: 'FIXED', fixedAmount: 20000, amountBasis: 'MONTHLY', isEnabled: true },
      { componentCode: 'HRA', valueType: 'FIXED', fixedAmount: 8000, amountBasis: 'MONTHLY', isEnabled: true },
    ]);
  });
  it('does not let an HR user change their own salary', async () => {
    const { svc } = build();
    const res = await svc.process({ rows: [{ employeeCode: 'E1', annualCtc: 1 }], existing: 'SKIP', dryRun: true }, { id: 'u1', role: Role.HR }, 'org');
    expect(res.rows[0].message).toMatch(/cannot change your own/);
  });
  it('skips a revision that would change nothing, and shows the current CTC otherwise', async () => {
    const same = await build().svc.process({ rows: [{ employeeCode: 'E2', annualCtc: 600000 }], existing: 'REVISE', dryRun: true }, actor, 'org');
    expect(same.rows[0]).toMatchObject({ status: 'SKIPPED', currentMonthlyGross: 50000 });
    expect(same.rows[0].message).toMatch(/No change/);
    const raise = await build().svc.process({ rows: [{ employeeCode: 'E2', annualCtc: 900000 }], existing: 'REVISE', dryRun: true }, actor, 'org');
    expect(raise.rows[0]).toMatchObject({ status: 'READY', currentMonthlyGross: 50000 });
    expect(raise.rows[0].warnings.join(' ')).toMatch(/\+50%/);
  });
  it('refuses a date in a locked payroll month at the check, unless arrears are allowed', async () => {
    const row = { employeeCode: 'E1', annualCtc: 600000, effectiveFrom: '2026-03-01' };
    const refused = await build().svc.process({ rows: [row], existing: 'SKIP', dryRun: true }, actor, 'org');
    expect(refused.rows[0].status).toBe('FAILED');
    expect(refused.rows[0].message).toMatch(/LOCKED.*arrears/);
    const allowed = await build().svc.process({ rows: [row], existing: 'SKIP', dryRun: true, backdateForArrears: true }, actor, 'org');
    expect(allowed.rows[0].status).toBe('READY');
  });
  it('warns, without blocking, when an amount looks wrong', async () => {
    const res = await build().svc.process({ rows: [{ employeeCode: 'E1', annualCtc: 50000 }], existing: 'SKIP', dryRun: true }, actor, 'org');
    expect(res.rows[0].status).toBe('READY');
    expect(res.rows[0].warnings.join(' ')).toMatch(/monthly amount/);
  });
  it('matches the employee code whatever the case', async () => {
    const res = await build().svc.process({ rows: [{ employeeCode: 'e1', annualCtc: 600000 }], existing: 'SKIP', dryRun: true }, actor, 'org');
    expect(res.rows[0]).toMatchObject({ status: 'READY', name: 'Person E1' });
  });

  describe('amounts typed per component', () => {
    const all = [
      { code: 'BASIC', name: 'Basic Salary', type: 'EARNING', isEmployerContribution: false, isActive: true },
      { code: 'HRA', name: 'House Rent Allowance', type: 'EARNING', isEmployerContribution: false, isActive: true },
      { code: 'PF', name: 'Provident Fund', type: 'DEDUCTION', isEmployerContribution: false, isActive: true },
      { code: 'PF_EMPLOYER', name: 'Employer PF Contribution', type: 'EARNING', isEmployerContribution: true, isActive: true },
      { code: 'DA', name: 'Dearness Allowance', type: 'EARNING', isEmployerContribution: false, isActive: false },
    ];
    it('the monthly gross is what the person earns: deductions and employer contributions are not added to it', async () => {
      const { svc } = build(all);
      const res = await svc.process({ rows: [{ employeeCode: 'E1', components: { 'Basic Salary': 20000, 'House Rent Allowance': 8000, 'Provident Fund': 1800, 'Employer PF Contribution': 2400 } }], existing: 'SKIP', dryRun: true }, actor, 'org');
      expect(res.rows[0]).toMatchObject({ status: 'READY', monthlyGross: 28000, ctcAnnual: (28000 + 2400) * 12 });
    });
    it('returns every typed amount, as it will be saved, with what kind of component it is', async () => {
      const { svc } = build(all);
      const res = await svc.process({ rows: [{ employeeCode: 'E1', components: { 'Basic Salary': 20000, 'Provident Fund': 1800, 'Employer PF Contribution': 2400 } }], existing: 'SKIP', dryRun: true }, actor, 'org');
      expect(res.rows[0].components).toEqual([
        { name: 'Basic Salary', amount: 20000, kind: 'EARNING' },
        { name: 'Provident Fund', amount: 1800, kind: 'DEDUCTION' },
        { name: 'Employer PF Contribution', amount: 2400, kind: 'EMPLOYER' },
        { name: 'ESI', amount: 75, kind: 'DEDUCTION', calculated: true },
        { name: 'Employer ESI', amount: 325, kind: 'EMPLOYER', calculated: true },
      ]);
    });
    it('names a switched-off component instead of calling it unknown', async () => {
      const { svc } = build(all);
      const res = await svc.process({ rows: [{ employeeCode: 'E1', components: { 'Dearness Allowance': 500 } }], existing: 'SKIP', dryRun: true }, actor, 'org');
      expect(res.rows[0]).toMatchObject({ status: 'FAILED' });
      expect(res.rows[0].message).toMatch(/Dearness Allowance is switched off/);
    });
  });
});
