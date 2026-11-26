// Purpose: tax-year wording and the age used by income-tax limits.
// Important: under the Income-tax Act, 2025 (from 1-Apr-2026) the year is a "Tax Year"; earlier years stay "FY". The web and mobile
//   apps use the same rule.

/** "2026-27" -> "Tax Year 2026-27"; "2025-26" -> "FY 2025-26". */
export function taxYearLabel(taxYear: string): string {
  return Number(taxYear.slice(0, 4)) >= 2026 ? `Tax Year ${taxYear}` : `FY ${taxYear}`;
}

/** Age (whole years) on 31 March ending the year ("2026-27" -> 31 Mar 2027); null when there is no valid date of birth. */
export function ageOnFYEnd(dob: unknown, financialYear: string): number | null {
  if (typeof dob !== 'string') return null;
  const born = new Date(dob);
  const startYear = Number(financialYear.slice(0, 4));
  if (Number.isNaN(born.getTime()) || !Number.isFinite(startYear)) return null;
  const end = new Date(Date.UTC(startYear + 1, 2, 31));
  let age = end.getUTCFullYear() - born.getUTCFullYear();
  const beforeBirthday =
    end.getUTCMonth() < born.getUTCMonth() ||
    (end.getUTCMonth() === born.getUTCMonth() && end.getUTCDate() < born.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
}
