-- A work location can now be just an address (no geo-fence). Every existing location keeps its fence (true).
ALTER TABLE "work_locations" ADD COLUMN "geoFenceEnabled" BOOLEAN NOT NULL DEFAULT true;
