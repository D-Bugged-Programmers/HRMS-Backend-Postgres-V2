// Purpose: each person's estimated monthly Basic, for overtime pay estimates (report, table and pay summary).
// Source: the salary structure (fixed, or a percentage of CTC or of another fixed component), else the largest Basic on
//   their last three payroll runs. An estimate only - payroll is the source of truth. People with no figure are left out.
import { PayrollRunStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { estimateMonthlyBasic } from './basic-estimate';
import { resolveCurrentRows } from '../employee-salary-components/salary-structure-math';

export async function loadMonthlyBasics(
  db: Pick<Prisma.TransactionClient, 'employeeSalaryComponent' | 'payrollRun'>,
  employeeIds: string[],
  asOfDate: string,
  organizationId: string,
): Promise<Map<string, number>> {
  const basics = new Map<string, number>();
  const approvedIds = employeeIds;
  const to = asOfDate;
  if (approvedIds.length) {
    const [structureRows, runs] = await Promise.all([
      db.employeeSalaryComponent.findMany({
        where: {
          organizationId,
          employeeId: { in: approvedIds },
          isEnabled: true,
        },
      }),
      db.payrollRun.findMany({
        where: {
          organizationId,
          employeeId: { in: approvedIds },
          isFinalSettlement: false,
          runSequence: 0,
          status: { not: PayrollRunStatus.DRAFT },
        },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        select: { employeeId: true, earnings: true, ctcMonthly: true },
        take: approvedIds.length * 3,
      }),
    ]);
    const rowsBy = new Map<string, typeof structureRows>();
    for (const r of structureRows) {
      rowsBy.set(r.employeeId, [...(rowsBy.get(r.employeeId) ?? []), r]);
    }
    // The latest run's monthly CTC, for a Basic set as a percentage of CTC.
    const ctcBy = new Map<string, number>();
    for (const run of runs) {
      if (!ctcBy.has(run.employeeId) && run.ctcMonthly > 0) {
        ctcBy.set(run.employeeId, run.ctcMonthly);
      }
    }
    const runBasics = new Map<string, number[]>();
    for (const run of runs) {
      const list = runBasics.get(run.employeeId) ?? [];
      if (list.length >= 3) continue;
      const entry = (
        (run.earnings ?? []) as unknown as { code: string; amount: number }[]
      ).find((e) => e.code === 'BASIC');
      list.push(Number(entry?.amount) || 0);
      runBasics.set(run.employeeId, list);
    }
    for (const id of approvedIds) {
      const estimate = estimateMonthlyBasic({
        rows: resolveCurrentRows(rowsBy.get(id) ?? [], to),
        ctcMonthly: ctcBy.get(id) ?? null,
        lastRunBasics: runBasics.get(id) ?? [],
      });
      if (estimate !== null) basics.set(id, estimate);
    }
  }
  return basics;
}

// Pay for one overtime record, with the same maths as the standard Overtime Pay formula: hours x multiplier x (Basic / 208),
// plus pay days x (Basic / 30). Work compensated with comp-off is not paid by the hour.
export function estimateOvertimeAmount(
  r: {
    hours: number;
    rateMultiplier: number;
    compensationKey?: string | null;
    payDays?: number | null;
  },
  basic: number,
): number {
  const paidHours = r.compensationKey ? 0 : r.hours * r.rateMultiplier;
  return (
    Math.round(
      (paidHours * (basic / 208) + (r.payDays ?? 0) * (basic / 30)) * 100,
    ) / 100
  );
}
