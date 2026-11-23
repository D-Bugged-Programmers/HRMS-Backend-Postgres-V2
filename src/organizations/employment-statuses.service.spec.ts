import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { EmploymentStatusesService } from './employment-statuses.service';

function build(initial: unknown = {}, holders: Record<string, number> = {}) {
  let stored: unknown = initial;
  const audits: Record<string, any>[] = [];
  const prisma: any = {
    organization: {
      findUnique: async () => ({ employmentStatusConfig: stored }),
      update: async (a: any) => { stored = a.data.employmentStatusConfig; },
    },
    user: {
      groupBy: async () => [],
      count: async (a: any) => holders[a.where.employmentStatusKey] ?? 0,
    },
  };
  const svc = new EmploymentStatusesService(prisma, { log: async (e: any) => { audits.push(e); } } as never);
  return { svc, get: () => stored as any, audits };
}
const actor = { id: 'a1' };

describe('EmploymentStatusesService', () => {
  it('adds a company status that follows a built-in behaviour, and audits it', async () => {
    const { svc, get, audits } = build();
    const list = await svc.create('  Sabbatical ', 'PAUSED', 'org', actor);
    expect(get().custom).toEqual([{ key: 'CUSTOM_SABBATICAL', label: 'Sabbatical', behavior: 'PAUSED', isActive: true }]);
    expect(list.find((s) => s.key === 'CUSTOM_SABBATICAL')).toMatchObject({ baseStatus: 'ON_HOLD', employeeCount: 0 });
    expect(audits[0]).toMatchObject({ action: 'EMPLOYMENT_STATUS_CREATED' });
  });

  it('refuses a name that is already taken (built-in or company), compared without case', async () => {
    const { svc } = build();
    await expect(svc.create('probation', 'WORKING', 'org', actor)).rejects.toBeInstanceOf(ConflictException);
    await svc.create('Sabbatical', 'PAUSED', 'org', actor);
    await expect(svc.create('SABBATICAL', 'PAUSED', 'org', actor)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.create('   ', 'PAUSED', 'org', actor)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('renames a built-in status (and restores the standard name) and switches off only the ones that are safe to', async () => {
    const { svc, get } = build();
    await svc.update('PROBATION', { label: 'Trial' }, 'org', actor);
    expect(get().labels).toEqual({ PROBATION: 'Trial' });
    await svc.update('PROBATION', { label: '' }, 'org', actor);
    expect(get().labels).toEqual({});
    await svc.update('ON_HOLD', { isActive: false }, 'org', actor);
    expect(get().inactive).toEqual(['ON_HOLD']);
    await expect(svc.update('CONFIRMED', { isActive: false }, 'org', actor)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.update('NOPE', { label: 'x' }, 'org', actor)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('removes a company status nobody holds, and refuses when someone does', async () => {
    const { svc, get } = build({ custom: [{ key: 'CUSTOM_A', label: 'A', behavior: 'PAUSED', isActive: true }] }, { CUSTOM_A: 0 });
    await svc.delete('CUSTOM_A', 'org', actor);
    expect(get().custom).toEqual([]);
    const held = build({ custom: [{ key: 'CUSTOM_A', label: 'A', behavior: 'PAUSED', isActive: true }] }, { CUSTOM_A: 3 });
    await expect(held.svc.delete('CUSTOM_A', 'org', actor)).rejects.toThrow(/3 people have this status/);
    await expect(held.svc.delete('PROBATION', 'org', actor)).rejects.toBeInstanceOf(BadRequestException);
  });
});
