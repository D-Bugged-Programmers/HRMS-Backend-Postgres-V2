import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export class SetHolidayYearDto {
  @ApiProperty({ description: 'The month the holiday calendar year starts in: 1 = January ... 12 = December.' })
  @Type(() => Number)
  @IsInt({ message: 'Pick a month from January to December.' })
  @Min(1, { message: 'Pick a month from January to December.' })
  @Max(12, { message: 'Pick a month from January to December.' })
  startMonth!: number;
}
