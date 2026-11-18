import { isOvertimePayEnabled } from './overtime-pay';

// Overtime is on only when the org's Enable Overtime switch (default on) AND the Overtime Pay component are on.
const db = (prefs: unknown, componentActive: boolean) =>
  ({
    organization: {
      findFirst: async () => ({ orgPayrollAttendancePrefs: prefs }),
    },
    salaryComponent: { count: async () => (componentActive ? 1 : 0) },
  }) as never;

describe('isOvertimePayEnabled', () => {
  it('is on when nothing is set and the component is active', async () => {
    expect(await isOvertimePayEnabled(db(null, true), 'org')).toBe(true);
    expect(await isOvertimePayEnabled(db({}, true), 'org')).toBe(true);
  });
  it('is off when the org switch is off, even with the component active', async () => {
    expect(
      await isOvertimePayEnabled(db({ enableOvertime: false }, true), 'org'),
    ).toBe(false);
  });
  it('is off when the component is off, even with the org switch on', async () => {
    expect(
      await isOvertimePayEnabled(db({ enableOvertime: true }, false), 'org'),
    ).toBe(false);
  });
});
