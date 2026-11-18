import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsUUID,
} from 'class-validator';

/** Body of POST /employees/bulk-overtime - set overtime eligibility for several employees (FOLLOW_POLICY clears it). */
export class BulkSetOvertimeDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  employeeIds!: string[];

  @ApiProperty({ enum: ['ELIGIBLE', 'NOT_ELIGIBLE', 'FOLLOW_POLICY'] })
  @IsIn(['ELIGIBLE', 'NOT_ELIGIBLE', 'FOLLOW_POLICY'])
  eligibility!: 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'FOLLOW_POLICY';
}
