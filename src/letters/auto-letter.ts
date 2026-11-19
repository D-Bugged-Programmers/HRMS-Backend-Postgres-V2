// Purpose: sends a standard letter (resignation acceptance, confirmation, probation extension) as a side effect of an HR
//   decision, so HR no longer has to remember to generate and send it.
// Important: best-effort. The decision it follows has already been saved and must never fail because the letter could not be
//   sent (no active template for the company, no email address on file, mail down) - the reason is logged and HR can still
//   send the letter by hand from the employee's Letters tab. Returns whether it was sent.
import type { Logger } from '@nestjs/common';
import type { User } from '@prisma/client';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import type { LettersService } from './letters.service';

// Letters that follow an event HR decided (a promotion, a salary revision, a transfer). The company chooses per letter what happens:
// 'review' (default) tells HR/Admin the letter is ready, so they read it and send it from the employee's Letters tab; 'send' emails it
// straight away; 'off' does nothing. Organization Settings > Policies > Letters.
export type EventLetterKey = 'promotionLetter' | 'incrementLetter' | 'transferLetter' | 'offerLetter' | 'appointmentLetter';
export const EVENT_LETTER_LABELS: Record<EventLetterKey, string> = {
  promotionLetter: 'Promotion letter',
  incrementLetter: 'Increment letter',
  transferLetter: 'Transfer letter',
  offerLetter: 'Offer letter',
  appointmentLetter: 'Appointment letter',
};
export type EventLetterMode = 'off' | 'review' | 'send';

export function eventLetterMode(policies: unknown, key: EventLetterKey): EventLetterMode {
  const v = ((policies ?? {}) as { eventLetters?: Record<string, unknown> }).eventLetters?.[key];
  return v === 'off' || v === 'send' ? v : 'review';
}

export async function handleEventLetter(
  deps: { letters: LettersService | null; logger: Logger; prisma: ExtendedPrismaClient },
  args: { employeeId: string; key: EventLetterKey; actorId: string; organizationId: string },
): Promise<void> {
  try {
    const { prisma, letters, logger } = deps;
    const { employeeId, key, actorId, organizationId } = args;
    const [org, employee] = await Promise.all([
      prisma.organization.findFirst({ where: { id: organizationId }, select: { policies: true } }),
      prisma.user.findFirst({ where: { id: employeeId, organizationId }, select: { name: true, isActive: true } }),
    ]);
    const mode = eventLetterMode(org?.policies, key);
    if (mode === 'off' || !employee?.isActive) return;
    // A letter that can be issued again (every promotion, every increment) goes under its own new entry; HR then finds it on
    // the Letters tab next to the earlier ones.
    const slot = letters ? await letters.prepareNextIssue(employeeId, key, organizationId) : key;
    if (mode === 'send' && letters) {
      const actor = await prisma.user.findFirst({ where: { id: actorId, organizationId } });
      if (actor && (await sendLetterQuietly(letters, logger, employeeId, slot, actor as never, organizationId))) return;
    }
    const hr = await prisma.user.findMany({ where: { organizationId, isActive: true, role: { in: ['HR', 'ADMIN'] } }, select: { id: true } });
    const label = EVENT_LETTER_LABELS[key];
    await prisma.notification.createMany({
      data: hr.map((u) => ({
        organizationId,
        userId: u.id,
        title: `Letter ready to review: ${label}`,
        message: `${employee.name}: review the ${label.toLowerCase()} and send it from their Letters tab.`,
        category: 'GENERAL' as const,
        link: `/employee-profile?id=${employeeId}&tab=letters`,
      })),
    });
  } catch (err) {
    deps.logger.warn(`Event letter ${args.key} for ${args.employeeId} not prepared: ${(err as Error).message}`);
  }
}

// When someone is added: the hiring letters are prepared the way the company chose - 'review' (default: HR/Admin get one notice that
// they are ready to read and send), 'send' (emailed straight away) or 'off'. One notice per person, however many letters.
export const HIRING_LETTER_KEYS_AUTO: EventLetterKey[] = ['offerLetter', 'appointmentLetter'];
export async function handleHiringLetters(
  deps: { letters: LettersService | null; logger: Logger; prisma: ExtendedPrismaClient },
  args: { employeeId: string; actorId: string; organizationId: string },
): Promise<void> {
  try {
    const { prisma, letters, logger } = deps;
    const { employeeId, actorId, organizationId } = args;
    const [org, employee] = await Promise.all([
      prisma.organization.findFirst({ where: { id: organizationId }, select: { policies: true } }),
      prisma.user.findFirst({ where: { id: employeeId, organizationId }, select: { name: true, isActive: true } }),
    ]);
    if (!employee?.isActive) return;
    const toReview: string[] = [];
    for (const key of HIRING_LETTER_KEYS_AUTO) {
      const mode = eventLetterMode(org?.policies, key);
      if (mode === 'off') continue;
      if (mode === 'send' && letters) {
        const actor = await prisma.user.findFirst({ where: { id: actorId, organizationId } });
        if (actor && (await sendLetterQuietly(letters, logger, employeeId, key, actor as never, organizationId))) continue;
      }
      toReview.push(EVENT_LETTER_LABELS[key]);
    }
    if (toReview.length === 0) return;
    const hr = await prisma.user.findMany({ where: { organizationId, isActive: true, role: { in: ['HR', 'ADMIN'] } }, select: { id: true } });
    await prisma.notification.createMany({
      data: hr.map((u) => ({
        organizationId,
        userId: u.id,
        title: `Hiring letters ready to review: ${employee.name}`,
        message: `${employee.name} was added: read the ${toReview.join(' and ').toLowerCase()} and send ${toReview.length === 1 ? 'it' : 'them'} from their Letters tab.`,
        category: 'GENERAL' as const,
        link: `/employee-profile?id=${employeeId}&tab=letters`,
      })),
    });
  } catch (err) {
    deps.logger.warn(`Hiring letters for ${args.employeeId} not prepared: ${(err as Error).message}`);
  }
}

export async function sendLetterQuietly(
  letters: LettersService,
  logger: Logger,
  employeeId: string,
  // The template key, or a slot of a letter issued before ("incrementLetter#2").
  key: string,
  actor: Omit<User, 'password'>,
  organizationId: string,
): Promise<boolean> {
  try {
    // A repeat of a letter that can be issued again goes under its own new entry; a slot already named is used as given.
    const started = !key.includes('#');
    const slot = started ? await letters.prepareNextIssue(employeeId, key, organizationId) : key;
    try {
      // An automatic letter is also switched on for the employee, so they can open it and approve it.
    await letters.send(employeeId, slot, actor, organizationId, undefined, undefined, true);
    } catch (err) {
      // An entry this call started for a repeat letter that could not be sent is removed again, so no empty one is left behind.
      if (started) await letters.discardEmptyIssue(employeeId, slot, organizationId).catch(() => undefined);
      throw err;
    }
    return true;
  } catch (err) {
    logger.warn(`Automatic ${key} for ${employeeId} not sent: ${(err as Error).message}`);
    return false;
  }
}
