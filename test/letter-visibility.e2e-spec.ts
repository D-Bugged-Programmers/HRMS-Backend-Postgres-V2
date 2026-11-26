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
import { PDFParse } from 'pdf-parse';

const PASSWORD = 'TestPass123!';
const DISCIPLINARY = ['warningLetter', 'showCauseNotice', 'suspensionLetter', 'abscondingNotice'];
interface Person { id: string; token: string }
interface Row { key: string; unlocked: boolean; reason: string | null }

describe('Letter visibility (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const people: Record<string, Person> = {};

  const api = () => request(app.getHttpServer());
  const as = (who: string) => ({ Authorization: `Bearer ${people[who].token}` });
  const login = async (email: string, password: string) => ((await api().post('/auth/login').send({ email, password })).body as { accessToken: string }).accessToken;
  const list = async (viewer: string, owner = viewer) => (await api().get(`/employees/${people[owner].id}/letters`).set(as(viewer)).expect(200)).body as Row[];
  const available = (rows: Row[]) => rows.filter((r) => r.unlocked).map((r) => r.key);
  const download = (viewer: string, owner: string, key: string) => api().get(`/employees/${people[owner].id}/letters/${key}`).set(as(viewer));
  const issuedCount = (who: string, key?: string) => prisma.issuedLetter.count({ where: { employeeId: people[who].id, ...(key ? { key } : {}) } });
  const grant = (who: string, key: string) => api().patch(`/employees/${people[who].id}/letters/${key}/access`).set(as('admin')).send({ enabled: true }).expect(200);
  const askLetters = async (who: string) => {
    const body = (await api().get('/ask-hr').query({ q: 'Show my letters' }).set(as(who)).expect(200)).body as { cards: { kind: string; items: { name: string; available: boolean }[] }[] };
    return body.cards.find((c) => c.kind === 'letters')?.items ?? [];
  };
  const disciplinaryNames = /warning|show.?cause|suspension|abscond|termination/i;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(createValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);

    await api().post('/auth/register').send({ organizationName: 'Letters E2E Org', name: 'Founder', email: 'lv-admin@example.test', password: PASSWORD });
    // A self-registered company waits for a Super Admin's approval; approve this throwaway one directly.
    await prisma.$executeRawUnsafe(`UPDATE "organizations" SET "platformStatus" = 'ACTIVE', "isActive" = true`);
    await prisma.$executeRawUnsafe(`UPDATE "users" SET "isActive" = true, "emailVerified" = true`);
    const adminToken = await login('lv-admin@example.test', PASSWORD);
    const founder = await prisma.user.findFirstOrThrow({ where: { email: 'lv-admin@example.test' } });
    people.admin = { id: founder.id, token: adminToken };

    const add = async (key: string, extra: Record<string, unknown> = {}) => {
      const res = await api().post('/employees').set(as('admin')).send({ name: `LV ${key}`, email: `lv-${key}@example.test`, joiningDate: '2025-01-01', ...extra });
      expect(res.status).toBe(201);
      const body = res.body as { employee: { id: string }; generatedPassword: string };
      people[key] = { id: body.employee.id, token: await login(`lv-${key}@example.test`, body.generatedPassword) };
    };
    await add('hr', { role: 'HR' });
    await add('manager', { role: 'MANAGER' });
    await add('employee', { reportingManagerId: people.manager.id });
    await add('outsider'); // nobody's report; never gets a letter
  }, 120000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE');
    await app.close();
  });

  it.each(['manager', 'employee', 'outsider'])('%s with no letters: nothing disciplinary is listed, in My Letters or Ask HR', async (who) => {
    expect(available(await list(who)).filter((k) => DISCIPLINARY.includes(k) || k === 'terminationLetter')).toEqual([]);
    expect((await askLetters(who)).filter((i) => i.available && disciplinaryNames.test(i.name))).toEqual([]);
  });

  it('a manager cannot download or create their own disciplinary letter, or any letter not made visible to them', async () => {
    for (const key of [...DISCIPLINARY, 'offerLetter']) await download('manager', 'manager', key).expect(403);
    await api().get(`/employees/${people.manager.id}/letters/warningLetter/history`).set(as('manager')).expect(403);
    expect(await issuedCount('manager')).toBe(0);
  });

  it('visibility alone is not a letter: a disciplinary grant with nothing issued shows nothing and creates nothing', async () => {
    for (const who of ['manager', 'employee']) {
      await grant(who, 'warningLetter');
      await grant(who, 'abscondingNotice'); // what the earlier one-off migration granted to existing people
      expect(available(await list(who)).filter((k) => DISCIPLINARY.includes(k))).toEqual([]);
      expect((await askLetters(who)).filter((i) => i.available && disciplinaryNames.test(i.name))).toEqual([]);
      await download(who, who, 'warningLetter').expect(403);
      await download(who, who, 'abscondingNotice').expect(403);
      expect(await issuedCount(who)).toBe(0);
    }
  });

  it('once HR issues it and it is visible, the person it belongs to sees and downloads it (manager and employee)', async () => {
    for (const who of ['manager', 'employee']) {
      await download('hr', who, 'warningLetter').expect(200);
      expect(await issuedCount(who, 'warningLetter')).toBe(1);
      expect(available(await list(who))).toContain('warningLetter');
      expect(available(await list(who))).not.toContain('abscondingNotice');
      expect((await askLetters(who)).some((i) => i.available && /warning/i.test(i.name))).toBe(true);
      const res = await download(who, who, 'warningLetter').expect(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(await issuedCount(who, 'warningLetter')).toBe(1);
    }
  });

  it('an issued letter that is not made visible stays hidden from its owner', async () => {
    await download('hr', 'manager', 'showCauseNotice').expect(200);
    expect(available(await list('manager'))).not.toContain('showCauseNotice');
    await download('manager', 'manager', 'showCauseNotice').expect(403);
  });

  it('other letters work for a manager once made visible', async () => {
    await grant('manager', 'offerLetter');
    expect(available(await list('manager'))).toContain('offerLetter');
    await download('manager', 'manager', 'offerLetter').expect(200);
  });

  it("nobody can reach another person's letters without permission", async () => {
    for (const viewer of ['employee', 'outsider']) {
      await api().get(`/employees/${people.manager.id}/letters`).set(as(viewer)).expect(403);
      await download(viewer, 'manager', 'warningLetter').expect(403);
      await api().get(`/employees/${people.manager.id}/letters/warningLetter/history`).set(as(viewer)).expect(403);
    }
    // Outside the manager's reporting line.
    await api().get(`/employees/${people.outsider.id}/letters`).set(as('manager')).expect(403);
    await download('manager', 'outsider', 'warningLetter').expect(403);
    await api().get(`/employees/${people.manager.id}/letters`).expect(401);
  });

  describe('a manager generating their own non-payroll letters', () => {
    // Every active non-payroll template of the company: all categories, not only one letter type.
    const nonPayrollKeys = async () => (await prisma.letterTemplate.findMany({ where: { isActive: true, dataProfile: { in: ['BASIC', 'EXIT'] } }, select: { key: true } })).map((t) => t.key);
    // What the one-off migration wrote: visible, with nobody recorded as having decided it.
    const migrationGrant = async (who: string, keys: string[]) => {
      const { organizationId } = await prisma.user.findFirstOrThrow({ where: { id: people[who].id } });
      await prisma.employeeLetterAccess.createMany({ data: keys.map((key) => ({ organizationId, employeeId: people[who].id, key, enabled: true })), skipDuplicates: true });
    };
    const pdfText = async (buffer: Buffer) => { const parser = new PDFParse({ data: new Uint8Array(buffer) }); const out = await parser.getText(); await parser.destroy(); return out.text; };
    const binary = (res: any, done: (e: Error | null, b: Buffer) => void) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))); };

    beforeAll(async () => { await add2('boss', { role: 'MANAGER' }); await add2('report', { reportingManagerId: people.boss.id }); }, 60000);
    const add2 = async (key: string, extra: Record<string, unknown>) => {
      const res = await api().post('/employees').set(as('admin')).send({ name: `LV ${key}`, email: `lv-${key}@example.test`, joiningDate: '2025-01-01', ...extra });
      expect(res.status).toBe(201);
      const body = res.body as { employee: { id: string }; generatedPassword: string };
      people[key] = { id: body.employee.id, token: await login(`lv-${key}@example.test`, body.generatedPassword) };
    };

    it('is refused by direct API call for every non-payroll letter, even those the migration made visible, and creates nothing', async () => {
      const keys = await nonPayrollKeys();
      expect(keys.length).toBeGreaterThan(10);
      await migrationGrant('boss', keys);
      for (const key of keys) {
        const res = await download('boss', 'boss', key);
        expect({ key, status: res.status < 500 && res.status !== 200 && res.status !== 429 ? 'refused' : res.status }).toEqual({ key, status: 'refused' });
      }
      const offer = await download('boss', 'boss', 'offerLetter').expect(403);
      expect((offer.body as { message: string }).message).toBe('HR authorization is needed for this letter — ask HR to make it available to you.');
      expect(await issuedCount('boss')).toBe(0);
      expect(available(await list('boss')).filter((k) => keys.includes(k))).toEqual([]);
      expect((await askLetters('boss')).filter((i) => i.available)).toEqual([]);
    }, 60000);

    it('cannot be worked around: reissue, HR-only endpoints, authorising themselves, signing', async () => {
      const base = `/employees/${people.boss.id}/letters`;
      await api().get(`${base}/offerLetter`).query({ reissue: 'true' }).set(as('boss')).expect(403);
      await api().get(`${base}/offerLetter/content`).set(as('boss')).expect(403);
      await api().put(`${base}/offerLetter/content`).set(as('boss')).send({ title: 'x', body: 'y' }).expect(403);
      await api().patch(`${base}/offerLetter/access`).set(as('boss')).send({ enabled: true }).expect(403);
      await api().patch(`${base}/stage/HIRING/access`).set(as('boss')).send({ enabled: true }).expect(403);
      await api().post(`${base}/offerLetter/send`).set(as('boss')).send({}).expect(403);
      await api().post(`${base}/offerLetter/new`).set(as('boss')).send({}).expect(403);
      await api().patch(`${base}/offerLetter/issue-date`).set(as('boss')).send({ date: '2026-01-01' }).expect(403);
      const sign = await api().post(`${base}/offerLetter/approve`).set(as('boss')).send({ signatureName: 'LV boss', consent: true });
      expect([400, 403]).toContain(sign.status);
      expect(await issuedCount('boss')).toBe(0);
    });

    it('works once HR authorises it, on the company letterhead with their own details', async () => {
      await grant('boss', 'offerLetter');
      expect(available(await list('boss'))).toContain('offerLetter');
      const res = await download('boss', 'boss', 'offerLetter').buffer(true).parse(binary).expect(200);
      const me = await prisma.user.findFirstOrThrow({ where: { id: people.boss.id } });
      const text = await pdfText(res.body as Buffer);
      expect(text).toContain('Letters E2E Org');
      expect(text).toContain('LV boss');
      expect(res.headers['content-disposition']).toContain(me.employeeId);
      // Only the letter HR authorised.
      await download('boss', 'boss', 'appointmentLetter').expect(403);
    });

    it("HR switching a whole stage on authorises the migration's letters in it", async () => {
      await api().patch(`/employees/${people.boss.id}/letters/stage/HIRING/access`).set(as('hr')).send({ enabled: true }).expect(200);
      await download('boss', 'boss', 'appointmentLetter').expect(200);
    });

    it('leaves employees as before with a migration grant', async () => {
      await migrationGrant('report', ['offerLetter']);
      await download('report', 'report', 'offerLetter').expect(200);
    });

    it("HR and Admin generate for others; a manager keeps their existing permission for a report's letters only", async () => {
      for (const viewer of ['hr', 'admin']) await download(viewer, 'report', 'appointmentLetter').expect(200);
      await download('boss', 'report', 'appointmentLetter').expect(200);
      await download('boss', 'outsider', 'appointmentLetter').expect(403);
      await download('boss', 'manager', 'appointmentLetter').expect(403);
    });
  });

  it("unchanged: HR/Admin see others' letters, and a manager's access to a report's letters is as before", async () => {
    for (const viewer of ['hr', 'admin']) expect(available(await list(viewer, 'outsider'))).toEqual(expect.arrayContaining(DISCIPLINARY));
    expect(available(await list('manager', 'employee'))).toEqual(expect.arrayContaining(DISCIPLINARY));
  });

  it('HR and Admin are not told their own never-issued disciplinary letters are available', async () => {
    for (const who of ['hr', 'admin']) {
      const mine = await list(who);
      expect(available(mine).filter((k) => DISCIPLINARY.includes(k))).toEqual([]);
      expect(mine.find((r) => r.key === 'warningLetter')?.reason).toBe('No letter of this kind has been issued to you.');
      expect(available(mine)).toContain('offerLetter');
      expect((await askLetters(who)).filter((i) => i.available && disciplinaryNames.test(i.name))).toEqual([]);
    }
  });
});
