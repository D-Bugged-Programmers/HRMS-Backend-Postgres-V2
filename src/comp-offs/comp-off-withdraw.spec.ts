import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { CompOffService } from './comp-off.service';

function build(row: any, updated = 1) {
  const calls: any = { update: null, notify: null };
  const svc = Object.create(CompOffService.prototype) as any;
  svc.scopedPrisma = {
    compOff: { updateMany: async (a: any) => { calls.update = a; return { count: updated }; } },
    organization: { findFirst: async () => ({ timezone: 'Asia/Kolkata' }) },
  };
  svc.findByIdOrThrow = async () => row;
  svc.notificationsService = { notifyReviewers: async (a: any) => { calls.notify = a; } };
  svc.auditLogService = { log: async () => {} };
  return { svc, calls };
}
const me = { id: 'e1', name: 'Asha', role: 'EMPLOYEE' } as any;
const base = { id: 'c1', employeeId: 'e1', earnedForDate: '2026-11-08', daysAvailed: 0 };

describe('employee withdraws own comp-off', () => {
  it('refuses someone else’s comp-off', async () => {
    const { svc } = build({ ...base, employeeId: 'e2', status: 'PENDING' });
    await expect(svc.withdraw('c1', {}, me, 'o')).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('needs a reason once approved', async () => {
    const { svc } = build({ ...base, status: 'APPROVED' });
    await expect(svc.withdraw('c1', {}, me, 'o')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('refuses a comp-off already used', async () => {
    const { svc } = build({ ...base, status: 'APPROVED', daysAvailed: 0.5 });
    await expect(svc.withdraw('c1', { reason: 'x' }, me, 'o')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('refuses a rejected comp-off', async () => {
    const { svc } = build({ ...base, status: 'REJECTED' });
    await expect(svc.withdraw('c1', { reason: 'x' }, me, 'o')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('withdraws a waiting one without a reason and tells reviewers', async () => {
    const { svc, calls } = build({ ...base, status: 'PENDING' });
    await svc.withdraw('c1', {}, me, 'o');
    expect(calls.update.data.status).toBe('REJECTED');
    expect(calls.update.where).toMatchObject({ status: 'PENDING', daysAvailed: 0 });
    expect(calls.notify.title).toBe('Comp-Off Withdrawn');
  });
  it('withdraws an approved unused one with a reason', async () => {
    const { svc, calls } = build({ ...base, status: 'APPROVED' });
    await svc.withdraw('c1', { reason: 'Plans changed' }, me, 'o');
    expect(calls.update.data.decisionNote).toContain('Plans changed');
  });
  it('reports a race as a conflict', async () => {
    const { svc } = build({ ...base, status: 'APPROVED' }, 0);
    await expect(svc.withdraw('c1', { reason: 'x' }, me, 'o')).rejects.toBeInstanceOf(ConflictException);
  });
});
