// Purpose: asks HR and Admin, in the last two months of the holiday year (November and December unless the company's year starts in
//   another month), to add next year's holidays while the calendar is empty or thin.
// Important: holidays are entered by hand each year, and a missing one makes attendance, leave and payroll treat the day as a
//   working day. Runs daily at 09:00 but only acts on 1 Nov, 1 Dec and 20 Dec (see holiday-calendar-status.ts).
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NotificationCategory, Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { todayInOrgTz } from '../common/org-date';
import { frontendUrl } from '../common/frontend-url';
import { calendarStatus, isReminderDay } from '../holidays/holiday-calendar-status';
import { holidayYearLabel, holidayYearOf, holidayYearRange, readHolidayYearStartMonth } from '../holidays/holiday-year';
import { ReminderNotifier } from './reminder-notifier.service';

@Injectable()
export class HolidayCalendarReminderService {
  private readonly logger = new Logger(HolidayCalendarReminderService.name);

  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly notifier: ReminderNotifier,
  ) {}

  @Cron('0 9 * * *')
  async sendReminders() {
    const organizations = await this.scopedPrisma.organization.findMany({ where: { isActive: true }, select: { id: true, timezone: true } });
    for (const org of organizations) {
      try {
        await this.remindForOrg(org.id, todayInOrgTz(org.timezone));
      } catch (err) {
        this.logger.error(`Holiday calendar reminder failed for org ${org.id}: ${(err as Error).message}`);
      }
    }
  }

  async remindForOrg(organizationId: string, today: string): Promise<number> {
    // The holiday year may run across two calendar years (e.g. April-March): the reminder days and the counts follow the company's setting.
    const org = await this.scopedPrisma.organization.findFirst({ where: { id: organizationId }, select: { policies: true } });
    const startMonth = readHolidayYearStartMonth(org?.policies);
    if (!isReminderDay(today, startMonth)) return 0;
    const year = holidayYearOf(today, startMonth);
    const count = (y: number) => {
      const { from, to } = holidayYearRange(y, startMonth);
      return this.scopedPrisma.holiday.count({ where: { organizationId, date: { gte: from, lte: to }, OR: [{ isActive: true }, { isReference: true }] } });
    };
    const [thisYear, nextYear] = await Promise.all([count(year), count(year + 1)]);
    const status = calendarStatus(today, nextYear, thisYear, startMonth);
    const nextLabel = holidayYearLabel(status.nextYear, startMonth);
    if (!status.due) return 0;

    const users = await this.notifier.activeUsers(organizationId);
    let sent = 0;
    for (const hr of users.filter((u) => u.role === Role.HR || u.role === Role.ADMIN)) {
      const delivered = await this.notifier.send({
        organizationId,
        user: hr,
        occasionKey: 'HOLIDAY_CALENDAR_REMINDER',
        variables: { employeeName: hr.name, nextYear: nextLabel, holidayCount: String(status.nextYearCount), reviewUrl: `${frontendUrl()}/holidays` },
        title: `Add ${nextLabel}'s holidays: ${status.nextYearCount} so far`,
        message: `The ${nextLabel} holiday calendar has ${status.nextYearCount} holiday(s). Add them before the year starts so attendance, leave and payroll are right.`,
        category: NotificationCategory.GENERAL,
        // Each reminder day is its own prompt, even when the count has not changed since the last one.
        dedupeWithinHours: 20,
      });
      if (delivered) sent++;
    }
    return sent;
  }
}
