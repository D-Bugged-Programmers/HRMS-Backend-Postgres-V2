import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsObject, IsOptional, IsString, Matches, ValidateNested } from 'class-validator';

// Spreadsheet cells arrive untyped (strings, numbers, blanks): each row field is checked by the service row by row, so one bad
// row is reported without refusing the whole file. Declared here so the global whitelist does not strip them.
export class SalaryUploadRowDto {
  @ApiProperty({ description: "The employee's code (Employee ID), e.g. SIS2-0001." })
  @IsOptional()
  employeeCode!: unknown;

  @ApiPropertyOptional({ description: 'Annual CTC (or give Monthly gross).' })
  @IsOptional()
  annualCtc?: unknown;

  @ApiPropertyOptional({ description: 'Monthly gross (or give Annual CTC).' })
  @IsOptional()
  monthlyGross?: unknown;

  @ApiPropertyOptional({ description: 'Variable pay for the year.' })
  @IsOptional()
  variableAnnual?: unknown;

  @ApiPropertyOptional({ description: 'Yes: the annual CTC includes the variable pay. No / blank: it is paid on top.' })
  @IsOptional()
  variableIncludedInCtc?: unknown;

  @ApiPropertyOptional({ description: 'YYYY-MM-DD. Blank = the file default, else the joining date (first structure) or today.' })
  @IsOptional()
  effectiveFrom?: unknown;

  @ApiPropertyOptional({ description: 'Fixed monthly amounts by salary component code or name; used instead of the CTC / gross split when any is given.' })
  @IsOptional()
  @IsObject()
  components?: Record<string, unknown>;
}

export class SalaryUploadDto {
  @ApiProperty({ type: [SalaryUploadRowDto] })
  @IsArray()
  @ArrayMinSize(1, { message: 'The file has no rows.' })
  @ArrayMaxSize(1000, { message: 'Upload at most 1000 employees at a time.' })
  @ValidateNested({ each: true })
  @Type(() => SalaryUploadRowDto)
  rows!: SalaryUploadRowDto[];

  @ApiProperty({ enum: ['SKIP', 'REVISE'], description: 'What to do with an employee who already has a salary structure.' })
  @IsIn(['SKIP', 'REVISE'])
  existing!: 'SKIP' | 'REVISE';

  @ApiPropertyOptional({ description: 'The effective date for every row that has none (YYYY-MM-DD).' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Effective date must be YYYY-MM-DD.' })
  defaultEffectiveFrom?: string;

  @ApiPropertyOptional({ description: 'Allow an effective date in months whose payroll is locked or paid; the difference is paid as arrears.' })
  @IsOptional()
  @IsBoolean()
  backdateForArrears?: boolean;

  @ApiPropertyOptional({ description: 'true: check and calculate every row, save nothing.' })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}
