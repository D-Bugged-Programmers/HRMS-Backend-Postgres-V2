// Purpose: The single answer to "is overtime being paid?" for the whole backend.
// Important: overtime is paid through the Overtime Pay salary component (code OVERTIME_PAY, see
//   salary-component-defaults.ts) and payroll only runs active components, so that component's Active switch is the
//   switch. When it is off, overtime can never reach a payslip, so logging it, auto-suggesting it from a punch-out and
//   editing its pay rates would only create approved overtime that is never paid. The org preference `enableOvertime`
//   (Organization Settings > Features) is a second switch: off hides and blocks overtime everywhere, whatever the component says.
import type { Prisma } from '@prisma/client';

export const OVERTIME_PAY_CODE = 'OVERTIME_PAY';

export const OVERTIME_PAY_OFF_MESSAGE =
  'Overtime Pay is turned off in payroll, so overtime cannot be logged. Ask HR to turn on the Overtime Pay component in Salary Components.';

// Overtime is on only when BOTH the org's Overtime switch (Organization Settings > Payroll & Attendance > Features, on unless
// switched off) and the Overtime Pay component are on. Every screen and every overtime call asks this one function.
export async function isOvertimePayEnabled(
  db: Pick<Prisma.TransactionClient, 'salaryComponent' | 'organization'>,
  organizationId: string,
): Promise<boolean> {
  const org = await db.organization.findFirst({
    where: { id: organizationId },
    select: { orgPayrollAttendancePrefs: true },
  });
  const prefs = (org?.orgPayrollAttendancePrefs ?? {}) as {
    enableOvertime?: boolean;
  };
  if (prefs.enableOvertime === false) return false;
  const active = await db.salaryComponent.count({
    where: { organizationId, code: OVERTIME_PAY_CODE, isActive: true },
  });
  return active > 0;
}

// Just the org's Enable Overtime switch (on unless switched off), without the component check - for screens that must hide
// overtime-only items (the Overtime Pay component, its email template) only when the org has switched it off.
export async function isOvertimeSwitchOn(
  db: Pick<Prisma.TransactionClient, 'organization'>,
  organizationId: string,
): Promise<boolean> {
  const org = await db.organization.findFirst({
    where: { id: organizationId },
    select: { orgPayrollAttendancePrefs: true },
  });
  return ((org?.orgPayrollAttendancePrefs ?? {}) as { enableOvertime?: boolean }).enableOvertime !== false;
}
