import { PrivacyMeService } from './privacy-me.service';

// The tenant-scoped client refuses upsert/update/delete by a unique key, so saving the nominee must use updateMany / create.
function build(existing: boolean) {
  const rows: Record<string, unknown>[] = existing ? [{ organizationId: 'org', userId: 'u1', name: 'Old', relationship: '', email: '', phone: '' }] : [];
  const refuse = (op: string) => () => { throw new Error(`PrivacyNominee.${op}: not allowed on a tenant-scoped model`); };
  const db = {
    privacyNominee: {
      findFirst: async () => rows[0] ?? null,
      updateMany: async (a: { data: Record<string, unknown> }) => { if (!rows[0]) return { count: 0 }; Object.assign(rows[0], a.data); return { count: 1 }; },
      create: async (a: { data: Record<string, unknown> }) => { rows.push(a.data); return a.data; },
      upsert: refuse('upsert'),
      update: refuse('update'),
    },
  };
  const audit = { log: async () => undefined };
  const svc = new PrivacyMeService(db as never, audit as never, {} as never);
  return { svc, rows };
}
const actor = { id: 'u1', organizationId: 'org', role: 'EMPLOYEE', name: 'A' } as never;
const ctx = { ip: '1.1.1.1', userAgent: 'x' } as never;

describe('privacy: nominee', () => {
  it('saves a first nominee and then changes it, without the refused upsert', async () => {
    const { svc, rows } = build(false);
    await expect(svc.saveNominee({ name: ' Ravi ', relationship: 'Brother' }, actor, ctx)).resolves.toMatchObject({ name: 'Ravi', relationship: 'Brother', email: '', phone: '' });
    await expect(svc.saveNominee({ name: 'Ravi K', email: 'ravi@example.com', phone: '9999999999' }, actor, ctx)).resolves.toMatchObject({ name: 'Ravi K', email: 'ravi@example.com' });
    expect(rows).toHaveLength(1);
  });
  it('updates an existing nominee in place', async () => {
    const { svc, rows } = build(true);
    await svc.saveNominee({ name: 'New' }, actor, ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('New');
  });
});
