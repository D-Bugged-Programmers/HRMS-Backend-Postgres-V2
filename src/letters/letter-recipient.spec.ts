import { letterRecipientOf } from './letter-recipient';

const base = { isActive: true, exitDate: null, email: 'asha@company.com', personalData: { personalEmail: 'asha@gmail.com' } };

describe('letterRecipientOf', () => {
  it('uses the company email for a current employee', () => {
    expect(letterRecipientOf(base)).toEqual({ leaving: false, recipient: 'asha@company.com' });
  });
  it('uses only the personal email for an inactive employee', () => {
    expect(letterRecipientOf({ ...base, isActive: false })).toEqual({ leaving: true, recipient: 'asha@gmail.com' });
  });
  it('uses only the personal email once an exit date is set', () => {
    expect(letterRecipientOf({ ...base, exitDate: '2026-12-31' })).toEqual({ leaving: true, recipient: 'asha@gmail.com' });
  });
  it('has no recipient for a leaver with no personal email, never the company address', () => {
    expect(letterRecipientOf({ ...base, isActive: false, personalData: {} })).toEqual({ leaving: true, recipient: null });
    expect(letterRecipientOf({ ...base, exitDate: new Date(), personalData: { personalEmail: 'not-an-email' } }).recipient).toBeNull();
  });
});
