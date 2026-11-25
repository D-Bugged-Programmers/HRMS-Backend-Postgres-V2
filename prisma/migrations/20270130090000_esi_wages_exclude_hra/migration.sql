-- Only Basic, DA and a retaining allowance always count towards the ESI wages. The standard allowances are left out of them
-- (switchable per company on the component: "Excluded from ESI wages"). Overtime, arrears and custom earnings are not changed.
UPDATE "salary_components" SET "excludedFromEsiWages" = true
WHERE "type" = 'EARNING' AND "code" IN ('HRA', 'SPECIAL_ALLOWANCE', 'CONVEYANCE', 'MEDICAL_ALLOWANCE', 'INCENTIVE', 'COMMISSION');
