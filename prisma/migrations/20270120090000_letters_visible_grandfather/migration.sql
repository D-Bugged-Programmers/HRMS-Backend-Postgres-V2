-- Letters now start hidden from the employee until HR/Admin switch on "Visible to employee". So nobody loses a letter they could
-- already open today, every active, non-disciplinary template that is unlocked for an employee right now is granted to them once.
-- Insert-only (ON CONFLICT DO NOTHING): an existing grant, on or off, is never changed. Letters that unlock later start hidden.
INSERT INTO "employee_letter_access" ("id", "organizationId", "employeeId", "key", "enabled", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, u."organizationId", u."id", t."key", true, now(), now()
FROM "users" u
JOIN "letter_templates" t
  ON t."organizationId" = u."organizationId"
 AND t."isActive" = true
 AND t."key" NOT IN ('warningLetter', 'suspensionLetter', 'showCauseNotice')
WHERE
  t."dataProfile" = 'BASIC'
  OR (t."dataProfile" = 'EXIT' AND EXISTS (
        SELECT 1 FROM "offboarding_cases" o WHERE o."organizationId" = u."organizationId" AND o."employeeId" = u."id"))
  OR (t."dataProfile" = 'PAYROLL' AND EXISTS (
        SELECT 1 FROM "payroll_runs" p
        WHERE p."organizationId" = u."organizationId" AND p."employeeId" = u."id"
          AND p."isFinalSettlement" = false AND p."runSequence" = 0
          AND p."status" IN ('APPROVED', 'LOCKED', 'PAID')))
  OR (t."dataProfile" = 'SETTLEMENT' AND EXISTS (
        SELECT 1 FROM "settlements" s WHERE s."organizationId" = u."organizationId" AND s."employeeId" = u."id"))
ON CONFLICT ("organizationId", "employeeId", "key") DO NOTHING;
