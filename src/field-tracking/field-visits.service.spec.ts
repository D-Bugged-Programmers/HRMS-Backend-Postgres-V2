import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { FieldVisitsService } from './field-visits.service';
import { dateStrInOrgTz } from '../common/org-date';

const TODAY = dateStrInOrgTz('Asia/Kolkata', new Date());
const refuse = (op: string) => () => {
  throw new Error(`FieldVisit.${op}: not allowed on a tenant-scoped model`);
};

function build(
  opts: {
    visits?: Record<string, unknown>[];
    shift?: boolean;
    maxPerDay?: number;
    person?: Record<string, unknown> | null;
  } = {},
) {
  const visits = (opts.visits ?? []).map((v) => ({ ...v }));
  const notes: Record<string, unknown>[] = [];
  const locks: string[] = [];
  const db = {
    organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata' }) },
    user: {
      findFirst: async () =>
        opts.person === undefined
          ? { id: 'e1', name: 'Asha', fieldTrackingEnabled: true }
          : opts.person,
    },
    fieldVisit: {
      create: async (a: { data: Record<string, unknown> }) => {
        const row = {
          id: `v${visits.length + 1}`,
          status: 'PLANNED',
          ...a.data,
        };
        visits.push(row);
        return row;
      },
      findMany: async (a: { where: { employeeId?: string; scheduledFor?: string; status?: { in: string[] }; id?: { not: string } } }) =>
        visits
          .filter(
            (v) =>
              (!a.where.employeeId || v.employeeId === a.where.employeeId) &&
              (!a.where.scheduledFor || v.scheduledFor === a.where.scheduledFor) &&
              (!a.where.status || a.where.status.in.includes(v.status as string)) &&
              (!a.where.id || v.id !== a.where.id.not),
          )
          .map((v) => ({ ...v, createdBy: { id: v.createdById, name: 'Admin' } })),
      findFirst: async (a: { where: Record<string, unknown> }) =>
        visits.find((v) =>
          Object.entries(a.where).every(
            ([k, w]) => k === 'organizationId' || v[k] === w,
          ),
        ) ?? null,
      updateMany: async (a: {
        where: { id: string; status?: string };
        data: Record<string, unknown>;
      }) => {
        const v = visits.find(
          (x) =>
            x.id === a.where.id &&
            (!a.where.status || x.status === a.where.status),
        );
        if (!v) return { count: 0 };
        Object.assign(v, a.data);
        return { count: 1 };
      },
      update: refuse('update'),
      delete: refuse('delete'),
    },
  };
  // A transaction in these tests is the same fake database plus the lock call (which does nothing here).
  // Like the real advisory lock, it makes transactions on the same day wait their turn.
  let queue: Promise<unknown> = Promise.resolve();
  (db as Record<string, unknown>).$transaction = (fn: (tx: unknown) => Promise<unknown>) => {
    const run = queue.then(() => fn({ ...db, $executeRaw: async () => { locks.push('lock'); return 1; } }));
    queue = run.catch(() => undefined);
    return run;
  };
  const svc = new FieldVisitsService(
    db as never,
    {} as never,
    { log: async () => undefined } as never,
    {
      create: async (n: Record<string, unknown>) => {
        notes.push(n);
      },
    } as never,
    {
      openShift: async () =>
        opts.shift === false ? null : { inTime: new Date(), outTime: null },
      getSettings: async () => ({ maxVisitsPerDay: opts.maxPerDay ?? 0 }),
    } as never,
  );
  return { svc, visits, notes, locks };
}

const emp = {
  id: 'e1',
  name: 'Asha',
  role: Role.EMPLOYEE,
  organizationId: 'org',
} as never;
const admin = {
  id: 'a1',
  name: 'Admin',
  role: Role.ADMIN,
  organizationId: 'org',
} as never;
const planned = (o: Record<string, unknown> = {}) => ({
  id: 'v1',
  employeeId: 'e1',
  createdById: 'a1',
  clientName: 'Acme',
  latitude: 19.07,
  longitude: 72.87,
  radiusMeters: 150,
  scheduledFor: TODAY,
  status: 'PLANNED',
  address: '',
  purpose: '',
  ...o,
});

describe('field visits: planning', () => {
  it("an employee plans their own visit; nobody else's", async () => {
    const { svc, visits } = build();
    await expect(
      svc.create(emp, { clientName: 'Acme' }),
    ).resolves.toMatchObject({
      employeeId: 'e1',
      createdById: 'e1',
      scheduledFor: TODAY,
      status: 'PENDING_APPROVAL',
    });
    expect(visits).toHaveLength(1);
    await expect(
      svc.create(emp, { employeeId: 'other', clientName: 'Acme' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('an Admin plans for someone, who is told; a past day, no client, or a non-field employee is refused', async () => {
    const { svc, notes } = build();
    await svc.create(admin, {
      employeeId: 'e1',
      clientName: 'Acme',
      scheduledFor: TODAY,
    });
    expect(notes[0]).toMatchObject({ userId: 'e1', title: 'New field visit' });
    await expect(
      svc.create(admin, {
        employeeId: 'e1',
        clientName: 'Acme',
        scheduledFor: '2020-01-01',
      }),
    ).rejects.toThrow(/past/);
    await expect(
      svc.create(admin, { employeeId: 'e1', clientName: '' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const off = build({
      person: { id: 'e1', name: 'A', fieldTrackingEnabled: false },
    });
    await expect(
      off.svc.create(admin, { employeeId: 'e1', clientName: 'Acme' }),
    ).rejects.toThrow(/field employees/);
  });
  it('cancel and edit use company-scoped writes and only work on a planned visit', async () => {
    const { svc, visits } = build({ visits: [planned()] });
    await expect(svc.cancel(admin, 'v1', 'Client postponed')).resolves.toMatchObject({
      status: 'CANCELLED',
    });
    await expect(svc.cancel(admin, 'v1', 'Client postponed')).rejects.toThrow(/planned/);
    visits[0].status = 'PLANNED';
    await expect(
      svc.update(admin, 'v1', { clientName: 'Beta Corp' }),
    ).resolves.toMatchObject({ clientName: 'Beta Corp' });
  });
});

describe('field visits: approval, duplicates and the daily limit', () => {
  const mgr = { id: 'm1', name: 'Mira', role: Role.MANAGER, organizationId: 'org' } as never;

  it('a visit an employee plans for themselves is not confirmed until approved, and cannot be checked in to meanwhile', async () => {
    const { svc } = build();
    const v = await svc.create(emp, { clientName: 'Acme' });
    expect(v.status).toBe('PENDING_APPROVAL');
    await expect(svc.checkIn(emp, v.id, { latitude: 19.07, longitude: 72.87, accuracyMeters: 10 })).rejects.toThrow(/no longer/);
  });
  it('a visit planned by an Admin is confirmed straight away', async () => {
    const { svc } = build();
    expect((await svc.create(admin, { employeeId: 'e1', clientName: 'Acme' })).status).toBe('PLANNED');
  });
  it('an approver can approve or reject a waiting visit; the employee cannot, and a rejection needs a reason', async () => {
    // inReviewerScope is real code; an Admin is always in scope.
    const { svc, notes } = build({ visits: [planned({ status: 'PENDING_APPROVAL', createdById: 'e1' }), planned({ id: 'v2', status: 'PENDING_APPROVAL', createdById: 'e1' })] });
    await expect(svc.review(emp, 'v1', 'APPROVED')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.review(admin, 'v1', 'REJECTED', '  ')).rejects.toThrow(/reason/);
    await expect(svc.review(admin, 'v1', 'APPROVED')).resolves.toMatchObject({ status: 'PLANNED', reviewedById: 'a1' });
    await expect(svc.review(admin, 'v2', 'REJECTED', 'Not a client we serve')).resolves.toMatchObject({ status: 'REJECTED', reviewNote: 'Not a client we serve' });
    await expect(svc.review(admin, 'v1', 'APPROVED')).rejects.toThrow(/not waiting/);
    expect(notes.map((n) => n.title)).toEqual(['Field visit approved', 'Field visit not approved']);
    void mgr;
  });
  it('an Admin assigning on a day the employee already has a visit is warned with the existing details, and can go on', async () => {
    const { svc, visits } = build({ visits: [planned({ createdById: 'e1', status: 'PENDING_APPROVAL' })] });
    let caught: unknown;
    try {
      await svc.create(admin, { employeeId: 'e1', clientName: 'Beta', scheduledFor: TODAY });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    const body = (caught as ConflictException).getResponse() as { code: string; existing: { clientName: string; selfAssigned: boolean }[] };
    expect(body.code).toBe('FIELD_VISIT_ALREADY_ON_DATE');
    expect(body.existing[0]).toMatchObject({ clientName: 'Acme', selfAssigned: true });
    expect(visits).toHaveLength(1);
    await svc.create(admin, { employeeId: 'e1', clientName: 'Beta', scheduledFor: TODAY, confirmDuplicate: true });
    expect(visits).toHaveLength(2);
  });
  it('cancelled and rejected visits do not count as already assigned', async () => {
    const { svc } = build({ visits: [planned({ status: 'CANCELLED' }), planned({ id: 'v2', status: 'REJECTED' })] });
    await expect(svc.create(admin, { employeeId: 'e1', clientName: 'Beta', scheduledFor: TODAY })).resolves.toMatchObject({ status: 'PLANNED' });
  });
  it('the company daily limit stops a visit that would go over it, for an employee and for an Admin; 0 means no limit', async () => {
    const { svc } = build({ maxPerDay: 2, visits: [planned(), planned({ id: 'v2', status: 'PENDING_APPROVAL' })] });
    await expect(svc.create(emp, { clientName: 'Third' })).rejects.toThrow(/daily limit of 2/);
    await expect(svc.create(admin, { employeeId: 'e1', clientName: 'Third', confirmDuplicate: true })).rejects.toThrow(/daily limit of 2/);
    const free = build({ maxPerDay: 0, visits: [planned(), planned({ id: 'v2' }), planned({ id: 'v3' })] });
    await expect(free.svc.create(emp, { clientName: 'Fourth' })).resolves.toBeDefined();
  });
  it('two requests at the same moment cannot both slip under the daily limit', async () => {
    const { svc, visits, locks } = build({ maxPerDay: 1 });
    const results = await Promise.allSettled([
      svc.create(emp, { clientName: 'First' }),
      svc.create(admin, { employeeId: 'e1', clientName: 'Second', confirmDuplicate: true }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(visits).toHaveLength(1);
    expect(locks).toHaveLength(2);
  });
  it('different employees on the same day are checked independently', async () => {
    const { svc } = build({ maxPerDay: 1, visits: [planned({ employeeId: 'someone-else' })] });
    await expect(svc.create(emp, { clientName: 'Mine' })).resolves.toMatchObject({ employeeId: 'e1' });
  });
  it('moving a visit to a day that is full is refused, and a cancelled visit frees its slot', async () => {
    const { svc, visits } = build({
      maxPerDay: 1,
      visits: [planned({ id: 'v1', createdById: 'a1', scheduledFor: TODAY }), planned({ id: 'v2', createdById: 'a1', scheduledFor: '2099-01-01' })],
    });
    await expect(svc.update(admin, 'v2', { scheduledFor: TODAY, confirmDuplicate: true })).rejects.toThrow(/daily limit/);
    visits[0].status = 'CANCELLED';
    await expect(svc.update(admin, 'v2', { scheduledFor: TODAY })).resolves.toMatchObject({ scheduledFor: TODAY });
  });
  it('an employee changing the client or day of their own approved visit sends it back for approval', async () => {
    const { svc } = build({ visits: [planned({ createdById: 'e1' })] });
    await expect(svc.update(emp, 'v1', { clientName: 'Different client' })).resolves.toMatchObject({ status: 'PENDING_APPROVAL' });
  });
  it('an employee can cancel a visit that is still waiting', async () => {
    const { svc } = build({ visits: [planned({ createdById: 'e1', status: 'PENDING_APPROVAL' })] });
    await expect(svc.cancel(emp, 'v1', 'Changed plan')).resolves.toMatchObject({ status: 'CANCELLED' });
  });
});

describe('field visits: who may change one', () => {
  it('an employee cannot edit or cancel a visit their manager planned, but can their own', async () => {
    const { svc } = build({
      visits: [
        planned({ createdById: 'a1' }),
        planned({ id: 'v2', createdById: 'e1' }),
      ],
    });
    await expect(svc.cancel(emp, 'v1', 'Client postponed')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      svc.update(emp, 'v1', { clientName: 'Hijack' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.cancel(emp, 'v2', 'Client postponed')).resolves.toMatchObject({
      status: 'CANCELLED',
    });
  });
});

describe('field visits: nightly clean-up', () => {
  it('marks old planned visits Missed and closes stale check-ins, and never throws', async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 2 });
    const svc = new FieldVisitsService(
      {} as never,
      { fieldVisit: { updateMany } } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await svc.closeStale();
    expect(updateMany).toHaveBeenCalledTimes(3);
    expect(updateMany.mock.calls[0][0]).toMatchObject({
      where: { status: 'PLANNED' },
      data: { status: 'MISSED' },
    });
    expect(updateMany.mock.calls[1][0]).toMatchObject({
      where: { status: 'PENDING_APPROVAL' },
      data: { status: 'REJECTED' },
    });
    expect(updateMany.mock.calls[2][0]).toMatchObject({
      where: { status: 'CHECKED_IN' },
      data: { status: 'COMPLETED', autoClosed: true },
    });
    const broken = new FieldVisitsService(
      {} as never,
      {
        fieldVisit: {
          updateMany: jest.fn().mockRejectedValue(new Error('db')),
        },
      } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(broken.closeStale()).resolves.toBeUndefined();
  });
});

describe('field visits: check in and out', () => {
  const here = { latitude: 19.0701, longitude: 72.8701, accuracyMeters: 10 };
  it('checks in at the client (in range) and out with a duration', async () => {
    const { svc } = build({ visits: [planned()] });
    const inn = await svc.checkIn(emp, 'v1', here);
    expect(inn).toMatchObject({
      status: 'CHECKED_IN',
      checkInWithinRange: true,
    });
    const out = await svc.checkOut(emp, 'v1', { outcome: ' Order taken ' });
    expect(out).toMatchObject({ status: 'COMPLETED', outcome: 'Order taken' });
    expect(typeof out.durationMinutes).toBe('number');
  });
  it('records far-away check-ins as outside range instead of refusing them', async () => {
    const { svc } = build({ visits: [planned()] });
    const r = await svc.checkIn(emp, 'v1', {
      latitude: 19.1,
      longitude: 72.9,
      accuracyMeters: 10,
    });
    expect(r).toMatchObject({
      status: 'CHECKED_IN',
      checkInWithinRange: false,
    });
    expect(r.checkInDistanceMeters).toBeGreaterThan(1000);
  });
  it("is refused for someone else's visit, another day, without a punch-in, or while still in another visit", async () => {
    await expect(
      build({ visits: [planned({ employeeId: 'x' })] }).svc.checkIn(
        emp,
        'v1',
        here,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      build({ visits: [planned({ scheduledFor: '2099-01-01' })] }).svc.checkIn(
        emp,
        'v1',
        here,
      ),
    ).rejects.toThrow(/later day/);
    await expect(
      build({ visits: [planned()], shift: false }).svc.checkIn(emp, 'v1', here),
    ).rejects.toThrow(/Punch in/);
    await expect(
      build({
        visits: [
          planned(),
          planned({ id: 'v2', status: 'CHECKED_IN', clientName: 'Other Co' }),
        ],
      }).svc.checkIn(emp, 'v1', here),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      build({ visits: [planned()] }).svc.checkIn(emp, 'v1', { latitude: 'x' }),
    ).rejects.toThrow(/location/);
  });
  it('cannot check out of a visit you are not checked in to', async () => {
    await expect(
      build({ visits: [planned()] }).svc.checkOut(emp, 'v1', {}),
    ).rejects.toThrow(/not checked in/);
  });
});
