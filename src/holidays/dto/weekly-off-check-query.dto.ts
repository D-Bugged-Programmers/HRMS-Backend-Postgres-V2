import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

export class WeeklyOffCheckQueryDto {
  @ApiProperty({ example: '2026-01-26,2026-08-15', description: 'Dates to check, comma separated (YYYY-MM-DD), at most 400.' })
  @IsString()
  @MaxLength(5000)
  dates!: string;
}
