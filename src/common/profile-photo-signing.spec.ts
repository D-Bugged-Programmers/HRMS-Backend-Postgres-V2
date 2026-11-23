import { signProfilePhotos } from './profile-photo-signing.interceptor';

describe('signProfilePhotos', () => {
  beforeAll(() => {
    process.env.FILE_TOKEN_SECRET = process.env.FILE_TOKEN_SECRET || 'test-file-token-secret';
  });
  it('turns a stored key into a /files link, wherever it sits in the response', () => {
    const body = { data: [{ id: 1, employee: { name: 'A', profileImage: 'org/profile-photos/a.png' } }], meta: { total: 1 } };
    signProfilePhotos(body, 'org');
    expect(body.data[0].employee.profileImage).toMatch(/^\/files\/.+/);
  });
  it('leaves a link, an empty value and a missing photo alone, and never signs twice', () => {
    const body = { a: { profileImage: '/files/abc' }, b: { profileImage: 'https://x.test/a.png' }, c: { profileImage: null }, d: { profileImage: '' }, e: { name: 'no photo' } };
    const before = JSON.stringify(body);
    signProfilePhotos(body, 'org');
    expect(JSON.stringify(body)).toBe(before);
    const once = { employee: { profileImage: 'org/profile-photos/a.png' } };
    signProfilePhotos(once, 'org');
    const signed = once.employee.profileImage;
    signProfilePhotos(once, 'org');
    expect(once.employee.profileImage).toBe(signed);
  });
  it('skips dates, buffers and other non-plain values', () => {
    const when = new Date();
    const body = { when, file: Buffer.from('x'), list: [when] };
    expect(() => signProfilePhotos(body, 'org')).not.toThrow();
    expect(body.when).toBe(when);
  });
});
