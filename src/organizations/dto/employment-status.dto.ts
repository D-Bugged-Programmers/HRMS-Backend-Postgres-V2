import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { NoMarkup } from '../../common/decorators/no-markup.decorator';
import { MAX_LABEL_LENGTH, STATUS_BEHAVIORS } from '../employment-status-config';

export class CreateEmploymentStatusDto {
  @ApiProperty({ example: 'Sabbatical' })
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_LABEL_LENGTH)
  @NoMarkup('Name')
  label!: string;

  @ApiProperty({ enum: STATUS_BEHAVIORS, description: 'Working behaves like Confirmed, Paused like On Hold.' })
  @IsIn(STATUS_BEHAVIORS)
  behavior!: 'WORKING' | 'PAUSED';
}

export class UpdateEmploymentStatusDto {
  @ApiPropertyOptional({ description: 'The name shown for this status. Empty text on a built-in status restores its standard name.' })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_LABEL_LENGTH)
  @NoMarkup('Name')
  label?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
