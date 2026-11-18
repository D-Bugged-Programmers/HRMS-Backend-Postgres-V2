import { resolveBranding } from './brand-rules';

// A sister company's documents show ITS registration details; they are never borrowed from the parent company.
const org = {
  name: 'Parent Pvt Ltd',
  companyName: 'Parent',
  legalName: null,
  companyLogoUrl: null,
  emailLogoUrl: null,
  registeredAddress: null,
  contactEmail: null,
  phone: null,
  website: null,
  gstin: '27ABCDE1234F1Z5',
  pan: 'ABCDE1234F',
};
const brand = {
  id: 'b1',
  name: 'Sister A',
  legalName: null,
  logoUrl: null,
  emailLogoUrl: null,
  address: null,
  contactEmail: null,
  phone: null,
  website: null,
  pan: 'PQRSX5678L',
};

describe('registration details on a resolved branding', () => {
  it("no brand: the organization's own details", () => {
    const r = resolveBranding(org, null);
    expect(r.registration.gstin).toBe('27ABCDE1234F1Z5');
    expect(r.registration.pan).toBe('ABCDE1234F');
  });
  it("a brand: only its own details, blank where it has none (not the parent's)", () => {
    const r = resolveBranding(org, brand);
    expect(r.registration.pan).toBe('PQRSX5678L');
    expect(r.registration.gstin).toBeNull();
  });
});
