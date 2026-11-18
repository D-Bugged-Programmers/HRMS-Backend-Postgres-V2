-- Flexible shifts: a work schedule with no fixed start / end time, where the hours worked decide Present / Half Day.
-- Existing schedules and departments stay fixed-time (false).
ALTER TABLE "work_schedules" ADD COLUMN "isFlexible" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "flexFullDayHours" DOUBLE PRECISION, ADD COLUMN "flexHalfDayHours" DOUBLE PRECISION;
ALTER TABLE "departments" ADD COLUMN "isFlexibleShift" BOOLEAN NOT NULL DEFAULT false;
