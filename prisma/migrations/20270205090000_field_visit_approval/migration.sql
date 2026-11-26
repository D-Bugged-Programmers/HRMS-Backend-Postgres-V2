-- Field visits an employee plans for themselves now wait for approval; the approver's decision is kept on the visit.
ALTER TYPE "FieldVisitStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL';
ALTER TYPE "FieldVisitStatus" ADD VALUE IF NOT EXISTS 'REJECTED';

ALTER TABLE "field_visits" ADD COLUMN "reviewedById" TEXT;
ALTER TABLE "field_visits" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "field_visits" ADD COLUMN "reviewNote" TEXT NOT NULL DEFAULT '';
