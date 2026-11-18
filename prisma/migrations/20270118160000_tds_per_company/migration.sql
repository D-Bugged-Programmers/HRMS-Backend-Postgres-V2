-- TDS challans and statements belong to a company (a sister company's TAN is its own). Existing rows stay with the main company (null).
ALTER TABLE "tds_challans" ADD COLUMN "brandId" TEXT;
CREATE INDEX "tds_challans_organizationId_brandId_idx" ON "tds_challans"("organizationId", "brandId");
ALTER TABLE "tds_statements" ADD COLUMN "brandId" TEXT;
DROP INDEX "tds_statements_organizationId_financialYear_quarter_key";
CREATE UNIQUE INDEX "tds_statements_organizationId_financialYear_quarter_brandId_key" ON "tds_statements"("organizationId", "financialYear", "quarter", "brandId");
