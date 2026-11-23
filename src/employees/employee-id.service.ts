import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { formatDocumentNumber, issueDocumentNumber } from '../organizations/document-numbering';
import { effectiveCounter } from '../company-brands/brand-rules';
import { codeNumberFor } from './employee-code';

/**
 * Employee ID generation. A person in a company brand that has its own ID series takes the next number of that series; everyone else
 * (no brand, or a brand without its own series) takes the next number of the organization's 'employeeId' Document Numbering
 * config (issueDocumentNumber), exactly as before.
 *
 * Must be called with a transaction client (`tx` from `prisma.$transaction(async (tx) => ...)`), so the row lock and the User insert
 * that follows are part of the same transaction.
 */
@Injectable()
export class EmployeeIdService {
  async generate(
    tx: Prisma.TransactionClient,
    organizationId: string,
    brandId?: string | null,
  ): Promise<string> {
    if (brandId) {
      const rows = await tx.$queryRaw<{ employeeIdFormat: string | null; employeeIdCounter: number }[]>`
        SELECT "employeeIdFormat", "employeeIdCounter" FROM company_brands
        WHERE id = ${brandId} AND "organizationId" = ${organizationId} FOR UPDATE
      `;
      const brand = rows[0];
      if (brand?.employeeIdFormat) {
        // The number inside the braces is where the series starts (E{3000} issues E3001 first); a series already beyond it keeps counting.
        let counter = effectiveCounter(brand.employeeIdFormat, brand.employeeIdCounter);
        // An ID is unique across the company: a number somebody already holds is skipped, never reused.
        for (let tries = 0; tries < 50; tries++) {
          counter += 1;
          const id = formatDocumentNumber(brand.employeeIdFormat, counter);
          const taken = await tx.user.findFirst({ where: { organizationId, employeeId: id }, select: { id: true } });
          if (!taken) {
            await tx.companyBrand.updateMany({ where: { id: brandId, organizationId }, data: { employeeIdCounter: counter } });
            return id;
          }
        }
        throw new Error('Could not issue a free employee ID for this company series.');
      }
    }
    return issueDocumentNumber(tx, organizationId, 'employeeId');
  }

  /**
   * Takes an employee code someone supplied (the bulk-import sheet) instead of issuing the next one. The code is saved exactly as written;
   * the company's series then continues after it when the code is higher than where the series stands. Refuses a code already in use.
   * `format` is the format that governs this person (the brand's own series, else the organization's employee ID numbering).
   */
  async claim(tx: Prisma.TransactionClient, organizationId: string, brandId: string | null | undefined, code: string): Promise<string> {
    let seriesLocked = false;
    if (brandId) {
      const rows = await tx.$queryRaw<{ employeeIdFormat: string | null; employeeIdCounter: number }[]>`
        SELECT "employeeIdFormat", "employeeIdCounter" FROM company_brands
        WHERE id = ${brandId} AND "organizationId" = ${organizationId} FOR UPDATE
      `;
      const brand = rows[0];
      if (brand?.employeeIdFormat) {
        seriesLocked = true;
        await this.assertFree(tx, organizationId, code);
        const n = codeNumberFor(brand.employeeIdFormat, code);
        if (n !== null && n > effectiveCounter(brand.employeeIdFormat, brand.employeeIdCounter)) {
          await tx.companyBrand.updateMany({ where: { id: brandId, organizationId }, data: { employeeIdCounter: n } });
        }
      }
    }
    if (!seriesLocked) {
      const rows = await tx.$queryRaw<{ documentNumbering: unknown }[]>`
        SELECT "documentNumbering" FROM organizations WHERE id = ${organizationId} FOR UPDATE
      `;
      await this.assertFree(tx, organizationId, code);
      const numbering = (rows[0]?.documentNumbering ?? {}) as Record<string, { format?: string; counter?: number; resetRule?: string }>;
      const entry = numbering.employeeId;
      const n = codeNumberFor(entry?.format, code);
      // A series that restarts every month/year keeps its own count; only a never-resetting one continues after the supplied number.
      if (entry && n !== null && (entry.resetRule ?? 'never') === 'never' && n > (entry.counter ?? 0)) {
        await tx.organization.update({
          where: { id: organizationId },
          data: { documentNumbering: { ...numbering, employeeId: { ...entry, counter: n } } as unknown as Prisma.InputJsonValue },
        });
      }
    }
    return code;
  }

  private async assertFree(tx: Prisma.TransactionClient, organizationId: string, code: string) {
    const taken = await tx.user.findFirst({ where: { organizationId, employeeId: code }, select: { id: true } });
    if (taken) throw new ConflictException(`Employee code ${code} is already in use.`);
  }
}
