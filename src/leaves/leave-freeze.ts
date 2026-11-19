// Purpose: the Leave Freeze rule - after the cut-off day each month, leave dated in the month before can no longer be
//   applied for, edited, cancelled, approved or rejected by employees and managers (Admin and HR can still change it).
// Why: payroll for the previous month runs a few days into the new month; the leave it reads must stop moving first.
// Important: Policies > leaveFreezeDay is a day of the month, 1-28. Blank = no freeze. With freeze day 2: on 1-2 Nov,
//   October leave is still open; from 3 Nov it is frozen. A leave is judged by its START date (one rule, no month splits).
export function leaveFreezeDayOf(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 28 ? n : null;
}

// First day (YYYY-MM-DD) from which leave is still open. Anything dated before it is frozen. null = no freeze.
export function leaveFreezeCutoff(todayYmd: string, freezeDay: number | null): string | null {
  if (freezeDay === null) return null;
  let year = Number(todayYmd.slice(0, 4));
  let month = Number(todayYmd.slice(5, 7));
  if (Number(todayYmd.slice(8, 10)) <= freezeDay) {
    month -= 1;
    if (month === 0) { month = 12; year -= 1; }
  }
  return `${year}-${String(month).padStart(2, '0')}-01`;
}

export function isLeaveFrozen(startDate: string, todayYmd: string, freezeDay: number | null): boolean {
  const cutoff = leaveFreezeCutoff(todayYmd, freezeDay);
  return cutoff !== null && startDate < cutoff;
}

export function leaveFrozenMessage(startDate: string): string {
  return `Leave for ${startDate.slice(0, 7)} is frozen for payroll and can no longer be applied for, changed, cancelled or decided. Ask HR or an Admin to make the change.`;
}
