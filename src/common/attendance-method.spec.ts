import { appPunchAllowed, resolveAttendanceMethod } from './attendance-method';

describe('resolveAttendanceMethod', () => {
  it("uses the employee's own setting over the company's", () => {
    expect(resolveAttendanceMethod('BIOMETRIC' as never, { attendanceMethod: 'MOBILE' })).toBe('BIOMETRIC');
    expect(resolveAttendanceMethod('MOBILE' as never, { attendanceMethod: 'BIOMETRIC' })).toBe('MOBILE');
    expect(resolveAttendanceMethod('BOTH' as never, { attendanceMethod: 'BIOMETRIC' })).toBe('BOTH');
  });
  it('DEFAULT follows the company default', () => {
    expect(resolveAttendanceMethod('DEFAULT' as never, { attendanceMethod: 'BIOMETRIC' })).toBe('BIOMETRIC');
    expect(resolveAttendanceMethod(undefined, { attendanceMethod: 'MOBILE' })).toBe('MOBILE');
  });
  it('a company that never set it keeps today\'s behaviour (either way)', () => {
    expect(resolveAttendanceMethod('DEFAULT' as never, {})).toBe('BOTH');
    expect(resolveAttendanceMethod(null, null)).toBe('BOTH');
    expect(resolveAttendanceMethod(null, { attendanceMethod: 'NOPE' })).toBe('BOTH');
  });
  it('only a biometric-only person is kept out of the app punch', () => {
    expect(appPunchAllowed('BIOMETRIC')).toBe(false);
    expect(appPunchAllowed('MOBILE')).toBe(true);
    expect(appPunchAllowed('BOTH')).toBe(true);
  });
});
