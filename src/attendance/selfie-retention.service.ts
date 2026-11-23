// Purpose: deletes the original (unstamped) selfie of old punches, for companies whose Super Admin set a retention period.
// Responsibilities: every night at 03:45, for each company with a retention period in the Control Panel, deletes the stored original
//   file of every punch older than that many days and clears the punch's selfieOriginalUrl. Companies with no period are never touched.
// Important: ONLY the original kept beside a stamped copy is deleted - the stamped selfie that attendance screens show (selfieUrl) and a
//   selfie that was never stamped (it has no separate original) stay. Deleting is permanent. A failure is logged and retried next night.
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PRISMA_CLIENT } from '../prisma/prisma.module';
import type { ExtendedPrismaClient } from '../prisma/prisma.module';
import { deleteStoredFile } from '../files/delete-stored-file';

const BATCH = 500;

@Injectable()
export class SelfieRetentionService {
  private readonly logger = new Logger(SelfieRetentionService.name);

  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: ExtendedPrismaClient) {}

  @Cron('45 3 * * *')
  async run(now: Date = new Date()): Promise<number> {
    let total = 0;
    try {
      const profiles = await this.prisma.ccOrgProfile.findMany({
        where: { selfieOriginalRetentionDays: { not: null } },
        select: { organizationId: true, selfieOriginalRetentionDays: true },
      });
      for (const p of profiles) {
        const days = p.selfieOriginalRetentionDays;
        if (!days || days < 7) continue;
        const cutoff = new Date(now.getTime() - days * 86_400_000);
        for (;;) {
          const rows = await this.prisma.punch.findMany({
            where: { organizationId: p.organizationId, selfieOriginalUrl: { not: null }, createdAt: { lt: cutoff } },
            select: { id: true, selfieUrl: true, selfieOriginalUrl: true },
            take: BATCH,
          });
          if (!rows.length) break;
          for (const r of rows) {
            // Never remove the file the app still shows.
            if (r.selfieOriginalUrl && r.selfieOriginalUrl !== r.selfieUrl) deleteStoredFile(r.selfieOriginalUrl);
          }
          await this.prisma.punch.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { selfieOriginalUrl: null } });
          total += rows.length;
          if (rows.length < BATCH) break;
        }
      }
      if (total) this.logger.log(`Deleted ${total} original selfies past their company's retention period.`);
    } catch (e) {
      this.logger.error(`Selfie retention clean-up failed: ${(e as Error).message}`);
    }
    return total;
  }
}
