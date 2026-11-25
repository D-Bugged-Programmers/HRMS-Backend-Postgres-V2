-- Employer EDLI and the PF admin charge are not part of the CTC and are not listed on the salary structure or the payslip.
-- Switch "Include in CTC" back on for a component to list it again.
UPDATE "salary_components" SET "includeInCTC" = false
WHERE "isEmployerContribution" = true AND "code" IN ('EDLI_EMPLOYER', 'EPF_ADMIN_EMPLOYER');
