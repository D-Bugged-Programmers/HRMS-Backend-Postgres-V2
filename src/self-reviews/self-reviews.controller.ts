// Purpose: endpoints for the employee's self-review (/me) and the manager's team list + evaluation.
import { Body, Controller, Get, Param, Patch, Put, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { SelfReviewsService } from './self-reviews.service';
import { SaveSelfReviewDto } from './dto/save-self-review.dto';
import { EvaluateSelfReviewDto } from './dto/evaluate-self-review.dto';
import { TeamSelfReviewsQueryDto } from './dto/team-self-reviews-query.dto';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('self-reviews')
@ApiBearerAuth('access-token')
@Controller('self-reviews')
export class SelfReviewsController {
  constructor(private readonly service: SelfReviewsService) {}

  @Get('me')
  getMine(@CurrentUser() caller: Caller) {
    return this.service.getMine(caller);
  }

  @Put('me')
  saveMine(@Body() dto: SaveSelfReviewDto, @CurrentUser() caller: Caller) {
    return this.service.saveMine(dto, caller);
  }

  @Get('team')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  listTeam(@Query() query: TeamSelfReviewsQueryDto, @CurrentUser() caller: Caller) {
    return this.service.listTeam(caller, query.financialYear);
  }

  @Patch(':id/evaluate')
  @Roles(Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  evaluate(@Param('id') id: string, @Body() dto: EvaluateSelfReviewDto, @CurrentUser() caller: Caller) {
    return this.service.evaluate(id, dto, caller);
  }
}
