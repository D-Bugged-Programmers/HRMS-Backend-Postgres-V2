import { BrandingLookupService } from './branding-lookup.service';

// Which company a return is for: everyone (as today), only the main company, or one sister company with ITS own codes.
const brand = {
  id: 'b1',
  name: 'Sister A',
  epfoEstablishmentCode: 'MHBAN1234567000',
  esicEmployerCode: null,
};
const svc = new BrandingLookupService({
  companyBrand: {
    findFirst: async ({ where }: { where: { id: string } }) =>
      where.id === 'b1' ? brand : null,
  },
} as never);

describe('companyScope', () => {
  it("blank or ALL: everyone, with the organization's own codes (unchanged behaviour)", async () => {
    for (const id of [undefined, '', 'ALL']) {
      expect(await svc.companyScope('org', id)).toEqual({
        runWhere: {},
        registration: null,
        company: null,
      });
    }
  });
  it("MAIN: only people with no sister company, still the organization's codes", async () => {
    expect(await svc.companyScope('org', 'MAIN')).toEqual({
      runWhere: { brandId: null },
      registration: null,
      company: null,
      brandId: null,
    });
  });
  it('a sister company: only its people and ITS codes, blank where it has none', async () => {
    const s = await svc.companyScope('org', 'b1');
    expect(s.runWhere).toEqual({ brandId: 'b1' });
    expect(s.company).toBe('Sister A');
    expect(s.registration?.epfoEstablishmentCode).toBe('MHBAN1234567000');
    expect(s.registration?.esicEmployerCode).toBeNull();
  });
  it('an unknown company is refused', async () => {
    await expect(svc.companyScope('org', 'nope')).rejects.toThrow(/not found/);
  });
});
