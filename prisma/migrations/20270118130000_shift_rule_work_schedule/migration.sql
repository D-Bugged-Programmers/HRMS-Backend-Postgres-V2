-- Shift rules can now be made inside a work schedule (they follow the departments that schedule is assigned to). Existing rules are unchanged (NULL).
ALTER TABLE "shift_rules" ADD COLUMN "workScheduleId" TEXT;
CREATE INDEX "shift_rules_workScheduleId_idx" ON "shift_rules"("workScheduleId");
