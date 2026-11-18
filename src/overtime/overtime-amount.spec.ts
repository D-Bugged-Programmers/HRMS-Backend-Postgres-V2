import { estimateOvertimeAmount } from './overtime-basics';

// Same maths as the Overtime Pay formula: hours x multiplier x (Basic / 208) + payDays x (Basic / 30).
describe('estimateOvertimeAmount', () => {
  it('pays hours x multiplier x Basic/208', () => {
    expect(estimateOvertimeAmount({ hours: 2, rateMultiplier: 1.5 }, 20800)).toBe(300);
  });
  it('pays whole days of pay at Basic/30', () => {
    expect(estimateOvertimeAmount({ hours: 8, rateMultiplier: 2, compensationKey: 'PAY_1', payDays: 1 }, 30000)).toBe(1000);
  });
  it('pays nothing by the hour when compensated with comp-off', () => {
    expect(estimateOvertimeAmount({ hours: 8, rateMultiplier: 2, compensationKey: 'COMP_OFF', payDays: 0 }, 30000)).toBe(0);
  });
});
