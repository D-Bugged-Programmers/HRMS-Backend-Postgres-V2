import { LettersService } from './letters.service';

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
