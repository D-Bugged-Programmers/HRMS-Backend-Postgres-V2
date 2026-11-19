// Purpose: where an emailed letter goes. Someone who has left, or has an exit date, no longer has a working company mailbox, so
//   their letters go ONLY to the personal email on file; with none, the letter cannot be emailed (never the company address).
//   Everyone else gets it at their company email, except a placeholder address (no email at all), which falls back to a personal one.
import { personalEmailOf } from '../common/personal-email';
import { isPlaceholderEmail } from '../common/no-email';

export function letterRecipientOf(employee: {
  isActive: boolean;
  exitDate?: unknown;
  email: string;
  personalData: unknown;
}): { leaving: boolean; recipient: string | null } {
  const leaving = !employee.isActive || !!employee.exitDate;
  const personal = personalEmailOf(employee.personalData);
  if (leaving) return { leaving, recipient: personal };
  return { leaving, recipient: isPlaceholderEmail(employee.email) ? personal : employee.email };
}
