// The app has no dedicated FRONTEND_URL env var — CORS_ORIGIN (a
// comma-separated allowlist) already names the frontend's origin, so this
// reuses its first entry rather than introducing a second source of truth
// that could drift from it. Same fallback as main.ts's CORS setup.
// CHANGE HERE (production): set FRONTEND_URL (or CORS_ORIGIN) to the live web app address. Registration, approval, rejection and
// welcome emails, and the Control Panel's System Check, all use it; the localhost fallback is for development only.
export function frontendUrl(): string {
  const first = (
    process.env.FRONTEND_URL ||
    process.env.CORS_ORIGIN ||
    'http://localhost:5173'
  ).split(',')[0];
  return cleanFrontendUrl(first);
}

// A configured address as it must appear in a link: spaces and trailing slashes removed (a trailing slash made email links read
// "https://app.example.com//tax-declaration", which the web app does not route), and https:// added when the setting names only a host.
// localhost and plain-IP development addresses keep http://.
export function cleanFrontendUrl(raw: string): string {
  let url = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) {
    url = `${/^(localhost|127\.|\d+\.\d+\.\d+\.\d+)/i.test(url) ? 'http' : 'https'}://${url}`;
  }
  return url;
}
