CREATE TYPE "AttendanceMethod" AS ENUM ('DEFAULT', 'MOBILE', 'BIOMETRIC', 'BOTH');
ALTER TABLE "users" ADD COLUMN "attendanceMethod" "AttendanceMethod" NOT NULL DEFAULT 'DEFAULT';
