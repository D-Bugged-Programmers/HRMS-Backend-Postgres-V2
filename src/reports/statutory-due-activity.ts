// Purpose: Decides which statutory due dates are worth showing or reminding about, from what actually happened in payroll.
// Responsibilities: reads the months with a paid-out payroll run and the salary TDS deducted in each, plus the month each
//   statutory module was first switched on, and drops the dues that cannot apply: a past period with no payroll, a period before
//   the module started, and TDS deposits / returns for months or quarters in which no TDS was deducted.
// Important: a due date still to come is always kept (the payroll for it may not have run yet), and an unfiled overdue one is never
//   dropped just for being old - only for having nothing behind it.
import { PayrollRunStatus } from '@prisma/client';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { SALARY_COMPONENT_CODES } from '../common/reserved-codes';
import type { StatutoryDue } from '../scheduled-reminders/reminder-dates';
import { quarterOf, taxYearOf } from '../tds-compliance/tds-math';

export interface DueContext {
  /** 'YYYY-MM' of every month with a paid-out payroll run. */
  runMonths: Set<string>;
  /** Salary TDS deducted per month ('YYYY-MM'), over those runs. */
  tdsByMonth: Map<string, number>;
  /** The month ('YYYY-MM') each of PF / ESI / PT / LWF was first switched on. */
  moduleStart: Map<string, string>;
  /** TDS deposits recorded on the TDS Compliance page, and the statement receipts of the quarterly returns. */
  challans: { month: number; year: number; tdsAmount: number; bsrCode: string; challanSerialNo: string; depositDate: string }[];
  statements: { financialYear: string; quarter: number; receiptNumber: string; filedOn: string | null }[];
}

/** What the TDS records say about a TDS deposit / return due: when and how it was recorded, or null while it is not. */
export function tdsRecordFor(
  d: { key: string; months: string[] },
  ctx: DueContext,
): { filedOn: string | null; reference: string; amount: number | null } | null {
  if (d.key !== 'TDS' && d.key !== '24Q') return null;
  const [y, m] = d.months[0].split('-').map(Number);
  if (d.key === 'TDS') {
    const total = ctx.tdsByMonth.get(d.months[0]) ?? 0;
    const rows = ctx.challans.filter((c) => c.month === m && c.year === y);
    const deposited = rows.reduce((t, c) => t + c.tdsAmount, 0);
    if (!(total > 0 && deposited >= total)) return null;
    const refs = rows.map((c) => `${c.bsrCode}/${c.challanSerialNo}`);
    return {
      filedOn: rows.map((c) => c.depositDate).sort().pop() ?? null,
      reference: refs.length > 2 ? `${refs.length} challans` : refs.join(', '),
      amount: deposited,
    };
  }
  const st = ctx.statements.find((x) => x.financialYear === taxYearOf(m, y) && x.quarter === quarterOf(m));
  return st ? { filedOn: st.filedOn ?? null, reference: st.receiptNumber, amount: null } : null;
}

const PAID_OUT: PayrollRunStatus[] = [PayrollRunStatus.APPROVED, PayrollRunStatus.LOCKED, PayrollRunStatus.PAID];

export async function loadDueContext(
  prisma: ExtendedPrismaClient,
  organizationId: string,
  sinceYear: number,
): Promise<DueContext> {
  const runs = await prisma.payrollRun.findMany({
    where: { organizationId, status: { in: PAID_OUT }, year: { gte: sinceYear } },
    select: { month: true, year: true, deductions: true },
  });
  const runMonths = new Set<string>();
  const tdsByMonth = new Map<string, number>();
  for (const r of runs) {
    const key = `${r.year}-${String(r.month).padStart(2, '0')}`;
    runMonths.add(key);
    const tds =
      ((r.deductions as { code: string; amount: number }[] | null) ?? []).find(
        (l) => l.code === SALARY_COMPONENT_CODES.INCOME_TAX,
      )?.amount ?? 0;
    tdsByMonth.set(key, (tdsByMonth.get(key) ?? 0) + tds);
  }
  const versions = await prisma.statutoryConfigVersion.findMany({
    where: { organizationId, isEnabled: true, module: { in: ['PF', 'ESI', 'PT', 'LWF'] } },
    select: { module: true, effectiveFrom: true },
    orderBy: { effectiveFrom: 'asc' },
  });
  const moduleStart = new Map<string, string>();
  for (const v of versions) if (!moduleStart.has(v.module)) moduleStart.set(v.module, v.effectiveFrom.slice(0, 7));
  const challans = await prisma.tdsChallan.findMany({
    where: { organizationId, year: { gte: sinceYear } },
    select: { month: true, year: true, tdsAmount: true, bsrCode: true, challanSerialNo: true, depositDate: true },
  });
  const statements = await prisma.tdsStatement.findMany({
    where: { organizationId },
    select: { financialYear: true, quarter: true, receiptNumber: true, filedOn: true },
  });
  return { runMonths, tdsByMonth, moduleStart, challans, statements };
}

export function relevantDues<T extends StatutoryDue>(dues: T[], ctx: DueContext): T[] {
  return dues.filter((d) => {
    const ran = d.months.some((m) => ctx.runMonths.has(m));
    if (d.key === 'TDS' || d.key === '24Q') {
      // Salary TDS: only where some was deducted. With no payroll yet for the period, only a due date still to come is kept.
      if (ran) return d.months.reduce((t, m) => t + (ctx.tdsByMonth.get(m) ?? 0), 0) > 0;
      return d.daysLeft >= 0;
    }
    // PF / ESI / PT / LWF: a past period needs a payroll behind it and must not be before the module was switched on.
    if (d.daysLeft >= 0) return true;
    const start = ctx.moduleStart.get(d.key);
    if (start && d.months[d.months.length - 1] < start) return false;
    return ran;
  });
}
