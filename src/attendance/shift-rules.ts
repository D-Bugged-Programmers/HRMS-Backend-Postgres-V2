// Purpose: Gender-wise shift timings (Organization Structure > Work Schedules > Shift rules) and how they combine with
//   the department's shift.
// Responsibilities: pickShiftRule finds the rule that applies to a person; shiftDepartmentFor returns the department's
//   shift fields with that rule's timing laid over them, so resolveShiftConfig and every caller after it needs no change.
// Important: precedence is a rule that names the person, then a gender rule for their own department, then a company-wide
//   gender rule, then the department's shift unchanged. Only the start/end time and (optionally) the break are replaced; weekly offs and thresholds stay the
//   department's.
import type { Gender } from '@prisma/client';
import type { DepartmentShiftFields } from './attendance-shift-config';

export interface ShiftRuleLite {
  gender: Gender | null;
  // Non-empty = a per-person override for exactly these people.
  employeeIds?: string[];
  startTime: string;
  endTime: string;
  breakMinutes: number | null;
  departmentIds: string[];
  // Set for a rule made inside a work schedule: it follows that schedule's departments and does nothing while it has none.
  workScheduleId?: string | null;
  isActive: boolean;
}

export interface ShiftPerson {
  id?: string | null;
  gender?: Gender | null;
  departmentId?: string | null;
}

export function pickShiftRule<T extends ShiftRuleLite>(
  rules: T[] | null | undefined,
  person: ShiftPerson,
): T | null {
  if (!rules?.length) return null;
  // A schedule's own rule with no department yet must not fall through to "every department".
  const live = rules.filter(
    (r) =>
      r.isActive &&
      !(
        r.workScheduleId &&
        !(r.employeeIds ?? []).length &&
        r.departmentIds.length === 0
      ),
  );
  // A rule that names people applies to them alone, whatever their gender or department.
  const named = live.find(
    (r) => !!person.id && (r.employeeIds ?? []).includes(person.id),
  );
  if (named) return named;
  if (!person.gender) return null;
  const mine = live.filter(
    (r) => !(r.employeeIds ?? []).length && r.gender === person.gender,
  );
  return (
    mine.find(
      (r) =>
        person.departmentId && r.departmentIds.includes(person.departmentId),
    ) ??
    mine.find((r) => r.departmentIds.length === 0) ??
    null
  );
}

// A shift that starts after it ends (22:00-06:00) runs past midnight.
const crosses = (start: string, end: string) => end <= start;

export function shiftDepartmentFor<D extends DepartmentShiftFields>(
  department: D | null | undefined,
  person: ShiftPerson,
  rules: ShiftRuleLite[] | null | undefined,
): D | null | undefined {
  const rule = pickShiftRule(rules, {
    ...person,
    departmentId:
      (department as { id?: string } | null)?.id ?? person.departmentId,
  });
  // Without a department there is nothing to lay a rule over (the company default shift applies); a flexible shift has no times
  // to replace.
  if (!rule || !department || department.isFlexibleShift) return department;
  return {
    ...department,
    shiftStartTime: rule.startTime,
    shiftEndTime: rule.endTime,
    breakMinutes: rule.breakMinutes ?? department.breakMinutes,
    crossesMidnight: crosses(rule.startTime, rule.endTime),
  };
}
