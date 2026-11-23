import { startsOnProbation } from './probation-start';

describe('startsOnProbation', () => {
  it('starts on probation with the tick, or with the older Probation category', () => {
    expect(startsOnProbation({ startOnProbation: true, employeeType: 'permanent' })).toBe(true);
    expect(startsOnProbation({ employeeType: 'probation' })).toBe(true);
  });
  it('otherwise the new hire stays in onboarding', () => {
    expect(startsOnProbation({ employeeType: 'permanent' })).toBe(false);
    expect(startsOnProbation({ startOnProbation: false })).toBe(false);
    expect(startsOnProbation({})).toBe(false);
  });
});
