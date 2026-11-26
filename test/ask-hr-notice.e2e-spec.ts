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
interface Card { kind: string; answer?: string; sources?: string[]; items?: { name: string; available: boolean }[] }

describe('Ask HR: notice period (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let organizationId: string;
  const people: Record<string, Person> = {};

  const api = () => request(app.getHttpServer());
  const as = (who: string) => ({ Authorization: `Bearer ${people[who].token}` });
  const login = async (email: string, password: string) => ((await api().post('/auth/login').send({ email, password })).body as { accessToken: string }).accessToken;
  const ask = async (who: string, q: string) => ((await api().get('/ask-hr').query({ q }).set(as(who)).expect(200)).body as { cards: Card[] }).cards;
  const answerOf = (cards: Card[]) => cards.find((c) => c.kind === 'answer')?.answer ?? '';
  const lettersOf = (cards: Card[]) => cards.find((c) => c.kind === 'letters')?.items?.map((i) => i.name) ?? [];
  const setDefault = async (days: number | null) => {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    await prisma.organization.update({ where: { id: organizationId }, data: { policies: { ...(org.policies as object), defaultNoticeDays: days } } });
  };
  const QUESTIONS = ['What is the notice period?', 'What is my notice period?', 'How many days is my notice period?', 'What is the notice period during probation?', 'What is the notice period after confirmation?'];

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication();
    app.use(cookieParser());
    app.useGlobalPipes(createValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);

    await api().post('/auth/register').send({ organizationName: 'Notice E2E Org', name: 'Founder', email: 'np-admin@example.test', password: PASSWORD });
    await prisma.$executeRawUnsafe(`UPDATE "organizations" SET "platformStatus" = 'ACTIVE', "isActive" = true`);
    await prisma.$executeRawUnsafe(`UPDATE "users" SET "isActive" = true, "emailVerified" = true`);
    const founder = await prisma.user.findFirstOrThrow({ where: { email: 'np-admin@example.test' } });
    organizationId = founder.organizationId;
    people.admin = { id: founder.id, token: await login('np-admin@example.test', PASSWORD) };

    const add = async (key: string, extra: Record<string, unknown> = {}) => {
      const res = await api().post('/employees').set(as('admin')).send({ name: `NP ${key}`, email: `np-${key}@example.test`, joiningDate: '2025-01-01', ...extra });
      expect(res.status).toBe(201);
      const body = res.body as { employee: { id: string }; generatedPassword: string };
      people[key] = { id: body.employee.id, token: await login(`np-${key}@example.test`, body.generatedPassword) };
    };
    await add('hr', { role: 'HR' });
    await add('manager', { role: 'MANAGER' });
    await add('staff', { reportingManagerId: people.manager.id });
    await add('trainee');
    await add('leaver');
    await prisma.user.update({ where: { id: people.staff.id }, data: { designation: 'Senior Engineer', employmentStatus: 'CONFIRMED' } });
    await prisma.user.update({ where: { id: people.trainee.id }, data: { designation: 'Intern', employmentStatus: 'PROBATION' } });
    // The leaver's own resignation carries a figure HR set, different from the company default.
    await prisma.resignation.create({ data: { organizationId, employeeId: people.leaver.id, reason: 'Moving', submittedOn: '2026-11-01', requestedLwd: '2026-12-16', approvedLwd: '2026-12-16', noticePeriodDays: 45, status: 'APPROVED' } });
    // Issued and visible disciplinary letters, so that a wrong match would show them.
    for (const who of ['staff', 'manager']) {
      for (const key of ['showCauseNotice', 'abscondingNotice']) {
        await api().get(`/employees/${people[who].id}/letters/${key}`).set(as('hr')).expect(200);
        await api().patch(`/employees/${people[who].id}/letters/${key}/access`).set(as('hr')).send({ enabled: true }).expect(200);
      }
    }
  }, 180000);

  afterAll(async () => {
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "refresh_tokens", "users", "organizations" RESTART IDENTITY CASCADE');
    await app.close();
  });

  it('says it cannot find a notice period when none is recorded, with no figure and no letters', async () => {
    await setDefault(null);
    for (const who of ['staff', 'trainee', 'manager', 'hr', 'admin']) {
      for (const q of QUESTIONS) {
        const cards = await ask(who, q);
        expect(answerOf(cards)).toContain("couldn't find");
        expect(answerOf(cards)).not.toMatch(/\d+ days?/);
        expect(cards.some((c) => c.kind === 'letters')).toBe(false);
      }
    }
  }, 120000);

  it("answers from the company's current default, never with letters, for every role and designation", async () => {
    await setDefault(30);
    for (const who of ['staff', 'trainee', 'manager', 'hr', 'admin']) {
      for (const q of QUESTIONS) {
        const cards = await ask(who, q);
        expect(cards[0].kind).toBe('answer');
        expect(answerOf(cards)).toContain('30 days');
        expect(JSON.stringify(cards.filter((c) => c.kind !== 'policy'))).not.toMatch(/show.?cause|abscond/i);
        expect(cards.some((c) => c.kind === 'letters')).toBe(false);
      }
    }
    await setDefault(60);
    expect(answerOf(await ask('staff', 'What is my notice period?'))).toContain('60 days');
  }, 120000);

  it('does not claim a probation or confirmation figure, and flags probation', async () => {
    await setDefault(30);
    for (const q of QUESTIONS.slice(3)) expect(answerOf(await ask('trainee', q))).toMatch(/^I couldn't find a notice period recorded specifically for/);
    expect(answerOf(await ask('trainee', 'What is my notice period?'))).toContain('You are on probation.');
    expect(answerOf(await ask('staff', 'What is my notice period?'))).not.toContain('You are on probation.');
  });

  it("uses the person's own resignation record, and shows it to nobody else", async () => {
    await setDefault(30);
    expect(answerOf(await ask('leaver', 'What is my notice period?'))).toContain('Your notice period is 45 days');
    for (const who of ['staff', 'manager', 'hr', 'admin']) {
      const cards = await ask(who, "What is NP leaver's notice period?");
      expect(answerOf(cards)).toContain('30 days');
      expect(JSON.stringify(cards)).not.toMatch(/45 days|NP leaver/);
    }
  });

  it('returns only the disciplinary letter that is asked about, to a person who has it', async () => {
    for (const who of ['staff', 'manager']) {
      for (const q of ['Show cause notice', 'Do I have a show-cause letter?']) {
        const names = lettersOf(await ask(who, q));
        expect(names).toHaveLength(1);
        expect(names[0]).toMatch(/show.?cause/i);
      }
      const absc = lettersOf(await ask(who, 'Show my absconding letter'));
      expect(absc).toHaveLength(1);
      expect(absc[0]).toMatch(/abscond/i);
    }
  });

  it('says so, without listing other letters, to a person who has no such letter', async () => {
    for (const q of ['Show my show cause letter', 'Show my absconding notice', 'Show my warning letter']) {
      const cards = await ask('trainee', q);
      expect(cards.some((c) => c.kind === 'letters')).toBe(false);
      expect(answerOf(cards)).toMatch(/^No (show-cause|absconding|warning) letter is available to you/);
    }
  });

  it('leaves other questions working', async () => {
    await api().patch(`/employees/${people.staff.id}/letters/offerLetter/access`).set(as('hr')).send({ enabled: true }).expect(200);
    expect(lettersOf(await ask('staff', 'Show my letters')).length).toBeGreaterThanOrEqual(3);
    expect(lettersOf(await ask('staff', 'offer letter')).join()).toMatch(/offer/i);
    expect((await ask('staff', 'How many leaves do I have left?')).some((c) => c.kind === 'balance')).toBe(true);
    expect((await ask('staff', 'What is my salary?')).some((c) => c.kind === 'payroll')).toBe(true);
    expect((await ask('staff', 'upcoming holidays')).some((c) => c.kind === 'holiday')).toBe(true);
  });
});
