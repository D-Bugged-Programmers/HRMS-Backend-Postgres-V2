import { AttendanceMethod } from '@prisma/client';
import { ATTENDANCE_METHOD_LABELS } from './employees.service';

// What a sheet may say in the "attendanceMethod" column (compared without case; blank = the company setting).
const read = (text: string) => ATTENDANCE_METHOD_LABELS.get(text.trim().toLowerCase());

describe('employee upload: attendanceMethod column', () => {
  it('reads the names people write', () => {
    expect(read('Company setting')).toBe(AttendanceMethod.DEFAULT);
    expect(read('Mobile app')).toBe(AttendanceMethod.MOBILE);
    expect(read('MOBILE')).toBe(AttendanceMethod.MOBILE);
    expect(read('Biometric device')).toBe(AttendanceMethod.BIOMETRIC);
    expect(read('Device')).toBe(AttendanceMethod.BIOMETRIC);
    expect(read('Both')).toBe(AttendanceMethod.BOTH);
    expect(read('Mobile app or biometric device')).toBe(AttendanceMethod.BOTH);
  });
  it('does not guess at anything else (the row is refused with the allowed names)', () => {
    expect(read('Fingerprint?')).toBeUndefined();
    expect(read('xyz')).toBeUndefined();
  });
});
