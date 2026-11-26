import { PrivacyRequestsService } from './privacy-requests.service';

function build(admins: { id: string }[] = [{ id: 'a1' }, { id: 'a2' }]) {
  const sent: Record<string, unknown>[] = [];
  const db = { user: { findMany: jest.fn().mockResolvedValue(admins) } };
  const svc = new PrivacyRequestsService(
    db as never,
    {} as never,
    {} as never,
    { create: async (n: Record<string, unknown>) => { sent.push(n); } } as never,
  );
  return { svc: svc as unknown as Record<string, (...a: unknown[]) => Promise<void>>, sent, db };
}
const request = { id: 'r1', organizationId: 'org', userId: 'u1', type: 'CORRECTION', requestNo: 'PRV-00007', status: 'SUBMITTED' };

describe('privacy requests: notifications', () => {
  it('tells every Admin (not the requester) when a request is submitted, without any request details', async () => {
    const { svc, sent, db } = build();
    await svc.notifyAdminsOfNewRequest(request, { id: 'u1', name: 'Asha Rao' });
    expect(db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ role: 'ADMIN', id: { not: 'u1' }, isActive: true }) }));
    expect(sent.map((n) => n.userId)).toEqual(['a1', 'a2']);
    expect(sent[0]).toMatchObject({ title: 'New privacy request', link: '/privacy/requests' });
    expect(String(sent[0].message)).toContain('Asha Rao');
    expect(String(sent[0].message)).toContain('PRV-00007');
    expect(String(sent[0].message)).toContain('correction of personal data');
  });
  it("tells the person when their request is approved, rejected, completed or needs attention, once, and not for other changes", async () => {
    const { svc, sent } = build();
    await svc.notifyRequester({ ...request, status: 'APPROVED' }, 'SUBMITTED');
    await svc.notifyRequester({ ...request, status: 'REJECTED' }, 'UNDER_REVIEW');
    await svc.notifyRequester({ ...request, status: 'COMPLETED' }, 'APPROVED');
    await svc.notifyRequester({ ...request, status: 'ACTION_REQUIRED' }, 'UNDER_REVIEW');
    expect(sent.map((n) => n.title)).toEqual([
      'Privacy request approved',
      'Privacy request not approved',
      'Privacy request completed',
      'Privacy request needs your attention',
    ]);
    expect(sent.every((n) => n.userId === 'u1' && n.link === '/my/privacy')).toBe(true);
    await svc.notifyRequester({ ...request, status: 'UNDER_REVIEW' }, 'SUBMITTED');
    await svc.notifyRequester({ ...request, status: 'CANCELLED' }, 'SUBMITTED');
    await svc.notifyRequester({ ...request, status: 'APPROVED' }, 'APPROVED');
    expect(sent).toHaveLength(4);
  });
  it('a failing notification never fails the request', async () => {
    const svc = new PrivacyRequestsService(
      { user: { findMany: jest.fn().mockRejectedValue(new Error('db')) } } as never,
      {} as never,
      {} as never,
      { create: async () => { throw new Error('push'); } } as never,
    ) as unknown as Record<string, (...a: unknown[]) => Promise<void>>;
    await expect(svc.notifyAdminsOfNewRequest(request, { id: 'u1', name: 'A' })).resolves.toBeUndefined();
    await expect(svc.notifyRequester({ ...request, status: 'APPROVED' }, 'SUBMITTED')).resolves.toBeUndefined();
  });
});
