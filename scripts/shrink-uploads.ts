// Purpose: shrink old profile photos and attendance selfies already stored on this server, to save disk space - safely.
// Usage (from backend-v2/), a DRY RUN is the default and changes nothing:
//   npx ts-node -T scripts/shrink-uploads.ts                       report what would be saved (profile photos + selfies)
//   npx ts-node -T scripts/shrink-uploads.ts --kind profile-photos report for profile photos only
//   npx ts-node -T scripts/shrink-uploads.ts --apply               really do it; every original is copied to a backup folder first
//   npx ts-node -T scripts/shrink-uploads.ts --apply --limit 20    a trial on the first 20 files
//   npx ts-node -T scripts/shrink-uploads.ts --restore <folder>    put the originals from that backup folder back
// Options: --kind profile-photos|selfies|all   --org <organisation id>   --older-than-days <n> (selfies; default 90)
//   --max-edge <px> --quality <1-100> (override the defaults of the kinds chosen)   --backup-dir <folder>   --limit <n>
// Defaults: profile photos 1024px / quality 95 (all of them); selfies 1600px / quality 88, only those older than 90 days, never the
//   stamped copies. Local-disk storage only (with S3 the files are not on this disk).
import * as path from 'path';
import { UPLOAD_ROOT } from '../src/files/file-storage.config';
import { DEFAULT_SETTINGS, restoreFromBackup, shrinkUploads, type ShrinkKind } from '../src/files/shrink-uploads';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  if (process.env.FILE_STORAGE_DRIVER === 's3' || process.env.STORAGE_DRIVER === 's3') {
    console.log('Files are stored in S3, not on this disk: this tool only works on local-disk storage. Nothing was changed.');
    return;
  }
  const restore = value('restore');
  if (restore) {
    const n = restoreFromBackup(UPLOAD_ROOT, path.resolve(restore));
    console.log(`Restored ${n} original file(s) from ${path.resolve(restore)} into ${UPLOAD_ROOT}.`);
    return;
  }
  const kindArg = value('kind') ?? 'all';
  const kinds: ShrinkKind[] = kindArg === 'all' ? ['profile-photos', 'selfies'] : kindArg === 'profile-photos' || kindArg === 'selfies' ? [kindArg] : [];
  if (kinds.length === 0) throw new Error('--kind must be profile-photos, selfies or all.');
  const override = {
    ...(value('max-edge') ? { maxEdge: Number(value('max-edge')) } : {}),
    ...(value('quality') ? { quality: Number(value('quality')) } : {}),
  };
  const settings: Record<string, object> = {};
  for (const k of kinds) {
    settings[k] = { ...override, ...(k === 'selfies' && value('older-than-days') ? { olderThanDays: Number(value('older-than-days')) } : {}) };
  }
  const apply = flag('apply');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
  const backupDir = path.resolve(value('backup-dir') ?? path.join(UPLOAD_ROOT, '..', 'uploads-originals', stamp));
  console.log(apply ? `APPLYING. Originals are backed up to ${backupDir}\n` : 'DRY RUN: nothing is changed. Add --apply to do it.\n');
  const reports = await shrinkUploads({
    root: UPLOAD_ROOT,
    kinds,
    settings,
    apply,
    backupDir: apply ? backupDir : undefined,
    organizationId: value('org'),
    limit: value('limit') ? Number(value('limit')) : undefined,
  });
  let before = 0;
  let after = 0;
  for (const r of reports) {
    const d = { ...DEFAULT_SETTINGS[r.kind], ...(settings[r.kind] as object) };
    console.log(`${r.kind}  (longest side ${(d as { maxEdge: number }).maxEdge}px, quality ${(d as { quality: number }).quality}${r.kind === 'selfies' ? `, older than ${(d as { olderThanDays: number }).olderThanDays} days` : ''})`);
    console.log(`  files looked at: ${r.scanned}   ${apply ? 'shrunk' : 'would shrink'}: ${r.shrunk}`);
    console.log(`  space: ${mb(r.bytesBefore)} -> ${mb(r.bytesAfter)}   ${apply ? 'saved' : 'would save'}: ${mb(r.bytesBefore - r.bytesAfter)}`);
    console.log(`  left alone: ${r.skipped.tooRecent} too recent, ${r.skipped.stampedCopy} stamped copies, ${r.skipped.noSaving} already small, ${r.skipped.notShrinkable} not JPEG/PNG, ${r.skipped.unreadable} unreadable`);
    if (r.errors.length) console.log(`  errors (${r.errors.length}):\n    ${r.errors.slice(0, 5).join('\n    ')}`);
    before += r.bytesBefore;
    after += r.bytesAfter;
  }
  console.log(`\nTotal ${apply ? 'saved' : 'that would be saved'}: ${mb(before - after)} (${mb(before)} -> ${mb(after)})`);
  if (apply) console.log(`To undo: npx ts-node -T scripts/shrink-uploads.ts --restore ${backupDir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
