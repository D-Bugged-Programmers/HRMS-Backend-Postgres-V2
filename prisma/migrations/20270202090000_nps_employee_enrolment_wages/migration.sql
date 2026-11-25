-- NPS: an earning can count towards the NPS wages (Basic and DA always do).
ALTER TABLE "salary_components" ADD COLUMN IF NOT EXISTS "countsTowardsNpsWages" BOOLEAN NOT NULL DEFAULT false;

-- Employer NPS applies only to employees enrolled in NPS (everyone is, unless the profile says 'No'). Only the untouched default is moved.
UPDATE "salary_components"
SET "formula" = 'IF(NPS_ENROLLED == 1, PERCENT(NPS_WAGES, NPS_EMPLOYER_RATE), 0)'
WHERE "code" = 'NPS_EMPLOYER' AND "formula" = 'PERCENT(NPS_WAGES, NPS_EMPLOYER_RATE)';

-- The employee's own NPS deduction, for every organisation that does not have one yet. Nil until a rate is set.
INSERT INTO "salary_components" ("id", "organizationId", "name", "code", "type", "calcType", "formula", "isStatutory", "statutoryKey", "displayOrder", "isSystemDefault", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, o."id", 'NPS (Employee)', 'NPS_EMPLOYEE', 'DEDUCTION', 'FORMULA',
       'IF(NPS_ENROLLED == 1, ROUND(NPS_WAGES * NPS_EMPLOYEE_RATE / 100, 0), 0)', true, 'NPS', 32, true, now(), now()
FROM "organizations" o
WHERE NOT EXISTS (SELECT 1 FROM "salary_components" c WHERE c."organizationId" = o."id" AND c."code" = 'NPS_EMPLOYEE');
