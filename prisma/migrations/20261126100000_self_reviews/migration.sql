-- CreateEnum
CREATE TYPE "SelfReviewStatus" AS ENUM ('SUBMITTED', 'REVIEWED');

-- CreateTable
CREATE TABLE "self_reviews" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "proud" TEXT NOT NULL DEFAULT '',
    "grow" TEXT NOT NULL DEFAULT '',
    "selfRating" INTEGER NOT NULL,
    "impact" TEXT NOT NULL DEFAULT '',
    "support" TEXT NOT NULL DEFAULT '',
    "status" "SelfReviewStatus" NOT NULL DEFAULT 'SUBMITTED',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "evaluatedById" TEXT,
    "evaluatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "self_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "self_reviews_organizationId_financialYear_idx" ON "self_reviews"("organizationId", "financialYear");

-- CreateIndex
CREATE UNIQUE INDEX "self_reviews_organizationId_employeeId_financialYear_key" ON "self_reviews"("organizationId", "employeeId", "financialYear");

-- AddForeignKey
ALTER TABLE "self_reviews" ADD CONSTRAINT "self_reviews_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_reviews" ADD CONSTRAINT "self_reviews_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "self_reviews" ADD CONSTRAINT "self_reviews_evaluatedById_fkey" FOREIGN KEY ("evaluatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
