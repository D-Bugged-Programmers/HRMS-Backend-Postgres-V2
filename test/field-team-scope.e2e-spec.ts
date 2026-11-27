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
import * as gate from '../src/module-access/module-gate';

const PASSWORD = 'TestPass123!';
describe('Field Team: a manager is not their own reportee (e2e)', () => {
  let app: INestApplication<App>; let prisma: PrismaService; let org: string;
  const people: Record<string, { id: string; token: string }> = {};
  const api = () => request(app.getHttpServer());
  const as = (w: string) => ({ Authorization: `Bearer ${people[w].token}` });
  const login = async (e: string, p: string) => (await api().post('/auth/login').send({ email: e, password: p })).body.accessToken as string;
  const live = async (w: string) => ((await api().get('/field-tracking/live').set(as(w)).expect(200)).body.employees as { id: string }[]).map((e) => e.id).sort();
  const day = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    jest.spyOn(gate, 'featureEnabledFor').mockResolvedValue(true);
    const m = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = m.createNestApplication(); app.use(cookieParser()); app.useGlobalPipes(createValidationPipe()); await app.init(); prisma = app.get(PrismaService);
    await api().post('/auth/register').send({ organizationName: 'FT Org', name: 'Founder', email: 'ft-admin@example.test', password: PASSWORD });
    await prisma.$executeRawUnsafe(`UPDATE "organizations" SET "platformStatus" = 'ACTIVE', "isActive" = true`);
    await prisma.$executeRawUnsafe(`UPDATE "users" SET "isActive" = true, "emailVerified" = true`);
    const f = await prisma.user.findFirstOrThrow({ where: { email: 'ft-admin@example.test' } }); org = f.organizationId;
    people.admin = { id: f.id, token: await login('ft-admin@example.test', PASSWORD) };
    const add = async (k: string, extra: Record<string, unknown> = {}) => {
      const r = await api().post('/employees').set(as('admin')).send({ name: `FT ${k.replace(/1/, 'One').replace(/2/, 'Two')}`, email: `ft-${k}@example.test`, joiningDate: '2025-01-01', ...extra });
      expect({ s: r.status, m: r.status === 201 ? "" : r.body.message }).toEqual({ s: 201, m: "" });
      people[k] = { id: r.body.employee.id, token: await login(`ft-${k}@example.test`, r.body.generatedPassword) };
    };
    await add('mgr', { role: 'MANAGER' });
    await add('lonely', { role: 'MANAGER' });
    await add('r1', { reportingManagerId: people.mgr.id });
    await add('r2', { reportingManagerId: people.mgr.id });
    await add('outsider');
    await prisma.user.updateMany({ where: { organizationId: org }, data: { fieldTrackingEnabled: true } });
  }, 180000);
  afterAll(async () => { jest.restoreAllMocks(); await prisma.$executeRawUnsafe('TRUNCATE TABLE "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE'); await app.close(); });

  it("Live lists only the manager's reportees, never the manager", async () => {
    expect(await live('mgr')).toEqual([people.r1.id, people.r2.id].sort());
  });
  it('a manager with no reportees gets an empty list', async () => {
    expect(await live('lonely')).toEqual([]);
  });
  it('Admin still sees everyone who is tracked, as before', async () => {
    const all = await live('admin');
    for (const k of ['mgr', 'lonely', 'r1', 'r2', 'outsider']) expect(all).toContain(people[k].id);
  });
  it('an employee cannot open the team view', async () => {
    await api().get('/field-tracking/live').set(as('r1')).expect(403);
  });
  it("the team's visits and the summary count reportees only; the manager's own visit stays under Mine", async () => {
    await prisma.fieldVisit.createMany({ data: [
      { organizationId: org, employeeId: people.mgr.id, createdById: people.mgr.id, clientName: 'Mgr own', scheduledFor: day, status: 'PLANNED' },
      { organizationId: org, employeeId: people.r1.id, createdById: people.mgr.id, clientName: 'R1 client', scheduledFor: day, status: 'PLANNED' },
    ] as never });
    const team = (await api().get('/field-visits').query({ from: day, to: day }).set(as('mgr')).expect(200)).body;
    const names = (team.visits ?? team.data ?? team).map((v: { clientName: string }) => v.clientName);
    expect(names).toEqual(['R1 client']);
    const mine = (await api().get('/field-visits/mine').set(as('mgr')).expect(200)).body.visits.map((v: { clientName: string }) => v.clientName);
    expect(mine).toEqual(['Mgr own']);
    const summary = (await api().get('/field-tracking/summary').set(as('mgr')).expect(200)).body;
    expect(summary.visitsToday.planned).toBe(1);
    expect(summary.tracked).toBe(2);
  });
  it('planning for a reportee works; for someone outside the team is refused', async () => {
    await api().post('/field-visits').set(as('mgr')).send({ employeeId: people.r2.id, clientName: 'For R2', scheduledFor: day }).expect((r) => expect([200, 201]).toContain(r.status));
    await api().post('/field-visits').set(as('mgr')).send({ employeeId: people.outsider.id, clientName: 'Nope', scheduledFor: day }).expect(403);
  });

  describe('recent points are limited per person, not over everyone', () => {
    const ping = (employeeId: string, minutesAgo: number, lat: number, extra: Record<string, unknown> = {}) => ({
      organizationId: org, employeeId, kind: 'POINT', latitude: lat, longitude: 73, recordedAt: new Date(Date.now() - minutesAgo * 60_000), ...extra,
    });
    const liveRows = async (w: string) => (await api().get('/field-tracking/live').set(as(w)).expect(200)).body.employees as { id: string; latitude: number | null; locationAt: string | null }[];

    it('a person who reports very often does not starve the others of their latest point', async () => {
      // r1 sends 60 points in the last hour; r2 sent only two, older than all of r1's. A single limit of 3 x people over everyone's
      // points would have returned only r1's.
      await prisma.locationPing.createMany({ data: [
        ...Array.from({ length: 60 }, (_, k) => ping(people.r1.id, k + 1, 10 + k / 1000)),
        ping(people.r2.id, 120, 20.5), ping(people.r2.id, 125, 20.4),
      ] as never });
      // The old query, for the record: one limit of 3 x people over everyone's points returns none of r2's.
      const old = await prisma.locationPing.findMany({ where: { organizationId: org, employeeId: { in: [people.r1.id, people.r2.id] }, kind: 'POINT' }, orderBy: { recordedAt: 'desc' }, take: 2 * 3 });
      expect(old.some((p) => p.employeeId === people.r2.id)).toBe(false);
      const rows = await liveRows('mgr');
      const r1 = rows.find((r) => r.id === people.r1.id)!; const r2 = rows.find((r) => r.id === people.r2.id)!;
      expect(r2.latitude).toBe(20.5);                       // r2's own newest point, not missing
      expect(new Date(r2.locationAt as string).getTime()).toBeLessThan(new Date(r1.locationAt as string).getTime());
      expect(r1.latitude).toBeCloseTo(10.000, 3);            // r1's newest (1 minute ago)
    });
    it("each person's points stay their own, newest first, and a person with no history is just empty", async () => {
      const rows = await liveRows('mgr');
      expect(rows.map((r) => r.id).sort()).toEqual([people.r1.id, people.r2.id].sort());
      await prisma.locationPing.deleteMany({ where: { organizationId: org, employeeId: people.r2.id } });
      const after = await liveRows('mgr');
      expect(after.find((r) => r.id === people.r2.id)).toMatchObject({ latitude: null, locationAt: null });
      expect(after.find((r) => r.id === people.r1.id)!.latitude).not.toBeNull();
    });
    it('a manager still cannot read points of people outside their team', async () => {
      await prisma.locationPing.create({ data: ping(people.outsider.id, 5, 30.1) as never });
      const rows = await liveRows('mgr');
      expect(rows.find((r) => r.id === people.outsider.id)).toBeUndefined();
    });
    it('stays quick with a large team', async () => {
      const bulk = Array.from({ length: 150 }, (_, k) => ({ name: `Bulk Person ${String.fromCharCode(65 + (k % 26))}${String.fromCharCode(65 + Math.floor(k / 26))}`, email: `ft-bulk${k}@example.test`, password: 'x', role: 'EMPLOYEE', organizationId: org, reportingManagerId: people.mgr.id, fieldTrackingEnabled: true, joiningDate: new Date('2025-01-01'), isActive: true, employeeId: `BULK${k}` }));
      await prisma.user.createMany({ data: bulk as never });
      const ids = (await prisma.user.findMany({ where: { organizationId: org, employeeId: { startsWith: 'BULK' } }, select: { id: true } })).map((u) => u.id);
      await prisma.locationPing.createMany({ data: ids.flatMap((id, n) => Array.from({ length: 6 }, (_, k) => ping(id, k + 1 + (n % 7), 11 + n / 1000))) as never });
      const t0 = Date.now();
      const rows = await liveRows('mgr');
      const ms = Date.now() - t0;
      expect(rows.filter((r) => r.latitude !== null).length).toBeGreaterThanOrEqual(150);
      console.log(`LIVE with ${rows.length} people took ${ms} ms`);
      expect(ms).toBeLessThan(3000);
    });
  });
});
