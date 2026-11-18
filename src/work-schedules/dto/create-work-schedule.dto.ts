import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsNumber,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

// One "alternate" day — off only on the given occurrence(s) of the month
// (1st..5th) rather than every week. E.g. { day: 6, occurrences: [2, 4] }
// = 2nd/4th Saturday off, 1st/3rd/5th worked.
export class AlternateWeeklyOffDto {
  @ApiProperty({ description: '0=Sunday ... 6=Saturday' })
  @IsInt()
  @Min(0)
  @Max(6)
  day!: number;

  @ApiProperty({
    type: [Number],
    description: '1st..5th occurrence of that weekday in the month',
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(5, { each: true })
  occurrences!: number[];
}

export class CreateWorkScheduleDto {
  @ApiProperty({ example: 'General Shift' })
  @IsString()
  @MinLength(1)
  name!: string;

  @ApiProperty({ type: [Number], description: '0=Sunday ... 6=Saturday' })
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  workingDays!: number[];

  // Flexible shift: no fixed start or end time - people work any time and the hours worked decide Present / Half Day.
  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  isFlexible?: boolean;

  @ApiPropertyOptional({
    example: 8,
    description: 'Hours worked for a full Present day (flexible shifts).',
  })
  @ValidateIf((o: CreateWorkScheduleDto) => o.isFlexible === true)
  @IsNumber()
  @Min(1)
  @Max(24)
  flexFullDayHours?: number;

  @ApiPropertyOptional({
    example: 4,
    description: 'Hours worked for a Half Day (flexible shifts).',
  })
  @ValidateIf((o: CreateWorkScheduleDto) => o.isFlexible === true)
  @IsNumber()
  @Min(0.5)
  @Max(24)
  flexHalfDayHours?: number;

  @ApiPropertyOptional({
    example: '09:30',
    description: 'Not used for a flexible shift.',
  })
  @ValidateIf((o: CreateWorkScheduleDto) => o.isFlexible !== true)
  @IsString()
  startTime?: string;

  @ApiPropertyOptional({
    example: '18:30',
    description: 'Not used for a flexible shift.',
  })
  @ValidateIf((o: CreateWorkScheduleDto) => o.isFlexible !== true)
  @IsString()
  endTime?: string;

  // Mandatory, at least 1: the attendance engine takes it off the worked time before judging Present / Half Day.
  @ApiProperty({ example: 60 })
  @IsInt()
  @Min(1)
  breakMinutes!: number;

  // Only for days NOT in workingDays — a day off every week by default
  // doesn't need an entry here; only list a day if it should be off on
  // just some occurrences (see WorkSchedulesService's overlap validation).
  @ApiPropertyOptional({ type: [AlternateWeeklyOffDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => AlternateWeeklyOffDto)
  alternateWeeklyOffs?: AlternateWeeklyOffDto[];

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
