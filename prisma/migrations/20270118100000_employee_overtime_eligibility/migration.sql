-- Per-employee overtime override. NULL (every existing employee) keeps following the overtime rule sets and company policy.
CREATE TYPE "OvertimeEligibility" AS ENUM ('ELIGIBLE', 'NOT_ELIGIBLE');
ALTER TABLE "users" ADD COLUMN "overtimeEligibility" "OvertimeEligibility";
