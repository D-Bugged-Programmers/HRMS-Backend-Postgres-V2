import { ORG_ITEM_LABELS, SCREEN_SWITCH_LABELS, moduleForPath } from './module-routes';

describe('moduleForPath', () => {
  it('maps module routes to their flag', () => {
    expect(moduleForPath('/payroll/runs')).toBe('module.payroll');
    expect(moduleForPath('/leave-balances/me?year=2026')).toBe('module.leave');
    expect(moduleForPath('/tds/summary')).toBe('module.statutory');
    expect(moduleForPath('/employees/abc/letters')).toBe('module.documents_letters');
    expect(moduleForPath('/dashboard/hr/payroll-cost-summary?range=this_year')).toBe('module.payroll');
  });
  it('leaves core routes alone', () => {
    expect(moduleForPath('/employees')).toBeNull();
    expect(moduleForPath('/auth/me')).toBeNull();
    expect(moduleForPath('/modules')).toBeNull();
    expect(moduleForPath('/dashboard/hr')).toBeNull();
    expect(moduleForPath('/dashboard/pending-counts')).toBeNull();
    expect(moduleForPath('/')).toBeNull();
  });
});

describe('Organization menu switches', () => {
  it('are menu-and-page only: none of them refuses an API route', () => {
    expect(Object.keys(ORG_ITEM_LABELS).length).toBeGreaterThan(0);
    for (const path of ['/departments', '/designations', '/grades', '/holidays', '/work-locations', '/org-list-items']) {
      expect(moduleForPath(path)).toBeNull();
    }
  });
});

describe('Screen switches', () => {
  it('hide things in the apps only: none of them refuses an API route', () => {
    expect(Object.keys(SCREEN_SWITCH_LABELS)).toContain('module.mobile_app');
    for (const path of ['/tds/monthly', '/overtime', '/reports/payroll', '/employees/bulk', '/approvals']) {
      const m = moduleForPath(path);
      expect(m === null || !(m in SCREEN_SWITCH_LABELS)).toBe(true);
    }
  });
});
