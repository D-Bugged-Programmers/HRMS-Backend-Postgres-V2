-- A Work From Home request still undecided after its date: the company chooses what happens (default: nothing, as before).
ALTER TYPE "WfhApprovalStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TABLE "organizations" ADD COLUMN "wfhOverdueAction" TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE "attendances" ADD COLUMN "workArrangementEscalatedAt" TIMESTAMP(3);
