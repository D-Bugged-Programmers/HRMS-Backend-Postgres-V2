// Purpose: Exposes letter generation as a PDF download, mounted at /employees/:id/letters/:key — key is a
//   LetterTemplate's key (see letter-templates module), not a fixed set: any active template, built-in or
//   admin-created custom, is downloadable here. Also exposes :key/content — GET returns the same title/body
//   as plain editable text (for the Send modal's edit step), PUT saves an edit as this employee's new
//   default (a LetterOverride — Download and future Sends then use it too), DELETE clears it back to the
//   template's own rendering — and :key/send, which generates the PDF (using a per-request title/body if
//   given, else the saved override if any, else the template) and emails it. See LettersService.
// Important: Self-or-role scoped (self, or ADMIN/HR/MANAGER — MANAGER further restricted to own
//   department in the service), same pattern as /employees/:id/timeline. :key/content and :key/send are
//   narrower — ADMIN/HR only, not self or MANAGER: emailing someone official correspondence (and editing
//   it beforehand) is an HR action, not something an employee (who can already download their own copy)
//   or a department head needs to do.
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Req,
  Query,
  Patch,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role, User } from '@prisma/client';
import { LettersService } from './letters.service';
import { SendLetterDto } from './dto/send-letter.dto';
import { SetIssueDateDto, NewLetterIssueDto } from './dto/set-issue-date.dto';
import { ApproveLetterDto, DeclineLetterDto } from './dto/approve-letter.dto';
import { SaveLetterContentDto } from './dto/save-letter-content.dto';
import { SetLetterAccessDto } from './dto/set-letter-access.dto';
import { SelfOrRoles } from '../common/decorators/self-or-roles.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { EXPENSIVE_OP_THROTTLE_LIMIT } from '../common/throttle.constants';

type Caller = Omit<User, 'password'>;

// The directory's Letters column: where every employee is in their letters (Admin / HR).
@ApiTags('letters')
@ApiBearerAuth('access-token')
@Controller('letters')
export class LettersOverviewController {
  constructor(private readonly lettersService: LettersService) {}

  @Get('overview')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  overview(@CurrentUser() caller: Caller) {
    return this.lettersService.overview(caller.organizationId);
  }
}

@ApiTags('letters')
@ApiBearerAuth('access-token')
@Controller('employees/:id/letters')
export class LettersController {
  constructor(private readonly lettersService: LettersService) {}

  // Must be declared before ':key' — Nest matches routes in registration
  // order, and ':key' would otherwise swallow this literal path.
  @Get()
  @SelfOrRoles('id', Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  async list(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.lettersService.listForEmployee(
      id,
      caller,
      caller.organizationId,
    );
  }

  @Get(':key')
  @SelfOrRoles('id', Role.ADMIN, Role.HR, Role.MANAGER)
  @UseGuards(RolesGuard)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  async generate(
    @Param('id') id: string,
    @Param('key') key: string,
    @CurrentUser() caller: Caller,
    @Res() res: Response,
    // ?reissue=true: HR/Admin issue the letter afresh, with today's date and a new document number.
    @Query('reissue') reissue?: string,
  ) {
    const { buffer, filename } = await this.lettersService.generate(
      id,
      key,
      caller,
      caller.organizationId,
      undefined,
      undefined,
      reissue === 'true',
    );
    res.setHeader('Content-Type', 'application/pdf');
    // Quoted (the name has spaces) plus the UTF-8 form for names that are not plain ASCII.
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.send(buffer);
  }

  // Text-only counterpart to :key — same rendered title/body, no PDF, no
  // document number issued — used to seed the Send modal's editable
  // Title/Body fields before HR decides whether to change anything.
  @Get(':key/content')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async previewContent(
    @Param('id') id: string,
    @Param('key') key: string,
    @CurrentUser() caller: Caller,
  ) {
    return this.lettersService.previewContent(
      id,
      key,
      caller,
      caller.organizationId,
    );
  }

  // Saves HR's edited title/body as this employee's new default for this
  // letter key — Download and every future unedited Send pick it up from
  // here on, until DELETE :key/content resets it.
  @Put(':key/content')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async saveContent(
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() dto: SaveLetterContentDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.lettersService.saveOverride(
      id,
      key,
      caller,
      caller.organizationId,
      {
        title: dto.title,
        body: dto.body,
      },
    );
  }

  // Clears a saved override — Download/Send fall back to the template's
  // own rendering again. Not a 404 when nothing was saved.
  @Delete(':key/content')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async resetContent(
    @Param('id') id: string,
    @Param('key') key: string,
    @CurrentUser() caller: Caller,
  ) {
    return this.lettersService.resetOverride(
      id,
      key,
      caller,
      caller.organizationId,
    );
  }

  // Grants/revokes one employee's self-service visibility for one of the
  // small set of restricted (disciplinary) letter keys — see
  // RESTRICTED_LETTER_KEYS in letters.service.ts. HR/Admin only, same as
  // :key/content and :key/send.
  @Patch(':key/access')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async setAccess(
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() dto: SetLetterAccessDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.lettersService.setEmployeeAccess(
      id,
      key,
      dto.enabled,
      caller,
      caller.organizationId,
    );
  }

  // Switch a whole stage (HIRING, PROBATION, EMPLOYMENT, DISCIPLINARY, EXIT) on or off for the employee at once.
  @Patch('stage/:stage/access')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async setStageAccess(
    @Param('id') id: string,
    @Param('stage') stage: string,
    @Body() dto: SetLetterAccessDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.lettersService.setStageAccess(id, stage, dto.enabled, caller, caller.organizationId);
  }

  @Patch(':key/issue-date')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async setIssueDate(
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() dto: SetIssueDateDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.lettersService.setIssueDate(id, key, dto.date, caller, caller.organizationId);
  }

  @Post(':key/send')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  @Throttle({ default: { limit: EXPENSIVE_OP_THROTTLE_LIMIT, ttl: 60_000 } })
  async send(
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() dto: SendLetterDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.lettersService.send(id, key, caller, caller.organizationId, {
      title: dto.title,
      body: dto.body,
    }, undefined, dto.makeVisible === true);
  }

  // Start another issue of a letter that can be issued again (increment, promotion, warning...).
  @Post(':key/new')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async newIssue(@Param('id') id: string, @Param('key') key: string, @Body() dto: NewLetterIssueDto, @CurrentUser() caller: Caller) {
    return this.lettersService.newOccurrence(id, key, caller, caller.organizationId, dto.date);
  }

  // The employee approves (accepts) their letter and signs it in the app; from then on it is final.
  @Post(':key/approve')
  async approve(
    @Param('id') id: string,
    @Param('key') key: string,
    @Body() dto: ApproveLetterDto,
    @CurrentUser() caller: Caller,
    @Req() req: Request,
  ) {
    return this.lettersService.approve(id, key, dto, caller, caller.organizationId, {
      ip: req.ip ?? null,
      device: (req.headers['user-agent'] as string | undefined) ?? null,
    });
  }

  // The employee declines their letter with a reason.
  @Post(':key/decline')
  async decline(@Param('id') id: string, @Param('key') key: string, @Body() dto: DeclineLetterDto, @CurrentUser() caller: Caller) {
    return this.lettersService.decline(id, key, dto.reason, caller, caller.organizationId);
  }

  // HR/Admin correct an approved or declined letter: a new version starts and the old one is kept as the record.
  @Post(':key/version')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async newVersion(@Param('id') id: string, @Param('key') key: string, @CurrentUser() caller: Caller) {
    return this.lettersService.newVersion(id, key, caller, caller.organizationId);
  }

  // The employee confirms they received and read their own letter.
  @Post(':key/acknowledge')
  async acknowledge(
    @Param('id') id: string,
    @Param('key') key: string,
    @CurrentUser() caller: Caller,
  ) {
    return this.lettersService.acknowledge(id, key, caller, caller.organizationId);
  }

  // Who did what to this letter (HR/Admin); the employee sees only issued / emailed / confirmed for their own switched-on letter.
  @Get(':key/history')
  @SelfOrRoles('id', Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async history(@Param('id') id: string, @Param('key') key: string, @CurrentUser() caller: Caller) {
    return this.lettersService.history(id, key, caller, caller.organizationId);
  }
}
