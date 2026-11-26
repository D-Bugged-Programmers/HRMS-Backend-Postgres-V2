import { AskHrService } from './ask-hr.service';
import { EMPLOYEE_VISIBLE_STATUSES } from '../payroll/payroll.service';
import { moduleEnabledFor } from '../module-access/module-gate';

jest.mock('../module-access/module-gate', () => ({ moduleEnabledFor: jest.fn().mockResolvedValue(true) }));

const actor = (role: string) => ({ id: 'u1', organizationId: 'o1', role, departmentId: null }) as any;

function build() {
  const db: any = {
    organization: { findFirst: jest.fn().mockResolvedValue({ timezone: 'Asia/Kolkata' }) },
    leaveType: { findMany: jest.fn().mockResolvedValue([]) },
    holiday: { findMany: jest.fn().mockResolvedValue([]) },
    leaveBalance: { findMany: jest.fn().mockResolvedValue([]) },
    leave: { findMany: jest.fn().mockResolvedValue([]) },
    payrollRun: { findMany: jest.fn().mockResolvedValue([]) },
    resignation: { findFirst: jest.fn().mockResolvedValue(null) },
    policyDocument: { updateMany: jest.fn() },
  };
  const prisma: any = {
    askHrQuery: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const docs: any = { findActivePoliciesRaw: jest.fn().mockResolvedValue([]) };
  const letters: any = { listForEmployee: jest.fn().mockResolvedValue([]) };
  const audit: any = { log: jest.fn().mockResolvedValue(undefined) };
  const leaves: any = { getBalance: jest.fn().mockResolvedValue({ balances: [], leaveYear: { year: 2026 } }) };
  return { svc: new AskHrService(db, docs, letters, prisma, audit, leaves), db, prisma, docs, audit, leaves };
}

describe('AskHrService', () => {
  beforeEach(() => (moduleEnabledFor as jest.Mock).mockResolvedValue(true));

  it('gives an employee no "on leave" card, a manager only their reports, HR everyone', async () => {
    const { svc, db } = build();
    expect((await svc.ask('who is on leave today', actor('EMPLOYEE'), 'o1')).cards.some((c) => c.kind === 'onLeave')).toBe(false);
    expect(db.leave.findMany).not.toHaveBeenCalled();
    await svc.ask('who is on leave today', actor('MANAGER'), 'o1');
    expect(db.leave.findMany.mock.calls[0][0].where.employee).toEqual({ reportingManagerId: 'u1' });
    await svc.ask('who is on leave today', actor('HR'), 'o1');
    expect(db.leave.findMany.mock.calls[1][0].where.employee).toBeUndefined();
  });

  it('shows only the caller\'s own final payslips and writes a privacy-audit entry', async () => {
    const { svc, db, audit } = build();
    db.payrollRun.findMany.mockResolvedValue([
      { month: 10, year: 2026, earnings: [{ name: 'Basic', amount: 100 }], deductions: [], grossSalary: 100, totalDeductions: 0, netPay: 100, status: 'PAID', heldAt: null },
    ]);
    const r = await svc.ask('what is my salary', actor('HR'), 'o1');
    const where = db.payrollRun.findMany.mock.calls[0][0].where;
    expect(where.employeeId).toBe('u1');
    expect(where.status.in).toEqual(EMPLOYEE_VISIBLE_STATUSES);
    expect((r.cards[0] as any).items[0]).toMatchObject({ period: 'Oct 2026', net: 100, status: 'Paid' });
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'PAYSLIP_VIEWED_VIA_ASK_HR', category: 'PAYSLIP', actorId: 'u1', targetUserId: 'u1' }));
  });

  it('writes no audit entry when there is no payslip to show', async () => {
    const { svc, audit } = build();
    await svc.ask('what is my salary', actor('EMPLOYEE'), 'o1');
    expect(audit.log).not.toHaveBeenCalled();
  });

  it('skips a card whose module the company switched off', async () => {
    (moduleEnabledFor as jest.Mock).mockImplementation(async (_o: string, m: string) => m !== 'module.payroll');
    const { svc, db } = build();
    const r = await svc.ask('what is my salary', actor('EMPLOYEE'), 'o1');
    expect(r.cards.some((c) => c.kind === 'payroll')).toBe(false);
    expect(db.payrollRun.findMany).not.toHaveBeenCalled();
    expect(await svc.suggestions('o1')).not.toContain('What is my salary?');
  });

  it('records each question, and marks one that found nothing as unanswered', async () => {
    const { svc, prisma } = build();
    await svc.ask('zzz nothing here', actor('EMPLOYEE'), 'o1');
    expect(prisma.askHrQuery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ organizationId: 'o1', userId: 'u1', question: 'zzz nothing here', answered: false }) });
  });

  it('only reads the policies the word index picks, and lists ones with no readable text', async () => {
    const { svc, prisma, docs } = build();
    prisma.$queryRaw.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }]);
    docs.findActivePoliciesRaw.mockResolvedValue([
      { id: 'p1', title: 'Handbook', contentText: '1. Notice Period\nSixty days notice is required.', updatedAt: new Date(), docType: 'PDF', fileUrl: 'k' },
      { id: 'p2', title: 'Scanned', contentText: '', updatedAt: new Date(), docType: 'PDF', fileUrl: 'k2' },
    ]);
    const r = await svc.ask('notice period', actor('EMPLOYEE'), 'o1');
    expect(docs.findActivePoliciesRaw).toHaveBeenCalledWith(expect.anything(), 'o1', ['p1', 'p2']);
    const policy = r.cards.find((c) => c.kind === 'policy') as any;
    expect(policy.hits[0].snippet).toContain('Sixty days');
    expect(policy.unreadable).toEqual(['Scanned']);
  });

  it('insights count the unanswered questions and group repeats', async () => {
    const { svc, prisma } = build();
    prisma.askHrQuery.findMany.mockResolvedValue([
      { question: 'Sabbatical leave?', answered: false },
      { question: 'sabbatical leave', answered: false },
      { question: 'notice period', answered: true },
    ]);
    const r = await svc.insights('o1');
    expect(r).toMatchObject({ total: 3, unanswered: 2 });
    expect(r.topUnanswered).toHaveLength(1);
    expect(r.topUnanswered[0].count).toBe(2);
  });

  it('does not show the leave balance just because the question says "leave"', async () => {
    const { svc, db } = build();
    db.leaveType.findMany.mockResolvedValue([{ name: 'Casual Leave', code: 'CL' }, { name: 'Sick Leave', code: 'SL' }]);
    const r = await svc.ask('sabbatical leave', actor('EMPLOYEE'), 'o1');
    expect(r.cards.some((c) => c.kind === 'balance')).toBe(false);
    const r2 = await svc.ask('casual', actor('EMPLOYEE'), 'o1');
    expect(r2.cards.some((c) => c.kind === 'balance')).toBe(true);
  });

  it("takes leave balances from the Leave screen's own calculation, for the caller and the company's leave year", async () => {
    const { svc, leaves, db } = build();
    leaves.getBalance.mockResolvedValue({
      leaveYear: { year: 2026 },
      balances: [{ leaveType: { name: 'Earned Leave' }, available: 14.5, availed: 2.5, pending: 1 }],
    });
    const who = actor('HR');
    const r = await svc.ask('how many leaves do I have left', who, 'o1');
    expect(leaves.getBalance).toHaveBeenCalledWith(undefined, undefined, who, 'o1');
    expect(db.leaveBalance.findMany).not.toHaveBeenCalled();
    expect(r.cards.find((c) => c.kind === 'balance')).toEqual({ kind: 'balance', year: 2026, items: [{ leaveType: 'Earned Leave', available: 14.5, used: 2.5, pending: 1 }] });
  });
});
