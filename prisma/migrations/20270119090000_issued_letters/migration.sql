CREATE TABLE "issued_letters" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL,
    "documentNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "issued_letters_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "issued_letters_organizationId_employeeId_key_key" ON "issued_letters"("organizationId", "employeeId", "key");
CREATE INDEX "issued_letters_organizationId_employeeId_idx" ON "issued_letters"("organizationId", "employeeId");
