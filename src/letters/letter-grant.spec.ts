import { LetterDataProfile, Role } from '@prisma/client';
import { grantAllows } from './letters.service';

const manager = { id: 'm1', role: Role.MANAGER };
const migrated = { enabled: true, enabledById: null };
const byHr = { enabled: true, enabledById: 'hr1' };

describe('grantAllows', () => {
  it("needs HR's own decision for a manager's own non-payroll letter", () => {
    for (const profile of [LetterDataProfile.BASIC, LetterDataProfile.EXIT]) {
      expect(grantAllows(undefined, manager, 'm1', profile)).toBe(false);
      expect(grantAllows(migrated, manager, 'm1', profile)).toBe(false);
      expect(grantAllows({ enabled: true, enabledById: 'm1' }, manager, 'm1', profile)).toBe(false);
      expect(grantAllows({ enabled: false, enabledById: 'hr1' }, manager, 'm1', profile)).toBe(false);
      expect(grantAllows(byHr, manager, 'm1', profile)).toBe(true);
    }
  });
  it('leaves pay and settlement letters, and employees, as they were', () => {
    expect(grantAllows(migrated, manager, 'm1', LetterDataProfile.PAYROLL)).toBe(true);
    expect(grantAllows(migrated, manager, 'm1', LetterDataProfile.SETTLEMENT)).toBe(true);
    expect(grantAllows(migrated, { id: 'e1', role: Role.EMPLOYEE }, 'e1', LetterDataProfile.BASIC)).toBe(true);
    expect(grantAllows(undefined, { id: 'e1', role: Role.EMPLOYEE }, 'e1', LetterDataProfile.PAYROLL)).toBe(false);
  });
});
