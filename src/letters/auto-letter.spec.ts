import { Logger } from '@nestjs/common';
import { sendLetterQuietly } from './auto-letter';

const logger = { warn: jest.fn() } as unknown as Logger;
const actor = { id: 'hr1' } as never;

describe('sendLetterQuietly', () => {
  it('sends the letter and reports it', async () => {
    const send = jest.fn().mockResolvedValue({ message: 'ok' });
    expect(await sendLetterQuietly({ send, prepareNextIssue: async (_e: string, k: string) => k, discardEmptyIssue: async () => undefined } as never, logger, 'e1', 'confirmationLetter', actor, 'org')).toBe(true);
    // An automatic letter is also switched on for the employee, so they can open it and approve it.
    expect(send).toHaveBeenCalledWith('e1', 'confirmationLetter', actor, 'org', undefined, undefined, true);
  });

  it('never throws: a missing template is logged and reported as not sent', async () => {
    const send = jest.fn().mockRejectedValue(new Error('No active letter template found'));
    expect(await sendLetterQuietly({ send, prepareNextIssue: async (_e: string, k: string) => k, discardEmptyIssue: async () => undefined } as never, logger, 'e1', 'resignationAcceptance', actor, 'org')).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('hiring letters when someone is added', () => {
  const run = async (policies: any, sendOk = true) => {
    const { handleHiringLetters } = require('./auto-letter');
    const notices: any[] = [];
    const sent: string[] = [];
    const prisma = {
      organization: { findFirst: async () => ({ policies }) },
      user: {
        findFirst: async (a: any) => (a.select ? { name: 'Asha', isActive: true } : { id: 'hr', role: 'HR' }),
        findMany: async () => [{ id: 'hr1' }, { id: 'ad1' }],
      },
      notification: { createMany: async (a: any) => { notices.push(...a.data); } },
    };
    const letters = {
      prepareNextIssue: async (_e: string, k: string) => k,
      send: async (_e: string, k: string) => { if (!sendOk) throw new Error('no email'); sent.push(k); },
    };
    const logger = { warn: () => undefined };
    await handleHiringLetters({ letters, logger, prisma } as never, { employeeId: 'e1', actorId: 'hr', organizationId: 'o' });
    return { notices, sent };
  };
  it('tells HR once for both letters by default', async () => {
    const { notices, sent } = await run({});
    expect(sent).toEqual([]);
    expect(notices).toHaveLength(2);
    expect(notices[0].message).toContain('offer letter and appointment letter');
  });
  it('sends straight away when the company chose send, and does nothing when off', async () => {
    const a = await run({ eventLetters: { offerLetter: 'send', appointmentLetter: 'off' } });
    expect(a.sent).toEqual(['offerLetter']);
    expect(a.notices).toHaveLength(0);
  });
  it('falls back to a review notice when a send fails', async () => {
    const { notices } = await run({ eventLetters: { offerLetter: 'send', appointmentLetter: 'off' } }, false);
    expect(notices).toHaveLength(2);
  });
});
