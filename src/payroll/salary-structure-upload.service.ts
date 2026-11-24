// Purpose: set the salary structure of many employees from one spreadsheet (CTC / gross per row), after a check-first preview.
// Responsibilities: per row - find the employee by code, work out the structure (the organisation's own calculator from an annual CTC
//   or a monthly gross, or fixed amounts per salary component), say what is wrong, and (when not a dry run) save it through the same
//   per-employee save the Salary tab uses, so revisions, arrears rules and notices behave exactly as for a single employee.
// Important: nothing is saved on a dry run. One bad row never stops the others; each row reports READY / SAVED / SKIPPED / FAILED.
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { Role } from '@prisma/client';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { AuditLogService } from '../audit-log/audit-log.service';
import { todayInOrgTz } from '../common/org-date';
import { EmployeeSalaryComponentsService } from '../employee-salary-components/employee-salary-components.service';
import { PayrollService } from './payroll.service';
import { SalaryUploadDto } from './dto/salary-upload.dto';

export type SalaryUploadStatus = 'READY' | 'SAVED' | 'SKIPPED' | 'FAILED';

export interface SalaryUploadRowResult {
  row: number;
  employeeCode: string;
  name: string | null;
  status: SalaryUploadStatus;
  /** Why a row was skipped or failed, or what happened. */
  message: string;
  effectiveFrom: string | null;
  monthlyGross: number | null;
  ctcAnnual: number | null;
  variableAnnual: number | null;
  /** True when the employee already had a salary structure (this row is a revision). */
  revision: boolean;
  /** Their current monthly gross, for a revision: shown beside the new one so a big jump is seen before saving. */
  currentMonthlyGross: number | null;
  /** For a row that gave an amount per salary component: exactly what will be saved, so the figures can be compared with the sheet. */
  components?: { name: string; amount: number; kind: 'EARNING' | 'DEDUCTION' | 'EMPLOYER'; /** True when the system worked it out (not typed in the sheet). */ calculated?: boolean }[];
  warnings: string[];
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function text(v: unknown): string {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
}

/** A money cell: blank = not given (null); otherwise a non-negative number (commas and a leading currency sign are ignored), else NaN. */
function money(v: unknown): number | null | typeof NaN {
  const s = text(v).replace(/[,₹\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

function yes(v: unknown): boolean {
  return ['yes', 'y', 'true', '1'].includes(text(v).toLowerCase());
}

/** A look-wrong warning for an amount: a monthly figure typed as annual, an extra zero... Never blocks a row. */
function sanityWarnings(annualCtc: number | null, monthlyGross: number | null): string[] {
  const out: string[] = [];
  if (annualCtc && annualCtc < 120000) out.push(`Annual CTC is ₹${Math.round(annualCtc).toLocaleString('en-IN')}: is this a monthly amount?`);
  if (annualCtc && annualCtc > 100000000) out.push(`Annual CTC is ₹${Math.round(annualCtc).toLocaleString('en-IN')}: please check for an extra zero.`);
  if (monthlyGross && monthlyGross < 5000) out.push(`Monthly gross is ₹${Math.round(monthlyGross).toLocaleString('en-IN')}: is this a daily or annual figure in the wrong column?`);
  if (monthlyGross && monthlyGross > 5000000) out.push(`Monthly gross is ₹${Math.round(monthlyGross).toLocaleString('en-IN')}: please check for an extra zero.`);
  return out;
}

function validDate(s: string): boolean {
  return YMD.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
}

@Injectable()
export class SalaryStructureUploadService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly payroll: PayrollService,
    private readonly employeeSalary: EmployeeSalaryComponentsService,
    private readonly auditLogService: AuditLogService,
  ) {}

  async process(dto: SalaryUploadDto, actor: { id: string; role: Role }, organizationId: string) {
    if (dto.defaultEffectiveFrom && !validDate(dto.defaultEffectiveFrom)) {
      throw new BadRequestException('The default effective date is not a valid date.');
    }
    const org = await this.scopedPrisma.organization.findFirst({ where: { id: organizationId }, select: { timezone: true } });
    const today = todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
    const context = await this.payroll.structureContext(organizationId);
    const activeComponents = context.components.filter((c) => c.isActive);
    const componentByKey = new Map<string, string>();
    for (const c of activeComponents) {
      componentByKey.set(c.code.toLowerCase(), c.code);
      componentByKey.set(c.name.toLowerCase(), c.code);
    }
    // Every component of the company (also the switched-off ones), so a column for one can be named properly instead of "unknown".
    const anyComponentByKey = new Map<string, (typeof context.components)[number]>();
    for (const c of context.components) {
      anyComponentByKey.set(c.code.toLowerCase(), c);
      anyComponentByKey.set(c.name.toLowerCase(), c);
    }
    const componentOf = new Map(context.components.map((c) => [c.code, c]));

    const codes = [...new Set(dto.rows.map((r) => text(r.employeeCode)).filter(Boolean))];
    // Codes match whatever the case (sis2-0001 = SIS2-0001): look up the typed form and its upper / lower case.
    const lookupCodes = [...new Set(codes.flatMap((c) => [c, c.toUpperCase(), c.toLowerCase()]))];
    const employees = codes.length
      ? await this.scopedPrisma.user.findMany({
          where: { organizationId, employeeId: { in: lookupCodes } },
          select: { id: true, employeeId: true, name: true, isActive: true, joiningDate: true, workLocationId: true, departmentId: true, employeeType: true },
        })
      : [];
    const byCode = new Map(employees.map((e) => [e.employeeId.toUpperCase(), e]));
    // What each person is paid now (annual CTC), for a revision: the "no change" check and the comparison column.
    const currentCtc = dto.existing === 'REVISE' ? new Map((await this.employeeSalary.listSalarySummaries(organizationId)).map((s) => [s.employeeId, s])) : new Map<string, { hasStructure: boolean; fixedMonthly: number; variableAnnual: number }>();
    const withStructure = new Set(
      (
        await this.scopedPrisma.employeeSalaryComponent.groupBy({
          by: ['employeeId'],
          where: { organizationId, employeeId: { in: employees.map((e) => e.id) } },
          _count: { _all: true },
        })
      ).map((g) => g.employeeId),
    );
    const seen = new Set<string>();

    const results: SalaryUploadRowResult[] = [];
    for (const [i, raw] of dto.rows.entries()) {
      const code = text(raw.employeeCode);
      const result: SalaryUploadRowResult = {
        row: i + 1,
        employeeCode: code,
        name: null,
        status: 'FAILED',
        message: '',
        effectiveFrom: null,
        monthlyGross: null,
        ctcAnnual: null,
        variableAnnual: null,
        revision: false,
        currentMonthlyGross: null,
        warnings: [],
      };
      results.push(result);
      const fail = (message: string) => {
        result.status = 'FAILED';
        result.message = message;
      };

      if (!code) { fail('Employee code is required.'); continue; }
      if (seen.has(code.toUpperCase())) { fail(`Employee code ${code} appears more than once in this file.`); continue; }
      seen.add(code.toUpperCase());
      const employee = byCode.get(code.toUpperCase());
      if (!employee) { fail(`No employee has the code ${code}.`); continue; }
      result.name = employee.name;
      if (!employee.isActive) { fail('This employee is not active.'); continue; }
      if (employee.id === actor.id && actor.role !== Role.ADMIN) {
        fail('You cannot change your own salary structure. An Admin must do it.');
        continue;
      }
      const hasStructure = withStructure.has(employee.id);
      result.revision = hasStructure;
      if (hasStructure && dto.existing === 'SKIP') {
        result.status = 'SKIPPED';
        result.message = 'Already has a salary structure (skipped).';
        continue;
      }

      // The effective date: the row's own, else the file's, else the joining date for a first structure, else today.
      const rowDate = text(raw.effectiveFrom);
      if (rowDate && !validDate(rowDate)) { fail(`Effective date "${rowDate}" is not a valid date.`); continue; }
      const joined = employee.joiningDate ? employee.joiningDate.toISOString().slice(0, 10) : null;
      const effectiveFrom = rowDate || dto.defaultEffectiveFrom || (!hasStructure && joined ? joined : today);
      result.effectiveFrom = effectiveFrom;

      // What to save: fixed amounts per component when given, else the calculator's split of the CTC / gross.
      const componentEntries = Object.entries(raw.components ?? {}).filter(([, v]) => text(v) !== '');
      const annualCtc = money(raw.annualCtc);
      const monthlyGross = money(raw.monthlyGross);
      const variableAnnual = money(raw.variableAnnual);
      if ([annualCtc, monthlyGross, variableAnnual].some((n) => Number.isNaN(n))) {
        fail('Annual CTC, monthly gross and variable pay must be amounts (numbers, no text).');
        continue;
      }
      let lines: { componentCode: string; valueType: 'FIXED' | 'MANUAL' | 'PERCENTAGE'; fixedAmount?: number; percentageValue?: number; percentageOf?: string; amountBasis?: 'MONTHLY' | 'ANNUAL'; isEnabled: boolean }[] = [];
      if (componentEntries.length > 0) {
        const unknown: string[] = [];
        const switchedOff: string[] = [];
        let gross = 0;
        let employer = 0;
        const breakdown: NonNullable<SalaryUploadRowResult['components']> = [];
        for (const [key, v] of componentEntries) {
          const componentCode = componentByKey.get(key.trim().toLowerCase());
          const amount = money(v);
          if (!componentCode) {
            // A component the company has, but switched off: say so instead of calling it unknown.
            if (anyComponentByKey.has(key.trim().toLowerCase())) switchedOff.push(anyComponentByKey.get(key.trim().toLowerCase())!.name);
            else unknown.push(key);
            continue;
          }
          if (amount === null || Number.isNaN(amount)) { fail(`${key} must be an amount.`); break; }
          const comp = componentOf.get(componentCode);
          // The monthly gross is what the person earns; deductions and what the employer pays on top are not part of it.
          const kind = comp?.isEmployerContribution ? 'EMPLOYER' : comp?.type === 'DEDUCTION' ? 'DEDUCTION' : 'EARNING';
          if (kind === 'EARNING') gross += amount;
          else if (kind === 'EMPLOYER') employer += amount;
          breakdown.push({ name: comp?.name ?? componentCode, amount, kind });
          lines.push({ componentCode, valueType: 'FIXED', fixedAmount: amount, amountBasis: 'MONTHLY', isEnabled: true });
        }
        if (result.message) continue;
        if (switchedOff.length > 0) { fail(`${switchedOff.join(', ')} ${switchedOff.length === 1 ? 'is' : 'are'} switched off in Salary Components. Switch ${switchedOff.length === 1 ? 'it' : 'them'} on first, or leave the column empty.`); continue; }
        if (unknown.length > 0) { fail(`Unknown salary component: ${unknown.join(', ')}.`); continue; }
        result.components = breakdown;
        result.monthlyGross = Math.round(gross);
        result.ctcAnnual = Math.round((gross + employer) * 12);
      } else {
        if ((annualCtc ?? 0) > 0 && (monthlyGross ?? 0) > 0) { fail('Give either Annual CTC or Monthly gross, not both.'); continue; }
        if (!((annualCtc ?? 0) > 0) && !((monthlyGross ?? 0) > 0)) { fail('Annual CTC or Monthly gross is required (or the salary component amounts).'); continue; }
        try {
          const preview = await this.payroll.previewStructure(
            {
              mode: (annualCtc ?? 0) > 0 ? 'CTC' : 'GROSS',
              ...((annualCtc ?? 0) > 0 ? { annualCtc: annualCtc as number } : { monthlyGross: monthlyGross as number }),
              ...((variableAnnual ?? 0) > 0 ? { variableAnnual: variableAnnual as number } : {}),
              ...((annualCtc ?? 0) > 0 && (variableAnnual ?? 0) > 0 ? { variableIncludedInCtc: yes(raw.variableIncludedInCtc) } : {}),
              workLocationId: employee.workLocationId ?? undefined,
              departmentId: employee.departmentId ?? undefined,
              employeeType: employee.employeeType ?? undefined,
            },
            organizationId,
            context,
          );
          lines = preview.lines;
          result.monthlyGross = preview.grossMonthly;
          result.ctcAnnual = preview.ctcAnnual;
          result.variableAnnual = preview.variableAnnual || null;
          result.warnings.push(...preview.warnings);
        } catch (err) {
          fail(err instanceof BadRequestException ? err.message : 'The salary could not be worked out for this row.');
          continue;
        }
      }
      if (lines.length === 0) { fail('There is nothing to save for this row.'); continue; }

      // Show the employee's own and the employer's PF / ESI too (worked out from what is being saved), so nothing is a surprise later.
      try {
        const extra = await this.payroll.contributionLinesForRows(lines, employee, organizationId, context);
        const shown = new Set((result.components ?? []).map((c) => c.name));
        const add: NonNullable<SalaryUploadRowResult['components']> = [];
        for (const l of extra.employeeLines) if (!shown.has(l.name)) add.push({ name: l.name, amount: l.amount, kind: 'DEDUCTION', calculated: true });
        for (const l of extra.employerLines) if (!shown.has(l.name)) add.push({ name: l.name, amount: l.amount, kind: 'EMPLOYER', calculated: true });
        if (add.length > 0) result.components = [...(result.components ?? []), ...add];
      } catch { /* the preview still works without this extra detail */ }

      // Look-wrong amounts: a warning on the row, never a block.
      result.warnings.push(...sanityWarnings(annualCtc, monthlyGross));
      // A revision: show what they earn now, flag a big jump, and skip a row that would change nothing.
      if (hasStructure) {
        const now = currentCtc.get(employee.id);
        if (now?.hasStructure) {
          result.currentMonthlyGross = Math.round(now.fixedMonthly);
          // Only the calculator's own figures are comparable with the saved structure (fixed amounts typed per component are not).
          if (componentEntries.length === 0 && result.monthlyGross !== null) {
            const sameFixed = Math.abs(result.monthlyGross - now.fixedMonthly) < 1.5;
            const sameVariable = Math.abs((result.variableAnnual ?? 0) - now.variableAnnual) < 2;
            if (sameFixed && sameVariable) {
              result.status = 'SKIPPED';
              result.message = 'No change: this is already their salary.';
              continue;
            }
            if (now.fixedMonthly > 0) {
              const change = ((result.monthlyGross - now.fixedMonthly) / now.fixedMonthly) * 100;
              if (Math.abs(change) >= 30) result.warnings.push(`Monthly gross changes by ${change > 0 ? '+' : ''}${Math.round(change)}% (from ₹${Math.round(now.fixedMonthly).toLocaleString('en-IN')} to ₹${Math.round(result.monthlyGross).toLocaleString('en-IN')}).`);
            }
          }
        }
      }
      // A date in a month whose payroll is already locked or paid is refused unless arrears are allowed - said now, not at Save.
      if (!dto.backdateForArrears) {
        const locked = await this.employeeSalary.finalizedPayrollConflict(employee.id, effectiveFrom, organizationId);
        if (locked) { fail(`${locked} Tick "Allow dates in months whose payroll is locked" to pay the difference as arrears.`); continue; }
      }

      if (dto.dryRun) {
        result.status = 'READY';
        result.message = hasStructure ? 'Ready: a new revision from the effective date.' : 'Ready: first salary structure.';
        continue;
      }
      try {
        const saved = await this.employeeSalary.bulkSetStructure(
          employee.id,
          { lines, effectiveFrom, ...(dto.backdateForArrears ? { backdateForArrears: true } : {}) } as never,
          actor.id,
          organizationId,
        );
        result.warnings.push(...saved.warnings);
        if (saved.failed.length > 0) {
          fail(`${saved.failed.length} of ${lines.length} components were not saved: ${saved.failed[0].error}`);
        } else {
          result.status = 'SAVED';
          result.message = hasStructure ? 'Revision saved.' : 'Salary structure saved.';
        }
      } catch (err) {
        fail(err instanceof BadRequestException ? err.message : 'Could not save this salary structure.');
      }
    }

    const count = (s: SalaryUploadStatus) => results.filter((r) => r.status === s).length;
    const summary = { total: results.length, ready: count('READY'), saved: count('SAVED'), skipped: count('SKIPPED'), failed: count('FAILED') };
    if (!dto.dryRun) {
      await this.auditLogService.log({
        actorId: actor.id,
        action: 'SALARY_STRUCTURE_BULK_UPLOAD',
        module: 'PAYROLL',
        organizationId,
        details: { ...summary, existing: dto.existing },
      });
    }
    return { dryRun: !!dto.dryRun, summary, rows: results };
  }
}
