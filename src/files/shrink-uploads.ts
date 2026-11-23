// Purpose: shrink photos that are ALREADY stored (old profile photos, attendance selfies) to save disk space, safely.
// Responsibilities: walks <root>/<organisation>/<kind>/ for the kinds asked for, shrinks each eligible photo (see image-shrink.ts),
//   keeps a copy of every original it replaces in a backup folder, and reports what was (or would be) saved. A restore puts the
//   originals back. A dry run (the default) changes nothing.
// Important:
//   - Selfies are evidence: only files older than a set number of days are touched, the stamped copies (...-stamped.jpg, already
//     at most 1280px wide) are never touched, and every original is backed up first.
//   - Files keep their name, type and modified time, so no database reference changes and "older than" still means the same.
//   - Each file is replaced atomically (written beside it, then renamed). A file that cannot be read, or would not get clearly
//     smaller, is left alone.
//   - Local-disk storage only. With S3 storage the files are not on this disk and this tool does nothing.
import * as fs from 'fs';
import * as path from 'path';
import { shrinkImage, SHRINKABLE_EXTENSIONS } from './image-shrink';

export type ShrinkKind = 'profile-photos' | 'selfies';

export interface KindSettings {
  maxEdge: number;
  quality: number;
  /** Only files last modified at least this many days ago are touched (0 = all). */
  olderThanDays: number;
}

/** Defaults: profile photos get the same gentle settings as new uploads; selfies keep more detail and only the older ones are touched. */
export const DEFAULT_SETTINGS: Record<ShrinkKind, KindSettings> = {
  'profile-photos': { maxEdge: 1024, quality: 95, olderThanDays: 0 },
  selfies: { maxEdge: 1600, quality: 88, olderThanDays: 90 },
};

export interface ShrinkReport {
  kind: ShrinkKind;
  scanned: number;
  shrunk: number;
  bytesBefore: number;
  bytesAfter: number;
  skipped: { notShrinkable: number; stampedCopy: number; tooRecent: number; noSaving: number; unreadable: number };
  errors: string[];
}

export interface RunOptions {
  root: string;
  kinds: ShrinkKind[];
  settings?: Partial<Record<ShrinkKind, Partial<KindSettings>>>;
  /** false = report only. */
  apply: boolean;
  /** Where each replaced original is copied first. Required when applying. */
  backupDir?: string;
  /** Only this organisation's folder. */
  organizationId?: string;
  /** Stop after this many files have been shrunk (a trial run). */
  limit?: number;
  now?: Date;
}

const emptyReport = (kind: ShrinkKind): ShrinkReport => ({
  kind,
  scanned: 0,
  shrunk: 0,
  bytesBefore: 0,
  bytesAfter: 0,
  skipped: { notShrinkable: 0, stampedCopy: 0, tooRecent: 0, noSaving: 0, unreadable: 0 },
  errors: [],
});

export async function shrinkUploads(opts: RunOptions): Promise<ShrinkReport[]> {
  if (opts.apply && !opts.backupDir) throw new Error('A backup folder is required to apply (so the originals can be restored).');
  const now = (opts.now ?? new Date()).getTime();
  const reports: ShrinkReport[] = [];
  let remaining = opts.limit ?? Infinity;
  const orgs = fs.existsSync(opts.root)
    ? fs.readdirSync(opts.root, { withFileTypes: true }).filter((d) => d.isDirectory() && (!opts.organizationId || d.name === opts.organizationId)).map((d) => d.name)
    : [];
  for (const kind of opts.kinds) {
    const cfg = { ...DEFAULT_SETTINGS[kind], ...(opts.settings?.[kind] ?? {}) };
    const report = emptyReport(kind);
    reports.push(report);
    for (const org of orgs) {
      const dir = path.join(opts.root, org, kind);
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || remaining <= 0) continue;
        const file = path.join(dir, entry.name);
        if (entry.name.endsWith('.shrink.tmp')) continue;
        const ext = path.extname(entry.name).toLowerCase();
        report.scanned++;
        if (!SHRINKABLE_EXTENSIONS.has(ext)) { report.skipped.notShrinkable++; continue; }
        if (kind === 'selfies' && /-stamped\.jpe?g$/i.test(entry.name)) { report.skipped.stampedCopy++; continue; }
        const stat = fs.statSync(file);
        if (cfg.olderThanDays > 0 && now - stat.mtimeMs < cfg.olderThanDays * 86400000) { report.skipped.tooRecent++; continue; }
        try {
          const data = fs.readFileSync(file);
          const result = await shrinkImage(data, ext, { maxEdge: cfg.maxEdge, quality: cfg.quality });
          if (!result) {
            // Unreadable and "not worth it" are told apart so the report says which.
            report.skipped[(await shrinkImage(data, ext, { maxEdge: 1, quality: 1, minSaving: -1 })) ? 'noSaving' : 'unreadable']++;
            continue;
          }
          report.shrunk++;
          report.bytesBefore += data.length;
          report.bytesAfter += result.data.length;
          remaining--;
          if (!opts.apply) continue;
          const backup = path.join(opts.backupDir as string, org, kind, entry.name);
          fs.mkdirSync(path.dirname(backup), { recursive: true });
          if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
          const tmp = `${file}.shrink.tmp`;
          fs.writeFileSync(tmp, result.data);
          fs.renameSync(tmp, file);
          fs.utimesSync(file, stat.atime, stat.mtime);
        } catch (err) {
          report.errors.push(`${org}/${kind}/${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  }
  return reports;
}

/** Puts every file from a backup folder back where it came from. Returns how many were restored. */
export function restoreFromBackup(root: string, backupDir: string): number {
  let restored = 0;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const target = path.join(root, path.relative(backupDir, full));
        const stat = fs.statSync(full);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(full, target);
        fs.utimesSync(target, stat.atime, stat.mtime);
        restored++;
      }
    }
  };
  if (fs.existsSync(backupDir)) walk(backupDir);
  return restored;
}
