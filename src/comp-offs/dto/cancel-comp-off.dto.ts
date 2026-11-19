import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CancelCompOffDto {
  @ApiProperty({
    maxLength: 1000,
    description:
      'Why the approved comp-off is withdrawn; shown to the employee.',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

// The employee withdrawing their own comp-off: the reason is needed once it was approved, optional while it is waiting.
export class WithdrawCompOffDto {
  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
