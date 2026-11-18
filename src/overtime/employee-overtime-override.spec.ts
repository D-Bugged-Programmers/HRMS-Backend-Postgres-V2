import { getEffectiveOvertime } from './overtime.service';

// An employee's own overtime setting (Employee Directory) beats the rule set and the company policy.
function db(ruleEligible: boolean | undefined, own: 'ELIGIBLE' | 'NOT_ELIGIBLE' | null) {
  return {
    organization: { findFirst: async () => ({ policies: {} }) },
    payrollSettings: { findFirst: async () => null },
    overtimeRuleSet: {
      findMany: async () =>
        ruleEligible === undefined
          ? []
          : [{ id: 'rs', name: 'Factory', isActive: true, effectiveFrom: '2020-01-01', policy: { eligible: ruleEligible }, rates: null, employeeIds: ['e1'], departmentIds: [], employeeTypes: [], designations: [] }],
    },
    user: { findFirst: async () => ({ overtimeEligibility: own }) },
  } as never;
}

describe('employee overtime override', () => {
  it('follows the rule set when the employee has no setting of their own', async () => {
    const r = await getEffectiveOvertime(db(false, null), 'org', { id: 'e1' }, '2026-11-01');
    expect(r.policy.eligible).toBe(false);
  });
  it('ELIGIBLE beats a rule set that says not eligible', async () => {
    const r = await getEffectiveOvertime(db(false, 'ELIGIBLE'), 'org', { id: 'e1' }, '2026-11-01');
    expect(r.policy.eligible).toBe(true);
  });
  it('NOT_ELIGIBLE beats the company policy', async () => {
    const r = await getEffectiveOvertime(db(undefined, 'NOT_ELIGIBLE'), 'org', { id: 'e1' }, '2026-11-01');
    expect(r.policy.eligible).toBe(false);
  });
});
