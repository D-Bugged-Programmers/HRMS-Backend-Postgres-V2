-- From 1-Apr-2026 the salary TDS certificate is Form 130 (Form 16 before). The "ready to download" e-mail now names the form for the
-- tax year ({{formName}}). Only text still in its original wording is moved; a template an organisation rewrote is left alone.
UPDATE "email_templates"
SET "name" = 'Tax Certificate Available'
WHERE "occasionKey" = 'FORM16_AVAILABLE' AND "name" = 'Form 16 Available';

UPDATE "email_templates"
SET "subject" = 'Your {{formName}} for FY {{financialYear}} is ready'
WHERE "occasionKey" = 'FORM16_AVAILABLE' AND "subject" = 'Your Form 16 for FY {{financialYear}} is ready';

UPDATE "email_templates"
SET "bodyHtml" = REPLACE(REPLACE("bodyHtml", 'Your Form 16 is ready', 'Your {{formName}} is ready'), 'Your Form 16 (tax certificate) for FY', 'Your {{formName}} (tax certificate) for FY')
WHERE "occasionKey" = 'FORM16_AVAILABLE';
