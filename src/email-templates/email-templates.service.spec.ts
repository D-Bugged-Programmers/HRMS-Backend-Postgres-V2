
describe('switching every email template on or off', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EmailTemplatesService } = require('./email-templates.service');
  const build = (count: number) => {
    const s = Object.create(EmailTemplatesService.prototype) as any;
    const calls: any = { update: null, audit: [] };
    s.scopedPrisma = { emailTemplate: { updateMany: async (a: any) => { calls.update = a; return { count }; } } };
    s.auditLogService = { log: async (a: any) => { calls.audit.push(a); } };
    return { s, calls };
  };
  it('changes only the templates not already in that state, and records it', async () => {
    const { s, calls } = build(12);
    const r = await s.setAllActive(false, 'o', 'u1');
    expect(r).toEqual({ changed: 12 });
    expect(calls.update.where).toEqual({ organizationId: 'o', isActive: true });
    expect(calls.update.data).toMatchObject({ isActive: false, updatedById: 'u1' });
    expect(calls.audit[0].action).toBe('EMAIL_TEMPLATES_DISABLED_ALL');
  });
  it('can be limited to one category and logs nothing when nothing changed', async () => {
    const { s, calls } = build(0);
    expect(await s.setAllActive(true, 'o', 'u1', 'Payroll')).toEqual({ changed: 0 });
    expect(calls.update.where).toEqual({ organizationId: 'o', isActive: false, category: 'Payroll' });
    expect(calls.audit).toHaveLength(0);
  });
});
