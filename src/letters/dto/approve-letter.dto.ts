import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

// The employee approves (accepts) a letter and signs it: the typed name is always required, a drawn signature is optional.
export class ApproveLetterDto {
  @ApiProperty({ description: 'The full name typed as the signature.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  signatureName!: string;

  @ApiPropertyOptional({ description: 'A drawn signature as a PNG data URL.' })
  @IsOptional()
  @IsString()
  @MaxLength(400_000)
  signatureImage?: string;

  @ApiProperty({ description: 'Confirms the employee has read and accepts the letter.' })
  @IsBoolean()
  consent!: boolean;
}

export class DeclineLetterDto {
  @ApiProperty({ maxLength: 1000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
