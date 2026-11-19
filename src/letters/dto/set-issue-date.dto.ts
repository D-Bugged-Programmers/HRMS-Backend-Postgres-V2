import { ApiProperty } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

export class SetIssueDateDto {
  @ApiProperty({ example: '2026-11-01' })
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Enter the issue date as YYYY-MM-DD.' })
  date!: string;
}

export class NewLetterIssueDto {
  @ApiProperty({ example: '2026-11-01', required: false })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Enter the issue date as YYYY-MM-DD.' })
  date?: string;
}
