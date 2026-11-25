-- The filing tracker records when a PF / ESI / PT / LWF payment or return was made and its reference number, not just a tick.
ALTER TABLE "statutory_filings" ADD COLUMN IF NOT EXISTS "filedOn" TEXT;
ALTER TABLE "statutory_filings" ADD COLUMN IF NOT EXISTS "reference" TEXT NOT NULL DEFAULT '';
ALTER TABLE "statutory_filings" ADD COLUMN IF NOT EXISTS "amount" DOUBLE PRECISION;
