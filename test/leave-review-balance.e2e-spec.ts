import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createValidationPipe } from '../src/common/validation-pipe';
// The mobile app's rule (src/utils/leaveReviewBalance.ts): the server's `pending` includes the request under review.
const reviewBalance = (row: { closing: number; pending: number }, requestedDays: number) => {
  const days = Math.max(0, Number(requestedDays) || 0);
  const otherPending = Math.max(0, row.pending - days);
  const before = Math.round((row.closing - otherPending) * 100) / 100;
  const after = Math.round((before - days) * 100) / 100;
  return { requested: days, before, after, short: after < 0, otherPending: Math.round(otherPending * 100) / 100 };
};
const PASSWORD = 'TestPass123!';
describe('review leave balance', () => {
  let app: INestApplication<App>; let prisma: PrismaService; let org: string; let typeId: string;
  const people: Record<string, { id: string; token: string }> = {};
  const api = () => request(app.getHttpServer());
  const as = (w: string) => ({ Authorization: `Bearer ${people[w].token}` });
  const login = async (e: string, p: string) => (await api().post('/auth/login').send({ email: e, password: p })).body.accessToken as string;
  const apply = async (start: string, extra: Record<string, unknown> = {}) => { const r = await api().post('/leaves').set(as('emp')).send({ leaveType: typeId, startDate: start, endDate: start, remarks: 't', ...extra }); expect({ s: r.status, m: r.status === 201 ? '' : r.body.message }).toEqual({ s: 201, m: '' }); return r.body.id as string; };
  const items = async () => (await api().get('/dashboard/pending-items').query({ type: 'LEAVE' }).set(as('mgr')).expect(200)).body as any;
  const seen = async (id: string) => {
    const list = (Array.isArray((await items())) ? await items() : (await items()).items) as any[];
    const it = list.find((i) => i.id === id);
    const bal = (await api().get('/leaves/balance').query({ employeeId: it.employeeUserId, year: Number(it.date.slice(0, 4)) }).set(as('mgr')).expect(200)).body.balances.find((b: any) => b.leaveType.id === it.leaveTypeId);
    return { it, shown: reviewBalance({ closing: bal.closing, pending: bal.pending }, it.totalDays), employeeSees: bal.available };
  };
  beforeAll(async () => {
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication(); app.use(cookieParser()); app.useGlobalPipes(createValidationPipe()); await app.init(); prisma = app.get(PrismaService);
    await api().post('/auth/register').send({ organizationName: 'RB Org', name: 'Founder', email: 'rb-admin@example.test', password: PASSWORD });
    await prisma.$executeRawUnsafe(`UPDATE "organizations" SET "platformStatus" = 'ACTIVE', "isActive" = true`);
    await prisma.$executeRawUnsafe(`UPDATE "users" SET "isActive" = true, "emailVerified" = true`);
    const f = await prisma.user.findFirstOrThrow({ where: { email: 'rb-admin@example.test' } }); org = f.organizationId;
    people.admin = { id: f.id, token: await login('rb-admin@example.test', PASSWORD) };
    for (const [k, extra] of [['mgr', { role: 'MANAGER' }], ['other', { role: 'MANAGER' }]] as const) {
      const r = await api().post('/employees').set(as('admin')).send({ name: `RB ${k}`, email: `rb-${k}@example.test`, joiningDate: '2025-01-01', ...extra });
      people[k] = { id: r.body.employee.id, token: await login(`rb-${k}@example.test`, r.body.generatedPassword) };
    }
    const r = await api().post('/employees').set(as('admin')).send({ name: 'RB emp', email: 'rb-emp@example.test', joiningDate: '2025-01-01', reportingManagerId: people.mgr.id });
    people.emp = { id: r.body.employee.id, token: await login('rb-emp@example.test', r.body.generatedPassword) };
    const t = (await prisma.leaveType.findMany({ where: { organizationId: org, isActive: true } })).find((x) => x.code === 'SL')!; typeId = t.id;
    const rules = { minDurationDays: 0.5, maxDurationDays: null, noticePeriodDays: 0, allowBackdated: true, maxBackdateDays: 400, allowFutureDated: true, maxAdvanceDays: null, allowHalfDay: true, sandwichLeaveApplies: false, restrictPrefixSuffixHoliday: false, maxConsecutiveDays: null, minGapBetweenRequestsDays: 0 };
    await prisma.leaveType.update({ where: { id: typeId }, data: { allocationType: 'FIXED_ANNUAL', annualQuota: 2, documentsRequired: false, rules } });
    await prisma.leaveBalance.deleteMany({ where: { organizationId: org } });
  }, 180000);
  afterAll(async () => { await prisma.$executeRawUnsafe('TRUNCATE TABLE "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE'); await app.close(); });

  it('shows the employee balance, requested days and balance after, with other pending requests held', async () => {
    const a = await apply('2026-12-07'); const b = await apply('2026-12-09', { isHalfDay: true, halfDaySession: 'FIRST_HALF' });
    const x = await seen(a); const y = await seen(b);
    expect(x.it.leaveTypeId).toBe(typeId); expect(x.it.employeeUserId).toBe(people.emp.id);
    expect(x.shown).toMatchObject({ requested: 1, before: 2 - 0.5, after: 0.5, short: false, otherPending: 0.5 });
    expect(y.shown).toMatchObject({ requested: 0.5, before: 2 - 1, after: 0.5, short: false, otherPending: 1 });
    expect(x.employeeSees).toBe(0.5);
  });
  it('after approval the balance is exactly what was shown as "after"', async () => {
    const a = (await prisma.leave.findFirstOrThrow({ where: { employeeId: people.emp.id, startDate: '2026-12-07' } })).id;
    const before = await seen(a);
    await api().patch(`/leaves/${a}/review`).set(as('mgr')).send({ decision: 'APPROVED' }).expect(200);
    const bal = (await api().get('/leaves/balance').set(as('emp')).expect(200)).body.balances.find((r: any) => r.leaveType.id === typeId);
    expect(bal.closing - bal.pending).toBeCloseTo(before.shown.after, 5);
  });
  it('a shortfall is reported as insufficient (negative after)', async () => {
    // The server refuses to take a request beyond the balance, so a shortfall arises when the balance drops after the request
    // (here: an HR adjustment of -1 day while the request waits).
    const third = await apply('2026-12-10', { isHalfDay: true, halfDaySession: 'FIRST_HALF' });
    const row = await prisma.leaveBalance.findFirstOrThrow({ where: { organizationId: org, employeeId: people.emp.id, leaveTypeId: typeId } });
    await prisma.leaveBalance.update({ where: { id: row.id }, data: { adjusted: row.adjusted - 1, closing: row.closing - 1 } });
    const s = await seen(third);
    expect(s.shown.short).toBe(true);
    expect(s.shown.after).toBe(-1); // 0 left after the adjustment, minus 0.5 held by the other waiting half day, minus these 0.5
    expect(s.shown.before).toBe(-0.5);
  });
  it("the reviewer sees the employee's balance, never another manager's employee", async () => {
    await api().get('/leaves/balance').query({ employeeId: people.emp.id }).set(as('other')).expect(403);
    await api().get('/leaves/balance').query({ employeeId: people.emp.id }).set(as('emp')).expect(200);
    await api().get('/leaves/balance').query({ employeeId: people.mgr.id }).set(as('emp')).expect(403);
  });
});
