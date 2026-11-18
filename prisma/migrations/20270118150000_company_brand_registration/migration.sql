-- A sister company (brand) now carries its own registration details. Existing brands stay blank.
ALTER TABLE "company_brands"
  ADD COLUMN "gstin" TEXT,
  ADD COLUMN "pan" TEXT,
  ADD COLUMN "tan" TEXT,
  ADD COLUMN "cin" TEXT,
  ADD COLUMN "registrationNumber" TEXT,
  ADD COLUMN "lin" TEXT,
  ADD COLUMN "msmeRegistrationNumber" TEXT,
  ADD COLUMN "epfoEstablishmentCode" TEXT,
  ADD COLUMN "esicEmployerCode" TEXT,
  ADD COLUMN "ptRegistrationNumber" TEXT,
  ADD COLUMN "labourLicenseNumber" TEXT;
