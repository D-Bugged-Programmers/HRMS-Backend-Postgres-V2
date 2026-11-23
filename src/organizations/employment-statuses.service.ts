// Purpose: manage the company's list of employment statuses (Organization > People > Employment Statuses).
// Responsibilities: lists the built-in and custom statuses with how many people hold each, adds a custom status, renames a status,
//   switches one on or off, and removes a custom status nobody holds. Owns Organization.employmentStatusConfig.
// Important: the built-in statuses drive every rule, so they can be renamed and (two of them) switched off but never removed; a custom
//   status only FOLLOWS a built-in behaviour (see employment-status-config.ts). Switching a status off never changes anyone who holds it.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditModule, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-log/audit-log.service';
import {
  BUILTIN_STATUS_LABELS,
  MAX_CUSTOM_STATUSES,
  MAX_LABEL_LENGTH,
  SWITCHABLE_BUILTINS,
  buildStatusList,
  newStatusKey,
  readStatusConfig,
  type EmploymentStatusConfig,
  type StatusBehavior,
} from './employment-status-config';

type Actor = { id: string };

@Injectable()
export class EmploymentStatusesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogService: AuditLogService,
  ) {}

  private async getRaw(organizationId: string): Promise<Prisma.JsonValue> {
    const org = await this.prisma.organization.findUnique({ where: { id: organizationId }, select: { employmentStatusConfig: true } });
    if (!org) throw new NotFoundException('Organization not found.');
    return org.employmentStatusConfig;
  }

  private async save(organizationId: string, cfg: EmploymentStatusConfig) {
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { employmentStatusConfig: cfg as unknown as Prisma.InputJsonValue },
    });
  }

  async findAll(organizationId: string) {
    const raw = await this.getRaw(organizationId);
    const [custom, builtIn] = await Promise.all([
      this.prisma.user.groupBy({ by: ['employmentStatusKey'], where: { organizationId, employmentStatusKey: { not: null } }, _count: { _all: true } }),
      this.prisma.user.groupBy({ by: ['employmentStatus'], where: { organizationId, employmentStatusKey: null }, _count: { _all: true } }),
    ]);
    const used = new Map<string, number>([
      ...custom.map((c) => [c.employmentStatusKey as string, c._count._all] as [string, number]),
      ...builtIn.map((b) => [b.employmentStatus as string, b._count._all] as [string, number]),
    ]);
    return buildStatusList(raw).map((s) => ({ ...s, employeeCount: used.get(s.key) ?? 0 }));
  }

  private cleanLabel(label: string): string {
    const trimmed = label.trim();
    if (!trimmed) throw new BadRequestException('Enter a name for the status.');
    if (trimmed.length > MAX_LABEL_LENGTH) throw new BadRequestException(`The name can be at most ${MAX_LABEL_LENGTH} characters.`);
    return trimmed;
  }

  private assertNameFree(raw: Prisma.JsonValue, label: string, exceptKey?: string) {
    const clash = buildStatusList(raw).find((s) => s.key !== exceptKey && s.label.toLowerCase() === label.toLowerCase());
    if (clash) throw new ConflictException(`A status called "${clash.label}" already exists.`);
  }

  async create(label: string, behavior: StatusBehavior, organizationId: string, actor: Actor) {
    const name = this.cleanLabel(label);
    const raw = await this.getRaw(organizationId);
    const cfg = readStatusConfig(raw);
    if (cfg.custom.length >= MAX_CUSTOM_STATUSES) throw new BadRequestException(`You can add up to ${MAX_CUSTOM_STATUSES} statuses of your own.`);
    this.assertNameFree(raw, name);
    const key = newStatusKey(name, cfg.custom.map((c) => c.key));
    cfg.custom.push({ key, label: name, behavior, isActive: true });
    await this.save(organizationId, cfg);
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'EMPLOYMENT_STATUS_CREATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      details: { key, label: name, behavior },
    });
    return this.findAll(organizationId);
  }

  async update(key: string, dto: { label?: string; isActive?: boolean }, organizationId: string, actor: Actor) {
    const raw = await this.getRaw(organizationId);
    const cfg = readStatusConfig(raw);
    const custom = cfg.custom.find((c) => c.key === key);
    const isBuiltin = key in BUILTIN_STATUS_LABELS && key !== 'NOTICE_PERIOD';
    if (!custom && !isBuiltin) throw new NotFoundException('That employment status does not exist.');

    if (dto.label !== undefined) {
      if (custom) {
        const name = this.cleanLabel(dto.label);
        this.assertNameFree(raw, name, key);
        custom.label = name;
      } else if (dto.label.trim() === '') {
        delete cfg.labels[key];
      } else {
        const name = this.cleanLabel(dto.label);
        this.assertNameFree(raw, name, key);
        cfg.labels[key] = name;
      }
    }
    if (dto.isActive !== undefined) {
      if (custom) custom.isActive = dto.isActive;
      else if (!SWITCHABLE_BUILTINS.includes(key)) {
        throw new BadRequestException(`${cfg.labels[key] ?? BUILTIN_STATUS_LABELS[key]} is used by the system and cannot be switched off.`);
      } else {
        cfg.inactive = dto.isActive ? cfg.inactive.filter((k) => k !== key) : [...new Set([...cfg.inactive, key])];
      }
    }
    await this.save(organizationId, cfg);
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'EMPLOYMENT_STATUS_UPDATED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      details: { key, ...(dto.label !== undefined && { label: dto.label.trim() }), ...(dto.isActive !== undefined && { isActive: dto.isActive }) },
    });
    return this.findAll(organizationId);
  }

  async delete(key: string, organizationId: string, actor: Actor) {
    const raw = await this.getRaw(organizationId);
    const cfg = readStatusConfig(raw);
    const custom = cfg.custom.find((c) => c.key === key);
    if (!custom) {
      if (key in BUILTIN_STATUS_LABELS) throw new BadRequestException('Built-in statuses cannot be removed.');
      throw new NotFoundException('That employment status does not exist.');
    }
    const holders = await this.prisma.user.count({ where: { organizationId, employmentStatusKey: key } });
    if (holders > 0) {
      throw new ConflictException(`${holders} ${holders === 1 ? 'person has' : 'people have'} this status. Move them to another status first, or switch it off instead.`);
    }
    cfg.custom = cfg.custom.filter((c) => c.key !== key);
    await this.save(organizationId, cfg);
    await this.auditLogService.log({
      actorId: actor.id,
      action: 'EMPLOYMENT_STATUS_DELETED',
      module: AuditModule.ORGANIZATION,
      organizationId,
      details: { key, label: custom.label },
    });
    return this.findAll(organizationId);
  }
}
