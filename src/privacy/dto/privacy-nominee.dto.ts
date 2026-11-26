import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';

export class SavePrivacyNomineeDto {
  @ApiProperty() @IsString() @MinLength(1) @MaxLength(150) name!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(100) relationship?: string;
  // Blank means "no email"; anything else must be an address.
  @ApiPropertyOptional() @ValidateIf((o: SavePrivacyNomineeDto) => o.email !== undefined && o.email !== null && o.email !== '') @IsEmail() @MaxLength(200) email?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(30) phone?: string;
}
