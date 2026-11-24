-- An earning can be counted in the PF wages besides Basic and DA. Off for every existing component, so nothing changes.
ALTER TABLE "salary_components" ADD COLUMN "countsTowardsPfWages" BOOLEAN NOT NULL DEFAULT false;
