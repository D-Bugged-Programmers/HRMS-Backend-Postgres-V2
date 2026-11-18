-- Control Center switches for the Organization menu entries. On for everyone by default, so nothing changes until a Super Admin turns one off.
INSERT INTO "cc_feature_flags" ("key", "description", "defaultValue", "status", "updatedAt") VALUES
('module.org_locations', 'Organization: Locations & Branches', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.org_departments', 'Organization: Departments', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.org_designations', 'Organization: Designations', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.org_grades', 'Organization: Grades / Levels', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.org_reporting_structure', 'Organization: Reporting Structure', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.org_employee_categories', 'Organization: Employee Categories', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.org_employment_types', 'Organization: Employment Types', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.org_holidays', 'Organization: Holiday Calendar', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.org_required_documents', 'Organization: Required Documents', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.org_reasons_for_leaving', 'Organization: Reasons for Leaving', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.org_email_templates', 'Organization: Email Templates', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.org_data_privacy', 'Organization: Data Privacy & Protection', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.org_audit_logs', 'Organization: Audit Logs', 'true', 'ACTIVE', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
