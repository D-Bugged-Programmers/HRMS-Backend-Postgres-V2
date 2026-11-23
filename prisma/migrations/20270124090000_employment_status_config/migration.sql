ALTER TABLE "organizations" ADD COLUMN "employmentStatusConfig" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "users" ADD COLUMN "employmentStatusKey" TEXT;
