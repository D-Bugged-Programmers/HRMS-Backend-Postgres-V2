import {
  buildStatusList,
  isBuiltinSwitchedOff,
  newStatusKey,
  readStatusConfig,
  resolveChosenStatus,
  statusLabel,
} from './employment-status-config';

const cfg = {
  custom: [
    { key: 'CUSTOM_SABBATICAL', label: 'Sabbatical', behavior: 'PAUSED', isActive: true },
    { key: 'CUSTOM_CONTRACT', label: 'On Contract', behavior: 'WORKING', isActive: false },
  ],
  labels: { PROBATION: 'Trial' },
  inactive: ['ON_HOLD'],
};

describe('employment status config', () => {
  it('lists the built-in statuses (renamed or switched off as set) and the company ones; Notice Period is not offered', () => {
    const list = buildStatusList(cfg);
    expect(list.find((s) => s.key === 'PROBATION')).toMatchObject({ label: 'Trial', builtIn: true, selectable: true, isActive: true });
    expect(list.find((s) => s.key === 'ON_HOLD')).toMatchObject({ isActive: false, canSwitchOff: true });
    expect(list.find((s) => s.key === 'CONFIRMED')).toMatchObject({ canSwitchOff: false });
    expect(list.find((s) => s.key === 'TERMINATED')).toMatchObject({ selectable: false });
    expect(list.find((s) => s.key === 'NOTICE_PERIOD')).toBeUndefined();
    expect(list.find((s) => s.key === 'CUSTOM_SABBATICAL')).toMatchObject({ builtIn: false, baseStatus: 'ON_HOLD', behavior: 'PAUSED' });
  });

  it('ignores a broken or empty config and never lets a core status be switched off', () => {
    expect(readStatusConfig(null)).toEqual({ custom: [], labels: {}, inactive: [] });
    expect(readStatusConfig({ custom: [{ key: 1 }], labels: { NOPE: 'x', CONFIRMED: ' Permanent ' }, inactive: ['CONFIRMED', 'ON_HOLD'] })).toEqual({
      custom: [],
      labels: { CONFIRMED: 'Permanent' },
      inactive: ['ON_HOLD'],
    });
  });

  it('stores a custom status as the built-in one it follows, plus its key', () => {
    expect(resolveChosenStatus(cfg, 'CUSTOM_SABBATICAL')).toEqual({ employmentStatus: 'ON_HOLD', employmentStatusKey: 'CUSTOM_SABBATICAL' });
    expect(resolveChosenStatus(cfg, 'PROBATION')).toEqual({ employmentStatus: 'PROBATION', employmentStatusKey: null });
  });

  it('refuses a switched-off status, an exit status and an unknown one, in plain words', () => {
    expect(() => resolveChosenStatus(cfg, 'CUSTOM_CONTRACT')).toThrow(/switched off/);
    expect(() => resolveChosenStatus(cfg, 'ON_HOLD')).toThrow(/switched off/);
    expect(() => resolveChosenStatus(cfg, 'TERMINATED')).toThrow(/Resignation \/ Offboarding/);
    expect(() => resolveChosenStatus(cfg, 'NOPE')).toThrow(/does not exist/);
    expect(isBuiltinSwitchedOff(cfg, 'ON_HOLD')).toBe(true);
  });

  it("names a person's status by the company's own name only while they are still in the status it follows", () => {
    expect(statusLabel(cfg, 'ON_HOLD', 'CUSTOM_SABBATICAL')).toBe('Sabbatical');
    expect(statusLabel(cfg, 'PROBATION', null)).toBe('Trial');
    // the system moved them on (for example a resignation) without touching their key
    expect(statusLabel(cfg, 'RESIGNED', 'CUSTOM_SABBATICAL')).toBe('Resigned');
    // the custom status was removed
    expect(statusLabel({ custom: [] }, 'ON_HOLD', 'CUSTOM_SABBATICAL')).toBe('On Hold');
  });

  it('makes a unique key from a name', () => {
    expect(newStatusKey('Garden leave!', [])).toBe('CUSTOM_GARDEN_LEAVE');
    expect(newStatusKey('Garden leave', ['CUSTOM_GARDEN_LEAVE'])).toBe('CUSTOM_GARDEN_LEAVE_2');
    expect(newStatusKey('   ', [])).toBe('CUSTOM_STATUS');
  });
});
