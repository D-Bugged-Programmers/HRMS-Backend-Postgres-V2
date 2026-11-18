import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class SaveSelfReviewDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) proud?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) grow?: string;
  @ApiProperty({ description: '1-5' }) @IsInt() @Min(1) @Max(5) selfRating!: number;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(2000) impact?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(1000) support?: string;
}
