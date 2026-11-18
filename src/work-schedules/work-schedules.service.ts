// Purpose: Named shift templates (Organization Structure > Work Configuration > Work Schedules) and
//   assigning one to a set of departments.
// Responsibilities: CRUD for WorkSchedule; assign() copies startTime/endTime/workingDays/
//   alternateWeeklyOffs/breakMinutes onto each selected department's own shiftStartTime/shiftEndTime/
//   weeklyOffs/breakMinutes (what AttendanceService actually reads — see attendance-shift-config.ts) and
//   sets Department.workScheduleId for traceability, replace semantics (exact target set).
import { shiftConsistencyError } from '../attendance/shift-hours';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditModule, Prisma } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AttendanceService } from '../attendance/attendance.service';
import type { WeeklyOffEntry } from '../attendance/attendance-shift-config';
import {
  CreateWorkScheduleDto,
  AlternateWeeklyOffDto,
} from './dto/create-work-schedule.dto';
import { UpdateWorkScheduleDto } from './dto/update-work-schedule.dto';
import { AssignWorkScheduleDto } from './dto/assign-work-schedule.dto';
import { wrapAll } from '../common/pagination';

type Actor = { id: string };

// A day off every week (not in workingDays, and not one of the alternate
// days) is a plain number entry; an alternate day becomes the richer
// { day, occurrences } entry instead of "off every week" — see
// attendance-shift-config.ts's WeeklyOffEntry.
export function computeWeeklyOffs(
  workingDays: number[],
  alternateWeeklyOffs: AlternateWeeklyOffDto[],
): WeeklyOffEntry[] {
  const alternateDays = new Set(alternateWeeklyOffs.map((a) => a.day));
  const plainOffs = [0, 1, 2, 3, 4, 5, 6].filter(
    (day) => !workingDays.includes(day) && !alternateDays.has(day),
  );
  return [...plainOffs, ...alternateWeeklyOffs];
}

// A day can't simultaneously be "always worked" (in workingDays) and
// "alternately off" (in alternateWeeklyOffs) — that's a direct
// contradiction, so reject it rather than silently picking a winner.
function validateNoOverlap(
  workingDays: number[],
  alternateWeeklyOffs: AlternateWeeklyOffDto[],
) {
  const overlap = alternateWeeklyOffs.find((a) => workingDays.includes(a.day));
  if (overlap) {
    throw new BadRequestException(
      `Day ${overlap.day} can't be both a working day and an alternate off day.`,
    );
  }
}

// The longest shift (start to end, a shift past midnight included) a schedule may have. A typo such as 03:30-19:30
// would otherwise save and then turn every normal working day into a half-day against the minimum-hours rule.
export const MAX_SHIFT_HOURS = 12;

// Placeholder times stored for a flexible shift (no real start or end).
export const FLEX_START = '00:00';
export const FLEX_END = '23:59';

// The allowed working window of a flexible shift: both times or neither (neither = any time of day). Returns what to store.
export function flexibleWindow(
  start: string | null | undefined,
  end: string | null | undefined,
  full: number,
  breakMinutes: number,
): { startTime: string; endTime: string } {
  const hasStart = !!start;
  const hasEnd = !!end;
  if (!hasStart && !hasEnd) return { startTime: FLEX_START, endTime: FLEX_END };
  if (hasStart !== hasEnd) {
    throw new BadRequestException(
      'Give both the allowed start and end time, or leave both blank for any time.',
    );
  }
  const [sh, sm] = (start as string).split(':').map(Number);
  const [eh, em] = (end as string).split(':').map(Number);
  const span = eh * 60 + em - (sh * 60 + sm);
  if (span <= 0) {
    throw new BadRequestException(
      'The allowed window must end after it starts, on the same day.',
    );
  }
  if (span < full * 60 + breakMinutes) {
    throw new BadRequestException(
      'The allowed window is shorter than the full-day hours plus the break.',
    );
  }
  return { startTime: start as string, endTime: end as string };
}

function validateFlexibleHours(
  full: number | undefined,
  half: number | undefined,
  breakMinutes: number,
) {
  if (full === undefined || half === undefined) {
    throw new BadRequestException(
      'A flexible shift needs the full-day hours and the half-day hours.',
    );
  }
  if (half >= full)
    throw new BadRequestException(
      'Half-day hours must be less than the full-day hours.',
    );
  if (breakMinutes >= full * 60)
    throw new BadRequestException(
      'The break must be shorter than the full-day hours.',
    );
}

export function shiftHours(startTime: string, endTime: string): number {
  const toMinutes = (t: string) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const span =
    (toMinutes(endTime) - toMinutes(startTime) + 24 * 60) % (24 * 60);
  return span / 60;
}

function validateShiftLength(startTime: string, endTime: string) {
  if (shiftHours(startTime, endTime) > MAX_SHIFT_HOURS) {
    throw new BadRequestException(
      `A shift can be at most ${MAX_SHIFT_HOURS} hours long (${startTime} to ${endTime} is longer).`,
    );
  }
}

// The break (0 = none) must be shorter than the shift it sits in.
function validateBreak(
  startTime: string,
  endTime: string,
  breakMinutes: number,
) {
  const problem = shiftConsistencyError({ startTime, endTime, breakMinutes });
  if (problem) throw new BadRequestException(problem);
}

@Injectable()
export class WorkSchedulesService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly auditLogService: AuditLogService,
    private readonly attendanceService: AttendanceService,
  ) {}

  async findAll(organizationId: string) {
    const data = await this.scopedPrisma.workSchedule.findMany({
      where: { organizationId },
      include: {
        departments: { select: { id: true, name: true } },
      },
      orderBy: { name: 'asc' },
    });
    return wrapAll(data);
  }

  private async findOrThrow(id: string, organizationId: string) {
    const schedule = await this.scopedPrisma.workSchedule.findFirst({
      where: { id, organizationId },
    });
    if (!schedule) throw new NotFoundException('Work schedule not found.');
    return schedule;
  }

  async create(
    dto: CreateWorkScheduleDto,
    organizationId: string,
    actor: Actor,
  ) {
    const alternateWeeklyOffs = dto.alternateWeeklyOffs ?? [];
    validateNoOverlap(dto.workingDays, alternateWeeklyOffs);
    const flexible = dto.isFlexible === true;
    let flexWindow = { startTime: FLEX_START, endTime: FLEX_END };
    if (flexible) {
      validateFlexibleHours(
        dto.flexFullDayHours,
        dto.flexHalfDayHours,
        dto.breakMinutes,
      );
      flexWindow = flexibleWindow(
        dto.startTime,
        dto.endTime,
        dto.flexFullDayHours as number,
        dto.breakMinutes,
      );
    } else {
      validateShiftLength(dto.startTime as string, dto.endTime as string);
      validateBreak(
        dto.startTime as string,
        dto.endTime as string,
        dto.breakMinutes,
      );
    }

    const schedule = await this.scopedPrisma.workSchedule.create({
      data: {
        organizationId,
        name: dto.name.trim(),
        workingDays: dto.workingDays,
        // A flexible shift has no times: placeholders keep every time-based calculation inside one calendar day.
        startTime: flexible ? flexWindow.startTime : (dto.startTime as string),
        endTime: flexible ? flexWindow.endTime : (dto.endTime as string),
        isFlexible: flexible,
        flexFullDayHours: flexible ? dto.flexFullDayHours : null,
        flexHalfDayHours: flexible ? dto.flexHalfDayHours : null,
        breakMinutes: dto.breakMinutes,
        alternateWeeklyOffs:
          alternateWeeklyOffs as unknown as Prisma.InputJsonValue,
        isActive: dto.isActive ?? true,
      },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'WORK_SCHEDULE_CREATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: schedule.id,
      details: { name: schedule.name },
    });

    return schedule;
  }

  async update(
    id: string,
    dto: UpdateWorkScheduleDto,
    organizationId: string,
    actor: Actor,
  ) {
    const existing = await this.findOrThrow(id, organizationId);

    // Validate against the *final* merged shape (existing fields the
    // caller didn't touch, layered under whatever they did send) — a
    // partial update that only changes workingDays still needs to be
    // checked against the schedule's current alternateWeeklyOffs, and
    // vice versa.
    const workingDays = dto.workingDays ?? (existing.workingDays as number[]);
    const alternateWeeklyOffs =
      dto.alternateWeeklyOffs ??
      (existing.alternateWeeklyOffs as unknown as AlternateWeeklyOffDto[]);
    validateNoOverlap(workingDays, alternateWeeklyOffs);
    const flexible = dto.isFlexible ?? existing.isFlexible;
    let flexWindow = { startTime: FLEX_START, endTime: FLEX_END };
    if (flexible) {
      const fullHours =
        dto.flexFullDayHours ?? existing.flexFullDayHours ?? undefined;
      validateFlexibleHours(
        fullHours,
        dto.flexHalfDayHours ?? existing.flexHalfDayHours ?? undefined,
        dto.breakMinutes ?? existing.breakMinutes,
      );
      // The window: what was sent (blank = any time), else the schedule's own when it was already flexible, else any time.
      const sent = dto.startTime !== undefined || dto.endTime !== undefined;
      flexWindow = flexibleWindow(
        sent
          ? dto.startTime
          : existing.isFlexible
            ? existing.startTime
            : undefined,
        sent ? dto.endTime : existing.isFlexible ? existing.endTime : undefined,
        fullHours as number,
        dto.breakMinutes ?? existing.breakMinutes,
      );
    }
    // Only when the shift times are being changed, so an older schedule can still be renamed or reassigned.
    if (
      !flexible &&
      (dto.startTime !== undefined || dto.endTime !== undefined)
    ) {
      validateShiftLength(
        dto.startTime ?? existing.startTime,
        dto.endTime ?? existing.endTime,
      );
    }
    if (
      !flexible &&
      (dto.startTime !== undefined ||
        dto.endTime !== undefined ||
        dto.breakMinutes !== undefined)
    ) {
      validateBreak(
        dto.startTime ?? existing.startTime,
        dto.endTime ?? existing.endTime,
        dto.breakMinutes ?? existing.breakMinutes,
      );
    }

    await this.scopedPrisma.workSchedule.updateMany({
      where: { id, organizationId },
      data: {
        ...(dto.name !== undefined && { name: dto.name.trim() }),
        ...(dto.workingDays !== undefined && { workingDays: dto.workingDays }),
        ...(flexible
          ? {
              startTime: flexWindow.startTime,
              endTime: flexWindow.endTime,
              isFlexible: true,
              flexFullDayHours:
                dto.flexFullDayHours ?? existing.flexFullDayHours,
              flexHalfDayHours:
                dto.flexHalfDayHours ?? existing.flexHalfDayHours,
            }
          : {
              ...(dto.startTime !== undefined && { startTime: dto.startTime }),
              ...(dto.endTime !== undefined && { endTime: dto.endTime }),
              ...(dto.isFlexible === false && {
                isFlexible: false,
                flexFullDayHours: null,
                flexHalfDayHours: null,
              }),
            }),
        ...(dto.breakMinutes !== undefined && {
          breakMinutes: dto.breakMinutes,
        }),
        ...(dto.alternateWeeklyOffs !== undefined && {
          alternateWeeklyOffs:
            dto.alternateWeeklyOffs as unknown as Prisma.InputJsonValue,
        }),
        ...(dto.isActive !== undefined && { isActive: dto.isActive }),
      },
    });

    // Departments already assigned this schedule keep following it — if
    // the shift times/working days/alternate pattern changed, re-propagate
    // so they don't silently drift from what the schedule now says.
    const updated = await this.findOrThrow(id, organizationId);
    if (
      dto.startTime !== undefined ||
      dto.endTime !== undefined ||
      dto.isFlexible !== undefined ||
      dto.flexFullDayHours !== undefined ||
      dto.flexHalfDayHours !== undefined ||
      dto.workingDays !== undefined ||
      dto.alternateWeeklyOffs !== undefined ||
      dto.breakMinutes !== undefined
    ) {
      await this.scopedPrisma.department.updateMany({
        where: { organizationId, workScheduleId: id },
        data: {
          shiftStartTime: updated.startTime,
          shiftEndTime: updated.endTime,
          isFlexibleShift: updated.isFlexible,
          ...(updated.isFlexible &&
          updated.flexFullDayHours != null &&
          updated.flexHalfDayHours != null
            ? {
                minHoursForPresent: updated.flexFullDayHours,
                minHoursForHalfDay: updated.flexHalfDayHours,
              }
            : {}),
          weeklyOffs: computeWeeklyOffs(
            updated.workingDays as number[],
            updated.alternateWeeklyOffs as unknown as AlternateWeeklyOffDto[],
          ),
          breakMinutes: updated.breakMinutes,
        },
      });
      // Their shift / weekly offs changed: re-judge this month's saved attendance under the new rules.
      const affected = await this.scopedPrisma.department.findMany({
        where: { organizationId, workScheduleId: id },
        select: { id: true },
      });
      void this.attendanceService.rederiveCurrentMonth(
        organizationId,
        affected.map((d) => d.id),
        actor.id,
      );
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'WORK_SCHEDULE_UPDATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: id,
      details: { name: updated.name },
    });

    return updated;
  }

  async delete(id: string, organizationId: string, actor: Actor) {
    const schedule = await this.findOrThrow(id, organizationId);

    // Blocked while any department is still assigned to it — like every
    // other master-data delete in the app, instead of silently unlinking
    // departments out from under whoever set this up.
    const assignedDepartments = await this.scopedPrisma.department.findMany({
      where: { organizationId, workScheduleId: id },
      select: { name: true },
    });
    if (assignedDepartments.length > 0) {
      throw new ConflictException(
        `This work schedule is assigned to ${assignedDepartments.length} department(s) (${assignedDepartments.map((d) => d.name).join(', ')}) and can't be deleted — reassign them first.`,
      );
    }
    // The schedule's own shift rules go with it.
    await this.scopedPrisma.shiftRule.deleteMany({
      where: { organizationId, workScheduleId: id },
    });
    await this.scopedPrisma.workSchedule.deleteMany({
      where: { id, organizationId },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'WORK_SCHEDULE_DELETED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: id,
      details: { name: schedule.name },
    });

    return { success: true, message: 'Work schedule deleted' };
  }

  async assign(
    id: string,
    dto: AssignWorkScheduleDto,
    organizationId: string,
    actor: Actor,
  ) {
    const schedule = await this.findOrThrow(id, organizationId);

    if (dto.departmentIds.length > 0) {
      const found = await this.scopedPrisma.department.count({
        where: { id: { in: dto.departmentIds }, organizationId },
      });
      if (found !== dto.departmentIds.length) {
        throw new BadRequestException(
          'One or more departments were not found.',
        );
      }
    }

    const weeklyOffs = computeWeeklyOffs(
      schedule.workingDays as number[],
      schedule.alternateWeeklyOffs as unknown as AlternateWeeklyOffDto[],
    );

    // Replace semantics: unassign every department currently on this
    // schedule that isn't in the new list, then assign (+ propagate shift
    // fields to) every department in the new list — a single call always
    // leaves exactly dto.departmentIds assigned, regardless of prior state.
    await this.scopedPrisma.department.updateMany({
      where: {
        organizationId,
        workScheduleId: id,
        id: { notIn: dto.departmentIds },
      },
      data: { workScheduleId: null },
    });

    if (dto.departmentIds.length > 0) {
      await this.scopedPrisma.department.updateMany({
        where: { organizationId, id: { in: dto.departmentIds } },
        data: {
          workScheduleId: id,
          shiftStartTime: schedule.startTime,
          shiftEndTime: schedule.endTime,
          isFlexibleShift: schedule.isFlexible,
          ...(schedule.isFlexible &&
          schedule.flexFullDayHours != null &&
          schedule.flexHalfDayHours != null
            ? {
                minHoursForPresent: schedule.flexFullDayHours,
                minHoursForHalfDay: schedule.flexHalfDayHours,
              }
            : {}),
          weeklyOffs: weeklyOffs,
          breakMinutes: schedule.breakMinutes,
        },
      });
      void this.attendanceService.rederiveCurrentMonth(
        organizationId,
        dto.departmentIds,
        actor.id,
      );
    }
    // The schedule's own shift rules follow the departments it is now assigned to.
    await this.scopedPrisma.shiftRule.updateMany({
      // Only gender rules follow the schedule's departments; a rule for named people covers its people wherever they work.
      where: { organizationId, workScheduleId: id, employeeIds: { isEmpty: true } },
      data: { departmentIds: dto.departmentIds },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'WORK_SCHEDULE_ASSIGNED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      targetId: id,
      details: {
        name: schedule.name,
        departmentCount: dto.departmentIds.length,
      },
    });

    return this.findOrThrow(id, organizationId);
  }
}
