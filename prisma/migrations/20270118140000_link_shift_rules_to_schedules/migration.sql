-- One-off: link existing shift rules to the work schedule they obviously belong to, so they show in that schedule's form.
-- Only where nothing changes: a gender rule whose departments are exactly all the departments of ONE schedule; a rule for named
-- people whose people all work in departments of ONE schedule. Every other rule stays as it is (listed under "Other shift rules").
UPDATE "shift_rules" r SET "workScheduleId" = x.sid
FROM (
  SELECT r2.id AS rid, MIN(d."workScheduleId") AS sid
  FROM "shift_rules" r2
  JOIN "departments" d ON d.id = ANY (r2."departmentIds")
  WHERE r2."workScheduleId" IS NULL AND cardinality(r2."employeeIds") = 0 AND cardinality(r2."departmentIds") > 0
  GROUP BY r2.id, r2."departmentIds"
  HAVING COUNT(*) = cardinality(r2."departmentIds")
     AND COUNT(d."workScheduleId") = COUNT(*)
     AND COUNT(DISTINCT d."workScheduleId") = 1
     AND (SELECT COUNT(*) FROM "departments" d2 WHERE d2."workScheduleId" = MIN(d."workScheduleId")) = cardinality(r2."departmentIds")
) x
WHERE r.id = x.rid;

UPDATE "shift_rules" r SET "workScheduleId" = x.sid
FROM (
  SELECT r2.id AS rid, MIN(d."workScheduleId") AS sid
  FROM "shift_rules" r2
  JOIN "users" u ON u.id = ANY (r2."employeeIds")
  JOIN "departments" d ON d.id = u."departmentId"
  WHERE r2."workScheduleId" IS NULL AND cardinality(r2."employeeIds") > 0
  GROUP BY r2.id, r2."employeeIds"
  HAVING COUNT(*) = cardinality(r2."employeeIds")
     AND COUNT(d."workScheduleId") = COUNT(*)
     AND COUNT(DISTINCT d."workScheduleId") = 1
) x
WHERE r.id = x.rid;
