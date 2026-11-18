// Purpose: answers "which company name, logo and address go on this person's document?" in one place.
// Responsibilities: forEmployee() / forBrand() return the resolved branding - the employee's brand where it has a value, the organization's
//   own otherwise - so payslips, letters and emails all read the same answer.
// Important: no brand (or no brands at all) returns the organization's own branding exactly, so a company that never adds a brand is
//   unaffected by anything that calls this.
import { Inject, Injectable } from '@nestjs/common';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { sisterCompaniesOn } from '../module-access/module-gate';
import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  resolveBranding,
  type RegistrationFields,
  type ResolvedBranding,
} from './brand-rules';

/** Which company a statutory return or report is for: its payroll-run filter and the registration codes to print. */
export interface CompanyScope {
  runWhere: Prisma.PayrollRunWhereInput;
  // null = the organization's own registration details apply (all companies, or the main company).
  registration: RegistrationFields | null;
  // The sister company's name, or null.
  company: string | null;
  // Which company's own records (challans, statements) apply: undefined = all, null = the main company, otherwise a sister company's id.
  brandId?: string | null;
}

@Injectable()
export class BrandingLookupService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
  ) {}

  /** The branding for one brand id (null = the organization's own). */
  async forBrand(
    organizationId: string,
    brandIdIn: string | null | undefined,
  ): Promise<ResolvedBranding> {
    // With sister companies switched off, every document carries the organization's own branding, whatever tags exist.
    const brandId =
      brandIdIn && (await sisterCompaniesOn(organizationId)) ? brandIdIn : null;
    const [org, brand] = await Promise.all([
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: {
          gstin: true,
          pan: true,
          tan: true,
          cin: true,
          registrationNumber: true,
          lin: true,
          msmeRegistrationNumber: true,
          epfoEstablishmentCode: true,
          esicEmployerCode: true,
          ptRegistrationNumber: true,
          labourLicenseNumber: true,
          name: true,
          companyName: true,
          legalName: true,
          companyLogoUrl: true,
          emailLogoUrl: true,
          registeredAddress: true,
          contactEmail: true,
          phone: true,
          website: true,
        },
      }),
      brandId
        ? this.scopedPrisma.companyBrand.findFirst({
            where: { id: brandId, organizationId },
          })
        : Promise.resolve(null),
    ]);
    return resolveBranding(
      org ?? {
        name: '',
        companyName: null,
        legalName: null,
        companyLogoUrl: null,
        emailLogoUrl: null,
        registeredAddress: null,
        contactEmail: null,
        phone: null,
        website: null,
      },
      brand,
    );
  }

  /** The branding for one employee's documents. */
  async forEmployee(
    organizationId: string,
    employeeId: string,
  ): Promise<ResolvedBranding> {
    const user = await this.scopedPrisma.user.findFirst({
      where: { id: employeeId, organizationId },
      select: { brandId: true },
    });
    return this.forBrand(organizationId, user?.brandId);
  }

  /**
   * The scope of a return or report for one company: 'ALL' / blank = everyone with the organization's own codes (as before),
   * 'MAIN' = only people with no sister company, a brand id = only that company's people with ITS codes (never the parent's).
   */
  async companyScope(
    organizationId: string,
    companyId?: string | null,
  ): Promise<CompanyScope> {
    const all: CompanyScope = {
      runWhere: {},
      registration: null,
      company: null,
    };
    if (!companyId || companyId === 'ALL') return all;
    // Sister companies switched off: there is only the organization.
    if (!(await sisterCompaniesOn(organizationId))) return all;
    if (companyId === 'MAIN')
      return {
        runWhere: { brandId: null },
        registration: null,
        company: null,
        brandId: null,
      };
    const brand = await this.scopedPrisma.companyBrand.findFirst({
      where: { id: companyId, organizationId },
    });
    if (!brand) throw new BadRequestException('That company was not found.');
    const b = resolveBranding(
      {
        name: '',
        companyName: null,
        legalName: null,
        companyLogoUrl: null,
        emailLogoUrl: null,
        registeredAddress: null,
        contactEmail: null,
        phone: null,
        website: null,
      },
      brand,
    );
    return {
      runWhere: { brandId: brand.id },
      registration: b.registration,
      company: brand.name,
      brandId: brand.id,
    };
  }
}
