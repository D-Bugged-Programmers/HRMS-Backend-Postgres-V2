// Purpose: the statutory filing tracker - every PF / ESI / PT / TDS / TDS return (Form 138; 24Q before 1-Apr-2026) / LWF due date around today, whether it has been filed, and a
//   one-click link to the return file for the ones the app can produce (ECR, ESIC, PT).
// Responsibilities: lists the dues from the shared calendar (reminder-dates.ts) with filed / pending / overdue, and records or clears
//   "filed". Does not file anything with the authorities.
// Important: Admin and HR only. The due dates are reminders (the calendar tells HR to confirm the date for their registration category).
import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { Inject } from '@nestjs/common';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { todayInOrgTz } from '../common/org-date';
import { loadDueContext, relevantDues, tdsRecordFor } from './statutory-due-activity';
import { upcomingStatutoryDues } from '../scheduled-reminders/reminder-dates';

type Caller = Omit<User, 'password'>;

const KEYS = ['PF', 'ESI', 'PT', 'TDS', '24Q', 'LWF'];

class MarkFiledDto {
  @IsIn(KEYS) key!: string;
  @Matches(/^\d{4}-\d{2}-\d{2}$/) dueDate!: string;
  @IsBoolean() filed!: boolean;
  /** The date it was paid / filed (YYYY-MM-DD). Required when marking filed. */
  @IsOptional() @Matches(/^\d{4}-\d{2}-\d{2}$/) filedOn?: string;
  /** The challan / TRRN / acknowledgement number. Required when marking filed. */
  @IsOptional() @IsString() @MaxLength(80) reference?: string;
  @IsOptional() @IsNumber() @Min(0) amount?: number;
}

// Salary TDS is recorded on the TDS Compliance page (a challan for a deposit, a statement receipt for a return); the tracker follows those.
const TDS_KEYS = ['TDS', '24Q'];

// The return file for a due, when the app can make one: the contribution month is the month before the due date's month.
const FILE_PATH: Record<string, string> = { PF: 'reports/payroll/pf-ecr', ESI: 'reports/payroll/esic-return', PT: 'reports/payroll/pt-return' };

@ApiTags('reports')
@ApiBearerAuth('access-token')
@Controller('reports/statutory-tracker')
@Roles(Role.ADMIN, Role.HR)
@UseGuards(RolesGuard)
export class StatutoryFilingsController {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient) {}

  @Get()
  async list(@CurrentUser() caller: Caller) {
    const org = await this.prisma.organization.findFirst({ where: { id: caller.organizationId }, select: { timezone: true } });
    const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
    const versions = await this.prisma.statutoryConfigVersion.findMany({
      where: { organizationId: caller.organizationId, isEnabled: true, module: { in: ['PF', 'ESI', 'PT', 'LWF'] }, effectiveFrom: { lte: today }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }] },
      select: { module: true },
    });
    // Look back over the last 14 months so an unfiled overdue filing stays on the list until it is marked filed; only a filed one drops off
    // after 45 days. Dues with nothing behind them (no payroll, no TDS deducted) are left out - see statutory-due-activity.ts.
    const LOOKBACK_MONTHS = 14;
    const window = Array.from({ length: LOOKBACK_MONTHS * 31 + 46 }, (_, i) => i - LOOKBACK_MONTHS * 31);
    const ctx = await loadDueContext(this.prisma, caller.organizationId, Number(today.slice(0, 4)) - 2);
    const dues = relevantDues(
      upcomingStatutoryDues(today, new Set(versions.map((v) => v.module)), window, LOOKBACK_MONTHS),
      ctx,
    );
    const filings = await this.prisma.statutoryFiling.findMany({ where: { organizationId: caller.organizationId } });
    const filed = new Map(filings.map((f) => [`${f.key}|${f.dueDate}`, f]));
    const items = dues.filter((d) => !(filed.has(`${d.key}|${d.dueDate}`) && d.daysLeft < -45)).map((d) => {
      const manual = filed.get(`${d.key}|${d.dueDate}`);
      const fromTds = tdsRecordFor(d, ctx);
      const [y, m] = d.dueDate.split('-').map(Number);
      const contribMonth = m === 1 ? 12 : m - 1;
      const contribYear = m === 1 ? y - 1 : y;
      const isFiled = !!manual || !!fromTds;
      return {
        key: d.key,
        label: d.label,
        period: d.period,
        dueDate: d.dueDate,
        daysLeft: d.daysLeft,
        status: isFiled ? 'filed' : d.daysLeft < 0 ? 'overdue' : 'pending',
        filedAt: manual?.filedAt ?? null,
        // What was recorded: for TDS from the challans / statement on the TDS page, otherwise what HR entered when marking it filed.
        filedOn: fromTds ? fromTds.filedOn : manual?.filedOn ?? null,
        reference: fromTds ? fromTds.reference : manual?.reference ?? '',
        amount: fromTds ? fromTds.amount : manual?.amount ?? null,
        source: fromTds ? 'tds' : manual ? 'manual' : null,
        // Where to record a TDS deposit or return (the tracker does not take those itself).
        recordAt: TDS_KEYS.includes(d.key) ? '/tds-compliance' : null,
        file: FILE_PATH[d.key] ? { path: FILE_PATH[d.key], month: contribMonth, year: contribYear } : null,
      };
    });
    return { items };
  }

  @Post('mark')
  async mark(@Body() dto: MarkFiledDto, @CurrentUser() caller: Caller) {
    const where = { organizationId: caller.organizationId, key: dto.key, dueDate: dto.dueDate };
    if (dto.filed && TDS_KEYS.includes(dto.key)) {
      throw new BadRequestException(
        'Record this on TDS Compliance: a TDS deposit by recording its challan, a return by recording its statement receipt. The tracker then shows it as filed.',
      );
    }
    if (dto.filed) {
      const org = await this.prisma.organization.findFirst({ where: { id: caller.organizationId }, select: { timezone: true } });
      const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
      const reference = (dto.reference ?? '').trim();
      if (!dto.filedOn) throw new BadRequestException('Enter the date it was paid or filed.');
      if (dto.filedOn > today) throw new BadRequestException('The date paid or filed cannot be in the future.');
      if (reference.length < 3) throw new BadRequestException('Enter the challan, payment or acknowledgement number.');
      dto.reference = reference;
      // find-then-create, not upsert: an upsert on the (organizationId, key, dueDate) unique key is refused by the
      // tenant guard, which only allows organizationId filters on findFirst / updateMany / deleteMany.
      const existing = await this.prisma.statutoryFiling.findFirst({ where });
      if (!existing) {
        try {
          await this.prisma.statutoryFiling.create({
            data: { ...where, filedById: caller.id, filedOn: dto.filedOn, reference: dto.reference ?? '', amount: dto.amount ?? null },
          });
        } catch (err) {
          // Two clicks at once: the other request already recorded it, which is the outcome wanted.
          if ((err as { code?: string }).code !== 'P2002') throw err;
        }
      }
    } else {
      await this.prisma.statutoryFiling.deleteMany({ where });
    }
    return { ok: true };
  }
}
