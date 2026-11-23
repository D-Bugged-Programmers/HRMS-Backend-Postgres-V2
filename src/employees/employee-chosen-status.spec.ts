import { BadRequestException } from '@nestjs/common';
import { EmployeesService } from './employees.service';

const config = {
  custom: [
    { key: 'CUSTOM_SABBATICAL', label: 'Sabbatical', behavior: 'PAUSED', isActive: true },
    { key: 'CUSTOM_OFF', label: 'Retired Soon', behavior: 'WORKING', isActive: false },
  ],
  inactive: ['ON_HOLD'],
};
function svc() {
  const s = Object.create(EmployeesService.prototype) as any;
  s.scopedPrisma = { organization: { findFirst: async () => ({ employmentStatusConfig: config }) } };
  return (clean: any, before: any) => s.applyChosenStatus(clean, before, 'org').then(() => clean);
}
const confirmed = { employmentStatus: 'CONFIRMED', employmentStatusKey: null };

describe('applyChosenStatus', () => {
  it('stores a company status as the built-in one it follows, with its key', async () => {
    expect(await svc()({ employmentStatusKey: 'CUSTOM_SABBATICAL' }, confirmed)).toEqual({ employmentStatus: 'ON_HOLD', employmentStatusKey: 'CUSTOM_SABBATICAL' });
  });
  it('clears the key when a built-in status is chosen instead', async () => {
    expect(await svc()({ employmentStatus: 'PROBATION' }, { employmentStatus: 'ON_HOLD', employmentStatusKey: 'CUSTOM_SABBATICAL' })).toEqual({ employmentStatus: 'PROBATION', employmentStatusKey: null });
  });
  it('leaves everything alone when the status is not being changed', async () => {
    expect(await svc()({ designation: 'x' }, confirmed)).toEqual({ designation: 'x' });
    expect(await svc()({ employmentStatus: 'CONFIRMED' }, confirmed)).toEqual({ employmentStatus: 'CONFIRMED' });
    expect(await svc()({ employmentStatusKey: 'CUSTOM_SABBATICAL' }, { employmentStatus: 'ON_HOLD', employmentStatusKey: 'CUSTOM_SABBATICAL' })).toEqual({});
  });
  it('refuses a switched-off or unknown status with a plain message', async () => {
    await expect(svc()({ employmentStatusKey: 'CUSTOM_OFF' }, confirmed)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc()({ employmentStatus: 'ON_HOLD' }, confirmed)).rejects.toThrow(/switched off/);
    await expect(svc()({ employmentStatusKey: 'NOPE' }, confirmed)).rejects.toThrow(/does not exist/);
  });
});
