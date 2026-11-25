-- An earning can be left out of the ESI wages (Conveyance, a travelling allowance, is by default).
ALTER TABLE "salary_components" ADD COLUMN IF NOT EXISTS "excludedFromEsiWages" BOOLEAN NOT NULL DEFAULT false;
UPDATE "salary_components" SET "excludedFromEsiWages" = true WHERE "code" = 'CONVEYANCE' AND "type" = 'EARNING';

-- The employer's ESI share is rounded UP to the next rupee too. Only the untouched default formula is moved.
UPDATE "salary_components"
SET "formula" = 'IF(ESI_APPLICABLE == 1, CEIL(ESI_WAGES * ESI_EMPLOYER_RATE / 100), 0)'
WHERE "statutoryKey" = 'ESI'
  AND "isEmployerContribution" = true
  AND "formula" = 'IF(ESI_APPLICABLE == 1, ROUND(ESI_WAGES * ESI_EMPLOYER_RATE / 100, 0), 0)';
