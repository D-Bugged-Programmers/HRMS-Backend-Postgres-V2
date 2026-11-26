-- From 1-Apr-2026 the year is a "Tax Year". The tax declaration and certificate e-mails now take the wording from
-- {{taxYearLabel}} ("Tax Year 2026-27", or "FY 2025-26" for earlier years). Only the original wording is moved; a sentence
-- an organisation rewrote is left alone. Must be released together with the code that supplies {{taxYearLabel}}.

UPDATE "email_templates"
SET "bodyHtml" = REPLACE(REPLACE("bodyHtml",
  'Your tax declaration for FY {{financialYear}} has been verified.', 'Your tax declaration for {{taxYearLabel}} has been verified.'),
  '>FY {{financialYear}}<', '>{{taxYearLabel}}<')
WHERE "occasionKey" = 'TAX_DECLARATION_VERIFIED';

UPDATE "email_templates"
SET "bodyHtml" = REPLACE("bodyHtml", '>Financial year</td>', '>Year</td>')
WHERE "occasionKey" = 'TAX_DECLARATION_VERIFIED';

UPDATE "email_templates"
SET "subject" = 'Submit your tax declaration for {{taxYearLabel}}'
WHERE "occasionKey" = 'TAX_DECLARATION_REMINDER' AND "subject" = 'Submit your tax declaration for FY {{financialYear}}';

UPDATE "email_templates"
SET "bodyHtml" = REPLACE("bodyHtml",
  'Your investment declaration for FY {{financialYear}} is not submitted yet.', 'Your investment declaration for {{taxYearLabel}} is not submitted yet.')
WHERE "occasionKey" = 'TAX_DECLARATION_REMINDER';

UPDATE "email_templates"
SET "subject" = 'Your {{formName}} for {{taxYearLabel}} is ready'
WHERE "occasionKey" = 'FORM16_AVAILABLE' AND "subject" = 'Your {{formName}} for FY {{financialYear}} is ready';

UPDATE "email_templates"
SET "bodyHtml" = REPLACE("bodyHtml",
  '(tax certificate) for FY {{financialYear}} is ready', '(tax certificate) for {{taxYearLabel}} is ready')
WHERE "occasionKey" = 'FORM16_AVAILABLE';
