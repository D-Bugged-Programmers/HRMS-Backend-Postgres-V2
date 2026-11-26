import { declarationLimitErrors } from './declaration-limits';
import { ageOnFYEnd, taxYearLabel } from '../common/tax-year';

describe('declarationLimitErrors', () => {
  it('limits 80D by age, and allows the higher figure when the age is unknown', () => {
    expect(declarationLimitErrors({ section80D: 75000 }, true, 30)).toEqual([]);
    expect(declarationLimitErrors({ section80D: 75001 }, true, 30)).toEqual(['Section 80D can be at most ₹75,000.']);
    expect(declarationLimitErrors({ section80D: 100000 }, true, 60)).toEqual([]);
    expect(declarationLimitErrors({ section80D: 100000 }, true, null)).toEqual([]);
    expect(declarationLimitErrors({ section80D: 80000 }, false, 30)).toHaveLength(1);
  });
  it('limits home loan interest and 80TTA under the Old Regime only', () => {
    expect(declarationLimitErrors({ homeLoanInterest: 200000, section80TTA: 10000 }, true, 30)).toEqual([]);
    expect(declarationLimitErrors({ homeLoanInterest: 200001, section80TTA: 10001 }, true, 30)).toHaveLength(2);
    expect(declarationLimitErrors({ section80TTA: 50000 }, true, 60)).toEqual([]);
    expect(declarationLimitErrors({ section80TTA: 50001 }, true, 60)).toHaveLength(1);
    expect(declarationLimitErrors({ homeLoanInterest: 500000, section80TTA: 90000 }, false, 30)).toEqual([]);
  });
  it('ignores amounts that are not being saved', () => {
    expect(declarationLimitErrors({}, true, 30)).toEqual([]);
  });
});

describe('tax year helpers', () => {
  it('says Tax Year from 2026-27 and FY before', () => {
    expect(taxYearLabel('2025-26')).toBe('FY 2025-26');
    expect(taxYearLabel('2026-27')).toBe('Tax Year 2026-27');
  });
  it('takes the age on 31 March ending the year', () => {
    expect(ageOnFYEnd('1967-03-31', '2026-27')).toBe(60);
    expect(ageOnFYEnd('1967-04-01', '2026-27')).toBe(59);
    expect(ageOnFYEnd(undefined, '2026-27')).toBeNull();
  });
});
