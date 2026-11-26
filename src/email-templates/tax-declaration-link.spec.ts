import { EMAIL_TEMPLATE_DEFAULTS } from './email-template-defaults';
import { sanitizeEmailHtml } from './email-html-sanitizer';
import { renderTemplate } from './render-template';
import { cleanFrontendUrl } from '../common/frontend-url';

// The reminder email's "Submit declaration" button must end up as a plain https link to the web app's Tax Declaration page,
// with nothing about the employee in it.
describe('tax declaration reminder email: the Submit declaration link', () => {
  const t = EMAIL_TEMPLATE_DEFAULTS.find((d) => d.occasionKey === 'TAX_DECLARATION_REMINDER')!;
  const url = `${cleanFrontendUrl('https://app.example.com/')}/tax-declaration`;

  it('renders the button with the exact address, after the HTML cleanup every stored template goes through', () => {
    const html = renderTemplate(sanitizeEmailHtml(t.bodyHtml), { reviewUrl: url, employeeName: 'Asha', financialYear: '2026-27', deadline: '31-01-2027' });
    expect(html).toContain('href="https://app.example.com/tax-declaration"');
    expect(html).toContain('Submit declaration');
    expect(html).not.toContain('{{reviewUrl}}');
  });
  it('carries no employee identity or token in the address', () => {
    expect(url).toBe('https://app.example.com/tax-declaration');
    expect(url).not.toMatch(/token|employeeId|userId|email|\?/i);
  });
});
