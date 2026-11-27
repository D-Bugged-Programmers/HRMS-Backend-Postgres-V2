// Purpose: The one-page "Salary Structure" document - company letterhead, who it is for, and the CTC breakdown.
// Responsibilities: reads the employee's salary structure as of a date, builds the same breakdown the Salary Details
//   screen shows, and renders it as a PDF. Used by the Print button on the web, the PDF download on mobile, and as the
//   attachment mailed to the employee after a salary revision.
// Important: it states what is on the structure, so the person asking must already be allowed to see it (the
//   controller gates that); nothing here checks the caller.
import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import PDFDocument from 'pdfkit';
import * as path from 'path';
import { BrandingLookupService } from '../company-brands/branding-lookup.service';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { readStoredFile } from '../files/file-storage.config';
import { attachWatermark } from '../common/pdf-watermark';
import { FONTS_DIR, ROBOTO_FILES } from '../common/fonts-dir';
import { todayInOrgTz } from '../common/org-date';
import {
  breakdownStructure,
  resolveCurrentRows,
  synthesizeMissingRows,
  type StructureBreakdown,
} from './salary-structure-math';
import { withCityHra } from './city-hra';
import { PayrollSettingsService } from '../payroll-settings/payroll-settings.service';
import { StatutoryConfigService } from '../statutory-config/statutory-config.service';
import { applyStatutoryOverrides, type EffectiveConfigsByModule } from '../payroll/statutory-overlay';
import { employeeContributionLinesForStructure, employerLinesForStructure } from '../payroll/structure-preview';
import { hasDisability, npsProfileOf } from '../payroll/formula-context';
import { effectiveWorkLocation } from '../common/effective-work-location';
import { Prisma, StatutoryModule } from '@prisma/client';
import type { CityClassName } from '../common/hra-cities';
import { EMPLOYEE_ORDER_BY } from '../common/employee-order';
import type { ReportColumn } from '../reports/report-export';
import type { ReportPayload } from '../reports/reports.service';

const STRUCTURE_COMPONENT_SELECT = {
  name: true,
  type: true,
  payFrequency: true,
  isEmployerContribution: true,
  displayOrder: true,
} satisfies Prisma.SalaryComponentSelect;

type StructureRow = Prisma.EmployeeSalaryComponentGetPayload<{
  include: { component: { select: typeof STRUCTURE_COMPONENT_SELECT } };
}>;
type Location = { state: string | null; cityClass: string | null } | null;
interface StructureEmployee {
  gender: Prisma.UserGetPayload<{ select: { gender: true } }>['gender'];
  personalData: Prisma.JsonValue;
  workLocation?: Location;
  department?: { workLocation?: Location } | null;
}
type ContributionLine = { code: string; name: string; amount: number; notApplicable?: boolean };
interface SharedInputs {
  components: Prisma.SalaryComponentGetPayload<object>[];
  settings: ReturnType<typeof applyStatutoryOverrides>;
}
interface StructureFigures {
  breakdown: StructureBreakdown;
  employeeLines: ContributionLine[];
  employerLines: ContributionLine[];
}

const PAGE_W = 595.28; // A4 portrait, points
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;
const INK_900 = '#14161d';
const INK_600 = '#4c5262';
const BORDER = '#cfd4dc';
const SHADE = '#f1f3f7';
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export interface SalaryStructureDocInput {
  companyName: string;
  companyAddress: string;
  companyLogoBuffer: Buffer | null;
  watermarkEnabled: boolean;
  employeeName: string;
  employeeCode: string;
  designation: string;
  joiningDate: string;
  effectiveFrom: string;
  breakdown: StructureBreakdown;
  // The employee's own PF / ESI / PT (deducted from pay) and what the company pays on top, as the Salary Details screen lists them.
  // `notApplicable` lines are PF / ESI the company has on that are nil for this person.
  employeeLines?: { code: string; name: string; amount: number; notApplicable?: boolean }[];
  employerLines?: { code: string; name: string; amount: number; notApplicable?: boolean }[];
}

const inr = (n: number) =>
  `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// "2026-04-01" -> "April, 2026"
export function monthYear(iso: string | null): string {
  if (!iso) return '-';
  const [y, m] = iso.slice(0, 10).split('-');
  const idx = Number(m) - 1;
  return MONTHS[idx] ? `${MONTHS[idx]}, ${y}` : iso;
}

// "2024-10-23" -> "23/10/2024"
function dmy(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-');
  return y && m && d ? `${d}/${m}/${y}` : iso;
}

export function renderSalaryStructurePdf(
  input: SalaryStructureDocInput,
): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ margin: MARGIN, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    // Roboto, not the built-in Helvetica: Helvetica has no ₹ glyph.
    doc.registerFont('SS-Regular', path.join(FONTS_DIR, ROBOTO_FILES.regular));
    doc.registerFont('SS-Bold', path.join(FONTS_DIR, ROBOTO_FILES.bold));
    if (input.watermarkEnabled) attachWatermark(doc, input.companyLogoBuffer);

    // Letterhead: name and address left, logo right.
    const top = 36;
    const logoSize = 56;
    const textW = CONTENT_W - (input.companyLogoBuffer ? logoSize + 16 : 0);
    doc.font('SS-Bold').fontSize(15).fillColor(INK_900);
    doc.text(input.companyName, MARGIN, top, { width: textW });
    if (input.companyAddress) {
      doc.font('SS-Regular').fontSize(9).fillColor(INK_600);
      doc.text(input.companyAddress, MARGIN, doc.y + 2, { width: textW });
    }
    if (input.companyLogoBuffer) {
      try {
        doc.image(
          input.companyLogoBuffer,
          MARGIN + CONTENT_W - logoSize,
          top - 4,
          { fit: [logoSize, logoSize] },
        );
      } catch {
        // an unsupported image (an SVG logo) - the document stands without it
      }
    }
    let y = Math.max(doc.y, top + logoSize) + 12;
    doc
      .moveTo(MARGIN, y)
      .lineTo(MARGIN + CONTENT_W, y)
      .strokeColor(BORDER)
      .stroke();
    y += 22;

    doc.font('SS-Bold').fontSize(18).fillColor(INK_900);
    doc.text('SALARY STRUCTURE', MARGIN, y, { width: CONTENT_W });
    y = doc.y + 16;

    // Who it is for: four labelled values across the page.
    const cols = [
      {
        label: 'Employee Name',
        value: `${input.employeeName}, ${input.employeeCode}`,
        w: 165,
      },
      { label: 'Designation', value: input.designation || '-', w: 150 },
      { label: 'Date of Joining', value: dmy(input.joiningDate), w: 85 },
      {
        label: 'Salary Effective From',
        value: monthYear(input.effectiveFrom),
        w: 0,
      },
    ];
    cols[3].w = CONTENT_W - cols[0].w - cols[1].w - cols[2].w;
    let x = MARGIN;
    let rowBottom = y;
    for (const c of cols) {
      doc.font('SS-Regular').fontSize(9).fillColor(INK_600);
      doc.text(c.label, x, y, { width: c.w - 8 });
      doc.font('SS-Bold').fontSize(10.5).fillColor(INK_900);
      doc.text(c.value, x, doc.y + 2, { width: c.w - 8 });
      rowBottom = Math.max(rowBottom, doc.y);
      x += c.w;
    }
    y = rowBottom + 18;

    // The structure: three summary figures, then one block per part (earnings, your contributions, employer contributions,
    // variable pay) with its own total, and the Total CTC bar. Green is pay, red is taken from pay.
    const GREEN = '#17803d';
    const RED = '#b42318';
    const BAND = '#eef0f5';
    const TINT = '#e8eefb';
    const TINT_BORDER = '#b8c7ea';
    const colA = CONTENT_W * 0.5;
    const colB = CONTENT_W * 0.25;
    const colC = CONTENT_W * 0.25;
    const PAD = 12;
    const rowH = 25;
    const pageBottom = () => doc.page.height - MARGIN - 20;
    const ensureRoom = (needed: number) => {
      if (y + needed > pageBottom()) {
        doc.addPage();
        y = MARGIN;
      }
    };
    const hairline = (yy: number) =>
      doc.moveTo(MARGIN, yy).lineTo(MARGIN + CONTENT_W, yy).lineWidth(0.5).strokeColor(BORDER).stroke();

    const b = input.breakdown;
    const employeeLines = input.employeeLines ?? [];
    const employerLines = input.employerLines ?? [];
    const sum = (ls: { amount: number }[]) => ls.reduce((t, l) => t + l.amount, 0);
    const employerMonthly = sum(employerLines);
    const deductionsMonthly = sum(employeeLines);
    const takeHome = b.fixedMonthly - deductionsMonthly;

    // Summary figures.
    const tiles: { label: string; value: string; note: string; color: string; fill: string }[] = [
      { label: 'TOTAL CTC', value: inr(b.annualCTC + employerMonthly * 12), note: 'per year', color: INK_900, fill: '#ffffff' },
      { label: 'FIXED PAY', value: inr(b.fixedMonthly), note: 'per month', color: INK_900, fill: '#ffffff' },
    ];
    if (employeeLines.length > 0) {
      tiles.push({ label: 'TAKE-HOME PAY', value: inr(takeHome), note: 'per month, a full month', color: GREEN, fill: TINT });
    }
    const gap = 10;
    const tileW = (CONTENT_W - gap * (tiles.length - 1)) / tiles.length;
    const tileH = 58;
    ensureRoom(tileH + 16);
    tiles.forEach((t, i) => {
      const tx = MARGIN + i * (tileW + gap);
      doc.roundedRect(tx, y, tileW, tileH, 6).fillAndStroke(t.fill, t.fill === '#ffffff' ? BORDER : TINT_BORDER);
      doc.font('SS-Regular').fontSize(8).fillColor(INK_600).text(t.label, tx + 12, y + 10, { width: tileW - 24, characterSpacing: 0.6 });
      doc.font('SS-Bold').fontSize(15).fillColor(t.color).text(t.value, tx + 12, y + 23, { width: tileW - 24 });
      doc.font('SS-Regular').fontSize(8).fillColor(INK_600).text(t.note, tx + 12, y + 43, { width: tileW - 24 });
    });
    y += tileH + 16;

    // One block of the structure.
    const section = (
      title: string,
      note: string,
      total: { monthly: string; annual?: string; color: string } | null,
    ) => {
      const h = 40;
      ensureRoom(h + rowH * 2);
      doc.rect(MARGIN, y, CONTENT_W, h).fill(BAND);
      doc.font('SS-Bold').fontSize(10).fillColor(INK_900).text(title.toUpperCase(), MARGIN + PAD, y + 8, { width: colA - PAD, characterSpacing: 0.4 });
      doc.font('SS-Regular').fontSize(8).fillColor(INK_600).text(note, MARGIN + PAD, y + 22, { width: colA + colB - PAD * 2 });
      if (total) {
        doc.font('SS-Bold').fontSize(11).fillColor(total.color).text(total.monthly, MARGIN + colA, y + 9, { width: colB - PAD, align: 'right' });
        if (total.annual) doc.font('SS-Regular').fontSize(8.5).fillColor(INK_600).text(total.annual, MARGIN + colA + colB, y + 11, { width: colC - PAD, align: 'right' });
      }
      y += h;
      // column labels
      doc.font('SS-Regular').fontSize(7.5).fillColor(INK_600);
      doc.text('COMPONENT', MARGIN + PAD, y + 7, { width: colA - PAD * 2, characterSpacing: 0.4 });
      doc.text('MONTHLY', MARGIN + colA, y + 7, { width: colB - PAD, align: 'right', characterSpacing: 0.4 });
      doc.text('ANNUAL', MARGIN + colA + colB, y + 7, { width: colC - PAD, align: 'right', characterSpacing: 0.4 });
      y += 20;
      hairline(y);
    };
    const row = (label: string, monthly: string, annual: string, opts: { color?: string; sub?: string | null; muted?: boolean } = {}) => {
      const h = opts.sub ? rowH + 10 : rowH;
      ensureRoom(h);
      doc.font('SS-Regular').fontSize(10.5).fillColor(opts.muted ? INK_600 : INK_900).text(label, MARGIN + PAD, y + 7, { width: colA - PAD * 2 });
      if (opts.sub) doc.font('SS-Regular').fontSize(8.5).fillColor(INK_600).text(opts.sub, MARGIN + PAD, doc.y + 1, { width: colA - PAD * 2 });
      doc.font('SS-Bold').fontSize(10.5).fillColor(opts.muted ? INK_600 : opts.color ?? INK_900).text(monthly, MARGIN + colA, y + 7, { width: colB - PAD, align: 'right' });
      doc.font('SS-Regular').fontSize(10.5).fillColor(opts.muted ? INK_600 : opts.color ?? INK_900).text(annual, MARGIN + colA + colB, y + 7, { width: colC - PAD, align: 'right' });
      y += h;
      hairline(y);
    };

    // Earnings
    section('Earnings', 'Your fixed pay, paid every month', { monthly: inr(b.fixedMonthly), annual: `${inr(b.fixedAnnual)} / year`, color: GREEN });
    for (const e of b.earnings.filter((x) => x.monthly !== 0 || x.annual !== 0)) {
      row(e.name, inr(e.monthly), inr(e.annual), { color: GREEN, sub: e.basis });
    }
    y += 14;

    if (employeeLines.length > 0) {
      section('Your contributions', 'Deducted from your pay each month (not part of the CTC)', {
        monthly: inr(deductionsMonthly),
        annual: `${inr(deductionsMonthly * 12)} / year`,
        color: RED,
      });
      for (const l of employeeLines) {
        if (l.notApplicable) row(l.name, 'Not applicable', '-', { muted: true });
        else row(l.name, inr(l.amount), inr(l.amount * 12), { color: RED });
      }
      y += 14;
    }

    if (employerLines.length > 0) {
      section('Employer contributions', 'Paid by the company on top of your pay (part of the CTC)', {
        monthly: inr(employerMonthly),
        annual: `${inr(employerMonthly * 12)} / year`,
        color: INK_900,
      });
      for (const l of employerLines) {
        if (l.notApplicable) row(l.name, 'Not applicable', '-', { muted: true });
        else row(l.name, inr(l.amount), inr(l.amount * 12));
      }
      y += 14;
    }

    const extras = [...b.variable, ...b.oneTime];
    if (extras.length > 0) {
      section('Variable & one-time pay', 'Not paid every month', { monthly: '', annual: `${inr(b.variableAnnual + b.oneTimeAnnual)} / year`, color: INK_900 });
      for (const v of extras) {
        row(/variable/i.test(v.name) ? v.name : `${v.name} (Variable)`, '', inr(v.annual));
      }
      y += 14;
    }

    // Total CTC bar
    const barH = 44;
    ensureRoom(barH);
    doc.roundedRect(MARGIN, y, CONTENT_W, barH, 6).fillAndStroke(TINT, TINT_BORDER);
    doc.font('SS-Bold').fontSize(12).fillColor(INK_900).text('TOTAL CTC', MARGIN + PAD, y + 15, { width: colA - PAD, characterSpacing: 0.4 });
    doc.font('SS-Regular').fontSize(7.5).fillColor(INK_600).text('MONTHLY', MARGIN + colA, y + 8, { width: colB - PAD, align: 'right', characterSpacing: 0.4 });
    doc.font('SS-Bold').fontSize(12).fillColor(INK_900).text(inr(b.fixedMonthly + employerMonthly), MARGIN + colA, y + 21, { width: colB - PAD, align: 'right' });
    doc.font('SS-Regular').fontSize(7.5).fillColor(INK_600).text('ANNUAL', MARGIN + colA + colB, y + 8, { width: colC - PAD, align: 'right', characterSpacing: 0.4 });
    doc.font('SS-Bold').fontSize(12).fillColor(INK_900).text(inr(b.annualCTC + employerMonthly * 12), MARGIN + colA + colB, y + 21, { width: colC - PAD, align: 'right' });
    y += barH;

    doc.end();
  });
}

@Injectable()
export class SalaryStructurePdfService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly scopedPrisma: ExtendedPrismaClient,
    private readonly brandingLookup: BrandingLookupService,
    private readonly payrollSettingsService: PayrollSettingsService,
    private readonly statutoryConfigService: StatutoryConfigService,
  ) {}

  async build(
    employeeId: string,
    organizationId: string,
    asOfParam?: string,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const [org, employee] = await Promise.all([
      this.scopedPrisma.organization.findFirst({
        where: { id: organizationId },
        select: {
          companyName: true,
          registeredAddress: true,
          companyLogoUrl: true,
          watermarkLogo: true,
          timezone: true,
        },
      }),
      this.scopedPrisma.user.findFirst({
        where: { id: employeeId, organizationId },
        select: {
          name: true,
          employeeId: true,
          designation: true,
          joiningDate: true,
          brandId: true,
          gender: true,
          personalData: true,
          workLocation: { select: { state: true, cityClass: true } },
          department: { select: { workLocation: { select: { state: true, cityClass: true } } } },
        },
      }),
    ]);
    if (!employee) throw new NotFoundException('Employee not found.');
    const asOf = asOfParam ?? todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');

    const shared = await this.loadShared(organizationId, asOf);
    const rows = await this.scopedPrisma.employeeSalaryComponent.findMany({
      where: { organizationId, employeeId },
      include: { component: { select: STRUCTURE_COMPONENT_SELECT } },
    });
    const figures = this.figuresFor(employee, rows, asOf, shared);
    if (!figures) {
      throw new BadRequestException(
        'This employee has no salary structure on file yet.',
      );
    }
    const { breakdown, employeeLines, employerLines } = figures;
    // A sister company's salary structure carries its brand's name, address and logo; no brand keeps the organization's own.
    const branding = employee.brandId ? await this.brandingLookup.forBrand(organizationId, employee.brandId) : null;
    const logoKey = branding?.brandId ? branding.logoUrl : org?.companyLogoUrl;
    const logo = logoKey
      ? await readStoredFile(logoKey).catch(() => null)
      : null;
    const buffer = await renderSalaryStructurePdf({
      companyName: branding?.brandId ? branding.companyName : org?.companyName || 'the Company',
      companyAddress: (branding?.brandId ? branding.address : org?.registeredAddress) || '',
      companyLogoBuffer: logo,
      watermarkEnabled: !!org?.watermarkLogo,
      employeeName: employee.name,
      employeeCode: employee.employeeId,
      designation: employee.designation || '',
      joiningDate: employee.joiningDate
        ? new Date(employee.joiningDate).toISOString().slice(0, 10)
        : '',
      effectiveFrom: breakdown.effectiveFrom ?? asOf,
      breakdown,
      employeeLines,
      employerLines,
    });
    const filename = `${`${employee.employeeId}-Salary Structure`
      .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()}.pdf`;
    return { buffer, filename };
  }

  // What every employee's structure is worked out against on a date: the active components and the PF / ESI / PT / NPS
  // settings in force then. Read once, so the bulk report does not reload them per person.
  private async loadShared(organizationId: string, asOf: string): Promise<SharedInputs> {
    const components = await this.scopedPrisma.salaryComponent.findMany({
      where: { organizationId, isActive: true },
    });
    const settingsRow = await this.payrollSettingsService.getOrCreate(organizationId);
    const effectiveConfigs: EffectiveConfigsByModule = {};
    for (const statutoryModule of Object.values(StatutoryModule)) {
      const { version } = await this.statutoryConfigService.getEffective(statutoryModule, asOf, organizationId);
      if (version) effectiveConfigs[statutoryModule] = { config: version.config, isEnabled: version.isEnabled };
    }
    return { components, settings: applyStatutoryOverrides(settingsRow, effectiveConfigs) };
  }

  // One employee's structure on a date (the same figures the Salary Details screen and the printed document show), or
  // null when they have none on file.
  private figuresFor(
    employee: StructureEmployee,
    rows: StructureRow[],
    asOf: string,
    shared: SharedInputs,
  ): StructureFigures | null {
    const { components, settings } = shared;
    const withRef = rows.map((r) => ({ ...r, componentRef: r.component }));
    const nameByCode = Object.fromEntries(components.map((c) => [c.code, c.name]));
    const current = resolveCurrentRows(withRef, asOf);
    const location = effectiveWorkLocation(employee);
    const structureComponents = withCityHra(components, (location?.cityClass as CityClassName | null | undefined) || 'NON_METRO');
    const synthesized = synthesizeMissingRows(withRef, structureComponents, asOf);
    const breakdown = breakdownStructure([...current, ...synthesized], nameByCode);
    if (breakdown.annualCTC <= 0) return null;
    const saved = current.map((r) => ({
      componentCode: r.componentCode,
      valueType: r.valueType,
      fixedAmount: r.fixedAmount,
      percentageValue: r.percentageValue,
      percentageOf: r.percentageOf,
      amountBasis: r.amountBasis,
      isEnabled: r.isEnabled,
    }));
    const profile = {
      state: location?.state ?? null,
      gender: employee.gender ?? null,
      disabled: hasDisability(employee.personalData),
      nps: npsProfileOf(employee.personalData),
    };
    const shownLines = (
      lines: { code: string; name: string; amount: number }[],
      codes: string[],
      employer: boolean,
    ) => [
      ...lines,
      ...codes
        .map((code) => components.find((c) => c.code === code && !!c.isEmployerContribution === employer))
        .filter((c): c is (typeof components)[number] => !!c && !lines.some((l) => l.code === c.code))
        .map((c) => ({ code: c.code, name: c.name, amount: 0, notApplicable: true })),
    ];
    return {
      breakdown,
      employeeLines: shownLines(
        employeeContributionLinesForStructure({ components: structureComponents, settings, rows: saved, profile }),
        ['PF', 'ESI'],
        false,
      ),
      employerLines: shownLines(
        employerLinesForStructure({ components: structureComponents, settings, rows: saved, profile }),
        ['PF_EMPLOYER', 'ESI_EMPLOYER'],
        true,
      ),
    };
  }

  // Every active employee's current salary structure in one sheet (Reports > Salary structures): one row per person, a
  // column per earning, their PF / ESI / PT / NPS, what the company pays on top, the total CTC and the take-home.
  // People with no structure on file are listed with a note instead of being left out.
  async bulkReport(organizationId: string, asOfParam?: string): Promise<ReportPayload> {
    const org = await this.scopedPrisma.organization.findFirst({
      where: { id: organizationId },
      select: { timezone: true },
    });
    const asOf = asOfParam ?? todayInOrgTz(org?.timezone ?? 'Asia/Kolkata');
    const [employees, allRows, shared] = await Promise.all([
      this.scopedPrisma.user.findMany({
        where: { organizationId, isActive: true },
        select: {
          id: true,
          name: true,
          employeeId: true,
          designation: true,
          gender: true,
          personalData: true,
          department: { select: { name: true, workLocation: { select: { state: true, cityClass: true } } } },
          workLocation: { select: { state: true, cityClass: true } },
        },
        orderBy: EMPLOYEE_ORDER_BY,
      }),
      this.scopedPrisma.employeeSalaryComponent.findMany({
        where: { organizationId, employee: { isActive: true } },
        include: { component: { select: STRUCTURE_COMPONENT_SELECT } },
      }),
      this.loadShared(organizationId, asOf),
    ]);
    const rowsByEmployee = new Map<string, StructureRow[]>();
    for (const r of allRows) {
      const list = rowsByEmployee.get(r.employeeId);
      if (list) list.push(r);
      else rowsByEmployee.set(r.employeeId, [r]);
    }

    // Column order: earnings as the components are ordered, then the person's deductions, then the employer's.
    const order = new Map(shared.components.map((c, i) => [c.code, c.displayOrder ?? i]));
    const earningCols = new Map<string, string>();
    const deductionCols = new Map<string, string>();
    const employerCols = new Map<string, string>();
    const built = employees.map((e) => {
      const f = this.figuresFor(e, rowsByEmployee.get(e.id) ?? [], asOf, shared);
      if (f) {
        for (const l of [...f.breakdown.earnings, ...f.breakdown.variable, ...f.breakdown.oneTime]) earningCols.set(l.code, l.name);
        for (const l of f.employeeLines) deductionCols.set(l.code, l.name);
        for (const l of f.employerLines) employerCols.set(l.code, l.name);
      }
      return { e, f };
    });
    const byOrder = (m: Map<string, string>) =>
      [...m.entries()].sort((a, b) => (order.get(a[0]) ?? 9999) - (order.get(b[0]) ?? 9999));
    const earnings = byOrder(earningCols);
    const deductions = byOrder(deductionCols);
    const employer = byOrder(employerCols);
    const sum = (ls: { amount: number }[]) => ls.reduce((t, l) => t + l.amount, 0);

    const rows = built.map(({ e, f }) => {
      const row: Record<string, unknown> = {
        employeeId: e.employeeId,
        name: e.name,
        department: e.department?.name ?? '',
        designation: e.designation ?? '',
      };
      if (!f) {
        row.effectiveFrom = 'No salary structure on file';
        return row;
      }
      const b = f.breakdown;
      const employerMonthly = sum(f.employerLines);
      const deductionsMonthly = sum(f.employeeLines);
      row.effectiveFrom = b.effectiveFrom ?? '';
      for (const l of b.earnings) row[`m_${l.code}`] = l.monthly;
      for (const l of [...b.variable, ...b.oneTime]) row[`m_${l.code}`] = `${l.annual} / year`;
      row.fixedMonthly = b.fixedMonthly;
      for (const l of f.employeeLines) row[`d_${l.code}`] = l.notApplicable ? 'N/A' : l.amount;
      row.deductionsMonthly = deductionsMonthly;
      row.takeHome = b.fixedMonthly - deductionsMonthly;
      for (const l of f.employerLines) row[`c_${l.code}`] = l.notApplicable ? 'N/A' : l.amount;
      row.employerMonthly = employerMonthly;
      row.ctcMonthly = b.fixedMonthly + employerMonthly;
      row.variableAnnual = b.variableAnnual + b.oneTimeAnnual;
      row.ctcAnnual = b.annualCTC + employerMonthly * 12;
      return row;
    });

    const columns: ReportColumn[] = [
      { header: 'Employee ID', key: 'employeeId', width: 14 },
      { header: 'Name', key: 'name', width: 22 },
      { header: 'Department', key: 'department', width: 18 },
      { header: 'Designation', key: 'designation', width: 18 },
      { header: 'Effective From', key: 'effectiveFrom', width: 14 },
      ...earnings.map(([code, name]) => ({ header: `${name} (Monthly)`, key: `m_${code}`, width: 14 })),
      { header: 'Gross Fixed (Monthly)', key: 'fixedMonthly', width: 16 },
      ...deductions.map(([code, name]) => ({ header: `${name} (Employee, Monthly)`, key: `d_${code}`, width: 16 })),
      { header: 'Total Deductions (Monthly)', key: 'deductionsMonthly', width: 16 },
      { header: 'Take-home (Monthly)', key: 'takeHome', width: 16 },
      ...employer.map(([code, name]) => ({ header: `${name} (Monthly)`, key: `c_${code}`, width: 16 })),
      { header: 'Employer Contributions (Monthly)', key: 'employerMonthly', width: 18 },
      { header: 'CTC (Monthly)', key: 'ctcMonthly', width: 14 },
      { header: 'Variable & One-time (Annual)', key: 'variableAnnual', width: 18 },
      { header: 'Total CTC (Annual)', key: 'ctcAnnual', width: 16 },
    ];
    return {
      title: 'Salary Structures',
      subtitle: `Active employees, structure in force on ${asOf}`,
      columns,
      rows,
      filename: `salary_structures_${asOf}`,
    };
  }
}
