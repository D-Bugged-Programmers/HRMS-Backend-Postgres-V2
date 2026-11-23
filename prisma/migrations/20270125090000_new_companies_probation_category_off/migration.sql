-- New companies start with the Probation category switched off (it is a status). Existing rows are not touched.
ALTER TABLE "organizations" ALTER COLUMN "inactiveBuiltinEmployeeTypes" SET DEFAULT ARRAY['probation']::TEXT[];
