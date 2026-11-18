-- Employer contribution lines a payslip template leaves off the printed payslip (by salary-component code). Empty = all shown, so existing templates are unchanged.
ALTER TABLE "payroll_templates" ADD COLUMN "hiddenEmployerContributionCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
