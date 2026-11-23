import { SelfieRetentionService } from './selfie-retention.service';
import * as del from '../files/delete-stored-file';

describe('SelfieRetentionService', () => {
  const now = new Date('2026-11-24T00:00:00Z');
  const make = (profiles: unknown[], rows: unknown[]) => {
    const findMany = jest.fn().mockResolvedValueOnce(rows).mockResolvedValue([]);
    const updateMany = jest.fn().mockResolvedValue({});
    const prisma = { ccOrgProfile: { findMany: jest.fn().mockResolvedValue(profiles) }, punch: { findMany, updateMany } };
    return { svc: new SelfieRetentionService(prisma as never), findMany, updateMany };
  };

  it('deletes originals past the company period and clears the column', async () => {
    const spy = jest.spyOn(del, 'deleteStoredFile').mockImplementation(() => {});
    const { svc, findMany, updateMany } = make(
      [{ organizationId: 'A', selfieOriginalRetentionDays: 60 }],
      [{ id: 'p1', selfieUrl: 'A/selfies/x-stamped.jpg', selfieOriginalUrl: 'A/selfies/x.jpg' }],
    );
    expect(await svc.run(now)).toBe(1);
    expect(spy).toHaveBeenCalledWith('A/selfies/x.jpg');
    const where = findMany.mock.calls[0][0].where;
    expect(where.organizationId).toBe('A');
    expect(where.createdAt.lt.toISOString()).toBe('2026-09-25T00:00:00.000Z');
    expect(updateMany).toHaveBeenCalledWith({ where: { id: { in: ['p1'] } }, data: { selfieOriginalUrl: null } });
  });

  it('never deletes the file the app still shows, and skips companies with no period', async () => {
    const spy = jest.spyOn(del, 'deleteStoredFile').mockImplementation(() => {});
    spy.mockClear();
    const same = make([{ organizationId: 'A', selfieOriginalRetentionDays: 30 }], [{ id: 'p1', selfieUrl: 'k', selfieOriginalUrl: 'k' }]);
    await same.svc.run(now);
    expect(spy).not.toHaveBeenCalled();
    const none = make([], []);
    expect(await none.svc.run(now)).toBe(0);
    expect(none.findMany).not.toHaveBeenCalled();
  });
});
