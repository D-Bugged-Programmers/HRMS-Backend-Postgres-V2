import { LettersModule } from '../letters/letters.module';
import { Module } from '@nestjs/common';
import { EmployeeSalaryComponentsController } from './employee-salary-components.controller';
import { EmployeeSalaryComponentsService } from './employee-salary-components.service';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { EmployeeTimelineModule } from '../employee-timeline/employee-timeline.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { EmailTemplatesModule } from '../email-templates/email-templates.module';
import { SalaryStructurePdfService } from './salary-structure-pdf.service';
import { PrivacyModule } from '../privacy/privacy.module';

import { CompanyBrandsModule } from '../company-brands/company-brands.module';
import { PayrollSettingsModule } from '../payroll-settings/payroll-settings.module';
import { StatutoryConfigModule } from '../statutory-config/statutory-config.module';

@Module({
  imports: [
    LettersModule,
    AuditLogModule,
    EmployeeTimelineModule,
    NotificationsModule,
    EmailTemplatesModule,
    PrivacyModule,
    CompanyBrandsModule,
    // The PF / ESI / PT figures on the printed structure are worked out from the settings in force today.
    PayrollSettingsModule,
    StatutoryConfigModule,
  ],
  controllers: [EmployeeSalaryComponentsController],
  providers: [EmployeeSalaryComponentsService, SalaryStructurePdfService],
  // Exported so LeaveEncashmentsModule can inject it for
  // getCurrentMonthlyValue (the "current BASIC" rate calculation).
  // SalaryStructurePdfService: Reports > Salary structures.
  exports: [EmployeeSalaryComponentsService, SalaryStructurePdfService],
})
export class EmployeeSalaryComponentsModule {}
