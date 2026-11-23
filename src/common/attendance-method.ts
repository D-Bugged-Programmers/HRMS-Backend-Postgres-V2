import { AttendanceMethod } from '@prisma/client';

// How an employee marks attendance - the one rule used by the app's punch endpoint and /auth/me (so the mobile app knows whether to
// offer the punch at all):
//   MOBILE    - in the app (a punch from the office device is still accepted and kept)
//   BIOMETRIC - on the office device; the app does not offer a punch and the server refuses one
//   BOTH      - either
// The employee's own setting wins; DEFAULT follows the organization's attendance prefs (`attendanceMethod`). Anything unset or
// unrecognised is BOTH, so companies that predate the setting keep exactly today's behaviour.
export type PunchMethod = 'MOBILE' | 'BIOMETRIC' | 'BOTH';

export const PUNCH_METHODS: PunchMethod[] = ['MOBILE', 'BIOMETRIC', 'BOTH'];

export function resolveAttendanceMethod(
  employeeSetting: AttendanceMethod | null | undefined,
  orgAttendancePrefs: unknown,
): PunchMethod {
  if (
    employeeSetting === AttendanceMethod.MOBILE ||
    employeeSetting === AttendanceMethod.BIOMETRIC ||
    employeeSetting === AttendanceMethod.BOTH
  ) {
    return employeeSetting;
  }
  const prefs = (orgAttendancePrefs ?? {}) as { attendanceMethod?: unknown };
  return PUNCH_METHODS.includes(prefs.attendanceMethod as PunchMethod)
    ? (prefs.attendanceMethod as PunchMethod)
    : 'BOTH';
}

/** Whether the app may record a punch for this person. */
export const appPunchAllowed = (method: PunchMethod): boolean => method !== 'BIOMETRIC';
