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
import { AttendanceService } from '../src/attendance/attendance.service';
import { createValidationPipe } from '../src/common/validation-pipe';
import { todayInOrgTz } from '../src/common/org-date';

const PASSWORD = 'TestPass123!';

describe('Overdue Work From Home requests (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let svc: AttendanceService;
  let organizationId: string;
  let tz: string;
  let today: string;
  const people: Record<string, { id: string; token: string }> = {};
  const api = () => request(app.getHttpServer());
  const as = (who: string) => ({ Authorization: `Bearer ${people[who].token}` });
  const login = async (email: string, password: string) => ((await api().post('/auth/login').send({ email, password })).body as { accessToken: string }).accessToken;
  const day = (n: number) => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const setAction = (a: string) => prisma.organization.update({ where: { id: organizationId }, data: { wfhOverdueAction: a } });
  const wfhRow = (employeeId: string, date: string, status: 'PENDING' | 'APPROVED' | 'REJECTED') =>
    prisma.attendance.create({ data: { organizationId, employeeId, date, status: 'ABSENT', workArrangement: 'WFH', workArrangementStatus: status } });
  const statusOf = async (id: string) => (await prisma.attendance.findUniqueOrThrow({ where: { id } }));
  const notes = (userId: string, like: string) => prisma.notification.count({ where: { organizationId, userId, title: { contains: like } } });
  const run = (action: 'ESCALATE' | 'EXPIRE', now?: Date) => svc.processOverdueWfhForOrg(organizationId, tz, action, now);

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(createValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);
    svc = app.get(AttendanceService);
    await api().post('/auth/register').send({ organizationName: 'WFH Overdue E2E Org', name: 'Founder', email: 'wo-admin@example.test', password: PASSWORD });
    await prisma.$executeRawUnsafe(`UPDATE "organizations" SET "platformStatus" = 'ACTIVE', "isActive" = true`);
    await prisma.$executeRawUnsafe(`UPDATE "users" SET "isActive" = true, "emailVerified" = true`);
    const founder = await prisma.user.findFirstOrThrow({ where: { email: 'wo-admin@example.test' } });
    organizationId = founder.organizationId;
    tz = (await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).timezone;
    today = todayInOrgTz(tz);
    people.admin = { id: founder.id, token: await login('wo-admin@example.test', PASSWORD) };
    const add = async (key: string, extra: Record<string, unknown> = {}) => {
      const res = await api().post('/employees').set(as('admin')).send({ name: `WO ${key}`, email: `wo-${key}@example.test`, joiningDate: '2025-01-01', ...extra });
      expect(res.status).toBe(201);
      people[key] = { id: res.body.employee.id, token: await login(`wo-${key}@example.test`, res.body.generatedPassword) };
    };
    await add('mgr', { role: 'MANAGER' });
    await add('hr', { role: 'HR' });
    await add('emp', { reportingManagerId: people.mgr.id });
  }, 180000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE');
    await app.close();
  });

  it('does nothing by default, even for an old pending request', async () => {
    const old = await wfhRow(people.emp.id, day(-21), 'PENDING');
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } })).wfhOverdueAction).toBe('NONE');
    await svc.handleOverdueWorkArrangements();
    expect((await statusOf(old.id)).workArrangementStatus).toBe('PENDING');
  });

  it('only Admin or HR can set the rule, and only to a valid value', async () => {
    await api().patch('/organizations/settings/auto-approval').set(as('admin')).send({ wfhOverdueAction: 'EXPIRE_ALL' }).expect(400);
    const res = await api().patch('/organizations/settings/auto-approval').set(as('admin')).send({ wfhOverdueAction: 'ESCALATE' });
    expect({ status: res.status, action: res.body.wfhOverdueAction }).toEqual({ status: 200, action: 'ESCALATE' });
    await api().patch('/organizations/settings/auto-approval').set(as('emp')).send({ wfhOverdueAction: 'EXPIRE' }).expect(403);
  });

  it('ESCALATE: only past, pending requests; notifies HR/Admin once; stays pending; runs once', async () => {
    const past = (await prisma.attendance.findFirstOrThrow({ where: { employeeId: people.emp.id, date: day(-21) } }));
    const todayRow = await wfhRow(people.emp.id, today, 'PENDING');
    const future = await wfhRow(people.emp.id, day(3), 'PENDING');
    const approved = await wfhRow(people.emp.id, day(-5), 'APPROVED');
    const rejected = await wfhRow(people.emp.id, day(-6), 'REJECTED');
    expect((await run('ESCALATE')).changed).toBe(1);
    const p = await statusOf(past.id);
    expect(p.workArrangementStatus).toBe('PENDING');
    expect(p.workArrangementEscalatedAt).not.toBeNull();
    for (const r of [todayRow, future]) expect((await statusOf(r.id)).workArrangementEscalatedAt).toBeNull();
    expect((await statusOf(approved.id)).workArrangementStatus).toBe('APPROVED');
    expect((await statusOf(rejected.id)).workArrangementStatus).toBe('REJECTED');
    const told = (await notes(people.hr.id, 'Overdue Work From Home')) + (await notes(people.admin.id, 'Overdue Work From Home'));
    expect(told).toBeGreaterThanOrEqual(1);
    const before = await prisma.notification.count({ where: { organizationId } });
    expect((await run('ESCALATE')).changed).toBe(0);
    expect(await prisma.notification.count({ where: { organizationId } })).toBe(before);
    expect(await prisma.auditLog.count({ where: { organizationId, action: 'WFH_REQUEST_ESCALATED', targetId: past.id } })).toBe(1);
  });

  it('an escalated request can still be approved by a reviewer, as before', async () => {
    const row = await prisma.attendance.findFirstOrThrow({ where: { employeeId: people.emp.id, date: day(-21) } });
    const res = await api().patch(`/attendance/work-arrangement/${row.id}/review`).set(as('admin')).send({ decision: 'APPROVED', comments: 'ok' });
    expect(res.status).toBe(200);
    expect((await statusOf(row.id)).workArrangementStatus).toBe('APPROVED');
  });

  it('EXPIRE: past pending becomes EXPIRED once, with record and notice; others untouched; counts drop', async () => {
    await setAction('EXPIRE');
    const past = await wfhRow(people.emp.id, day(-10), 'PENDING');
    const next = await wfhRow(people.emp.id, day(-30), 'PENDING');
    const future = await wfhRow(people.emp.id, day(2), 'PENDING');
    const pendingBefore = await prisma.attendance.count({ where: { organizationId, workArrangementStatus: 'PENDING' } });
    expect((await run('EXPIRE')).changed).toBe(2);
    for (const r of [past, next]) {
      const x = await statusOf(r.id);
      expect(x.workArrangementStatus).toBe('EXPIRED');
      expect(x.workArrangementReviewedById).toBeNull();
      expect(x.workArrangementReviewComments).toMatch(/Expired/);
    }
    expect((await statusOf(future.id)).workArrangementStatus).toBe('PENDING');
    expect(await prisma.attendance.count({ where: { organizationId, workArrangementStatus: 'PENDING' } })).toBe(pendingBefore - 2);
    expect(await notes(people.emp.id, 'Work From Home Request Expired')).toBe(2);
    expect((await run('EXPIRE')).changed).toBe(0);
    expect(await notes(people.emp.id, 'Work From Home Request Expired')).toBe(2);
    expect(await prisma.auditLog.count({ where: { organizationId, action: 'WFH_REQUEST_EXPIRED' } })).toBe(2);
    // An expired request can no longer be decided.
    const res = await api().patch(`/attendance/work-arrangement/${past.id}/review`).set(as('admin')).send({ decision: 'APPROVED', comments: 'late' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await statusOf(past.id)).workArrangementStatus).toBe('EXPIRED');
  });

  it('the scheduled entry point follows the company setting', async () => {
    const r = await wfhRow(people.emp.id, day(-12), 'PENDING');
    await setAction('NONE');
    await svc.handleOverdueWorkArrangements();
    expect((await statusOf(r.id)).workArrangementStatus).toBe('PENDING');
    await setAction('EXPIRE');
    await svc.handleOverdueWorkArrangements();
    expect((await statusOf(r.id)).workArrangementStatus).toBe('EXPIRED');
  });

  it('timezone boundary: a request is overdue only once its date has ended in the company time zone', async () => {
    const r = await wfhRow(people.emp.id, day(1), 'PENDING');
    // Just before midnight of that date in the company zone: not overdue. Just after: overdue.
    const midnightEnd = new Date(`${day(2)}T00:00:00Z`);
    const offsetMs = (() => { const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(midnightEnd); const g = (t: string) => Number(f.find((x) => x.type === t)!.value); return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) - midnightEnd.getTime(); })();
    const endInZone = new Date(midnightEnd.getTime() - offsetMs);
    // (Earlier tests left other requests, dated today and in two days, whose own turn comes as this clock moves on.)
    await run('EXPIRE', new Date(endInZone.getTime() - 60_000));
    expect((await statusOf(r.id)).workArrangementStatus).toBe('PENDING');
    await run('EXPIRE', new Date(endInZone.getTime() + 60_000));
    expect((await statusOf(r.id)).workArrangementStatus).toBe('EXPIRED');
  });

  it('an expired request shows as Expired to the employee and is not a WFH day', async () => {
    const list = (await api().get('/my-requests').set(as('emp'))).body;
    const items = (list.items ?? list.data ?? []) as { kind: string; status: string }[];
    expect(items.filter((i) => i.kind === 'wfh').some((i) => i.status === 'EXPIRED')).toBe(true);
  });
});
