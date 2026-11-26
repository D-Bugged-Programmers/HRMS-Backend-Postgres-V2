import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { IsFinancialYear } from '../../common/is-financial-year.validator';

export class TeamSelfReviewsQueryDto {
  @ApiPropertyOptional({ example: '2026-27', description: 'Defaults to the current financial year' })
  @IsOptional()
  @IsFinancialYear({ message: 'Financial year must look like 2026-27.' })
  financialYear?: string;
}
