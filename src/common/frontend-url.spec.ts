import { cleanFrontendUrl, frontendUrl } from './frontend-url';

describe('frontend address used in email links', () => {
  it('drops spaces and trailing slashes so a link never reads //path', () => {
    expect(cleanFrontendUrl(' https://app.example.com/ ')).toBe('https://app.example.com');
    expect(cleanFrontendUrl('https://app.example.com///')).toBe('https://app.example.com');
  });
  it('adds https:// when only a host is configured, and keeps http:// for local development', () => {
    expect(cleanFrontendUrl('app.example.com')).toBe('https://app.example.com');
    expect(cleanFrontendUrl('localhost:5173')).toBe('http://localhost:5173');
    expect(cleanFrontendUrl('http://localhost:5173')).toBe('http://localhost:5173');
  });
  it('uses the first address of a comma-separated CORS_ORIGIN when FRONTEND_URL is not set', () => {
    const before = { f: process.env.FRONTEND_URL, c: process.env.CORS_ORIGIN };
    delete process.env.FRONTEND_URL;
    process.env.CORS_ORIGIN = 'https://sso.example.com/, https://admin.example.com';
    try {
      expect(frontendUrl()).toBe('https://sso.example.com');
      expect(`${frontendUrl()}/tax-declaration`).toBe('https://sso.example.com/tax-declaration');
    } finally {
      if (before.f === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = before.f;
      if (before.c === undefined) delete process.env.CORS_ORIGIN; else process.env.CORS_ORIGIN = before.c;
    }
  });
});
