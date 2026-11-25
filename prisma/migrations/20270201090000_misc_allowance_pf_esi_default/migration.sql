-- The Miscellaneous Allowance counts towards the PF and ESI wages by default (every other earning besides Basic and DA is off
-- until switched on per component).
UPDATE "salary_components"
SET "countsTowardsPfWages" = true, "excludedFromEsiWages" = false
WHERE "code" = 'MISCELLANEOUS_ALLOWANCE' AND "type" = 'EARNING' AND "isEmployerContribution" = false;
