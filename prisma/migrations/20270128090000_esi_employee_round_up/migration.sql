-- The employee's ESI share is rounded UP to the next rupee. Only components still on the untouched default formula are moved;
-- a formula an organisation wrote itself is left alone.
UPDATE "salary_components"
SET "formula" = 'IF(ESI_APPLICABLE == 1, CEIL(ESI_WAGES * ESI_EMPLOYEE_RATE / 100), 0)'
WHERE "statutoryKey" = 'ESI'
  AND "type" = 'DEDUCTION'
  AND "formula" = 'IF(ESI_APPLICABLE == 1, ROUND(ESI_WAGES * ESI_EMPLOYEE_RATE / 100, 0), 0)';
