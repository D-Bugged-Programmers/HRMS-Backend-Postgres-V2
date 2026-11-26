import * as path from 'path';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.env.test'), override: true });

import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createValidationPipe } from '../src/common/validation-pipe';

const PASSWORD = 'TestPass123!';
const QUOTA = 18;
interface Row { leaveType: { id: string; code: string }; availed: number; pending: number; closing: number; available: number }

describe('Leave used and available (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let organizationId: string;
  let el: string;
  let other: { id: string; code: string };
  const people: Record<string, { id: string; token: string }> = {};

  const api = () => request(app.getHttpServer());
  const as = (who: string) => ({ Authorization: `Bearer ${people[who].token}` });
  const login = async (email: string, password: string) => ((await api().post('/auth/login').send({ email, password })).body as { accessToken: string }).accessToken;

  const apply = async (start: string, end = start, extra: Record<string, unknown> = {}, leaveType = el) => {
    const res = await api().post('/leaves').set(as('emp')).send({ leaveType, startDate: start, endDate: end, remarks: 'test', ...extra });
    expect({ status: res.status, message: res.status === 201 ? '' : res.body.message }).toEqual({ status: 201, message: '' });
    return (res.body as { id: string }).id;
  };
  const review = (id: string, decision: 'APPROVED' | 'REJECTED') => api().patch(`/leaves/${id}/review`).set(as('admin')).send({ decision, comments: 'ok' }).expect(200);
  const cancel = (id: string, who = 'admin') => api().patch(`/leaves/${id}/cancel`).set(as(who)).send({ reason: 'Plans changed' }).expect(200);
  const apiRow = async (typeId = el) => ((await api().get('/leaves/balance').set(as('emp')).expect(200)).body as { balances: Row[] }).balances.find((b) => b.leaveType.id === typeId)!;

  // The same figure in three places: the approved records, the stored balance row and the API the screens read.
  const check = async (used: number, pending = 0) => {
    const approved = await prisma.leave.findMany({ where: { organizationId, employeeId: people.emp.id, leaveTypeId: el, status: 'APPROVED', startDate: { startsWith: '2026' } } });
    const stored = await prisma.leaveBalance.findFirstOrThrow({ where: { organizationId, employeeId: people.emp.id, leaveTypeId: el, year: 2026 } });
    const shown = await apiRow();
    expect({ records: approved.reduce((n, l) => n + l.totalDays, 0), stored: stored.availed, api: shown.availed, pending: shown.pending, available: shown.available })
      .toEqual({ records: used, stored: used, api: used, pending, available: QUOTA - used - pending });
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(createValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);

    await api().post('/auth/register').send({ organizationName: 'Leave Used E2E Org', name: 'Founder', email: 'lu-admin@example.test', password: PASSWORD });
    await prisma.$executeRawUnsafe(`UPDATE "organizations" SET "platformStatus" = 'ACTIVE', "isActive" = true`);
    await prisma.$executeRawUnsafe(`UPDATE "users" SET "isActive" = true, "emailVerified" = true`);
    const founder = await prisma.user.findFirstOrThrow({ where: { email: 'lu-admin@example.test' } });
    organizationId = founder.organizationId;
    people.admin = { id: founder.id, token: await login('lu-admin@example.test', PASSWORD) };
    const res = await api().post('/employees').set(as('admin')).send({ name: 'LU emp', email: 'lu-emp@example.test', joiningDate: '2025-01-01' });
    expect(res.status).toBe(201);
    const body = res.body as { employee: { id: string }; generatedPassword: string };
    people.emp = { id: body.employee.id, token: await login('lu-emp@example.test', body.generatedPassword) };

    // Earned Leave and one other type, as plain yearly quotas with no application-time restrictions (this test is about counting).
    const types = await prisma.leaveType.findMany({ where: { organizationId, isActive: true } });
    const earned = types.find((t) => t.code === 'EL') ?? types.find((t) => /earned|privilege/i.test(t.name))!;
    const second = types.find((t) => ['CL', 'SL'].includes(t.code))!;
    el = earned.id;
    other = { id: second.id, code: second.code };
    const rules = { minDurationDays: 0.5, maxDurationDays: null, noticePeriodDays: 0, allowBackdated: true, maxBackdateDays: 400, allowFutureDated: true, maxAdvanceDays: null, allowHalfDay: true, sandwichLeaveApplies: false, restrictPrefixSuffixHoliday: false, maxConsecutiveDays: null, minGapBetweenRequestsDays: 0 };
    for (const t of [earned, second]) {
      await prisma.leaveType.update({ where: { id: t.id }, data: { allocationType: 'FIXED_ANNUAL', annualQuota: QUOTA, documentsRequired: false, rules } });
    }
    await prisma.leaveBalance.deleteMany({ where: { organizationId } });
  }, 180000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE');
    await app.close();
  });

  const ids: string[] = [];

  it('two approved one-day requests give Used 2, correct after each approval', async () => {
    expect((await apiRow()).availed).toBe(0);
    await check(0);
    ids.push(await apply('2026-12-07'), await apply('2026-12-09'));
    await check(0, 2);
    await review(ids[0], 'APPROVED');
    await check(1, 1);
    await review(ids[1], 'APPROVED');
    await check(2);
  });

  it('counts days, not requests: half-day and multi-day', async () => {
    const half = await apply('2026-12-14', '2026-12-14', { isHalfDay: true, halfDaySession: 'FIRST_HALF' });
    await review(half, 'APPROVED');
    await check(2.5);
    const three = await apply('2026-12-15', '2026-12-17');
    await review(three, 'APPROVED');
    await check(5.5);
  });

  it('pending and rejected requests are not used', async () => {
    const waiting = await apply('2026-12-21');
    await check(5.5, 1);
    await review(waiting, 'REJECTED');
    await check(5.5);
  });

  it('cancelling (before or after approval, by HR or the employee) gives the days back once', async () => {
    const pendingOne = await apply('2026-12-23');
    await cancel(pendingOne, 'emp');
    await check(5.5);
    await cancel(ids[0]);
    await check(4.5);
    await api().patch(`/leaves/${ids[0]}/cancel`).set(as('admin')).send({ reason: 'again' }).expect((r) => expect(r.status).toBeGreaterThanOrEqual(400));
    await check(4.5);
  });

  it('simultaneous approvals count each request exactly once', async () => {
    const a = await apply('2026-12-28');
    const b = await apply('2026-12-29');
    const results = await Promise.all([a, b, a, b].map((id) => api().patch(`/leaves/${id}/review`).set(as('admin')).send({ decision: 'APPROVED' })));
    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    await check(6.5);
  });

  it('other leave types are not affected, and the profile total and Ask HR agree', async () => {
    const before = await apiRow(other.id);
    expect(before.availed).toBe(0);
    await review(await apply('2026-12-30', '2026-12-30', {}, other.id), 'APPROVED');
    expect((await apiRow(other.id)).availed).toBe(1);
    await check(6.5);
    const ask = (await api().get('/ask-hr').query({ q: 'How many leaves do I have left?' }).set(as('emp')).expect(200)).body as { cards: { kind: string; items: { leaveType: string; used: number; available: number }[] }[] };
    const all = ((await api().get('/leaves/balance').set(as('emp'))).body as { balances: (Row & { leaveType: { name: string } })[] }).balances;
    expect(ask.cards.find((c) => c.kind === 'balance')!.items).toEqual(all.map((b) => expect.objectContaining({ leaveType: b.leaveType.name, used: b.availed, available: b.available })));
  });

  it("an approved leave dated in the next leave year counts in that year, not in this year's Used", async () => {
    await review(await apply('2027-01-11'), 'APPROVED');
    await check(6.5);
    const next = ((await api().get('/leaves/balance').query({ year: 2027 }).set(as('emp')).expect(200)).body as { balances: Row[] }).balances.find((r) => r.leaveType.id === el)!;
    expect(next.availed).toBe(1);
  });
});
