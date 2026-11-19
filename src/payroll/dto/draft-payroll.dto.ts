import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class DraftPayrollDto {
  @ApiProperty({ minimum: 1, maximum: 12 })
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @ApiProperty({ minimum: 2000, maximum: 2100 })
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  // See CalculatePayrollDto's own comment — same exclude-for-this-run-only
  // semantics, ignored when employeeId is set.
  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsUUID('4', { each: true })
  excludeEmployeeIds?: string[];

  // Run even though leave for this month is still waiting for a decision (only checked when a Leave Freeze day is set).
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  allowPendingLeave?: boolean;
}
