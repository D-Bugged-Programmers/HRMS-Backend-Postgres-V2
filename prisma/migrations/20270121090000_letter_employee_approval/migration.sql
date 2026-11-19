ALTER TABLE "issued_letters" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "issued_letters" ADD COLUMN "signatureName" TEXT;
ALTER TABLE "issued_letters" ADD COLUMN "signedIp" TEXT;
ALTER TABLE "issued_letters" ADD COLUMN "signedUserAgent" TEXT;
ALTER TABLE "issued_letters" ADD COLUMN "declinedAt" TIMESTAMP(3);
ALTER TABLE "issued_letters" ADD COLUMN "declineReason" TEXT;
ALTER TABLE "issued_letters" ADD COLUMN "supersededAt" TIMESTAMP(3);
ALTER TABLE "letter_templates" ADD COLUMN "requiresApproval" BOOLEAN NOT NULL DEFAULT true;
