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
interface Person { id: string; token: string }

describe('Self-reviews (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const people: Record<string, Person> = {};
  let fy: string;

  const api = () => request(app.getHttpServer());
  const as = (who: string) => ({ Authorization: `Bearer ${people[who].token}` });
  const answers = { proud: 'Shipped the app', grow: 'Design', selfRating: 4, impact: 'Faster releases', support: 'Mentoring' };
  const login = async (email: string, password: string) => ((await api().post('/auth/login').send({ email, password })).body as { accessToken: string }).accessToken;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(createValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);

    await api().post('/auth/register').send({ organizationName: 'SelfReview E2E Org', name: 'Founder', email: 'sr-admin@example.test', password: PASSWORD });
    // A self-registered company waits for a Super Admin's approval; approve this throwaway one directly.
    await prisma.$executeRawUnsafe(`UPDATE "organizations" SET "platformStatus" = 'ACTIVE', "isActive" = true`);
    await prisma.$executeRawUnsafe(`UPDATE "users" SET "isActive" = true, "emailVerified" = true`);
    people.admin = { id: '', token: await login('sr-admin@example.test', PASSWORD) };
    const dept = (await api().post('/departments').set(as('admin')).send({ name: 'Engineering', code: 'ENG' })).body as { id: string };

    const add = async (key: string, extra: Record<string, unknown>) => {
      const res = await api().post('/employees').set(as('admin'))
        .send({ name: `SR ${key}`, email: `sr-${key}@example.test`, joiningDate: '2025-01-01', departmentId: dept.id, ...extra });
      expect({ status: res.status, message: res.status === 201 ? "" : (res.body as { message?: unknown }).message }).toEqual({ status: 201, message: "" });
      const body = res.body as { employee: { id: string }; generatedPassword: string };
      people[key] = { id: body.employee.id, token: await login(`sr-${key}@example.test`, body.generatedPassword) };
    };
    await add('manager', { role: 'MANAGER' });
    // A team lead under the manager, so there is someone indirectly in the manager's reporting line too.
    await add('direct', { role: 'MANAGER', reportingManagerId: people.manager.id });
    await add('indirect', { reportingManagerId: people.direct.id });
    await add('peer', {}); // same department, does not report to the manager
    await add('lonely', { role: 'MANAGER' }); // a manager with nobody reporting to them
  }, 120000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE');
    await app.close();
  });

  it('starts with no review for the current year', async () => {
    const res = await api().get('/self-reviews/me').set(as('direct')).expect(200);
    expect(res.body).toMatchObject({ review: null, locked: false });
    fy = (res.body as { financialYear: string }).financialYear;
    expect(fy).toMatch(/^\d{4}-\d{2}$/);
  });

  it('requires sign-in', async () => {
    await api().get('/self-reviews/me').expect(401);
    await api().put('/self-reviews/me').send(answers).expect(401);
    await api().get('/self-reviews/team').expect(401);
  });

  it('refuses invalid data, including an employee id sent by the client, and saves nothing', async () => {
    for (const bad of [
      { ...answers, selfRating: undefined }, { ...answers, selfRating: 0 }, { ...answers, selfRating: 6 }, { ...answers, selfRating: 3.5 }, { ...answers, selfRating: '4' },
      { ...answers, proud: 'x'.repeat(2001) }, { ...answers, support: 'x'.repeat(1001) }, { ...answers, grow: 7 },
      { ...answers, employeeId: people.peer.id }, { ...answers, status: 'REVIEWED' },
    ]) {
      await api().put('/self-reviews/me').set(as('direct')).send(bad).expect(400);
    }
    expect(await prisma.selfReview.count()).toBe(0);
  });

  it("submits a review for the signed-in employee and returns it as SUBMITTED", async () => {
    const res = await api().put('/self-reviews/me').set(as('direct')).send(answers).expect(200);
    expect(res.body).toMatchObject({ financialYear: fy, locked: false, review: { ...answers, status: 'SUBMITTED', employeeId: people.direct.id, financialYear: fy } });
    const rows = await prisma.selfReview.findMany({ where: { employeeId: people.direct.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ...answers, status: 'SUBMITTED' });
  });

  it('updates the same record on a repeat, and stays at one record when sent several times at once', async () => {
    await api().put('/self-reviews/me').set(as('direct')).send({ ...answers, proud: 'Updated' }).expect(200);
    expect(await prisma.selfReview.count({ where: { employeeId: people.direct.id } })).toBe(1);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => api().put('/self-reviews/me').set(as('indirect')).send(answers)));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(await prisma.selfReview.count({ where: { employeeId: people.indirect.id } })).toBe(1);
  });

  it("shows an employee only their own review", async () => {
    const res = await api().get('/self-reviews/me').set(as('peer')).expect(200);
    expect((res.body as { review: unknown }).review).toBeNull();
    await api().get('/self-reviews/team').set(as('peer')).expect(403);
  });

  it("lists only the manager's reporting line, with employee details and status", async () => {
    await api().put('/self-reviews/me').set(as('peer')).send(answers).expect(200);
    await api().put('/self-reviews/me').set(as('manager')).send(answers).expect(200);
    const res = await api().get('/self-reviews/team').set(as('manager')).expect(200);
    const body = res.body as { financialYear: string; data: { employeeId: string; status: string; submittedAt: string; employee: { name: string }; managerRating: unknown }[] };
    expect(body.financialYear).toBe(fy);
    expect(body.data.map((r) => r.employeeId).sort()).toEqual([people.direct.id, people.indirect.id].sort());
    for (const r of body.data) {
      expect(r.status).toBe('SUBMITTED');
      expect(r.submittedAt).toEqual(expect.any(String));
      expect(r.employee.name).toMatch(/^SR /);
      expect(r.managerRating).toBeNull();
    }
  });

  it('answers with an empty list for a manager with no team and for a year with no reviews', async () => {
    expect(((await api().get('/self-reviews/team').set(as('lonely')).expect(200)).body as { data: unknown[] }).data).toEqual([]);
    expect(((await api().get('/self-reviews/team?financialYear=2024-25').set(as('manager')).expect(200)).body as { data: unknown[] }).data).toEqual([]);
  });

  it('lets an Admin see everyone and refuses bad query values', async () => {
    const res = await api().get('/self-reviews/team').set(as('admin')).expect(200);
    expect((res.body as { data: unknown[] }).data).toHaveLength(4);
    await api().get('/self-reviews/team?financialYear=abc').set(as('manager')).expect(400);
    await api().get('/self-reviews/team?financialYear=2026-29').set(as('manager')).expect(400);
    await api().get(`/self-reviews/team?employeeId=${people.peer.id}`).set(as('manager')).expect(400);
  });

  it("refuses evaluating outside the team, then locks a team member's review once evaluated", async () => {
    const idOf = async (who: string) => (await prisma.selfReview.findFirstOrThrow({ where: { employeeId: people[who].id } })).id;
    await api().patch(`/self-reviews/${await idOf('peer')}/evaluate`).set(as('manager')).send({ rating: 4 }).expect(403);
    await api().patch(`/self-reviews/${await idOf('manager')}/evaluate`).set(as('manager')).send({ rating: 5 }).expect(403);
    await api().patch(`/self-reviews/${await idOf('direct')}/evaluate`).set(as('manager')).send({ rating: 4, notes: 'Good year' }).expect(200);
    await api().patch(`/self-reviews/${await idOf('direct')}/evaluate`).set(as('manager')).send({ rating: 4 }).expect(409);
    await api().put('/self-reviews/me').set(as('direct')).send(answers).expect(409);
    expect((await api().get('/self-reviews/me').set(as('direct')).expect(200)).body).toMatchObject({ locked: true, review: { status: 'REVIEWED' } });
    const team = (await api().get('/self-reviews/team').set(as('manager')).expect(200)).body as { data: { status: string; managerRating: { rating: number } | null }[] };
    expect(team.data.map((r) => r.status).sort()).toEqual(['REVIEWED', 'SUBMITTED']);
    expect(team.data.find((r) => r.status === 'REVIEWED')?.managerRating?.rating).toBe(4);
  });
});
