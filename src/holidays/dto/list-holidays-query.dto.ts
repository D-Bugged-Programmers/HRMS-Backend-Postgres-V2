import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { HolidayType } from '@prisma/client';

export class ListHolidaysQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year?: number;

  @ApiPropertyOptional({ description: "The company's holiday year (named by the calendar year it starts in), e.g. 2026 = Apr 2026 - Mar 2027 for an April start." })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  holidayYear?: number;

  @ApiPropertyOptional({
    description: 'Returns holidays for this department OR company-wide',
  })
  @IsOptional()
  @IsUUID()
  department?: string;

  @ApiPropertyOptional({ enum: HolidayType })
  @IsOptional()
  @IsEnum(HolidayType)
  type?: HolidayType;
}
