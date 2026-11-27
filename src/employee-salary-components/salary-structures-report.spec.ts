import { SalaryStructurePdfService } from './salary-structure-pdf.service';
import {
  defaultComponents,
  defaultSettings,
  fixed,
} from '../payroll/testing/engine-harness';

// Reports > Salary structures: one row per active employee, built from the same figures as the printed structure.
describe('bulk salary structures report', () => {
  const components = defaultComponents();
  const withComponent = (row: Record<string, unknown>, employeeId: string) => {
    const c = components.find((x) => x.code === row.componentCode)!;
    return {
      ...row,
      employeeId,
      component: {
        name: c.name,
        type: c.type,
        payFrequency: c.payFrequency,
        isEmployerContribution: c.isEmployerContribution,
        displayOrder: c.displayOrder,
      },
    };
  };

  const build = () => {
    const prisma = {
      organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata' }) },
      user: {
        findMany: async () => [
          { id: 'u1', name: 'Asha', employeeId: 'E001', designation: 'Engineer', gender: 'FEMALE', personalData: {}, department: { name: 'Tech', workLocation: { state: 'Maharashtra', cityClass: 'METRO' } }, workLocation: null },
          { id: 'u2', name: 'Ravi', employeeId: 'E002', designation: null, gender: 'MALE', personalData: {}, department: null, workLocation: null },
        ],
      },
      employeeSalaryComponent: {
        findMany: async () => [withComponent(fixed('BASIC', 15000), 'u1')],
      },
      salaryComponent: { findMany: async () => components },
    };
    return new SalaryStructurePdfService(
      prisma as never,
      {} as never,
      { getOrCreate: async () => defaultSettings({ pfEnabled: true, esiEnabled: true }) } as never,
      { getEffective: async () => ({ version: null }) } as never,
    );
  };

  it('lists every active employee with earnings, deductions, employer cost, CTC and take-home', async () => {
    const report = await build().bulkReport('org-1', '2026-11-27');
    expect(report.filename).toBe('salary_structures_2026-11-27');
    expect(report.rows).toHaveLength(2);

    const asha = report.rows[0] as Record<string, number | string>;
    expect(asha.employeeId).toBe('E001');
    expect(asha.department).toBe('Tech');
    expect(asha.m_BASIC).toBe(15000);
    const deductions = asha.deductionsMonthly as number;
    const employer = asha.employerMonthly as number;
    expect(asha.takeHome).toBe((asha.fixedMonthly as number) - deductions);
    expect(asha.ctcMonthly).toBe((asha.fixedMonthly as number) + employer);
    expect(typeof asha.d_PF).toBe('number');
    expect(asha.d_PF as number).toBeGreaterThan(0);

    const keys = report.columns.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(['m_BASIC', 'd_PF', 'takeHome', 'ctcAnnual']));
    expect(keys.indexOf('m_BASIC')).toBeLessThan(keys.indexOf('d_PF'));

    // No structure on file: listed, not dropped.
    const ravi = report.rows[1] as Record<string, unknown>;
    expect(ravi.effectiveFrom).toBe('No salary structure on file');
    expect(ravi.ctcAnnual).toBeUndefined();
  });
});
