import { LettersService, paragraphsToHtml } from './letters.service';

// findIssuedLetter only needs the issued-letters table and the audit log.
function build(saved: any[], audit: any[]) {
  const svc = Object.create(LettersService.prototype) as any;
  svc.scopedPrisma = {
    issuedLetter: {
      findFirst: async () => saved[0] ?? null,
      createMany: async ({ data }: any) => { saved.push({ ...data[0] }); },
    },
    auditLog: { findFirst: async () => audit[0] ?? null },
  };
  return svc as { findIssuedLetter: (e: string, k: string, o: string) => Promise<any> };
}

describe('issued letter date', () => {
  it('returns the saved date and number', async () => {
    const d = new Date('2026-03-01T00:00:00Z');
    const r = await build([{ issuedAt: d, documentNumber: 'APP-1' }], []).findIssuedLetter('e', 'k', 'o');
    expect(r).toEqual({ issuedAt: d, documentNumber: 'APP-1' });
  });
  it('recovers the first issue from the audit log and saves it', async () => {
    const saved: any[] = [];
    const d = new Date('2026-02-10T08:00:00Z');
    const r = await build(saved, [{ createdAt: d, details: { documentNumber: 'APP-7' } }]).findIssuedLetter('e', 'k', 'o');
    expect(saved).toHaveLength(1);
    expect(r.issuedAt).toEqual(d);
    expect(r.documentNumber).toBe('APP-7');
  });
  it('is null when the letter was never issued', async () => {
    expect(await build([], []).findIssuedLetter('e', 'k', 'o')).toBeNull();
  });
});

describe('letter acknowledgement', () => {
  const svc = (issued: any) => {
    const s = Object.create(LettersService.prototype) as any;
    const updates: any[] = [];
    s.findIssuedLetter = async () => issued;
    s.scopedPrisma = { issuedLetter: { updateMany: async (a: any) => { updates.push(a); } } };
    s.auditLogService = { log: async () => {} };
    return { s, updates };
  };
  it('refuses someone else’s letter', async () => {
    await expect(svc({}).s.acknowledge('e1', 'k', { id: 'e2' }, 'o')).rejects.toThrow('your own');
  });
  it('refuses a letter never issued', async () => {
    await expect(svc(null).s.acknowledge('e1', 'k', { id: 'e1' }, 'o')).rejects.toThrow('not been issued');
  });
  it('records the first confirmation only', async () => {
    const a = svc({ acknowledgedAt: null });
    await a.s.acknowledge('e1', 'k', { id: 'e1' }, 'o');
    expect(a.updates).toHaveLength(1);
    const b = svc({ acknowledgedAt: new Date() });
    await b.s.acknowledge('e1', 'k', { id: 'e1' }, 'o');
    expect(b.updates).toHaveLength(0);
  });
});

describe('letters issued more than once', () => {
  const build = (existing: string[], template: any) => {
    const s = Object.create(LettersService.prototype) as any;
    s.letterTemplatesService = { findActiveByKey: async () => template };
    s.scopedPrisma = { issuedLetter: { findMany: async () => existing.map((key) => ({ key })) } };
    return s as { slotForNewIssue: (e: string, k: string, o: string) => Promise<string> };
  };
  const inc = { key: 'incrementLetter', isCustom: false };
  it('uses the template key for the first issue', async () => {
    expect(await build([], inc).slotForNewIssue('e', 'incrementLetter', 'o')).toBe('incrementLetter');
  });
  it('gives each repeat its own numbered slot', async () => {
    expect(await build(['incrementLetter'], inc).slotForNewIssue('e', 'incrementLetter', 'o')).toBe('incrementLetter#2');
    expect(await build(['incrementLetter', 'incrementLetter#2'], inc).slotForNewIssue('e', 'incrementLetter', 'o')).toBe('incrementLetter#3');
    expect(await build(['incrementLetter', 'incrementLetter#3'], inc).slotForNewIssue('e', 'incrementLetter', 'o')).toBe('incrementLetter#4');
  });
  it('keeps a one-time letter on its own key', async () => {
    expect(await build(['offerLetter'], { key: 'offerLetter', isCustom: false }).slotForNewIssue('e', 'offerLetter', 'o')).toBe('offerLetter');
  });
  it('lets a custom template opt in', async () => {
    expect(await build(['custom1'], { key: 'custom1', isCustom: true, allowMultiple: true }).slotForNewIssue('e', 'custom1', 'o')).toBe('custom1#2');
    expect(await build(['custom1'], { key: 'custom1', isCustom: true, allowMultiple: false }).slotForNewIssue('e', 'custom1', 'o')).toBe('custom1');
  });
});

describe('switching a whole stage', () => {
  const build = (items: any[], on: string[]) => {
    const s = Object.create(LettersService.prototype) as any;
    const written: any[] = [];
    const notes: any[] = [];
    s.listForEmployee = async () => items;
    s.scopedPrisma = { employeeLetterAccess: { findFirst: async (a: any) => (on.includes(a.where.key) ? { enabled: true } : null) } };
    s.writeAccess = async (...args: any[]) => { written.push(args.slice(1, 4)); };
    s.notificationsService = { create: async (n: any) => { notes.push(n); } };
    return { s, written, notes };
  };
  const actor = { id: 'hr1' } as any;
  const items = [
    { key: 'offerLetter', name: 'Offer', stage: 'HIRING', unlocked: true },
    { key: 'nda', name: 'NDA', stage: 'HIRING', unlocked: true },
    { key: 'relievingLetter', name: 'Relieving', stage: 'EXIT', unlocked: false },
    { key: 'confirmationLetter', name: 'Confirmation', stage: 'PROBATION', unlocked: true },
  ];
  it('switches only the open letters of that stage and tells the employee once', async () => {
    const t = build(items, []);
    const r = await t.s.setStageAccess('e1', 'HIRING', true, actor, 'o');
    expect(t.written).toEqual([['offerLetter', true, actor], ['nda', true, actor]]);
    expect(r.changed).toBe(2);
    expect(t.notes).toHaveLength(1);
  });
  it('skips letters already in the right state and leaves locked ones alone', async () => {
    const t = build(items, ['offerLetter']);
    await t.s.setStageAccess('e1', 'HIRING', true, actor, 'o');
    expect(t.written.map((w) => w[0])).toEqual(['nda']);
    const exit = build(items, []);
    await exit.s.setStageAccess('e1', 'EXIT', true, actor, 'o');
    expect(exit.written).toHaveLength(0);
    expect(exit.notes).toHaveLength(0);
  });
  it('turns a stage off without a notification and rejects an unknown stage', async () => {
    const t = build(items, ['offerLetter', 'nda']);
    await t.s.setStageAccess('e1', 'HIRING', false, actor, 'o');
    expect(t.written).toHaveLength(2);
    expect(t.notes).toHaveLength(0);
    await expect(t.s.setStageAccess('e1', 'NOPE', true, actor, 'o')).rejects.toThrow('Unknown stage');
  });
});

describe('small letter clean-ups', () => {
  it('removes only an entry that was never produced', async () => {
    const s = Object.create(LettersService.prototype) as any;
    const calls: any[] = [];
    s.scopedPrisma = { issuedLetter: { deleteMany: async (a: any) => { calls.push(a); } } };
    await s.discardEmptyIssue('e', 'incrementLetter#2', 'o');
    await s.discardEmptyIssue('e', 'incrementLetter', 'o');
    expect(calls).toHaveLength(1);
    expect(calls[0].where).toMatchObject({ key: 'incrementLetter#2', documentNumber: null, pdfKey: null });
  });
  it('shows an employee only the plain history of their own switched-on letter', async () => {
    const s = Object.create(LettersService.prototype) as any;
    let actions: string[] = [];
    s.scopedPrisma = {
      employeeLetterAccess: { findFirst: async () => ({ enabled: true }) },
      auditLog: { findMany: async (a: any) => { actions = a.where.action.in; return [{ action: 'LETTER_ISSUED', createdAt: new Date(), actorId: 'hr1', details: {} }]; } },
      user: { findMany: async () => [{ id: 'hr1', name: 'HR Person' }] },
    };
    const rows = await s.history('e1', 'k', { id: 'e1', role: 'EMPLOYEE' }, 'o');
    expect(actions).toEqual(['LETTER_ISSUED', 'LETTER_EMAILED', 'LETTER_ACKNOWLEDGED', 'LETTER_APPROVED', 'LETTER_DECLINED']);
    expect(rows[0].by).toBeNull();
    await expect(s.history('e2', 'k', { id: 'e1', role: 'EMPLOYEE' }, 'o')).rejects.toThrow('your own');
  });
  it('refuses an employee history for a letter not switched on', async () => {
    const s = Object.create(LettersService.prototype) as any;
    s.scopedPrisma = { employeeLetterAccess: { findFirst: async () => null } };
    await expect(s.history('e1', 'k', { id: 'e1', role: 'EMPLOYEE' }, 'o')).rejects.toThrow('not been made available');
  });
  it('rejects a bad issue date for a new issue', async () => {
    const s = Object.create(LettersService.prototype) as any;
    await expect(s.newOccurrence('e', 'incrementLetter', { id: 'hr' }, 'o', '2026-13-45')).rejects.toThrow('YYYY-MM-DD');
  });
});


describe('employee approval of a letter', () => {
  const employee = { id: 'e1', name: 'Asha Rao', role: 'EMPLOYEE' } as any;
  const build = (issued: any, grant: any = { enabled: true }) => {
    const s = Object.create(LettersService.prototype) as any;
    const state: any = { updates: [], generated: null, notices: [] };
    s.letterTemplatesService = { findActiveByKey: async () => ({ name: 'Offer Letter', key: 'offerLetter', requiresApproval: true }) };
    s.findIssuedLetter = async () => issued;
    s.generate = async (...args: any[]) => { state.generated = args; return { buffer: Buffer.from('x'), filename: 'f.pdf' }; };
    s.scopedPrisma = {
      issuedLetter: { updateMany: async (a: any) => { state.updates.push(a); return { count: 1 }; }, findFirst: async () => issued },
      employeeLetterAccess: { findFirst: async () => grant },
    };
    s.auditLogService = { log: async () => {} };
    s.tellReviewers = async (...a: any[]) => { state.notices.push(a); };
    return { s, state };
  };
  const dto = { signatureName: 'Asha Rao', consent: true };

  it('needs the employee themself, consent and a typed name', async () => {
    const { s } = build({});
    await expect(s.approve('e2', 'offerLetter', dto, employee, 'o', {})).rejects.toThrow('your own');
    await expect(s.approve('e1', 'offerLetter', { ...dto, consent: false }, employee, 'o', {})).rejects.toThrow('Tick the box');
    await expect(s.approve('e1', 'offerLetter', { ...dto, signatureName: ' ' }, employee, 'o', {})).rejects.toThrow('full name');
  });
  it('signs the PDF, records who and where, and tells HR', async () => {
    const { s, state } = build({ approvedAt: null, declinedAt: null, supersededAt: null });
    await s.approve('e1', 'offerLetter', dto, employee, 'o', { ip: '1.2.3.4', device: 'Chrome' });
    expect(state.generated[7]).toMatchObject({ name: 'Asha Rao', ip: '1.2.3.4' });
    expect(state.updates[0].data).toMatchObject({ signatureName: 'Asha Rao', signedIp: '1.2.3.4' });
    expect(state.notices).toHaveLength(1);
  });
  it('is a no-op the second time and refuses a replaced or declined letter', async () => {
    const done = build({ approvedAt: new Date('2026-11-01') });
    await done.s.approve('e1', 'offerLetter', dto, employee, 'o', {});
    expect(done.state.generated).toBeNull();
    await expect(build({ approvedAt: null, declinedAt: new Date() }).s.approve('e1', 'offerLetter', dto, employee, 'o', {})).rejects.toThrow('replaced or declined');
  });
  it('rejects an unreadable drawn signature', async () => {
    const { s } = build({ approvedAt: null });
    await expect(s.approve('e1', 'offerLetter', { ...dto, signatureImage: 'not-an-image' }, employee, 'o', {})).rejects.toThrow('drawn signature');
  });
  it('lets an employee decline with a reason, but never an approved letter', async () => {
    const ok = build({ approvedAt: null, declinedAt: null, supersededAt: null });
    ok.s.tellReviewers = async () => {};
    await expect(ok.s.decline('e1', 'offerLetter', '  ', employee, 'o')).rejects.toThrow('Say why');
    await ok.s.decline('e1', 'offerLetter', 'Salary is wrong', employee, 'o');
    expect(ok.state.updates[0].data.declineReason).toBe('Salary is wrong');
    await expect(build({ approvedAt: new Date() }).s.decline('e1', 'offerLetter', 'x', employee, 'o')).rejects.toThrow('final');
  });
  it('makes an approved letter final for everyone', async () => {
    const s = Object.create(LettersService.prototype) as any;
    s.scopedPrisma = { issuedLetter: { findFirst: async () => ({ approvedAt: new Date() }) } };
    await expect(s.assertNotFinal('e1', 'offerLetter', 'o')).rejects.toThrow('final');
    s.scopedPrisma = { issuedLetter: { findFirst: async () => ({ approvedAt: null }) } };
    await expect(s.assertNotFinal('e1', 'offerLetter', 'o')).resolves.toBeUndefined();
  });
  it('starts a new version only from an approved or declined letter, and marks the old one replaced', async () => {
    const hr = { id: 'hr1', role: 'HR' } as any;
    const mk = (rows: any[]) => {
      const s = Object.create(LettersService.prototype) as any;
      const calls: any = { updates: [], creates: [] };
      s.letterTemplatesService = { findActiveByKey: async () => ({ name: 'Offer Letter' }) };
      s.scopedPrisma = { issuedLetter: { findMany: async () => rows, updateMany: async (a: any) => { calls.updates.push(a); }, createMany: async (a: any) => { calls.creates.push(a); } } };
      s.auditLogService = { log: async () => {} };
      return { s, calls };
    };
    await expect(mk([{ key: 'offerLetter', approvedAt: null, declinedAt: null }]).s.newVersion('e1', 'offerLetter', hr, 'o')).rejects.toThrow('can still be edited');
    const ok = mk([{ key: 'offerLetter', approvedAt: new Date(), declinedAt: null, supersededAt: null }]);
    const r = await ok.s.newVersion('e1', 'offerLetter', hr, 'o');
    expect(r.key).toBe('offerLetter#2');
    expect(ok.calls.updates[0].data.supersededAt).toBeInstanceOf(Date);
    expect(ok.calls.creates[0].data[0].key).toBe('offerLetter#2');
  });
});

describe('letter wording as editor HTML', () => {
  it('keeps bold, italic and underline and shows everything else as plain text', () => {
    expect(paragraphsToHtml(['Dear <b>Asha</b>,', 'Pay <i>A & B</i> < 5 days'])).toBe('<p>Dear <b>Asha</b>,</p><p>Pay <i>A &amp; B</i> &lt; 5 days</p>');
  });
});
