import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

// Switch every email template on, or every one off - or only those of one category (the chips on the Email Templates page).
export class SetAllEmailTemplatesActiveDto {
  @ApiProperty()
  @IsBoolean()
  isActive!: boolean;

  @ApiPropertyOptional({ description: 'Only the templates of this category; omitted = all of them.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;
}
