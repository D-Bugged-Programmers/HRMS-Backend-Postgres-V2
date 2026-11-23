import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { shrinkImage } from './image-shrink';
import { restoreFromBackup, shrinkUploads } from './shrink-uploads';

// A photo-like picture: gradient + shapes + a little grain, so it compresses like a real photo rather than flat colour.
function picture(width: number, height: number, type: 'jpeg' | 'png', quality = 95): Buffer {
  const canvas = createCanvas(width, height);
  const g = canvas.getContext('2d');
  const gradient = g.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#2b4a7a');
  gradient.addColorStop(0.5, '#d9a066');
  gradient.addColorStop(1, '#223344');
  g.fillStyle = gradient;
  g.fillRect(0, 0, width, height);
  for (let i = 0; i < 30; i++) {
    g.fillStyle = `hsla(${i * 12}, 60%, ${30 + i}%, 0.55)`;
    g.beginPath();
    g.arc(((i * 977) % width), ((i * 541) % height), 50 + (i % 7) * 20, 0, 7);
    g.fill();
  }
  return type === 'png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg', quality);
}

describe('shrinkImage', () => {
  it('brings a large JPEG down to the limit and makes it clearly smaller, keeping the shape', async () => {
    const big = picture(3000, 2000, 'jpeg');
    const out = await shrinkImage(big, '.jpg', { maxEdge: 1024, quality: 95 });
    expect(out).not.toBeNull();
    expect(out!.width).toBe(1024);
    expect(out!.height).toBe(683);
    expect(out!.data.length).toBeLessThan(big.length * 0.9);
    const back = await loadImage(out!.data);
    expect(back.width).toBe(1024);
  });
  it('leaves a photo that is already small alone (no repeated re-compression)', async () => {
    const small = picture(600, 400, 'jpeg', 85);
    expect(await shrinkImage(small, '.jpg', { maxEdge: 1024, quality: 95 })).toBeNull();
  });
  it('keeps a PNG a PNG, never scales up, and ignores other types and unreadable data', async () => {
    const png = picture(2400, 1600, 'png');
    const out = await shrinkImage(png, '.png', { maxEdge: 1024, quality: 95 });
    expect(out).not.toBeNull();
    expect(out!.data.subarray(1, 4).toString()).toBe('PNG');
    expect(await shrinkImage(Buffer.from('%PDF-1.4'), '.pdf', { maxEdge: 1024, quality: 95 })).toBeNull();
    expect(await shrinkImage(Buffer.from('not an image'), '.jpg', { maxEdge: 1024, quality: 95 })).toBeNull();
  });
});

describe('shrinkUploads', () => {
  let root: string;
  let backup: string;
  const ORG = 'org-1';
  const old = new Date(Date.now() - 200 * 86400000);
  const put = (kind: string, name: string, data: Buffer, mtime: Date = old) => {
    const dir = path.join(root, ORG, kind);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, data);
    fs.utimesSync(file, mtime, mtime);
    return file;
  };
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'uploads-'));
    backup = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(backup, { recursive: true, force: true });
  });

  it('a dry run reports the saving and changes nothing', async () => {
    const photo = put('profile-photos', 'a.jpg', picture(3000, 2000, 'jpeg'));
    const before = fs.readFileSync(photo);
    const [report] = await shrinkUploads({ root, kinds: ['profile-photos'], apply: false });
    expect(report.shrunk).toBe(1);
    expect(report.bytesAfter).toBeLessThan(report.bytesBefore);
    expect(fs.readFileSync(photo).equals(before)).toBe(true);
    expect(fs.readdirSync(backup)).toHaveLength(0);
  });

  it('applies with a backup, keeps the modified time, and a restore brings the original back exactly', async () => {
    const photo = put('profile-photos', 'a.jpg', picture(3000, 2000, 'jpeg'));
    const original = fs.readFileSync(photo);
    const [report] = await shrinkUploads({ root, kinds: ['profile-photos'], apply: true, backupDir: backup });
    expect(report.shrunk).toBe(1);
    expect(fs.statSync(photo).size).toBeLessThan(original.length);
    expect(Math.abs(fs.statSync(photo).mtimeMs - old.getTime())).toBeLessThan(2000);
    expect(fs.readFileSync(path.join(backup, ORG, 'profile-photos', 'a.jpg')).equals(original)).toBe(true);
    expect(restoreFromBackup(root, backup)).toBe(1);
    expect(fs.readFileSync(photo).equals(original)).toBe(true);
  });

  it('selfies: only old originals are touched; recent ones, stamped copies and non-images are left alone', async () => {
    const oldOriginal = put('selfies', 'old.jpg', picture(3500, 2500, 'jpeg'));
    const recent = put('selfies', 'new.jpg', picture(3500, 2500, 'jpeg'), new Date());
    const stamped = put('selfies', 'old-stamped.jpg', picture(3500, 2500, 'jpeg'));
    const note = put('selfies', 'note.txt', Buffer.from('hello'));
    const sizes = [recent, stamped, note].map((f) => fs.statSync(f).size);
    const [report] = await shrinkUploads({ root, kinds: ['selfies'], apply: true, backupDir: backup });
    expect(report.shrunk).toBe(1);
    expect(report.skipped).toMatchObject({ tooRecent: 1, stampedCopy: 1, notShrinkable: 1 });
    expect([recent, stamped, note].map((f) => fs.statSync(f).size)).toEqual(sizes);
    const shrunk = await loadImage(fs.readFileSync(oldOriginal));
    expect(Math.max(shrunk.width, shrunk.height)).toBe(1600);
  });

  it('refuses to apply without a backup folder, and a limit stops after that many files', async () => {
    put('profile-photos', 'a.jpg', picture(3000, 2000, 'jpeg'));
    put('profile-photos', 'b.jpg', picture(3000, 2000, 'jpeg'));
    await expect(shrinkUploads({ root, kinds: ['profile-photos'], apply: true })).rejects.toThrow(/backup/i);
    const [report] = await shrinkUploads({ root, kinds: ['profile-photos'], apply: true, backupDir: backup, limit: 1 });
    expect(report.shrunk).toBe(1);
  });

  it('keeps the picture upright when a photo carries a rotation flag', async () => {
    const jpg = picture(3000, 2000, 'jpeg');
    // EXIF orientation 6 (rotate 90 degrees): a landscape file that should be shown portrait.
    const exif = Buffer.from([0xff, 0xe1, 0x00, 0x24, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const flagged = Buffer.concat([jpg.subarray(0, 2), exif, jpg.subarray(2)]);
    const out = await shrinkImage(flagged, '.jpg', { maxEdge: 1024, quality: 95 });
    expect(out).not.toBeNull();
    expect([out!.width, out!.height]).toEqual([683, 1024]);
  });
});
