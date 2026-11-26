// Purpose: Generates a letter PDF from an org's LetterTemplate — fetches the real employee/org/computed
//   data a template's dataProfile needs, substitutes it into the template's {{placeholder}} title/body,
//   issues the org's configured document number for it (making Document Numbering's entries actually get
//   used, the same way employeeId/payslip already are), and renders the PDF.
// Important: view-scoped the same way EmployeeTimelineService is — self, or ADMIN/HR see anyone, MANAGER
//   only their own department (enforced here; the self-or-role split itself is the controller's guard).
//   Content is fully admin-authored via LetterTemplatesService — nothing here hardcodes letter wording;
//   only the *shape* of the 4 dataProfiles (BASIC/EXIT/PAYROLL/SETTLEMENT) is fixed, since each names a
//   real prerequisite record (OffboardingCase/PayrollRun/Settlement) that can't be invented from nothing.
import { dateStrInOrgTz } from '../common/org-date';
import { personalEmailOf } from '../common/personal-email';
import { letterRecipientOf } from './letter-recipient';
import {
  ServiceUnavailableException,
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { escapeHtml } from '../email-templates/email-layout';
import {
  AuditModule,
  LetterDataProfile,
  PayrollRunStatus,
  Role,
  User,
  EmploymentStatus,
  NotificationCategory,
} from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { readStoredFile, writeStoredFile } from '../files/file-storage.config';
import { NotificationsService } from '../notifications/notifications.service';
import { sanitizeRichText } from '../letter-templates/rich-text-sanitizer';
import { issueDocumentNumber, LETTER_DOC_TYPE } from '../organizations/document-numbering';
import { formatDateDisplay } from '../payroll/format-date';
import { amountInWords } from '../payroll/number-to-words';
import { todayInOrgTz } from '../common/org-date';
import {
  resolveCurrentRows,
  summarizeStructure,
  synthesizeMissingRows,
} from '../employee-salary-components/salary-structure-math';
import {
  employeeCityClass,
  withCityHra,
} from '../employee-salary-components/city-hra';
import { BrandingLookupService } from '../company-brands/branding-lookup.service';
import { LetterPdfService } from './letter-pdf.service';
import {
  editedTextToParagraphs,
  editedTextToTitle,
  splitRichTextIntoParagraphs,
} from './rich-text-blocks';
import { LetterTemplatesService } from '../letter-templates/letter-templates.service';
import { EmployeeTimelineService } from '../employee-timeline/employee-timeline.service';
import { EmailService } from '../notifications/email.service';
import { EmailTemplatesService } from '../email-templates/email-templates.service';
import { inReviewerScope } from '../common/dept-scope';
import { isPlaceholderEmail } from '../common/no-email';

// Hiring-stage letters are for someone joining or working with the company. Once an employee is serving notice or has
// left (resigned, released, terminated, absconded - or their account is inactive) they can no longer be issued one.
const HIRING_LETTER_KEYS = new Set([
  'offerLetter',
  'appointmentLetter',
  'confirmationLetter',
]);
const LEAVING_STATUSES: EmploymentStatus[] = [
  EmploymentStatus.RESIGNED,
  EmploymentStatus.RELEASED,
  EmploymentStatus.TERMINATED,
  EmploymentStatus.ABSCONDED,
];
const HIRING_LETTER_BLOCKED_REASON =
  'Not available once the employee has resigned, is serving notice or has left the organization.';
function hiringLetterBlocked(
  key: string,
  employee: { employmentStatus: EmploymentStatus; isActive: boolean },
): boolean {
  return (
    HIRING_LETTER_KEYS.has(key) &&
    (!employee.isActive || LEAVING_STATUSES.includes(employee.employmentStatus))
  );
}

import {
  LETTER_STAGES,
  currentLetterStage,
  letterFlowOrder,
  letterFlowStatus,
  stageOfTemplate,
  type IssuedLetter,
  type LetterFlowStatus,
  type LetterStage,
} from './letter-stages';

type Actor = Omit<User, 'password'>;

// Letters about a particular event in someone's employment. On the employee's own My Letters they are offered only
// once that event is on record (a confirmed employee with no promotion used to see a "Ready" promotion letter); HR and
// Admin can still prepare them for someone else beforehand.
const EVENT_LETTER_REASON: Record<string, string> = {
  promotionLetter: 'Available once a promotion is recorded for you.',
  transferLetter: 'Available once a transfer is recorded for you.',
  probationExtensionLetter: 'Available once your probation is extended.',
  confirmationLetter: 'Available once you are confirmed.',
  letterOfIntent: 'Issued before joining only.',
};

const MONTHS = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export const LETTER_HR_AUTHORISATION_REASON = 'HR authorization is needed for this letter — ask HR to make it available to you.';

// Whether a visibility grant lets its holder have the letter. For a Manager's OWN non-payroll letter the grant must be a decision
// someone else made in the app (every in-app switch records who made it, and only HR/Admin actions make one). The one-off
// migration that made existing letters visible recorded nobody, so it is not HR authorisation for a manager to produce an
// official letter about themselves. Pay and settlement letters, employees, and HR/Admin are as before.
export function grantAllows(
  grant: { enabled: boolean; enabledById?: string | null } | null | undefined,
  actor: { id: string; role: Role },
  employeeId: string,
  dataProfile: LetterDataProfile,
): boolean {
  if (!grant?.enabled) return false;
  const managerOwnLetter = actor.role === Role.MANAGER && actor.id === employeeId;
  if (!managerOwnLetter || dataProfile === LetterDataProfile.PAYROLL || dataProfile === LetterDataProfile.SETTLEMENT) return true;
  return !!grant.enabledById && grant.enabledById !== employeeId;
}

const PAID_OUT_STATUSES: PayrollRunStatus[] = [
  PayrollRunStatus.APPROVED,
  PayrollRunStatus.LOCKED,
  PayrollRunStatus.PAID,
];

// Disciplinary/sensitive letter keys, flagged to HR/Admin/Manager as restricted. Every letter starts hidden from the person
// it belongs to until HR/Admin grant it through EmployeeLetterAccess (see setEmployeeAccess below and ownerRulesApply).
const RESTRICTED_LETTER_KEYS = new Set([
  'warningLetter',
  'suspensionLetter',
  'showCauseNotice',
]);
export const LETTER_NOT_ISSUED_REASON = 'No letter of this kind has been issued to you.';

// Letters that only mean something once one has really been issued: the disciplinary stage (including a company's own
// templates placed there) and termination. An active template or a visibility grant alone is not such a letter.
const isDisciplinaryLetter = (t: { key: string; isCustom: boolean; journeyStage?: string | null }) =>
  RESTRICTED_LETTER_KEYS.has(t.key) || t.key === 'terminationLetter' || stageOfTemplate(t) === 'DISCIPLINARY';

// Who gets a letter only once HR/Admin have made it visible to its owner: an Employee, and a Manager looking at their OWN
// letters (a manager is the subject there, not the person who decides what is released). What a Manager may do with the
// letters of the people they look after is unchanged, and so is HR/Admin access.
const ownerRulesApply = (actor: { id: string; role: Role }, employeeId: string) =>
  actor.role === Role.EMPLOYEE || (actor.role === Role.MANAGER && actor.id === employeeId);

const EMPLOYEE_HISTORY_ACTIONS = ['LETTER_ISSUED', 'LETTER_EMAILED', 'LETTER_ACKNOWLEDGED', 'LETTER_APPROVED', 'LETTER_DECLINED'];
// The letter's paragraphs as the HTML the editor works on: bold / italic / underline kept, everything else shown as plain text.
export function paragraphsToHtml(paragraphs: string[]): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return paragraphs
    .map((p) => `<p>${p.split(/(<\/?(?:b|i|u)>)/i).map((seg) => (/^<\/?(?:b|i|u)>$/i.test(seg) ? seg.toLowerCase() : esc(seg))).join('')}</p>`)
    .join('');
}

const LETTER_FINAL_MESSAGE =
  'This letter was approved and signed by the employee, so it is final and cannot be changed. If something was wrong, issue a new version.';
const LETTER_HISTORY_ACTIONS = ['LETTER_APPROVED', 'LETTER_DECLINED', 'LETTER_VERSION_STARTED', 'LETTER_ISSUE_STARTED', 'LETTER_ISSUED', 'LETTER_EMAILED', 'LETTER_CONTENT_SAVED', 'LETTER_CONTENT_RESET', 'LETTER_ISSUE_DATE_CHANGED', 'LETTER_ACCESS_GRANTED', 'LETTER_ACCESS_REVOKED', 'LETTER_ACKNOWLEDGED'];

// Letters that can be issued again and again (every increment, promotion, warning...). Each issue is stored under its own
// "slot" key - the template key for the first, then "incrementLetter#2", "#3"... - so every one keeps its own date, number,
// saved PDF, wording, visibility switch and confirmation. A custom template opts in with its "can be issued more than once" box.
const RECURRING_BUILTIN_KEYS = new Set([
  'incrementLetter', 'promotionLetter', 'transferLetter', 'warningLetter', 'showCauseNotice', 'suspensionLetter',
  'appreciationLetter', 'salaryCertificate', 'employmentVerificationLetter', 'probationExtensionLetter', 'abscondingNotice',
]);
export const baseKeyOf = (slot: string): string => slot.split('#')[0];
const isRecurringTemplate = (t: { key: string; isCustom: boolean; allowMultiple?: boolean }) =>
  t.isCustom ? !!t.allowMultiple : RECURRING_BUILTIN_KEYS.has(t.key) || !!t.allowMultiple;

// "DP-00005-Appointment Letter.pdf": the employee ID, then the letter's name as HR sees it.
function letterFilename(employeeCode: string, templateName: string): string {
  return `${`${employeeCode}-${templateName}`.replace(/[\\/:*?"<>|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()}.pdf`;
}

// The placeholders each stage-gated profile fills in; in a draft they start as "—" so HR can write the letter before the record exists.
const LENIENT_PLACEHOLDERS: Partial<Record<LetterDataProfile, string[]>> = {
  [LetterDataProfile.EXIT]: ['lastWorkingDay', 'reason', 'noticeDate'],
  [LetterDataProfile.PAYROLL]: ['effectiveFrom', 'month', 'year', 'annualCTC', 'fixedCTC', 'variablePay', 'grossSalary', 'netPay'],
  [LetterDataProfile.SETTLEMENT]: ['lastWorkingDay', 'pendingSalary', 'leaveEncashment', 'bonus', 'gratuity', 'recoveries', 'loanRecovered', 'noticePeriodRecovery', 'totalDeductions', 'netPayable', 'netPayableInWords'],
};

@Injectable()
export class LettersService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly pdfService: LetterPdfService,
    private readonly auditLogService: AuditLogService,
    private readonly letterTemplatesService: LetterTemplatesService,
    private readonly timelineService: EmployeeTimelineService,
    private readonly emailService: EmailService,
    private readonly emailTemplatesService: EmailTemplatesService,
    private readonly brandingLookup: BrandingLookupService,
    private readonly notificationsService: NotificationsService,
  ) {}

  // Event letters are held back on the person's own view (and for an EMPLOYEE looking at anyone).
  private isEventGated(actor: Actor, employeeId: string): boolean {
    return actor.id === employeeId || actor.role === Role.EMPLOYEE;
  }

  // Which event letters have no event on record for this employee.
  private async eventLettersMissing(
    employeeId: string,
    organizationId: string,
    employee: { employmentStatus: EmploymentStatus },
  ): Promise<Set<string>> {
    const [movements, statuses] = await Promise.all([
      this.scopedPrisma.employeeMovement.findMany({
        where: {
          organizationId,
          employeeId,
          type: { in: ['PROMOTION', 'TRANSFER'] },
        },
        select: { type: true },
      }),
      this.scopedPrisma.employmentStatusHistory.findMany({
        where: {
          organizationId,
          employeeId,
          newStatus: {
            in: [
              EmploymentStatus.EXTENDED_PROBATION,
              EmploymentStatus.CONFIRMED,
            ],
          },
        },
        select: { newStatus: true },
      }),
    ]);
    const moved = new Set(movements.map((m) => m.type));
    const reached = new Set<EmploymentStatus>([
      ...statuses.map((h) => h.newStatus),
      employee.employmentStatus,
    ]);
    const missing = new Set<string>();
    if (!moved.has('PROMOTION')) missing.add('promotionLetter');
    if (!moved.has('TRANSFER')) missing.add('transferLetter');
    if (!reached.has(EmploymentStatus.EXTENDED_PROBATION)) {
      missing.add('probationExtensionLetter');
    }
    if (!reached.has(EmploymentStatus.CONFIRMED)) {
      missing.add('confirmationLetter');
    }
    if (employee.employmentStatus !== EmploymentStatus.ONBOARDING) {
      missing.add('letterOfIntent');
    }
    return missing;
  }

  // Powers the Letters & Certificates tab's list — which of the org's
  // active templates this employee can actually see, given the real
  // prerequisite record each dataProfile needs. BASIC (Offer/Appointment)
  // is unlocked from day one; EXIT/PAYROLL/SETTLEMENT need an
  // OffboardingCase/paid-out PayrollRun/Settlement to exist first — the
  // exact same existence checks generate() already throws 400 on, just
  // turned into a boolean instead of an exception so the UI can show
  // locked ones greyed out rather than surfacing a failed download.
  // One line per employee for the directory's Letters column: the stage they are in and which letter is due or was issued last.
  // Admin / HR only (the controller enforces it). Built from what was issued (the audit trail of generated / emailed letters).
  async overview(
    organizationId: string,
  ): Promise<Record<string, LetterFlowStatus & { approval: { awaiting: number; approved: number; declined: number } }>> {
    const [people, issuedRows, issueRecords, grants, templates] = await Promise.all([
      this.scopedPrisma.user.findMany({
        where: { organizationId },
        select: { id: true, employmentStatus: true, isActive: true },
      }),
      this.scopedPrisma.auditLog.findMany({
        where: {
          organizationId,
          module: AuditModule.DOCUMENT,
          action: { in: ['LETTER_ISSUED', 'LETTER_EMAILED'] },
        },
        select: { targetId: true, details: true, createdAt: true },
        orderBy: { createdAt: 'desc' },
        take: 50_000,
      }),
      this.scopedPrisma.issuedLetter.findMany({
        where: { organizationId },
        select: { employeeId: true, key: true, approvedAt: true, declinedAt: true, supersededAt: true },
      }),
      this.scopedPrisma.employeeLetterAccess.findMany({ where: { organizationId, enabled: true }, select: { employeeId: true, key: true } }),
      this.scopedPrisma.letterTemplate.findMany({ where: { organizationId }, select: { key: true, isActive: true } }),
    ]);
    // Letters the company has switched off (every template of that letter is inactive) are never shown as due.
    const everKeys = new Set(templates.map((t) => baseKeyOf(t.key)));
    const activeKeys = new Set(templates.filter((t) => t.isActive).map((t) => baseKeyOf(t.key)));
    const switchedOff = new Set([...everKeys].filter((k) => !activeKeys.has(k)));
    // Where each person's letters stand with their own approval: waiting for their signature (switched on, not yet answered),
    // approved and signed, or declined. A replaced letter is not counted.
    const visible = new Set(grants.map((g) => `${g.employeeId}|${g.key}`));
    const approvalOf = new Map<string, { awaiting: number; approved: number; declined: number }>();
    for (const r of issueRecords) {
      const a = approvalOf.get(r.employeeId) ?? { awaiting: 0, approved: 0, declined: 0 };
      if (r.approvedAt) a.approved += 1;
      else if (r.declinedAt) a.declined += 1;
      else if (!r.supersededAt && visible.has(`${r.employeeId}|${r.key}`)) a.awaiting += 1;
      approvalOf.set(r.employeeId, a);
    }
    const byPerson = new Map<string, Map<string, IssuedLetter>>();
    for (const r of issuedRows) {
      const d = r.details as { key?: string; templateName?: string } | null;
      if (!r.targetId || !d?.key) continue;
      const m = byPerson.get(r.targetId) ?? new Map<string, IssuedLetter>();
      // A later issue of the same letter counts as the letter: the stage logic knows the template key, not the slot.
      const baseKey = baseKeyOf(d.key);
      // Newest first, so the first one seen for a key is its latest issue.
      if (!m.has(baseKey))
        m.set(baseKey, { name: d.templateName || baseKey, at: r.createdAt });
      byPerson.set(r.targetId, m);
    }
    return Object.fromEntries(
      people.map((p) => [
        p.id,
        {
          ...letterFlowStatus(p, byPerson.get(p.id) ?? new Map<string, IssuedLetter>(), switchedOff),
          approval: approvalOf.get(p.id) ?? { awaiting: 0, approved: 0, declined: 0 },
        },
      ]),
    );
  }

  async listForEmployee(
    employeeId: string,
    actor: Actor,
    organizationId: string,
  ): Promise<
    Array<{
      key: string;
      name: string;
      dataProfile: LetterDataProfile;
      unlocked: boolean;
      reason: string | null;
      // YYYY-MM-DD the letter was issued on (null = never issued).
      issuedOn: string | null;
      canIssueNew?: boolean;
      requiresApproval?: boolean;
      approvalStatus?: 'APPROVED' | 'DECLINED' | 'SUPERSEDED' | 'AWAITING' | null;
      approvedAt?: string | null;
      signedBy?: string | null;
      declinedAt?: string | null;
      declineReason?: string | null;
      superseded?: boolean;
      canNewVersion?: boolean;
      // When the employee confirmed they received and read it (null = not yet).
      acknowledgedAt: string | null;
      // Only present for a RESTRICTED_LETTER_KEYS entry — restricted is
      // always true there; accessEnabled reflects the current
      // EmployeeLetterAccess grant so a privileged caller's UI can render
      // the right toggle state (an EMPLOYEE caller doesn't need these,
      // `unlocked` already folds the grant in).
      restricted?: boolean;
      accessEnabled?: boolean;
      // Where the letter sits in the employee's journey (hiring, probation, ...), and whether that is the stage they are in now.
      stage: LetterStage;
      inCurrentStage: boolean;
    }>
  > {
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: employeeId, organizationId },
      select: { departmentId: true, employmentStatus: true, isActive: true },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    const eventGated = this.isEventGated(actor, employeeId);
    const eventsMissing = eventGated
      ? await this.eventLettersMissing(employeeId, organizationId, employee)
      : new Set<string>();
    // Self-view (My Letters) always bypasses the department check below —
    // a Manager with no department assigned (actor.departmentId === null)
    // would otherwise be forbidden from viewing their own letters, since
    // that branch treats a null department as "can't be trusted to view
    // anyone," self included. Same "self-access always allowed" pattern
    // as canAccessDocuments elsewhere in the app.
    if (
      employeeId !== actor.id &&
      actor.role !== Role.ADMIN &&
      actor.role !== Role.EMPLOYEE &&
      !(await inReviewerScope(
        this.scopedPrisma,
        actor,
        organizationId,
        employeeId,
      ))
    ) {
      throw new ForbiddenException('Not authorized to view this employee.');
    }

    const { data: templates } =
      await this.letterTemplatesService.findAll(organizationId);
    const activeTemplates = templates.filter((t) => t.isActive);

    const [hasOffboardingCase, hasPaidPayrollRun, hasSettlement, grants] =
      await Promise.all([
        this.scopedPrisma.offboardingCase
          .findFirst({
            where: { organizationId, employeeId },
            select: { id: true },
          })
          .then(Boolean),
        this.scopedPrisma.payrollRun
          .findFirst({
            where: {
              organizationId,
              employeeId,
              isFinalSettlement: false,
              runSequence: 0,
              status: { in: PAID_OUT_STATUSES },
            },
            select: { id: true },
          })
          .then(Boolean),
        this.scopedPrisma.settlement
          .findFirst({
            where: { organizationId, employeeId },
            select: { id: true },
          })
          .then(Boolean),
        this.scopedPrisma.employeeLetterAccess.findMany({
          where: { organizationId, employeeId },
          select: { key: true, enabled: true, enabledById: true },
        }),
      ]);
    const grantByKey = new Map(grants.map((g) => [g.key, g]));

    const UNLOCK_BY_PROFILE: Record<
      LetterDataProfile,
      { unlocked: boolean; reason: string }
    > = {
      [LetterDataProfile.BASIC]: { unlocked: true, reason: '' },
      [LetterDataProfile.EXIT]: {
        unlocked: hasOffboardingCase,
        reason: 'Available once offboarding is initiated for this employee.',
      },
      [LetterDataProfile.PAYROLL]: {
        unlocked: hasPaidPayrollRun,
        reason:
          'Available once a payroll run has been processed for this employee.',
      },
      [LetterDataProfile.SETTLEMENT]: {
        unlocked: hasSettlement,
        reason: 'Available once a Full & Final Settlement has been calculated.',
      },
    };

    const nowStage = currentLetterStage(employee);
    // Offer before appointment, relieving before experience: the order the letters come up in (custom templates last).
    const inFlowOrder = [...activeTemplates].sort(
      (a, b) => letterFlowOrder(a.key) - letterFlowOrder(b.key),
    );
    // When each letter was issued: the saved date, else the oldest "letter issued" entry (letters from before dates were saved).
    const issuedOnByKey = new Map<string, string>();
    const [savedIssues, issuedAudit] = await Promise.all([
      this.scopedPrisma.issuedLetter.findMany({ where: { organizationId, employeeId }, select: { key: true, issuedAt: true, acknowledgedAt: true, approvedAt: true, declinedAt: true, declineReason: true, supersededAt: true, signatureName: true } }),
      this.scopedPrisma.auditLog.findMany({
        where: { organizationId, module: AuditModule.DOCUMENT, action: 'LETTER_ISSUED', targetId: employeeId },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true, details: true },
      }),
    ]);
    for (const r of issuedAudit) {
      const k = (r.details as { key?: string } | null)?.key;
      if (k && !issuedOnByKey.has(k)) issuedOnByKey.set(k, dateStrInOrgTz('Asia/Kolkata', r.createdAt));
    }
    const ackByKey = new Map<string, string>();
    for (const r of savedIssues) {
      issuedOnByKey.set(r.key, dateStrInOrgTz('Asia/Kolkata', r.issuedAt));
      if (r.acknowledgedAt) ackByKey.set(r.key, r.acknowledgedAt.toISOString());
    }
    const all = inFlowOrder.flatMap((t) => {
      const recurring = isRecurringTemplate(t);
      // Every issue of the letter that exists: repeats of a recurring letter, and new versions of any letter.
      const slotKeys = savedIssues.filter((r) => baseKeyOf(r.key) === t.key).sort((a, b) => a.issuedAt.getTime() - b.issuedAt.getTime()).map((r) => r.key);
      const keys = slotKeys.length > 0 ? slotKeys : [t.key];
      return keys.map((slotKey, slotIndex) => {
      const gate = UNLOCK_BY_PROFILE[t.dataProfile];
      const restricted = RESTRICTED_LETTER_KEYS.has(t.key);
      // No EmployeeLetterAccess row yet: a restricted (disciplinary) key
      // defaults hidden (opt-in, per the constant's own comment), every
      // other key defaults visible (opt-out) — matches the existing
      // "every other letter stays visible by default" behavior exactly,
      // just now revocable per employee via the same grant row instead of
      // being un-hideable.
      // Every letter now starts hidden from the employee it belongs to: HR/Admin switch "Visible to employee" on once the
      // letter is ready (letters already visible when this rule began were granted by a one-off migration).
      const grant = grantByKey.get(slotKey);
      const accessEnabled = grant?.enabled ?? false;
      // The owner also needs the grant, on top of the usual dataProfile unlock (see ownerRulesApply).
      const employeeGateBlocked =
        ownerRulesApply(actor, employeeId) && !grantAllows(grant, actor, employeeId, t.dataProfile);
      const leavingBlocked = hiringLetterBlocked(t.key, employee);
      const eventBlocked = eventsMissing.has(t.key);
      const issuedOn = issuedOnByKey.get(slotKey) ?? null;
      const rec = savedIssues.find((r) => r.key === slotKey);
      const isLast = slotIndex === keys.length - 1;
      // On anyone's own list (HR/Admin too), a disciplinary letter is never "available" unless one was issued to them.
      const notIssued = actor.id === employeeId && isDisciplinaryLetter(t) && !issuedOn;
      const approvalStatus: 'APPROVED' | 'DECLINED' | 'SUPERSEDED' | 'AWAITING' | null = rec?.approvedAt
        ? 'APPROVED'
        : rec?.declinedAt
          ? 'DECLINED'
          : rec?.supersededAt
            ? 'SUPERSEDED'
            : t.requiresApproval && accessEnabled && (rec || issuedOn)
              ? 'AWAITING'
              : null;
      return {
        key: slotKey,
        name: keys.length > 1 && issuedOn ? `${t.name} (${formatDateDisplay(issuedOn)})` : t.name,
        // Only on the last issue of a letter that can be issued again: HR/Admin start the next one from it.
        canIssueNew: recurring && isLast,
        // Approval by the employee (accept and sign): where this issue stands, and what HR/Admin can do next.
        requiresApproval: !!t.requiresApproval,
        approvalStatus,
        approvedAt: rec?.approvedAt?.toISOString() ?? null,
        signedBy: rec?.signatureName ?? null,
        declinedAt: rec?.declinedAt?.toISOString() ?? null,
        declineReason: rec?.declineReason ?? null,
        superseded: !!rec?.supersededAt,
        canNewVersion: isLast && !!(rec?.approvedAt || rec?.declinedAt) && !rec?.supersededAt,
        issuedOn,
        acknowledgedAt: ackByKey.get(slotKey) ?? null,
        dataProfile: t.dataProfile,
        stage: stageOfTemplate(t),
        inCurrentStage: stageOfTemplate(t) === nowStage,
        unlocked:
          gate.unlocked &&
          !employeeGateBlocked &&
          !leavingBlocked &&
          !eventBlocked &&
          !notIssued,
        reason: leavingBlocked
          ? HIRING_LETTER_BLOCKED_REASON
          : eventBlocked
            ? EVENT_LETTER_REASON[t.key]
            : employeeGateBlocked
              ? actor.role === Role.MANAGER ? LETTER_HR_AUTHORISATION_REASON : 'Not yet made available to you — contact HR.'
              : notIssued
                ? LETTER_NOT_ISSUED_REASON
                : gate.unlocked
                  ? null
                  : gate.reason,
        // Present for every key (not just restricted ones) so a
        // privileged caller's UI can render the "Visible to employee"
        // toggle everywhere, not only on the 3 disciplinary keys.
        ...(actor.role !== Role.EMPLOYEE ? { restricted, accessEnabled } : {}),
      };
      });
    });
    // Only Admin and HR see a locked letter (greyed out, with the reason). Everyone else - employees looking at their
    // own letters, and managers - sees just the letters they can actually get.
    if (actor.role === Role.ADMIN || actor.role === Role.HR) return all;
    // An employee keeps an approved letter even after a newer version exists; a declined or never-approved old one is not shown.
    return all.filter((l) => l.unlocked && !(l.superseded && l.approvalStatus !== 'APPROVED'));
  }

  // Shared by generate() and previewContent() — fetches the real employee/
  // org/dataProfile-specific data and renders the template's {{placeholder}}
  // title/body into final text. No side effects (no document number issued,
  // no PDF rendered) so previewContent() can call this freely for an
  // editable-text preview without burning a document number on every call.
  private async computeLetterContent(
    employeeId: string,
    slot: string,
    actor: Actor,
    organizationId: string,
    // The date whose salary structure the Revised CTC letter describes (the revision's effective date); today when
    // omitted. Only the increment letter reads it.
    structureAsOf?: string,
    // The date this letter was first issued; today when it has not been issued yet.
    issuedAt?: Date,
    // HR/Admin writing or editing the letter before the record it is about exists (no offboarding case, payroll run or
    // settlement yet): the missing figures show as "—" in the draft instead of refusing. Never used for a plain download.
    lenient = false,
  ) {
    // `slot` names one issue of the letter; every rule about the letter itself goes by the template key.
    const key = baseKeyOf(slot);
    const template = await this.letterTemplatesService.findActiveByKey(
      key,
      organizationId,
    );
    if (!template) {
      throw new BadRequestException(
        `No active letter template found for '${key}' — configure one in Organization Settings > Letter Templates.`,
      );
    }

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: employeeId, organizationId },
      include: { department: { select: { name: true } } },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    if (hiringLetterBlocked(key, employee)) {
      throw new BadRequestException(HIRING_LETTER_BLOCKED_REASON);
    }
    // Payroll and settlement letters carry gross/net/CTC and full-and-final amounts. A manager may issue the
    // department's plain letters, but never another person's pay figures (the same rule that keeps a manager out of
    // their reports' payslips); HR, Admin and the employee themself are unaffected.
    if (
      actor.role === Role.MANAGER &&
      employeeId !== actor.id &&
      (template.dataProfile === LetterDataProfile.PAYROLL ||
        template.dataProfile === LetterDataProfile.SETTLEMENT)
    ) {
      throw new ForbiddenException(
        "Only HR or an Admin can issue a letter that contains an employee's pay figures.",
      );
    }

    // Same view-scoping rule as EmployeeTimelineService.assertCanView — HR/
    // ADMIN see anyone, a MANAGER only their own department, an EMPLOYEE
    // only themselves (self-or-role already enforced at the controller).
    // Self-view always bypasses this — see listForEmployee's identical
    // guard for why (a department-less Manager downloading their own
    // letter shouldn't be blocked by a department check).
    if (
      employeeId !== actor.id &&
      actor.role !== Role.ADMIN &&
      actor.role !== Role.EMPLOYEE &&
      !(await inReviewerScope(
        this.scopedPrisma,
        actor,
        organizationId,
        employee.id,
      ))
    ) {
      throw new ForbiddenException('Not authorized to view this employee.');
    }

    // Mirrors listForEmployee's employeeGateBlocked check — this is the
    // actual enforcement point (listForEmployee's `unlocked` is only a
    // display hint); without this an EMPLOYEE could still GET
    // /employees/:id/letters/:key directly for a key HR has hidden from
    // them (or never granted, for a restricted one).
    // The event a letter is about has to be on record before the employee can download it themselves.
    if (
      EVENT_LETTER_REASON[key] &&
      this.isEventGated(actor, employeeId) &&
      (
        await this.eventLettersMissing(employeeId, organizationId, employee)
      ).has(key)
    ) {
      throw new BadRequestException(EVENT_LETTER_REASON[key]);
    }
    if (ownerRulesApply(actor, employeeId)) {
      const grant = await this.scopedPrisma.employeeLetterAccess.findFirst({
        where: { organizationId, employeeId, key: slot },
        select: { enabled: true, enabledById: true },
      });
      if (!grantAllows(grant, actor, employeeId, template.dataProfile)) {
        throw new ForbiddenException(
          actor.role === Role.MANAGER ? LETTER_HR_AUTHORISATION_REASON : 'This letter has not been made available to you yet — contact HR.',
        );
      }
      // Downloading must never create a disciplinary letter: only one already issued can be fetched.
      if (isDisciplinaryLetter(template) && !issuedAt) {
        throw new ForbiddenException(LETTER_NOT_ISSUED_REASON);
      }
    }

    const organization = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: {
        companyName: true,
        registeredAddress: true,
        gstin: true,
        pan: true,
        tan: true,
        cin: true,
        registrationNumber: true,
        lin: true,
        msmeRegistrationNumber: true,
        labourLicenseNumber: true,
        companyLogoUrl: true,
        letterHeaderUrl: true,
        letterFooterUrl: true,
        signatories: true,
        policies: true,
        timezone: true,
        watermarkLogo: true,
      },
    });
    if (!organization) throw new NotFoundException('Organization not found.');
    // A sister company's letter carries its brand's name, address and logo; no brand keeps the organization's own exactly.
    const branding = employee.brandId
      ? await this.brandingLookup.forBrand(organizationId, employee.brandId)
      : null;
    const companyName = branding?.brandId
      ? branding.companyName
      : organization.companyName || 'the Company';
    const registration = branding?.brandId
      ? branding.registration
      : organization;
    const policies = (organization.policies ?? {}) as {
      currencySymbol?: string;
    };
    const rawSymbol = policies.currencySymbol || '₹';
    // Same fallback payslip-pdf.service.ts already uses: pdfkit's bundled
    // fonts (including the Roboto subset embedded by letter-pdf.service.ts)
    // don't reliably carry the ₹ glyph, so a non-ASCII configured symbol
    // renders as a broken glyph — fall back to "Rs." rather than let that
    // happen (the web UI elsewhere still renders ₹ fine via the browser's
    // own font).
    // eslint-disable-next-line no-control-regex -- ASCII-only check, not a stray control char
    const currencySymbol = /^[\x00-\x7F]+$/.test(rawSymbol) ? rawSymbol : 'Rs.';
    const money = (n: number) =>
      `${currencySymbol}${currencySymbol === 'Rs.' ? ' ' : ''}${Math.round(n).toLocaleString('en-IN')}`;

    const firstName = employee.name.split(' ')[0] || employee.name;
    const pd = (employee.personalData ?? {}) as Record<string, unknown>;
    const pdStr = (key: string): string => {
      const v = pd[key];
      return typeof v === 'string' && v.trim() ? v.trim() : '—';
    };
    const variables: Record<string, string> = {
      employeeName: employee.name,
      firstName,
      employeeId: employee.employeeId,
      designation: employee.designation || '—',
      department: employee.department?.name || '—',
      employeeType: employee.employeeType,
      joiningDate: formatDateDisplay(employee.joiningDate),
      // The date the employee was confirmed from ('—' until they are confirmed).
      confirmationDate: employee.confirmationDate
        ? formatDateDisplay(employee.confirmationDate)
        : '—',
      companyName,
      companyAddress:
        (branding?.brandId
          ? branding.address
          : organization.registeredAddress) || '',
      // Organization Settings > Registration Details ('—' when not filled in).
      // A sister company's letter shows ITS registration details (blank = '—', never the parent's).
      companyGstin: registration.gstin?.trim() || '—',
      companyPan: registration.pan?.trim() || '—',
      companyTan: registration.tan?.trim() || '—',
      companyCin: registration.cin?.trim() || '—',
      companyRegistrationNumber: registration.registrationNumber?.trim() || '—',
      companyLin: registration.lin?.trim() || '—',
      companyMsmeNumber: registration.msmeRegistrationNumber?.trim() || '—',
      companyLabourLicense: registration.labourLicenseNumber?.trim() || '—',
      issueDate: formatDateDisplay(issuedAt ?? new Date()),
      // Available on every dataProfile (not just BASIC) since it's a
      // plain employee-record field, same as designation/department above
      // — backs Confirmation/Probation Extension Letter.
      probationEndDate: employee.probationEndDate
        ? formatDateDisplay(employee.probationEndDate)
        : '—',
      // personalData-backed placeholders — a letter that needs to state an
      // employee's PAN/address/bank details (e.g. a bank-confirmation or
      // address-proof letter) previously had nothing to reference at all.
      employeeAddress: pdStr('currentAddress'),
      panNumber: pdStr('panNumber'),
      uanNumber: pdStr('uanNumber'),
      aadharNumber: pdStr('aadharNumber'),
      bankName: pdStr('bankName'),
      bankAccountNo: pdStr('bankAccountNo'),
      bankIFSC: pdStr('bankIFSC'),
      bankAccountHolderName: pdStr('bankAccountHolderName'),
      emergencyContactName: pdStr('emergencyContact1Name'),
      emergencyContactNumber: pdStr('emergencyContact1Number'),
    };

    if (lenient) {
      for (const k of LENIENT_PLACEHOLDERS[template.dataProfile] ?? []) variables[k] ??= '—';
    }
    try {
    switch (template.dataProfile) {
      case LetterDataProfile.EXIT: {
        const offboardingCase = await this.latestOffboardingCase(
          employeeId,
          organizationId,
        );
        variables.lastWorkingDay = formatDateDisplay(
          offboardingCase.lastWorkingDay,
        );
        // Backs Resignation Acceptance/Termination Letter — reason is
        // optional on OffboardingCase (HR isn't required to fill it in),
        // so this needs a fallback rather than rendering "undefined".
        variables.reason = offboardingCase.reason || 'personal reasons';
        variables.noticeDate = formatDateDisplay(offboardingCase.createdAt);
        break;
      }
      case LetterDataProfile.PAYROLL: {
        // Placeholders only the Increment / Revised CTC letter fills in; any other payroll letter that happens to use
        // one gets a dash rather than the raw {{...}}.
        variables.effectiveFrom = '—';
        variables.fixedCTC = '—';
        variables.variablePay = '—';
        // The Increment / Revised CTC letter describes the salary structure as revised - not the last paid run,
        // which still shows the old figures until the next payroll.
        if (key === 'incrementLetter') {
          const asOf =
            structureAsOf ??
            todayInOrgTz(organization.timezone ?? 'Asia/Kolkata');
          const [rows, components] = await Promise.all([
            this.scopedPrisma.employeeSalaryComponent.findMany({
              where: { organizationId, employeeId },
              include: {
                component: {
                  select: {
                    type: true,
                    payFrequency: true,
                    isEmployerContribution: true,
                  },
                },
              },
            }),
            this.scopedPrisma.salaryComponent.findMany({
              where: { organizationId, isActive: true },
            }),
          ]);
          const withRef = rows.map((r) => ({
            ...r,
            componentRef: r.component,
          }));
          const current = resolveCurrentRows(withRef, asOf);
          const cityClass = await employeeCityClass(
            this.scopedPrisma,
            employeeId,
            organizationId,
          );
          const synthesized = synthesizeMissingRows(
            withRef,
            withCityHra(components, cityClass),
            asOf,
          );
          const summary = summarizeStructure([...current, ...synthesized]);
          if (summary.annualCTC <= 0) {
            throw new BadRequestException(
              'This employee has no salary structure on file yet.',
            );
          }
          const effective = new Date(`${asOf}T00:00:00.000Z`);
          variables.effectiveFrom = formatDateDisplay(effective);
          variables.month = MONTHS[effective.getUTCMonth()];
          variables.year = String(effective.getUTCFullYear());
          variables.annualCTC = money(summary.annualCTC);
          variables.fixedCTC = money(summary.fixedAnnual);
          variables.variablePay = money(
            summary.variableAnnual + summary.oneTimeAnnual,
          );
          variables.grossSalary = money(summary.fixedMonthly);
          // Take-home depends on deductions worked out at payroll; the letter does not state it.
          variables.netPay = '—';
          break;
        }
        const run = await this.scopedPrisma.payrollRun.findFirst({
          where: {
            organizationId,
            employeeId,
            isFinalSettlement: false,
            runSequence: 0,
            status: { in: PAID_OUT_STATUSES },
          },
          orderBy: [{ year: 'desc' }, { month: 'desc' }],
        });
        if (!run) {
          throw new BadRequestException(
            'No processed payroll run found for this employee yet — this letter needs at least one.',
          );
        }
        variables.month = MONTHS[run.month];
        variables.year = String(run.year);
        variables.grossSalary = money(run.grossSalary);
        variables.netPay = money(run.netPay);
        variables.annualCTC = money(run.ctcMonthly * 12);
        break;
      }
      case LetterDataProfile.SETTLEMENT: {
        const settlement = await this.scopedPrisma.settlement.findFirst({
          where: { organizationId, employeeId },
          orderBy: { createdAt: 'desc' },
        });
        if (!settlement) {
          throw new BadRequestException(
            'No settlement found for this employee yet — calculate one first (Offboarding > Full & Final Settlement).',
          );
        }
        const totalDeductions =
          settlement.recoveriesAmount +
          settlement.loanBalanceRecovered +
          settlement.noticePeriodRecovery;
        variables.lastWorkingDay = formatDateDisplay(settlement.lastWorkingDay);
        variables.pendingSalary = money(settlement.pendingSalaryAmount);
        variables.leaveEncashment = money(settlement.leaveEncashmentAmount);
        variables.bonus = money(settlement.bonusAmount);
        variables.gratuity = money(settlement.gratuityAmount);
        variables.recoveries = money(settlement.recoveriesAmount);
        variables.loanRecovered = money(settlement.loanBalanceRecovered);
        variables.noticePeriodRecovery = money(settlement.noticePeriodRecovery);
        variables.totalDeductions = money(totalDeductions);
        variables.netPayable = money(settlement.netSettlementAmount);
        variables.netPayableInWords = amountInWords(
          Math.round(settlement.netSettlementAmount),
        );
        break;
      }
      case LetterDataProfile.BASIC:
      default:
        break;
    }
    } catch (err) {
      // Strict unless HR/Admin is drafting: then whatever could not be filled stays "—" and they type the rest.
      if (!(lenient && err instanceof BadRequestException)) throw err;
    }

    let title = this.letterTemplatesService.render(template.title, variables);
    const renderedBody = this.letterTemplatesService.render(
      template.bodyText,
      variables,
    );
    // template.bodyText may now be plain text (legacy) or the sanitized
    // rich-text HTML the Letter Templates editor produces (bold/italic/
    // underline/lists) — splitRichTextIntoParagraphs handles both, falling
    // back to the original '\n'-per-paragraph behavior when no block tags
    // are present. A LetterOverride's own `body` (below) is still always
    // plain text, typed in a separate plain-text screen, so it keeps the
    // original split.
    let paragraphs = splitRichTextIntoParagraphs(renderedBody);

    // A saved per-employee override (HR clicked Save in the Send modal,
    // not just a one-off edited send) replaces the template's own
    // rendering entirely — this is what makes Download and a future
    // unedited Send pick up the customized wording too.
    // findFirst, not findUnique: LetterOverride is tenant-scoped, and the
    // scope extension refuses findUnique on scoped models because a
    // compound-unique `where` leaves it nowhere to inject organizationId.
    // The @@unique([organizationId, employeeId, key]) makes this equally
    // selective.
    const override = await this.scopedPrisma.letterOverride.findFirst({
      where: { organizationId, employeeId, key: slot },
    });
    const isCustomized = !!override;
    if (override) {
      // HR may have typed {{placeholders}} while editing: they are filled in here too, not printed as written.
      title = editedTextToTitle(
        this.letterTemplatesService.render(override.title, variables),
      );
      paragraphs = editedTextToParagraphs(
        this.letterTemplatesService.render(override.body, variables),
      );
    }

    return {
      template,
      employee,
      organization,
      branding,
      companyName,
      title,
      paragraphs,
      isCustomized,
      variables,
    };
  }

  // Text-only, no-side-effect counterpart to generate() — lets the Send
  // flow show HR the exact title/body they're about to email (as plain
  // editable text, not a PDF) without issuing a document number the way
  // every generate()/send() call does. Reflects any saved override, so an
  // employee whose letter has already been customized opens the edit
  // fields on their customized text, not the template's default.
  async previewContent(
    employeeId: string,
    key: string,
    actor: Actor,
    organizationId: string,
  ): Promise<{ title: string; body: string; bodyHtml: string; isCustomized: boolean }> {
    const issued = await this.findIssuedLetter(employeeId, key, organizationId);
    const { title, paragraphs, isCustomized } = await this.computeLetterContent(
      employeeId,
      key,
      actor,
      organizationId,
      undefined,
      issued?.issuedAt,
      this.isPrivileged(actor),
    );
    return { title, body: paragraphs.join('\n'), bodyHtml: paragraphsToHtml(paragraphs), isCustomized };
  }

  // Persists HR's edited title/body for this one employee+letter — unlike
  // the per-send `overrides` param below (which only affects a single
  // email and is never stored), this becomes the new default: Download and
  // every future Send use it until resetOverride() is called. The
  // LetterTemplate row itself, and every other employee's copy, are
  // untouched.
  async saveOverride(
    employeeId: string,
    key: string,
    actor: Actor,
    organizationId: string,
    content: { title: string; body: string },
  ): Promise<{ title: string; body: string; bodyHtml: string; isCustomized: boolean }> {
    // Reuses the same template/employee/view-scope validation as
    // generate() — no point saving an override for an employee the actor
    // can't view, or a key with no active template.
    await this.computeLetterContent(employeeId, key, actor, organizationId, undefined, undefined, this.isPrivileged(actor));

    await this.assertNotFinal(employeeId, key, organizationId);
    const title = content.title.trim();
    // The wording may now carry bold / italic / underline and lists; anything else is stripped before it is saved.
    const body = sanitizeRichText(content.body.trim()).trim();
    if (!title || !body.replace(/<[^>]*>/g, '').trim()) {
      throw new BadRequestException('Title and body cannot be empty.');
    }

    // updateMany-then-create rather than upsert, for the same reason
    // findUnique became findFirst above — the scope extension can't inject
    // organizationId into an upsert's compound-unique `where`.
    const updated = await this.scopedPrisma.letterOverride.updateMany({
      where: { organizationId, employeeId, key },
      data: { title, body, updatedById: actor.id },
    });
    if (updated.count === 0) {
      await this.scopedPrisma.letterOverride.create({
        data: {
          organizationId,
          employeeId,
          key,
          title,
          body,
          updatedById: actor.id,
        },
      });
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'LETTER_CONTENT_SAVED',
      module: AuditModule.DOCUMENT,
      organizationId,
      targetId: employeeId,
      details: { key },
    });

    // The saved PDF no longer matches the wording: the next download builds it again.
    await this.scopedPrisma.issuedLetter.updateMany({ where: { organizationId, employeeId, key }, data: { pdfKey: null } });
    return { title, body, bodyHtml: body, isCustomized: true };
  }

  // Deletes a saved override — Download and future Sends fall back to the
  // template's own {{placeholder}} rendering again. A no-op (not a 404) if
  // nothing was saved, matching this being reachable from a "Reset" button
  // shown unconditionally.
  async resetOverride(
    employeeId: string,
    key: string,
    actor: Actor,
    organizationId: string,
  ): Promise<{ title: string; body: string; isCustomized: boolean }> {
    await this.assertNotFinal(employeeId, key, organizationId);
    await this.scopedPrisma.letterOverride.deleteMany({
      where: { organizationId, employeeId, key },
    });

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'LETTER_CONTENT_RESET',
      module: AuditModule.DOCUMENT,
      organizationId,
      targetId: employeeId,
      details: { key },
    });

    await this.scopedPrisma.issuedLetter.updateMany({ where: { organizationId, employeeId, key }, data: { pdfKey: null } });
    return this.previewContent(employeeId, key, actor, organizationId);
  }

  // HR/Admin-only (enforced at the controller) — grants or revokes one
  // employee's self-service visibility for one letter. Works for any
  // active template's key, not just the RESTRICTED_LETTER_KEYS set: those
  // default hidden (opt-in) with no row, every other letter defaults
  // visible (opt-out) with no row — see listForEmployee's accessEnabled
  // computation, which this row feeds either way.
  async setEmployeeAccess(
    employeeId: string,
    key: string,
    enabled: boolean,
    actor: Actor,
    organizationId: string,
  ) {
    const template = await this.letterTemplatesService.findActiveByKey(
      baseKeyOf(key),
      organizationId,
    );
    if (!template) {
      throw new BadRequestException(
        `No active letter template found for '${baseKeyOf(key)}'.`,
      );
    }
    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: employeeId, organizationId },
      select: { id: true },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    // An approved letter stays with the employee: it cannot be hidden again.
    if (!enabled) await this.assertNotFinal(employeeId, key, organizationId);
    // A letter whose stage has not been reached cannot be switched on yet.
    if (enabled) {
      const row = (await this.listForEmployee(employeeId, actor, organizationId)).find((l) => l.key === key);
      if (row && !row.unlocked) {
        throw new BadRequestException(row.reason || 'This letter cannot be made visible until its stage is reached.');
      }
    }
    return this.writeAccess(employeeId, key, enabled, actor, organizationId, template.name, true, !!template.requiresApproval);
  }

  // One switch for a whole stage of the journey (Hiring, Probation...): every letter of that stage that is open for this employee is
  // switched on or off together. A letter still locked is left alone, and any one letter can still be changed on its own.
  async setStageAccess(employeeId: string, stage: string, enabled: boolean, actor: Actor, organizationId: string) {
    if (!(LETTER_STAGES as readonly string[]).includes(stage) && stage !== 'OTHER') {
      throw new BadRequestException('Unknown stage.');
    }
    const items = (await this.listForEmployee(employeeId, actor, organizationId)).filter((l) => l.stage === stage && l.unlocked);
    // Looked up only if needed: are these a Manager's letters? (See below.)
    let isManager: boolean | undefined;
    const managersLetters = async () =>
      (isManager ??= (await this.scopedPrisma.user.findFirst({ where: { id: employeeId, organizationId }, select: { role: true } }))?.role === Role.MANAGER);
    let changed = 0;
    for (const l of items) {
      // An approved letter stays with the employee, so a stage switched off leaves it visible.
      if (!enabled && l.approvalStatus === 'APPROVED') continue;
      const before = await this.scopedPrisma.employeeLetterAccess.findFirst({
        where: { organizationId, employeeId, key: l.key },
        select: { enabled: true, enabledById: true },
      });
      // Already in that state - except a manager's letter visible with nobody recorded (the one-off migration): switching it
      // on here is HR's decision, so it is saved as theirs.
      if ((before?.enabled ?? false) === enabled && !(enabled && before?.enabledById === null && (await managersLetters()))) continue;
      await this.writeAccess(employeeId, l.key, enabled, actor, organizationId, l.name, false);
      changed += 1;
    }
    if (enabled && changed > 0 && employeeId !== actor.id) {
      await this.notificationsService.create({
        organizationId,
        userId: employeeId,
        title: 'Letters available',
        message: `${changed} ${changed === 1 ? 'letter is' : 'letters are'} now available in My Letters${items.some((l) => l.requiresApproval) ? ' - please review and approve them' : ''}.`,
        category: NotificationCategory.GENERAL,
      });
    }
    return { stage, enabled, changed };
  }

  // The visibility switch itself: saves it, logs it, and tells the employee when a letter is switched on for them.
  private async writeAccess(
    employeeId: string,
    key: string,
    enabled: boolean,
    actor: Actor,
    organizationId: string,
    templateName: string,
    // false when the caller sends one combined notice itself (a whole stage switched at once).
    notify = true,
    // The letter needs the employee's approval: the notice asks for it.
    askApproval = false,
  ) {
    const before = await this.scopedPrisma.employeeLetterAccess.findFirst({
      where: { organizationId, employeeId, key },
      select: { enabled: true },
    });
    // updateMany-then-create rather than upsert — the scope extension can't
    // inject organizationId into an upsert's compound-unique `where`, same
    // reason saveOverride() above uses this exact shape.
    const updated = await this.scopedPrisma.employeeLetterAccess.updateMany({
      where: { organizationId, employeeId, key },
      data: { enabled, enabledById: actor.id },
    });
    if (updated.count === 0) {
      await this.scopedPrisma.employeeLetterAccess.create({
        data: {
          organizationId,
          employeeId,
          key,
          enabled,
          enabledById: actor.id,
        },
      });
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: enabled ? 'LETTER_ACCESS_GRANTED' : 'LETTER_ACCESS_REVOKED',
      module: AuditModule.DOCUMENT,
      organizationId,
      targetId: employeeId,
      details: { key },
    });
    if (notify && enabled && !before?.enabled && employeeId !== actor.id) {
      await this.notificationsService.create({
        organizationId,
        userId: employeeId,
        title: 'Letter available',
        message: `Your ${templateName} is now available in My Letters${askApproval ? ' - please review and approve it' : ''}.`,
        category: NotificationCategory.GENERAL,
      });
    }

    return { key, enabled };
  }

  // HR/Admin correct the date a letter was issued on. It is saved, and every later download, preview and email shows it.
  async setIssueDate(employeeId: string, key: string, date: string, actor: Actor, organizationId: string) {
    const when = new Date(`${date}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(when.getTime()) || when.toISOString().slice(0, 10) !== date) {
      throw new BadRequestException('Enter the issue date as YYYY-MM-DD.');
    }
    const employee = await this.scopedPrisma.user.findFirst({ where: { id: employeeId, organizationId }, select: { id: true } });
    if (!employee) throw new NotFoundException('Employee not found.');
    await this.assertNotFinal(employeeId, key, organizationId);
    const existing = await this.findIssuedLetter(employeeId, key, organizationId);
    if (existing) {
      await this.scopedPrisma.issuedLetter.updateMany({ where: { organizationId, employeeId, key }, data: { issuedAt: when, pdfKey: null } });
    } else {
      await this.scopedPrisma.issuedLetter.createMany({ data: [{ organizationId, employeeId, key, issuedAt: when }], skipDuplicates: true });
    }
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'LETTER_ISSUE_DATE_CHANGED',
      module: AuditModule.DOCUMENT,
      organizationId,
      targetId: employeeId,
      details: { key, issuedOn: date },
    });
    return { issuedOn: date };
  }

  // The slot to use for the NEXT issue of a letter: the template key when it has never been issued, else the next free
  // "key#n" for a letter that can be issued again (an increment, a promotion, a warning...). One-time letters keep their key.
  async slotForNewIssue(employeeId: string, key: string, organizationId: string): Promise<string> {
    const base = baseKeyOf(key);
    const template = await this.letterTemplatesService.findActiveByKey(base, organizationId);
    if (!template || !isRecurringTemplate(template)) return key;
    const rows = await this.scopedPrisma.issuedLetter.findMany({ where: { organizationId, employeeId }, select: { key: true } });
    const mine = rows.filter((r) => baseKeyOf(r.key) === base).map((r) => r.key);
    return this.nextSlot(base, mine);
  }

  // An entry started for an automatic letter that then could not be sent is removed again, so no empty "issued" entry is left.
  // Only an entry with no number and no saved PDF (never actually produced) is removed.
  async discardEmptyIssue(employeeId: string, slot: string, organizationId: string): Promise<void> {
    if (!slot.includes('#')) return;
    await this.scopedPrisma.issuedLetter.deleteMany({ where: { organizationId, employeeId, key: slot, documentNumber: null, pdfKey: null } });
  }

  // For the automatic letters (promotion, increment, transfer, confirmation...: the slot the new letter goes under. A repeat
  // of a letter already issued gets its own new entry straight away, so it shows on the Letters tab beside the earlier ones.
  async prepareNextIssue(employeeId: string, key: string, organizationId: string): Promise<string> {
    const slot = await this.slotForNewIssue(employeeId, key, organizationId);
    if (slot.includes('#')) {
      await this.scopedPrisma.issuedLetter.createMany({
        data: [{ organizationId, employeeId, key: slot, issuedAt: new Date() }],
        skipDuplicates: true,
      });
    }
    return slot;
  }

  // HR/Admin start another issue of a letter that can be issued again: it appears as its own entry (own date, wording,
  // number, visibility), dated today until they change it.
  async newOccurrence(employeeId: string, key: string, actor: Actor, organizationId: string, date?: string) {
    if (date !== undefined) {
      const probe = new Date(`${date}T12:00:00Z`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(probe.getTime()) || probe.toISOString().slice(0, 10) !== date) {
        throw new BadRequestException('Enter the issue date as YYYY-MM-DD.');
      }
    }
    const base = baseKeyOf(key);
    const template = await this.letterTemplatesService.findActiveByKey(base, organizationId);
    if (!template) throw new BadRequestException(`No active letter template found for '${base}'.`);
    if (!isRecurringTemplate(template)) {
      throw new BadRequestException(`${template.name} is issued once; edit the existing one instead.`);
    }
    const row = (await this.listForEmployee(employeeId, actor, organizationId)).find((l) => baseKeyOf(l.key) === base && l.canIssueNew);
    if (row && !row.unlocked && actor.role !== Role.ADMIN && actor.role !== Role.HR) {
      throw new BadRequestException(row.reason || 'This letter is not available yet.');
    }
    const slot = await this.slotForNewIssue(employeeId, base, organizationId);
    await this.scopedPrisma.issuedLetter.createMany({
      data: [{ organizationId, employeeId, key: slot, issuedAt: date ? new Date(`${date}T12:00:00Z`) : new Date() }],
      skipDuplicates: true,
    });
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'LETTER_ISSUE_STARTED',
      module: AuditModule.DOCUMENT,
      organizationId,
      targetId: employeeId,
      details: { key: slot, templateName: template.name },
    });
    return { key: slot };
  }

  // An approved letter is final: nobody, Admin included, changes its wording, date or visibility; a correction is a new version.
  private async assertNotFinal(employeeId: string, key: string, organizationId: string) {
    const row = await this.scopedPrisma.issuedLetter.findFirst({ where: { organizationId, employeeId, key }, select: { approvedAt: true } });
    if (row?.approvedAt) throw new BadRequestException(LETTER_FINAL_MESSAGE);
  }

  private async tellReviewers(organizationId: string, title: string, message: string, link: string) {
    const reviewers = await this.scopedPrisma.user.findMany({
      where: { organizationId, isActive: true, role: { in: [Role.ADMIN, Role.HR] } },
      select: { id: true },
    });
    for (const r of reviewers) {
      await this.notificationsService.create({ organizationId, userId: r.id, title, message, category: NotificationCategory.GENERAL, link });
    }
  }

  // The employee approves (accepts) a letter and signs it in the app. The signed PDF - with their signature, the time and the
  // device - becomes the final copy; from then on the letter cannot be changed by anyone. HR and Admin are told.
  async approve(
    employeeId: string,
    key: string,
    dto: { signatureName: string; signatureImage?: string; consent: boolean },
    actor: Actor,
    organizationId: string,
    meta: { ip?: string | null; device?: string | null },
  ) {
    if (actor.id !== employeeId) throw new ForbiddenException('You can only approve your own letters.');
    if (!dto.consent) throw new BadRequestException('Tick the box to confirm you have read and accept this letter.');
    const name = (dto.signatureName ?? '').trim();
    if (name.length < 2) throw new BadRequestException('Type your full name to sign.');
    let imageBuffer: Buffer | null = null;
    if (dto.signatureImage) {
      const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dto.signatureImage);
      if (!m || m[1].length > 400_000) throw new BadRequestException('The drawn signature could not be read. Draw it again or just type your name.');
      imageBuffer = Buffer.from(m[1], 'base64');
    }
    const template = await this.letterTemplatesService.findActiveByKey(baseKeyOf(key), organizationId);
    if (!template) throw new BadRequestException('This letter is no longer available.');
    const issued = await this.findIssuedLetter(employeeId, key, organizationId);
    if (!issued) throw new BadRequestException('This letter has not been issued to you yet.');
    if (issued.approvedAt) return { approvedAt: issued.approvedAt.toISOString() };
    if (issued.declinedAt || issued.supersededAt) {
      throw new BadRequestException('This letter was replaced or declined and can no longer be approved.');
    }
    const signedAt = new Date();
    // Build the final PDF with the signature on it (this also checks that the letter is visible to this employee).
    await this.generate(employeeId, key, actor, organizationId, undefined, undefined, false, { name, signedAt, imageBuffer, ip: meta.ip ?? null, device: meta.device ?? null });
    const { count } = await this.scopedPrisma.issuedLetter.updateMany({
      where: { organizationId, employeeId, key, approvedAt: null },
      data: { approvedAt: signedAt, acknowledgedAt: signedAt, signatureName: name, signedIp: meta.ip ?? null, signedUserAgent: meta.device ?? null },
    });
    if (count > 0) {
      await this.auditLogService.log({
        actorId: actor.id,
        action: 'LETTER_APPROVED',
        module: AuditModule.DOCUMENT,
        organizationId,
        targetId: employeeId,
        details: { key, templateName: template.name, signedAs: name },
      });
      await this.tellReviewers(organizationId, 'Letter approved by employee', `${actor.name} approved and signed the ${template.name}.`, `/employee-profile?id=${employeeId}&tab=letters`);
    }
    return { approvedAt: signedAt.toISOString() };
  }

  // The employee declines a letter with a reason; HR/Admin are told and issue a new version.
  async decline(employeeId: string, key: string, reason: string, actor: Actor, organizationId: string) {
    if (actor.id !== employeeId) throw new ForbiddenException('You can only respond to your own letters.');
    const why = (reason ?? '').trim();
    if (!why) throw new BadRequestException('Say why you are declining this letter.');
    const template = await this.letterTemplatesService.findActiveByKey(baseKeyOf(key), organizationId);
    const issued = await this.findIssuedLetter(employeeId, key, organizationId);
    if (!issued) throw new BadRequestException('This letter has not been issued to you yet.');
    if (issued.approvedAt) throw new BadRequestException(LETTER_FINAL_MESSAGE);
    if (issued.declinedAt || issued.supersededAt) throw new BadRequestException('This letter has already been answered or replaced.');
    const grant = await this.scopedPrisma.employeeLetterAccess.findFirst({ where: { organizationId, employeeId, key }, select: { enabled: true } });
    if (!grant?.enabled) throw new ForbiddenException('This letter has not been made available to you yet - contact HR.');
    await this.scopedPrisma.issuedLetter.updateMany({
      where: { organizationId, employeeId, key, approvedAt: null, declinedAt: null },
      data: { declinedAt: new Date(), declineReason: why },
    });
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'LETTER_DECLINED',
      module: AuditModule.DOCUMENT,
      organizationId,
      targetId: employeeId,
      details: { key, templateName: template?.name ?? key, reason: why },
    });
    await this.tellReviewers(organizationId, 'Letter declined by employee', `${actor.name} declined the ${template?.name ?? 'letter'}: ${why}`, `/employee-profile?id=${employeeId}&tab=letters`);
    return { declinedAt: new Date().toISOString() };
  }

  // HR/Admin correct a letter that is final (approved) or was declined: the old one stays as it is, marked as replaced, and a new
  // version starts as its own entry (hidden from the employee until switched on, and to be approved again).
  async newVersion(employeeId: string, key: string, actor: Actor, organizationId: string) {
    const base = baseKeyOf(key);
    const template = await this.letterTemplatesService.findActiveByKey(base, organizationId);
    if (!template) throw new BadRequestException(`No active letter template found for '${base}'.`);
    const rows = await this.scopedPrisma.issuedLetter.findMany({ where: { organizationId, employeeId } });
    const mine = rows.filter((r) => baseKeyOf(r.key) === base);
    const current = mine.find((r) => r.key === key);
    if (!current) throw new BadRequestException('That letter has not been issued yet.');
    if (!current.approvedAt && !current.declinedAt) {
      throw new BadRequestException('This letter can still be edited; a new version is only for one that is approved or declined.');
    }
    if (current.supersededAt) throw new BadRequestException('A newer version of this letter already exists.');
    const slot = this.nextSlot(base, mine.map((r) => r.key));
    await this.scopedPrisma.issuedLetter.updateMany({ where: { organizationId, employeeId, key }, data: { supersededAt: new Date() } });
    await this.scopedPrisma.issuedLetter.createMany({ data: [{ organizationId, employeeId, key: slot, issuedAt: new Date() }], skipDuplicates: true });
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'LETTER_VERSION_STARTED',
      module: AuditModule.DOCUMENT,
      organizationId,
      targetId: employeeId,
      details: { key: slot, replaces: key, templateName: template.name },
    });
    return { key: slot };
  }

  private nextSlot(base: string, existing: string[]): string {
    if (existing.length === 0) return base;
    const used = existing.map((k) => Number(k.split('#')[1] ?? 1)).filter((n) => Number.isFinite(n));
    return `${base}#${Math.max(1, ...used) + 1}`;
  }

  // The employee confirms they received and read a letter. Only for their own letter, once it has been issued; the first
  // confirmation is kept.
  async acknowledge(employeeId: string, key: string, actor: Actor, organizationId: string) {
    if (actor.id !== employeeId) throw new ForbiddenException('You can only confirm your own letters.');
    const issued = await this.findIssuedLetter(employeeId, key, organizationId);
    if (!issued) throw new BadRequestException('This letter has not been issued to you yet.');
    if (!issued.acknowledgedAt) {
      await this.scopedPrisma.issuedLetter.updateMany({
        where: { organizationId, employeeId, key, acknowledgedAt: null },
        data: { acknowledgedAt: new Date() },
      });
      await this.auditLogService.log({
        actorId: actor.id,
        action: 'LETTER_ACKNOWLEDGED',
        module: AuditModule.DOCUMENT,
        organizationId,
        targetId: employeeId,
        details: { key },
      });
    }
    const after = await this.findIssuedLetter(employeeId, key, organizationId);
    return { acknowledgedAt: after?.acknowledgedAt?.toISOString() ?? null };
  }

  // Who did what to one letter, newest first: issued, edited, date changed, emailed, switched on or off, confirmed.
  // An employee sees only the plain facts about their own switched-on letter (issued, emailed, confirmed read), not HR's edits.
  async history(employeeId: string, key: string, actor: Actor, organizationId: string) {
    const asEmployee = ownerRulesApply(actor, employeeId);
    if (asEmployee) {
      if (actor.id !== employeeId) throw new ForbiddenException('You can only see the history of your own letters.');
      const grant = await this.scopedPrisma.employeeLetterAccess.findFirst({ where: { organizationId, employeeId, key }, select: { enabled: true } });
      if (!grant?.enabled) throw new ForbiddenException('This letter has not been made available to you yet - contact HR.');
    }
    const rows = await this.scopedPrisma.auditLog.findMany({
      where: {
        organizationId,
        module: AuditModule.DOCUMENT,
        targetId: employeeId,
        action: { in: asEmployee ? EMPLOYEE_HISTORY_ACTIONS : LETTER_HISTORY_ACTIONS },
        details: { path: ['key'], equals: key },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { action: true, createdAt: true, actorId: true, details: true },
    });
    const ids = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))];
    const people = ids.length ? await this.scopedPrisma.user.findMany({ where: { id: { in: ids }, organizationId }, select: { id: true, name: true } }) : [];
    const nameOf = new Map(people.map((p) => [p.id, p.name]));
    return rows.map((r) => {
      const d = (r.details ?? {}) as { to?: string; documentNumber?: string; issuedOn?: string; edited?: boolean };
      return {
        action: r.action,
        at: r.createdAt.toISOString(),
        by: asEmployee ? null : (r.actorId && nameOf.get(r.actorId)) || null,
        to: d.to ?? null,
        documentNumber: d.documentNumber ?? null,
        issuedOn: d.issuedOn ?? null,
        edited: d.edited ?? null,
      };
    });
  }

  // The date and number this letter was first issued with. Letters issued before this was stored are recovered from
  // the audit log's oldest "letter issued" entry and saved, so they keep their real date too. null = never issued.
  private isPrivileged(actor: Actor) {
    return actor.role === Role.ADMIN || actor.role === Role.HR;
  }

  private async findIssuedLetter(employeeId: string, key: string, organizationId: string) {
    const saved = await this.scopedPrisma.issuedLetter.findFirst({ where: { organizationId, employeeId, key } });
    if (saved) return saved;
    const first = await this.scopedPrisma.auditLog.findFirst({
      where: {
        organizationId,
        module: AuditModule.DOCUMENT,
        action: 'LETTER_ISSUED',
        targetId: employeeId,
        details: { path: ['key'], equals: key },
      },
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true, details: true },
    });
    if (!first) return null;
    const number = (first.details as { documentNumber?: unknown } | null)?.documentNumber;
    await this.scopedPrisma.issuedLetter.createMany({
      data: [{ organizationId, employeeId, key, issuedAt: first.createdAt, documentNumber: typeof number === 'string' ? number : null }],
      skipDuplicates: true,
    });
    return this.scopedPrisma.issuedLetter.findFirst({ where: { organizationId, employeeId, key } });
  }

  async generate(
    employeeId: string,
    key: string,
    actor: Actor,
    organizationId: string,
    // HR's edited title/body for this one send — see SendLetterDto. Blank/
    // omitted falls back to the template's own rendered content, same as
    // before this existed. Only ever passed from send(); the plain
    // download route never overrides anything.
    overrides?: { title?: string; body?: string },
    structureAsOf?: string,
    // HR/Admin issuing the letter afresh: a new date and document number replace the saved ones.
    reissue = false,
    // The employee's signature when they approve the letter: the PDF is built with it and kept as the final copy.
    signature?: { name: string; signedAt: Date; imageBuffer?: Buffer | null; ip?: string | null; device?: string | null },
  ): Promise<{ buffer: Buffer; filename: string }> {
    if (reissue) {
      if (actor.role !== Role.ADMIN && actor.role !== Role.HR) {
        throw new ForbiddenException('Only HR or an Admin can re-issue a letter.');
      }
      await this.assertNotFinal(employeeId, key, organizationId);
      await this.scopedPrisma.issuedLetter.deleteMany({ where: { organizationId, employeeId, key } });
    }
    const issued = await this.findIssuedLetter(employeeId, key, organizationId);
    // A letter HR/Admin has written or edited (a saved version, or this send's own wording) can go out even when the record a
    // template would draw its figures from does not exist yet.
    const customized =
      this.isPrivileged(actor) &&
      (!!(overrides?.title?.trim() || overrides?.body?.trim()) ||
        !!(await this.scopedPrisma.letterOverride.findFirst({ where: { organizationId, employeeId, key }, select: { id: true } })));
    const {
      template,
      employee,
      organization,
      branding,
      companyName,
      title: computedTitle,
      paragraphs: computedParagraphs,
      variables,
    } = await this.computeLetterContent(
      employeeId,
      key,
      actor,
      organizationId,
      structureAsOf,
      issued?.issuedAt,
      customized,
    );

    // The one-off edit made in the Send box: placeholders HR typed are filled in and stray HTML never reaches the PDF.
    const title =
      editedTextToTitle(
        this.letterTemplatesService.render(overrides?.title ?? '', variables),
      ) || computedTitle;
    const paragraphs = overrides?.body?.trim()
      ? editedTextToParagraphs(
          this.letterTemplatesService.render(overrides.body, variables),
        )
      : computedParagraphs;

    // The PDF that was issued is kept as it was: a later download returns it, not a rebuild from today's data. Editing the
    // wording or the date, or re-issuing, clears it (see saveOverride / setIssueDate), and a send with its own wording replaces it.
    const sendEdited = !!(overrides?.title?.trim() || overrides?.body?.trim());
    const filename = letterFilename(employee.employeeId, key.includes('#') ? `${template.name} ${(issued?.issuedAt ?? new Date()).toISOString().slice(0, 10)}` : template.name);
    if (issued?.pdfKey && !sendEdited && !signature) {
      const stored = await readStoredFile(issued.pdfKey);
      if (stored) return { buffer: stored, filename };
    }
    // A letter already issued keeps its date and number; only a first issue (or a re-issue) takes a new number.
    const issuedAt = issued?.issuedAt ?? new Date();
    const documentNumber =
      issued?.documentNumber ??
      (await this.scopedPrisma.$transaction((tx) =>
        issueDocumentNumber(tx, organizationId, LETTER_DOC_TYPE, issuedAt, employee.employeeId, employee.name),
      ));
    if (!issued) {
      await this.scopedPrisma.issuedLetter.createMany({
        data: [{ organizationId, employeeId, key, issuedAt, documentNumber }],
        skipDuplicates: true,
      });
    } else if (!issued.documentNumber) {
      // A date was set by hand before the letter was ever issued: the number is taken now and kept.
      await this.scopedPrisma.issuedLetter.updateMany({ where: { organizationId, employeeId, key }, data: { documentNumber } });
    }

    const signatories = (organization.signatories ?? []) as Array<{
      name?: string;
      designation?: string;
      signatureUrl?: string | null;
      isPrimary?: boolean;
    }>;
    const primarySignatory =
      signatories.find((s) => s.isPrimary) ?? signatories[0] ?? null;

    const [
      companyLogoBuffer,
      signatureBuffer,
      letterHeaderBuffer,
      letterFooterBuffer,
    ] = await Promise.all([
      (branding?.brandId ? branding.logoUrl : organization.companyLogoUrl)
        ? readStoredFile(
            (branding?.brandId
              ? branding.logoUrl
              : organization.companyLogoUrl) as string,
          ).catch(() => null)
        : Promise.resolve(null),
      primarySignatory?.signatureUrl
        ? readStoredFile(primarySignatory.signatureUrl).catch(() => null)
        : Promise.resolve(null),
      // The organization's letter header/footer images carry the parent's name, so a sister company's letter uses the built-in header.
      !branding?.brandId && organization.letterHeaderUrl
        ? readStoredFile(organization.letterHeaderUrl).catch(() => null)
        : Promise.resolve(null),
      !branding?.brandId && organization.letterFooterUrl
        ? readStoredFile(organization.letterFooterUrl).catch(() => null)
        : Promise.resolve(null),
    ]);

    const buffer = await this.pdfService.render({
      content: { title, paragraphs },
      documentNumber,
      issueDate: issuedAt,
      companyName,
      companyAddress:
        (branding?.brandId
          ? branding.address
          : organization.registeredAddress) || '',
      companyLogoBuffer,
      addressedToEmployee: template.addressedToEmployee,
      employeeName: employee.name,
      employeeIdLabel: `Employee ID: ${employee.employeeId}`,
      signatoryName: primarySignatory?.name || null,
      signatoryDesignation: primarySignatory?.designation || null,
      signatureBuffer,
      watermarkEnabled: organization.watermarkLogo,
      letterHeaderBuffer,
      letterFooterBuffer,
      employeeSignature: signature ?? null,
    });

    // Keep the exact PDF just produced as the issued copy. Never fatal: without it the letter is simply rebuilt next time.
    try {
      const pdfKey = `${organizationId}/letters/${employeeId}/${key.replace(/[^A-Za-z0-9_-]/g, '_')}-${Date.now()}.pdf`;
      await writeStoredFile(pdfKey, buffer, 'application/pdf');
      await this.scopedPrisma.issuedLetter.updateMany({ where: { organizationId, employeeId, key }, data: { pdfKey } });
    } catch {
      /* the letter was produced; only the saved copy is missing */
    }

    await this.auditLogService.log({
      actorId: actor.id,
      action: 'LETTER_ISSUED',
      module: AuditModule.DOCUMENT,
      organizationId,
      targetId: employeeId,
      details: { key, templateName: template.name, documentNumber },
    });

    return { buffer, filename };
  }

  // HR/Admin-only follow-up to generate() — everything is pulled from the
  // same real employee/org/computed data, nothing to fill in; HR reviews
  // the PDF (via generate()/the Download button), optionally edits the
  // title/body text for this one send (overrides — see SendLetterDto), and
  // this then emails that content to the employee's registered address.
  // Deliberately a second call to generate() rather than threading the
  // caller's already-fetched buffer through: this issues its own document
  // number for the copy that actually goes out, same as any other
  // independent download/generate call — see generate()'s own docstring,
  // numbers were never meant to be contiguous or deduped across repeat
  // generations.
  async send(
    employeeId: string,
    key: string,
    actor: Actor,
    organizationId: string,
    // HR's edited title/body for this one send, if they changed anything in
    // the Send modal — see SendLetterDto and generate()'s own comment.
    overrides?: { title?: string; body?: string },
    structureAsOf?: string,
    // Also switch the letter on in the employee's My Letters (so what they were emailed is also there).
    makeVisible = false,
  ): Promise<{ message: string }> {
    // The approved copy can be emailed as it is, but not re-worded.
    if (overrides?.title?.trim() || overrides?.body?.trim()) await this.assertNotFinal(employeeId, key, organizationId);
    const template = await this.letterTemplatesService.findActiveByKey(
      baseKeyOf(key),
      organizationId,
    );
    if (!template) {
      throw new BadRequestException(
        `No active letter template found for '${key}' — configure one in Organization Settings > Letter Templates.`,
      );
    }

    const employee = await this.scopedPrisma.user.findFirst({
      where: { id: employeeId, organizationId },
      select: {
        name: true,
        email: true,
        isActive: true,
        exitDate: true,
        personalData: true,
        brandId: true,
      },
    });
    if (!employee) throw new NotFoundException('Employee not found.');
    // Someone who has left (or is leaving) has no working company mailbox: their letters go to the personal email on file and
    // nowhere else. With none, the letter is refused - never sent to the company address, never "sent" to nowhere.
    const { leaving, recipient } = letterRecipientOf(employee);
    if (!recipient) {
      throw new BadRequestException(
        leaving
          ? `${employee.name} has left (or is leaving) and has no personal email on file, so this letter cannot be emailed. Add their Personal Email to the profile, or download the letter and hand it over.`
          : `${employee.name} has no email address, so this letter cannot be emailed. Download it and hand it over.`,
      );
    }

    const { buffer, filename } = await this.generate(
      employeeId,
      key,
      actor,
      organizationId,
      overrides,
      structureAsOf,
    );

    const organization = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { companyName: true, registeredAddress: true },
    });
    const sisterBrand = employee.brandId
      ? await this.brandingLookup.forBrand(organizationId, employee.brandId)
      : null;
    const companyName = sisterBrand?.brandId
      ? sisterBrand.companyName
      : organization?.companyName || 'the Company';

    const rendered = await this.emailTemplatesService.renderOccasion(
      organizationId,
      'LETTER_SENT',
      {
        employeeName: employee.name,
        letterName: template.name,
        companyName,
      },
      {
        subject: `Your ${template.name} from ${companyName}`,
        html: `<p>Hi ${escapeHtml(employee.name)},</p><p>Please find your ${escapeHtml(template.name)} attached.</p><p>${escapeHtml(companyName)}</p>`,
      },
      { brandId: employee.brandId },
    );

    const sendResult = await this.emailService.send({
      organizationId,
      allowInactive: true, // addressed to a leaver on purpose
      to: recipient,
      subject: rendered.subject,
      html: rendered.html,
      attachments: [{ filename, content: buffer }],
    });
    // The mail service reports, rather than throws, when nothing was sent: never tell HR a letter went out when it did not,
    // and leave no "emailed" record in the audit log or the timeline.
    if (sendResult?.dryRun) {
      const why: Record<string, string> = {
        'not-configured': 'Email is not set up for this system yet (the mail server login is missing).',
        paused: 'Email sending is paused for a few minutes after the mail server refused the login.',
        failed: 'The mail server did not accept it.',
        'no-address': 'The employee has no deliverable email address.',
        'test-address': 'The address is a reserved test address.',
        inactive: 'The recipient is an inactive employee.',
      };
      throw new ServiceUnavailableException(`The letter could not be emailed to ${recipient}. ${why[sendResult.reason ?? 'failed']} Try again, or download it and hand it over.`);
    }

    if (makeVisible) await this.writeAccess(employeeId, key, true, actor, organizationId, template.name, true, !!template.requiresApproval);
    const edited = !!(overrides?.title?.trim() || overrides?.body?.trim());
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'LETTER_EMAILED',
      module: AuditModule.DOCUMENT,
      organizationId,
      targetId: employeeId,
      // What HR changed for this send is kept as sent, so there is a record of the exact wording that went out.
      details: { key, templateName: template.name, to: recipient, edited, ...(edited ? { sentTitle: overrides?.title ?? null, sentBody: overrides?.body ?? null } : {}) },
    });
    await this.timelineService.logEvent({
      organizationId,
      employeeId,
      eventKey: 'LETTER_EMAILED',
      performedById: actor.id,
      description: `${template.name} emailed to ${recipient}.`,
    });

    return { message: `${template.name} emailed to ${recipient}.` };
  }

  private async latestOffboardingCase(
    employeeId: string,
    organizationId: string,
  ) {
    const offboardingCase = await this.scopedPrisma.offboardingCase.findFirst({
      where: { organizationId, employeeId },
      orderBy: { createdAt: 'desc' },
    });
    if (!offboardingCase) {
      throw new BadRequestException(
        'No offboarding case found for this employee yet — initiate offboarding first.',
      );
    }
    return offboardingCase;
  }
}
