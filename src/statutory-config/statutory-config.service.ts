// Purpose: Versioned, effective-dated statutory config (PF/ESI/PT/LWF/NPS/Gratuity/Bonus/Income
// Tax/Employer Insurance) per module, with the read path PayrollService relies on to resolve "what applied
// on this date."
// Responsibilities: Owns getEffective() (cached point-in-time resolution) and create()/remove() version
// management, closing out the currently-open version's effectiveTo when a new one starts and reopening it
// if the newer one is deleted; seedDefaults() pre-populates all 9 modules at registration.
// Important: getEffective() is cached (5 min TTL, invalidated on every write) because it's hit once per
// module per employee inside a full payroll batch — O(9xN) lookups of data that rarely changes. remove()
// only allows deleting a future-dated version — past/current versions are permanent history — and refuses
// to delete the last remaining version for a module.
import { summariseModules } from './statutory-summary';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { GRATUITY_COVERAGE_HEADCOUNT } from '../settlements/gratuity-math';
import {
  PayrollRunStatus,
  Prisma,
  StatutoryConfigVersion,
  StatutoryModule,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { RedisCacheService } from '../common/redis-cache';
import {
  dayBefore,
  localDateStr,
} from '../employee-salary-components/salary-structure-math';
import { CreateStatutoryConfigVersionDto } from './dto/create-statutory-config-version.dto';
import {
  SEED_DEFAULTS,
  validateModuleConfig,
} from './statutory-config-validation';
import { AuditLogService } from '../audit-log/audit-log.service';
import { ApplyStatutorySetupDto } from './dto/apply-statutory-setup.dto';
import {
  compulsorySkipped,
  planSetup,
  suggestedAnswers,
} from './statutory-setup';

import { dmyText } from '../payroll/format-date';
// The deduction/contribution modules - "statutory not set up" means none of these is on.
const SETUP_MODULES: StatutoryModule[] = [
  StatutoryModule.PF,
  StatutoryModule.ESI,
  StatutoryModule.PT,
  StatutoryModule.LWF,
  StatutoryModule.GRATUITY,
  StatutoryModule.BONUS,
];

// getEffective() is hit once per statutory module (9) per employee inside
// PayrollService.calculatePayroll — a full payroll batch does O(9xN)
// lookups of data that changes maybe a few times a year. Cached briefly
// with invalidation on every write (create/remove), so a batch run
// collapses to effectively one DB read per distinct (module, date)
// instead of one per employee.
const EFFECTIVE_CACHE_TTL_SECONDS = 300;

@Injectable()
export class StatutoryConfigService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly cache: RedisCacheService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private async getOrgTimezone(
    organizationId: string,
    db:
      | Pick<ExtendedPrismaClient, 'organization'>
      | Prisma.TransactionClient = this.scopedPrisma,
  ): Promise<string> {
    const org = await db.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    return org?.timezone ?? 'Asia/Kolkata';
  }

  private effectiveCacheKeyPrefix(
    organizationId: string,
    module: StatutoryModule,
  ): string {
    return `statconfig:${organizationId}:${module}:`;
  }

  // Every new org gets all 9 modules pre-seeded (most disabled,
  // payroll_calendar/rounding always enabled) so the payroll engine's
  // period-aware resolution has a row to resolve from day one — called
  // from AuthService.register()'s existing transaction.
  async seedDefaults(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    const today = localDateStr(await this.getOrgTimezone(organizationId, tx));
    for (const module of Object.values(StatutoryModule)) {
      const { config, isEnabled } = SEED_DEFAULTS[module];
      await tx.statutoryConfigVersion.create({
        data: {
          organizationId,
          module,
          effectiveFrom: today,
          config: config,
          isEnabled,
        },
      });
    }
  }

  getHistory(module: StatutoryModule, organizationId: string) {
    return this.scopedPrisma.statutoryConfigVersion.findMany({
      where: { organizationId, module },
      orderBy: { effectiveFrom: 'desc' },
    });
  }

  async getEffective(
    module: StatutoryModule,
    dateParam: string | undefined,
    organizationId: string,
  ) {
    const date =
      dateParam ?? localDateStr(await this.getOrgTimezone(organizationId));
    const key = `${this.effectiveCacheKeyPrefix(organizationId, module)}${date}`;
    return this.cache.getOrSet(key, EFFECTIVE_CACHE_TTL_SECONDS, async () => {
      const version = await this.scopedPrisma.statutoryConfigVersion.findFirst({
        where: {
          organizationId,
          module,
          effectiveFrom: { lte: date },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }],
        },
        orderBy: { effectiveFrom: 'desc' },
      });
      return { date, version };
    });
  }

  // A version effective in (or before) a month the org has already
  // finalized payroll for can never reach those payslips - locked runs are
  // not recalculated - so it used to be accepted and silently ignored for
  // them. Rejected instead, same rule as a backdated salary revision.
  private async assertNotFinalized(
    module: StatutoryModule,
    effectiveFrom: string,
    organizationId: string,
  ) {
    const fromYear = Number(effectiveFrom.slice(0, 4));
    const fromMonth = Number(effectiveFrom.slice(5, 7));
    const finalized = await this.scopedPrisma.payrollRun.findFirst({
      where: {
        organizationId,
        status: { in: [PayrollRunStatus.LOCKED, PayrollRunStatus.PAID] },
        OR: [
          { year: { gt: fromYear } },
          { year: fromYear, month: { gte: fromMonth } },
        ],
      },
      orderBy: [{ year: 'asc' }, { month: 'asc' }],
      select: { month: true, year: true },
    });
    if (finalized) {
      throw new BadRequestException(
        `Cannot add a ${module} version effective ${dmyText(effectiveFrom)}: payroll for ${finalized.month}/${finalized.year} is already locked or paid. Choose an effective date after the last finalized payroll month, or unlock those payroll runs first.`,
      );
    }
  }

  async create(
    module: StatutoryModule,
    dto: CreateStatutoryConfigVersionDto,
    actorId: string,
    organizationId: string,
  ): Promise<StatutoryConfigVersion> {
    try {
      validateModuleConfig(module, dto.config);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }

    const duplicate = await this.scopedPrisma.statutoryConfigVersion.findFirst({
      where: { organizationId, module, effectiveFrom: dto.effectiveFrom },
    });
    if (duplicate) {
      throw new ConflictException(
        `A version for ${module} already starts on ${dmyText(dto.effectiveFrom)} — edit or delete it instead.`,
      );
    }

    // A new version normally starts after the latest one. A past date (before the latest
    // version) is allowed only before the first payroll run - the set-up case, where history
    // from before go-live is being entered. The version is then slotted
    // into the timeline (below) so ranges never overlap or invert.
    const latest = await this.scopedPrisma.statutoryConfigVersion.findFirst({
      where: { organizationId, module },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (latest && dto.effectiveFrom < latest.effectiveFrom) {
      // Back-dating is for org set-up only: once any payroll run exists (draft included), history is fixed.
      const anyRun = await this.scopedPrisma.payrollRun.findFirst({
        where: { organizationId },
        select: { id: true },
      });
      if (anyRun) {
        throw new BadRequestException(
          `New version must start after the most recent version's effective date (${dmyText(latest.effectiveFrom)}). Past dates can only be added while setting up the organization, before the first payroll run.`,
        );
      }
    }

    await this.assertNotFinalized(module, dto.effectiveFrom, organizationId);

    // The version just before the new date is closed on the day before it; the version just
    // after it (past-date case) bounds the new version's own end date.
    const [prev, next] = await Promise.all([
      this.scopedPrisma.statutoryConfigVersion.findFirst({
        where: {
          organizationId,
          module,
          effectiveFrom: { lt: dto.effectiveFrom },
        },
        orderBy: { effectiveFrom: 'desc' },
      }),
      this.scopedPrisma.statutoryConfigVersion.findFirst({
        where: {
          organizationId,
          module,
          effectiveFrom: { gt: dto.effectiveFrom },
        },
        orderBy: { effectiveFrom: 'asc' },
      }),
    ]);
    // Closing out the current version and creating the new one must commit
    // together — previously these were two independent writes, so a crash/
    // timeout between them left the org with the current version closed but
    // no new one created, i.e. zero active versions for this module. Since
    // getEffective() has nothing to resolve in that state, payroll would
    // silently fail (or fall back incorrectly) for every employee until
    // someone noticed and manually created a new version.
    const created = await this.scopedPrisma.$transaction(async (tx) => {
      if (prev) {
        await tx.statutoryConfigVersion.updateMany({
          where: { id: prev.id, organizationId },
          data: { effectiveTo: dayBefore(dto.effectiveFrom) },
        });
      }
      return tx.statutoryConfigVersion.create({
        data: {
          organizationId,
          module,
          effectiveFrom: dto.effectiveFrom,
          effectiveTo: next ? dayBefore(next.effectiveFrom) : null,
          config: dto.config as Prisma.InputJsonValue,
          isEnabled: dto.isEnabled ?? true,
          notes: dto.notes ?? '',
          createdById: actorId,
        },
      });
    });
    await this.cache.invalidatePrefix(
      this.effectiveCacheKeyPrefix(organizationId, module),
    );

    await this.auditLogService.log({
      actorId,
      action: 'STATUTORY_CONFIG_VERSION_CREATED',
      module: 'PAYROLL',
      organizationId,
      targetId: created.id,
      details: { module: module, effectiveFrom: dto.effectiveFrom },
    });

    return created;
  }

  async remove(module: StatutoryModule, id: string, organizationId: string) {
    const row = await this.scopedPrisma.statutoryConfigVersion.findFirst({
      where: { id, organizationId, module },
    });
    if (!row)
      throw new NotFoundException('Statutory config version not found.');

    // A version already in force can be deleted only during org set-up (no payroll run yet);
    // a scheduled future one can always be removed.
    const today = localDateStr(await this.getOrgTimezone(organizationId));
    if (row.effectiveFrom <= today) {
      const anyRun = await this.scopedPrisma.payrollRun.findFirst({
        where: { organizationId },
        select: { id: true },
      });
      if (anyRun) {
        throw new BadRequestException(
          'Only a future-dated version can be deleted once payroll has run - past and current versions are permanent history.',
        );
      }
    }

    const count = await this.scopedPrisma.statutoryConfigVersion.count({
      where: { organizationId, module },
    });
    if (count <= 1) {
      throw new BadRequestException(
        'Cannot delete the only version for this module.',
      );
    }

    // Same atomicity concern as create() above — the delete and the reopen
    // of whatever version it had closed out must commit together, or a
    // crash between them leaves a coverage gap at that date.
    await this.scopedPrisma.$transaction([
      this.scopedPrisma.statutoryConfigVersion.deleteMany({
        where: { id, organizationId },
      }),
      this.scopedPrisma.statutoryConfigVersion.updateMany({
        where: {
          organizationId,
          module,
          effectiveTo: dayBefore(row.effectiveFrom),
        },
        // The version before it takes over the deleted one's range (open-ended if it was the latest).
        data: { effectiveTo: row.effectiveTo },
      }),
    ]);

    await this.cache.invalidatePrefix(
      this.effectiveCacheKeyPrefix(organizationId, module),
    );
    return { message: 'Statutory config version deleted' };
  }

  // True when none of PF/ESI/PT/LWF/gratuity/bonus is in force on the date - payslips would carry only TDS.
  async isStatutoryOff(organizationId: string, date?: string) {
    const results = await Promise.all(
      SETUP_MODULES.map((m) => this.getEffective(m, date, organizationId)),
    );
    return !results.some((r) => r.version?.isEnabled);
  }

  // One line per module for the Statutory Compliance Center's tab bar: in force today, and any change already scheduled.
  async getSummary(organizationId: string) {
    const today = localDateStr(await this.getOrgTimezone(organizationId));
    const versions = await this.scopedPrisma.statutoryConfigVersion.findMany({
      where: { organizationId },
      select: {
        module: true,
        effectiveFrom: true,
        effectiveTo: true,
        isEnabled: true,
      },
    });
    return summariseModules(Object.values(StatutoryModule), versions, today);
  }

  // What the guide needs: whether setup is still due, the headcount, and which of PF/ESI/PT to pre-select.
  async getSetupStatus(organizationId: string) {
    const [off, activeEmployees] = await Promise.all([
      this.isStatutoryOff(organizationId),
      this.scopedPrisma.user.count({
        where: { organizationId, isActive: true },
      }),
    ]);
    return {
      needsSetup: off,
      activeEmployees,
      suggested: suggestedAnswers(activeEmployees),
    };
  }

  // Switches on the chosen modules with India defaults from `effectiveFrom`. Modules already on are left alone (never
  // overwrite a customised rate); an untouched default (single, switched-off version) is replaced in place so the
  // start date can reach back to an earlier payroll month; otherwise a new version is added.
  async applySetup(
    dto: ApplyStatutorySetupDto,
    actorId: string,
    organizationId: string,
  ) {
    let plan;
    try {
      plan = planSetup(dto);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    const enabled: StatutoryModule[] = [];
    const alreadyOn: StatutoryModule[] = [];
    for (const item of plan) {
      const versions = await this.scopedPrisma.statutoryConfigVersion.findMany({
        where: { organizationId, module: item.module },
        orderBy: { effectiveFrom: 'desc' },
      });
      const latest = versions[0];
      if (latest?.isEnabled) {
        alreadyOn.push(item.module);
        continue;
      }
      if (versions.length === 1) {
        await this.assertNotFinalized(
          item.module,
          dto.effectiveFrom,
          organizationId,
        );
        await this.scopedPrisma.statutoryConfigVersion.updateMany({
          where: { id: latest.id, organizationId },
          data: {
            effectiveFrom: dto.effectiveFrom,
            effectiveTo: null,
            config: item.config as Prisma.InputJsonValue,
            isEnabled: true,
            notes: 'Set up with the guide',
          },
        });
        await this.cache.invalidatePrefix(
          this.effectiveCacheKeyPrefix(organizationId, item.module),
        );
        await this.auditLogService.log({
          actorId,
          action: 'STATUTORY_CONFIG_VERSION_CREATED',
          module: 'PAYROLL',
          organizationId,
          targetId: latest.id,
          details: { module: item.module, effectiveFrom: dto.effectiveFrom },
        });
      } else {
        await this.create(
          item.module,
          {
            config: item.config as Record<string, unknown>,
            isEnabled: true,
            effectiveFrom: dto.effectiveFrom,
            notes: 'Set up with the guide',
          },
          actorId,
          organizationId,
        );
      }
      enabled.push(item.module);
    }
    return { enabled, alreadyOn, compulsorySkipped: compulsorySkipped(dto) };
  }

  // Active headcount vs the usual ten-employee coverage line of the Payment of Gratuity Act.
  async gratuityCoverageHint(organizationId: string) {
    const activeEmployees = await this.scopedPrisma.user.count({
      where: { organizationId, isActive: true },
    });
    return {
      activeEmployees,
      threshold: GRATUITY_COVERAGE_HEADCOUNT,
      likelyCovered: activeEmployees >= GRATUITY_COVERAGE_HEADCOUNT,
    };
  }
}
