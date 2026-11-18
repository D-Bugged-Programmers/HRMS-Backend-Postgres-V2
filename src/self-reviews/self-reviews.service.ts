// Purpose: the employee's self-review for the current financial year, and the manager's evaluation of it.
// Responsibilities: one SelfReview per (employee, financial year) - a new financial year is simply a new row, so the review
//   "resets" every appraisal cycle with no job. The employee can re-save while it is SUBMITTED; evaluate() records the manager's
//   rating through PerformanceRatingsService.upsert (so every existing scope / approval rule applies) and locks the review (REVIEWED).
import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, Role, SelfReviewStatus, User } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { getFinancialYear } from '../payroll-settings/financial-year';
import { PerformanceRatingsService } from '../performance-ratings/performance-ratings.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SaveSelfReviewDto } from './dto/save-self-review.dto';
import { EvaluateSelfReviewDto } from './dto/evaluate-self-review.dto';

type Actor = Omit<User, 'password'>;

const EMPLOYEE_SELECT = { id: true, name: true, employeeId: true, designation: true } as const;

@Injectable()
export class SelfReviewsService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient,
    private readonly ratings: PerformanceRatingsService,
    private readonly notifications: NotificationsService,
  ) {}

  /** The organisation's current financial year (its start month is a payroll setting, default April). */
  async currentFinancialYear(organizationId: string): Promise<string> {
    const settings = await this.prisma.payrollSettings.findFirst({ where: { organizationId }, select: { financialYearStartMonth: true } });
    const now = new Date();
    return getFinancialYear(now.getUTCMonth() + 1, now.getUTCFullYear(), settings?.financialYearStartMonth ?? 4);
  }

  async getMine(actor: Actor) {
    const financialYear = await this.currentFinancialYear(actor.organizationId);
    const review = await this.prisma.selfReview.findFirst({
      where: { organizationId: actor.organizationId, employeeId: actor.id, financialYear },
    });
    return { financialYear, review, locked: review?.status === SelfReviewStatus.REVIEWED };
  }

  async saveMine(dto: SaveSelfReviewDto, actor: Actor) {
    const organizationId = actor.organizationId;
    const financialYear = await this.currentFinancialYear(organizationId);
    const existing = await this.prisma.selfReview.findFirst({ where: { organizationId, employeeId: actor.id, financialYear } });
    if (existing?.status === SelfReviewStatus.REVIEWED) {
      throw new ConflictException('Your manager has already reviewed this year\'s self-review, so it can no longer be edited.');
    }
    const data = {
      // An omitted answer keeps what was saved before (a partial save never wipes an answer).
      proud: dto.proud?.trim() ?? existing?.proud ?? '',
      grow: dto.grow?.trim() ?? existing?.grow ?? '',
      selfRating: dto.selfRating,
      impact: dto.impact?.trim() ?? existing?.impact ?? '',
      support: dto.support?.trim() ?? existing?.support ?? '',
    };
    if (existing) {
      await this.prisma.selfReview.updateMany({ where: { id: existing.id, organizationId, status: SelfReviewStatus.SUBMITTED }, data: { ...data, submittedAt: new Date() } });
    } else {
      await this.prisma.selfReview.create({ data: { organizationId, employeeId: actor.id, financialYear, ...data } });
      await this.notifyManager(actor);
    }
    return this.getMine(actor);
  }

  private async notifyManager(actor: Actor) {
    if (!actor.reportingManagerId) return;
    await this.notifications.create({
      organizationId: actor.organizationId,
      userId: actor.reportingManagerId,
      title: 'Self-review submitted',
      message: `${actor.name} has submitted their self-review. Open Team reviews to evaluate it.`,
      category: 'GENERAL',
    });
  }

  /** The people whose reviews this actor evaluates: a manager's own department and direct reports, everyone for HR/Admin. */
  private async scopeWhere(actor: Actor): Promise<Prisma.SelfReviewWhereInput> {
    const base: Prisma.SelfReviewWhereInput = { organizationId: actor.organizationId, employeeId: { not: actor.id } };
    if (actor.role === Role.MANAGER) {
      const people = await this.prisma.user.findMany({
        where: {
          organizationId: actor.organizationId,
          OR: [...(actor.departmentId !== null ? [{ departmentId: actor.departmentId }] : []), { reportingManagerId: actor.id }],
        },
        select: { id: true },
      });
      return { ...base, employeeId: { in: people.map((p) => p.id).filter((id) => id !== actor.id) } };
    }
    return base;
  }

  async listTeam(actor: Actor, financialYear?: string) {
    const fy = financialYear ?? (await this.currentFinancialYear(actor.organizationId));
    const where = { ...(await this.scopeWhere(actor)), financialYear: fy };
    const rows = await this.prisma.selfReview.findMany({
      where,
      include: { employee: { select: EMPLOYEE_SELECT } },
      orderBy: [{ status: 'asc' }, { submittedAt: 'desc' }],
    });
    const ratings = await this.prisma.performanceRating.findMany({
      where: { organizationId: actor.organizationId, financialYear: fy, employeeId: { in: rows.map((r) => r.employeeId) } },
      select: { employeeId: true, rating: true, notes: true, status: true },
    });
    const byEmployee = new Map(ratings.map((r) => [r.employeeId, r]));
    return { financialYear: fy, data: rows.map((r) => ({ ...r, managerRating: byEmployee.get(r.employeeId) ?? null })) };
  }

  async evaluate(id: string, dto: EvaluateSelfReviewDto, actor: Actor) {
    const organizationId = actor.organizationId;
    const review = await this.prisma.selfReview.findFirst({ where: { id, organizationId } });
    if (!review) throw new NotFoundException('Self-review not found.');
    if (review.employeeId === actor.id) throw new ForbiddenException('You cannot evaluate your own self-review.');
    const inScope = await this.prisma.selfReview.findFirst({ where: { id, ...(await this.scopeWhere(actor)) }, select: { id: true } });
    if (!inScope) throw new ForbiddenException('You can only evaluate the self-reviews of your own team.');
    if (review.status === SelfReviewStatus.REVIEWED) throw new ConflictException('This self-review has already been evaluated.');

    // The manager's rating goes through the existing rating flow (department scope, HR approval before it is published).
    await this.ratings.upsert(
      { employeeId: review.employeeId, financialYear: review.financialYear, rating: dto.rating, notes: dto.notes },
      actor,
      organizationId,
    );
    await this.prisma.selfReview.updateMany({
      where: { id, organizationId, status: SelfReviewStatus.SUBMITTED },
      data: { status: SelfReviewStatus.REVIEWED, evaluatedById: actor.id, evaluatedAt: new Date() },
    });
    await this.notifications.create({
      organizationId,
      userId: review.employeeId,
      title: 'Self-review reviewed',
      message: 'Your manager has reviewed your self-review. It is now closed for this year.',
      category: 'GENERAL',
    });
    return this.prisma.selfReview.findFirstOrThrow({ where: { id, organizationId }, include: { employee: { select: EMPLOYEE_SELECT } } });
  }
}
