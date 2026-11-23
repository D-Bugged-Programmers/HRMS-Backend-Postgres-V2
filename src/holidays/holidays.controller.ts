// Purpose: Exposes CRUD for the organization's holiday calendar, plus bulk import.
// Responsibilities: Validates DTOs and delegates all logic to HolidaysService.
// Important: findAll has no @Roles() — any authenticated caller can view the calendar; writes are ADMIN/HR only.
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Role, User } from '@prisma/client';
import { HolidaysService } from './holidays.service';
import { CreateHolidayDto } from './dto/create-holiday.dto';
import { UpdateHolidayDto } from './dto/update-holiday.dto';
import { ListHolidaysQueryDto } from './dto/list-holidays-query.dto';
import { BulkImportHolidaysDto } from './dto/bulk-import-holidays.dto';
import { WeeklyOffCheckQueryDto } from './dto/weekly-off-check-query.dto';
import { SetHolidayYearDto } from './dto/set-holiday-year.dto';
import { AttendanceService } from '../attendance/attendance.service';
import { Roles } from '../common/decorators/roles.decorator';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

type Caller = Omit<User, 'password'>;

@ApiTags('holidays')
@ApiBearerAuth('access-token')
@Controller('holidays')
export class HolidaysController {
  constructor(
    private readonly holidaysService: HolidaysService,
    private readonly attendanceService: AttendanceService,
  ) {}

  // No @Roles() — any authenticated caller can view the holiday calendar.
  @Get()
  findAll(@Query() query: ListHolidaysQueryDto, @CurrentUser() caller: Caller) {
    return this.holidaysService.findAll(query, caller.organizationId);
  }

  // Years that have holidays (the calendar's year picker) and whether next year's calendar still needs filling in.
  @Get('years')
  years(@CurrentUser() caller: Caller) {
    return this.holidaysService.years(caller.organizationId);
  }

  // The month the holiday calendar's year starts in, the current holiday year and its label: any signed-in user (the mobile app and
  // the calendar label their year pickers from it).
  @Get('year-setting')
  yearSetting(@CurrentUser() caller: Caller) {
    return this.holidaysService.yearSetting(caller.organizationId);
  }

  // Admin / HR: choose the month the holiday calendar's year starts in (1 = January).
  @Put('year-setting')
  @UseGuards(RolesGuard)
  @Roles(Role.ADMIN, Role.HR)
  setYearSetting(@Body() dto: SetHolidayYearDto, @CurrentUser() caller: Caller) {
    return this.holidaysService.setYearStartMonth(dto.startMonth, caller.organizationId, caller.id);
  }

  // The company's HOLIDAY years (see holiday-year.ts): the year picker of the Holiday Calendar. /years stays the calendar years.
  @Get('holiday-years')
  holidayYears(@CurrentUser() caller: Caller) {
    return this.holidaysService.holidayYears(caller.organizationId);
  }

  // The company's weekly off days (0 = Sunday), for any signed-in user.
  @Get('weekly-offs')
  weeklyOffs(@CurrentUser() caller: Caller) {
    return this.holidaysService.weeklyOffs(caller.organizationId);
  }

  // For each date: who has it as a weekly off and who works it (department schedules and alternate Saturdays included), for the
  // calendar's "falls on a weekly off" note. Any signed-in user: HR sees every department, others only their own schedule.
  @Get('weekly-off-check')
  weeklyOffCheck(@Query() query: WeeklyOffCheckQueryDto, @CurrentUser() caller: Caller) {
    return this.holidaysService.weeklyOffCheck(query.dates, caller, caller.organizationId);
  }

  @Post('copy')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  copy(@Body() body: { fromYear: number; toYear: number }, @CurrentUser() caller: Caller) {
    return this.holidaysService.copyYear(Number(body.fromYear), Number(body.toYear), caller.organizationId, caller.id);
  }

  @Get('calendar-status')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  calendarStatus(@CurrentUser() caller: Caller) {
    return this.holidaysService.calendarStatus(caller.organizationId);
  }

  @Post()
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  create(@Body() dto: CreateHolidayDto, @CurrentUser() caller: Caller) {
    return this.holidaysService.create(dto, caller.organizationId, caller.id);
  }

  @Post('bulk-import')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  async bulkImport(
    @Body() dto: BulkImportHolidaysDto,
    @CurrentUser() caller: Caller,
  ) {
    const result = await this.holidaysService.bulkImport(
      dto,
      caller.organizationId,
      caller.id,
    );
    // Past-dated holidays are reference holidays that count for attendance: fix the empty Absent rows already on them
    // (open payroll months only). Best-effort - the calendar upload itself has succeeded either way.
    let attendanceFixed = 0;
    if (result.pastReferenceOnly > 0) {
      attendanceFixed = await this.attendanceService
        .applyReferenceHolidays(caller.organizationId, caller.id)
        .then((r) => r.updated)
        .catch(() => 0);
    }
    return { ...result, attendanceFixed };
  }

  @Put(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  update(
    @Param('id') id: string,
    @Body() dto: UpdateHolidayDto,
    @CurrentUser() caller: Caller,
  ) {
    return this.holidaysService.update(
      id,
      dto,
      caller.organizationId,
      caller.id,
    );
  }

  @Delete(':id')
  @Roles(Role.ADMIN, Role.HR)
  @UseGuards(RolesGuard)
  remove(@Param('id') id: string, @CurrentUser() caller: Caller) {
    return this.holidaysService.remove(id, caller.organizationId, caller.id);
  }
}
