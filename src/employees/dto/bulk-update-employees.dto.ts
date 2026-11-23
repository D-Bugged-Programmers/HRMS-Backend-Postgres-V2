import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

// The statuses a bulk change may set. Resigned, Released, Terminated and Absconded go only through Resignation / Offboarding.
export const BULK_EMPLOYMENT_STATUSES = ['ON_HOLD', 'ONBOARDING', 'PROBATION', 'EXTENDED_PROBATION', 'CONFIRMED'] as const;

/** Body of POST /employees/bulk-update - give several employees the same department, reporting manager, work location, designation or employment status. */
export class BulkUpdateEmployeesDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  employeeIds!: string[];

  @ApiPropertyOptional() @IsOptional() @IsUUID() departmentId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() reportingManagerId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() workLocationId?: string;
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  designation?: string;

  @ApiPropertyOptional({ enum: BULK_EMPLOYMENT_STATUSES })
  @IsOptional()
  @IsIn(BULK_EMPLOYMENT_STATUSES as unknown as string[])
  employmentStatus?: (typeof BULK_EMPLOYMENT_STATUSES)[number];

  // A status from the company's own list (a built-in key or one the company added); takes the place of employmentStatus above.
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(60)
  employmentStatusKey?: string;
}
