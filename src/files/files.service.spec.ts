import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { FilesService } from './files.service';

process.env.FILE_TOKEN_SECRET ??= 'test-secret-test-secret-test-secret';

function jpeg(w: number, h: number): Buffer {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, w, h);
  gr.addColorStop(0, '#2b4a7a');
  gr.addColorStop(1, '#d9a066');
  g.fillStyle = gr;
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 30; i++) {
    g.fillStyle = `hsla(${i * 12},60%,${30 + i}%,.55)`;
    g.beginPath();
    g.arc((i * 977) % w, (i * 541) % h, 50 + (i % 7) * 20, 0, 7);
    g.fill();
  }
  return c.toBuffer('image/jpeg', 95);
}

function upload(dir: string, name: string, data: Buffer): Express.Multer.File {
  const p = path.join(dir, name);
  fs.writeFileSync(p, data);
  return { path: p, filename: name, originalname: name, mimetype: 'image/jpeg' } as Express.Multer.File;
}

describe('FilesService.describeUpload shrinking', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upl-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const svc = new FilesService();

  it('stores a big profile photo at 1024px, smaller, and still a valid JPEG', async () => {
    const big = jpeg(3000, 2000);
    const f = upload(dir, 'a.jpg', big);
    const res = await svc.describeUpload(f, 'profile-photos', 'org1');
    expect(res.relativeKey).toBe('org1/profile-photos/a.jpg');
    const img = await loadImage(fs.readFileSync(f.path));
    expect(Math.max(img.width, img.height)).toBe(1024);
    expect(fs.statSync(f.path).size).toBeLessThan(big.length * 0.9);
  });

  it('shrinks selfies to 1600px', async () => {
    const f = upload(dir, 's.jpg', jpeg(4000, 3000));
    await svc.describeUpload(f, 'selfies', 'org1');
    const img = await loadImage(fs.readFileSync(f.path));
    expect(img.width).toBe(1600);
  });

  it('leaves a small photo and other categories untouched', async () => {
    const small = jpeg(600, 400);
    const a = upload(dir, 'small.jpg', small);
    await svc.describeUpload(a, 'profile-photos', 'org1');
    expect(fs.readFileSync(a.path).equals(small)).toBe(true);
    const big = jpeg(3000, 2000);
    const b = upload(dir, 'doc.jpg', big);
    await svc.describeUpload(b, 'documents', 'org1');
    expect(fs.readFileSync(b.path).equals(big)).toBe(true);
  });
});
