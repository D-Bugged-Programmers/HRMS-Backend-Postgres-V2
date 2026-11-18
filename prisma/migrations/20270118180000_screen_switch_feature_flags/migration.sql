-- Control Center switches for more menu pages, in-screen features, report sections and the mobile app. On for everyone by default.
INSERT INTO "cc_feature_flags" ("key", "description", "defaultValue", "status", "updatedAt") VALUES
('module.menu_onboarding', 'Menu: Onboarding (New Joiners, Pending Onboarding, Probation Tracker)', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.menu_employee_history', 'Menu: Employee History', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.menu_tds_compliance', 'Menu: TDS Compliance', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.menu_approvals', 'Menu: Approvals', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.menu_my_requests', 'Menu: My Requests', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.menu_performance_reviews', 'Menu: Performance Reviews', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.feature_overtime', 'Feature: Overtime', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.feature_flexible_shift', 'Feature: Flexible shifts in work schedules', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.feature_geofence', 'Feature: Geo-fencing on locations', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.feature_bulk_employee_upload', 'Feature: Bulk Excel upload of employees', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.feature_certificate_email', 'Feature: Emailing Form 130 / Form 16 to employees', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.feature_payslip_download', 'Feature: Payslip download and print', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.report_payroll_compliance', 'Reports: Payroll & Compliance section', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.report_operations', 'Reports: Operations section', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.report_scheduled', 'Reports: Scheduled reports section', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.report_builder', 'Reports: Custom report builder', 'true', 'ACTIVE', CURRENT_TIMESTAMP),
('module.mobile_app', 'Mobile app', 'true', 'ACTIVE', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
