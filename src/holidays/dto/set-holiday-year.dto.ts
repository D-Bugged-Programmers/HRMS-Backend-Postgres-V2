import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

export class SetHolidayYearDto {
  @ApiPropertyOptional({ description: 'The month the holiday calendar year starts in: 1 = January ... 12 = December. Omit when sameAsFinancialYear is true.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'Pick a month from January to December.' })
  @Min(1, { message: 'Pick a month from January to December.' })
  @Max(12, { message: 'Pick a month from January to December.' })
  startMonth?: number;

  @ApiPropertyOptional({ description: "True = link the holiday year to the company's financial year start month." })
  @IsOptional()
  @IsBoolean()
  sameAsFinancialYear?: boolean;
}
