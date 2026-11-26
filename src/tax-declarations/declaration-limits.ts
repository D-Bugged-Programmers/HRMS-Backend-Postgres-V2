// Purpose: refuses declared amounts above the limits that depend on the employee's age or the tax regime. (80C, 80CCD(1B) and the
//   80D maximum are already refused by UpsertTaxDeclarationDto.)
// Important: pure. The figures match what payroll applies (payroll/tax-engine.ts) and the mobile app's utils/taxLimits.ts.
//   With no date of birth, 80D allows the higher figure so a senior is not wrongly refused (payroll still counts the lower one).

export interface LimitInput {
  section80D?: number;
  homeLoanInterest?: number;
  section80TTA?: number;
}

const rupees = (n: number) => `₹${n.toLocaleString('en-IN')}`;

/** One message per amount over its limit (only the amounts being saved are checked). */
export function declarationLimitErrors(input: LimitInput, isOldRegime: boolean, age: number | null): string[] {
  const senior = age !== null && age >= 60;
  const errors: string[] = [];
  const check = (value: number | undefined, limit: number, name: string) => {
    if (value !== undefined && value > limit) errors.push(`${name} can be at most ${rupees(limit)}.`);
  };
  check(input.section80D, age === null || senior ? 100000 : 75000, 'Section 80D');
  // The New Regime does not use these two, so a figure kept from the Old Regime does not block a save.
  if (isOldRegime) {
    check(input.homeLoanInterest, 200000, 'Home loan interest');
    // From 60 the same box carries the 80TTB figure.
    check(input.section80TTA, senior ? 50000 : 10000, 'Section 80TTA');
  }
  return errors;
}
