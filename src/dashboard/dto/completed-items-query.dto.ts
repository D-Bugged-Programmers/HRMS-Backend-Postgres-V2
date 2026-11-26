// Purpose: Query for GET /dashboard/completed-items - which decided requests to list, and which page.
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { MAX_PAGE_SIZE } from '../pending-page';

export const COMPLETED_ITEM_TYPES = ['ALL', 'LEAVE', 'REGULARIZATION', 'WFH', 'OVERTIME', 'COMP_OFF', 'REIMBURSEMENT'] as const;
export type CompletedItemType = (typeof COMPLETED_ITEM_TYPES)[number];
export const COMPLETED_DECISIONS = ['ALL', 'APPROVED', 'REJECTED'] as const;
export type CompletedDecision = (typeof COMPLETED_DECISIONS)[number];

export class CompletedItemsQueryDto {
  @ApiPropertyOptional({ enum: COMPLETED_ITEM_TYPES, description: 'One kind of request, or ALL (default).' })
  @IsOptional()
  @IsIn(COMPLETED_ITEM_TYPES)
  type?: CompletedItemType;

  @ApiPropertyOptional({ enum: COMPLETED_DECISIONS, description: 'Only approved or only rejected ones. Default ALL.' })
  @IsOptional()
  @IsIn(COMPLETED_DECISIONS)
  decision?: CompletedDecision;

  @ApiPropertyOptional({ description: 'How many to skip (most recently decided first). Default 0.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @ApiPropertyOptional({ description: `Page size, default 20, at most ${MAX_PAGE_SIZE}.` })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  limit?: number;
}
