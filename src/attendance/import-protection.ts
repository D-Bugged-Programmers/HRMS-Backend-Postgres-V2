// Purpose: which days an attendance import may not change: leave and regularized days stay. Everything else takes the
//   file's times, including days with biometric or mobile punches (the sheet is the record the admin chose to apply).
// Responsibilities: says why a row is skipped (shown to whoever ran the import), and recognises a half-day leave's stamp.
// Important: pure. Open to an import: no row, a punched day (biometric / mobile), a day the system filled in by itself
//   (Absent, Weekly Off, Holiday, Always present) and a day an earlier import wrote (a corrected file may fix it). A half day of leave is not skipped: its status
//   stays, and the times worked in the other half are kept under it (see the caller).
import { AttendanceSource, AttendanceStatus } from '@prisma/client';

export interface ImportExistingDay {
  status: AttendanceStatus;
  source: AttendanceSource;
  inTime: Date | null;
  regularization?: unknown;
  leaveOverriddenSource?: AttendanceSource | null;
}

export const isHalfLeaveStamp = (d: ImportExistingDay | null): boolean =>
  !!d &&
  d.status === AttendanceStatus.HALF_DAY &&
  d.source === AttendanceSource.SYSTEM;

export function importSkipReason(
  existing: ImportExistingDay | null,
  approvedLeave: { isHalfDay: boolean } | null,
): string | null {
  if (approvedLeave && !approvedLeave.isHalfDay) return 'On approved leave';
  if (!existing) return null;
  if (existing.status === AttendanceStatus.ON_LEAVE) return 'On approved leave';
  const regularization = (existing.regularization as { status?: string } | null)
    ?.status;
  if (existing.source === AttendanceSource.REGULARIZED || regularization === 'approved') {
    return 'Already regularized';
  }
  if (regularization === 'pending') return 'A regularization request is waiting';
  return null;
}
