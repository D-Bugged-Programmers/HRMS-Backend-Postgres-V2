import { AttendanceSource as Src, AttendanceStatus as St } from '@prisma/client';
import { isWorkedByPerson } from './attendance.service';

describe('isWorkedByPerson (days imported leave leaves alone)', () => {
  it('protects recorded or punched worked days', () => {
    expect(isWorkedByPerson({ status: St.PRESENT, source: Src.REGULARIZED })).toBe(true);
    expect(isWorkedByPerson({ status: St.PRESENT, source: Src.EXCEL_IMPORT })).toBe(true);
    expect(isWorkedByPerson({ status: St.HALF_DAY, source: Src.FACE_API })).toBe(true);
    expect(isWorkedByPerson({ status: St.INCOMPLETE, source: Src.FACE_API })).toBe(true);
  });
  it('does not protect the system stamps, absences or days off', () => {
    expect(isWorkedByPerson({ status: St.PRESENT, source: Src.SYSTEM })).toBe(false);
    expect(isWorkedByPerson({ status: St.ABSENT, source: Src.EXCEL_IMPORT })).toBe(false);
    expect(isWorkedByPerson({ status: St.ON_LEAVE, source: Src.SYSTEM })).toBe(false);
    expect(isWorkedByPerson({ status: St.WEEKLY_OFF, source: Src.REGULARIZED })).toBe(false);
  });
});
