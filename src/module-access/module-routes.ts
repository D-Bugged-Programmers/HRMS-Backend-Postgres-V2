// Purpose: which HRMS module each API route belongs to, so a company's switched-off modules can be refused in one place.
// Important: keyed by the FIRST path segment. Routes not listed (employees, auth, dashboard, organizations, ...) are core
//   and always available. Add a new module's routes here and a flag in cc_feature_flags.
export const MODULE_LABELS: Record<string, string> = {
  'module.attendance': 'Attendance',
  'module.leave': 'Leave',
  'module.payroll': 'Payroll',
  'module.statutory': 'Statutory compliance',
  'module.loans_reimbursements': 'Loans and reimbursements',
  'module.assets': 'Assets',
  'module.performance': 'Performance',
  'module.documents_letters': 'Documents and letters',
  'module.offboarding': 'Offboarding',
  'module.reports': 'Reports',
  'module.policy_assistant': 'Ask HR',
};

// Company Admin > Account Management tabs: switched on/off per company in the Control Center. Kept apart from MODULE_LABELS
// so they never show in the "My Plan & Modules" list of HRMS modules.
export const ACCOUNT_LABELS: Record<string, string> = {
  'module.account_billing': 'Subscription & Billing',
  'module.account_plan': 'My Plan & Modules',
  'module.account_usage': 'Usage & Limits',
  'module.account_export': 'Data Export',
  'module.account_support': 'Support & Tickets',
  'module.account_activity': 'Account Activity',
};

// Company Admin > Organization menu entries: switched on/off per company in the Control Center. Menu and page only - the data
// stays readable for the other screens that use it (an Employee form still lists designations), so these have no API segments below.
export const ORG_ITEM_LABELS: Record<string, string> = {
  'module.org_locations': 'Organization: Locations & Branches',
  'module.org_departments': 'Organization: Departments',
  'module.org_designations': 'Organization: Designations',
  'module.org_grades': 'Organization: Grades / Levels',
  'module.org_reporting_structure': 'Organization: Reporting Structure',
  'module.org_employee_categories': 'Organization: Employee Categories',
  'module.org_employment_types': 'Organization: Employment Types',
  'module.org_holidays': 'Organization: Holiday Calendar',
  'module.org_required_documents': 'Organization: Required Documents',
  'module.org_reasons_for_leaving': 'Organization: Reasons for Leaving',
  'module.org_email_templates': 'Organization: Email Templates',
  'module.org_data_privacy': 'Organization: Data Privacy & Protection',
  'module.org_audit_logs': 'Organization: Audit Logs',
};

// More menu pages, whole features inside screens, report sections and the mobile app: switched on/off per company in the Control
// Center. Like ORG_ITEM_LABELS they hide things in the apps only and have no API segments.
export const SCREEN_SWITCH_LABELS: Record<string, string> = {
  // Menu pages
  'module.menu_onboarding': 'Menu: Onboarding (New Joiners, Pending Onboarding, Probation Tracker)',
  'module.menu_employee_history': 'Menu: Employee History',
  'module.menu_tds_compliance': 'Menu: TDS Compliance',
  'module.menu_approvals': 'Menu: Approvals',
  'module.menu_my_requests': 'Menu: My Requests',
  'module.menu_performance_reviews': 'Menu: Performance Reviews',
  // Features inside screens
  'module.feature_overtime': 'Feature: Overtime',
  'module.feature_flexible_shift': 'Feature: Flexible shifts in work schedules',
  'module.feature_geofence': 'Feature: Geo-fencing on locations',
  'module.feature_bulk_employee_upload': 'Feature: Bulk Excel upload of employees',
  'module.feature_certificate_email': 'Feature: Emailing Form 130 / Form 16 to employees',
  'module.feature_payslip_download': 'Feature: Payslip download and print',
  // Report sections
  'module.report_payroll_compliance': 'Reports: Payroll & Compliance section',
  'module.report_operations': 'Reports: Operations section',
  'module.report_scheduled': 'Reports: Scheduled reports section',
  'module.report_builder': 'Reports: Custom report builder',
  // Mobile
  'module.mobile_app': 'Mobile app',
};

const SEGMENTS: Record<string, string[]> = {
  'module.attendance': ['attendance', 'work-schedules', 'overtime', 'field-tracking', 'field-visits'],
  'module.leave': ['leaves', 'leave-balances', 'leave-encashments', 'leave-grants', 'leave-tracker', 'leave-types', 'leave-year', 'comp-offs'],
  'module.payroll': ['payroll', 'payroll-settings', 'payroll-templates', 'employee-salary', 'salary-components', 'opening-balances'],
  'module.statutory': ['statutory-config', 'tds', 'tax-slabs', 'tax-declarations'],
  'module.loans_reimbursements': ['loans', 'reimbursements'],
  'module.assets': ['assets'],
  'module.performance': ['performance-ratings', 'company-performance'],
  'module.documents_letters': ['documents', 'letter-templates', 'letters'],
  'module.offboarding': ['offboarding', 'resignations', 'settlements'],
  'module.reports': ['reports'],
  'module.policy_assistant': ['ask-hr'],
  'module.account_billing': ['account-billing'],
  'module.account_plan': ['account-plan'],
  'module.account_usage': ['account-usage'],
  'module.account_export': ['account-export'],
  'module.account_support': ['account-support'],
  'module.account_activity': ['account-activity'],
};

const BY_SEGMENT = new Map(Object.entries(SEGMENTS).flatMap(([mod, segs]) => segs.map((s) => [s, mod] as const)));

/** The module a request path belongs to, or null for core routes. `/employees/:id/letters` is Documents and letters. */
export function moduleForPath(path: string): string | null {
  const parts = path.split('?')[0].split('/').filter(Boolean);
  if (parts[0] === 'employees' && parts[2] === 'letters') return 'module.documents_letters';
  // Dashboard routes are core, except the payroll cost figures, which are Payroll data.
  if (parts[0] === 'dashboard' && parts[1] === 'hr' && parts[2] === 'payroll-cost-summary') return 'module.payroll';
  return BY_SEGMENT.get(parts[0]) ?? null;
}
