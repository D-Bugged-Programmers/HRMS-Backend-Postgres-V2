import * as crypto from 'crypto';
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

// Single source of truth for password rules. Applied only when a password is
// SET or CHANGED — never at login, so existing weak passwords keep working.
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

// Rejected when the password, or the password with trailing digits/symbols
// stripped, matches one of these. Served to web/mobile via
// GET /auth/password-policy so their checklists apply the exact same list.
const COMMON_PASSWORDS = new Set([
  'password',
  'passw0rd',
  '12345678',
  '123456789',
  '1234567890',
  'qwerty',
  'qwertyuiop',
  'abc123',
  'letmein',
  'welcome',
  'admin',
  'iloveyou',
  'changeme',
  'password1',
  'password12',
  'password123',
  'password1234',
  'password123!',
  'p@ssw0rd',
  'p@ssword1',
  'password@123',
  'password#123',
  'qwerty123',
  'qwerty12345',
  'welcome1',
  'welcome123',
  'admin123',
  'admin1234',
  'administrator',
  'monkey',
  'dragon',
  'abcd1234',
  '123456',
  '1234567',
  '12345678910',
  '111111',
  '000000',
  'changeme123',
  'football',
  'baseball',
  'master',
  'login',
  'princess',
  'sunshine',
  'trustno1',
  'hrms',
  'hrms123',
  'india123',
  'test1234',
]);

/**
 * Returns human-readable problems (empty array = acceptable).
 * `context` optionally carries the user's email/name to reject trivial reuse.
 */
export function validatePasswordPolicy(
  password: unknown,
  context: { email?: string; name?: string } = {},
): string[] {
  if (typeof password !== 'string') return ['password must be a string'];
  const problems: string[] = [];
  if (password.length < PASSWORD_MIN_LENGTH)
    problems.push(`at least ${PASSWORD_MIN_LENGTH} characters`);
  if (password.length > PASSWORD_MAX_LENGTH)
    problems.push(`at most ${PASSWORD_MAX_LENGTH} characters`);
  if (!/[a-z]/.test(password)) problems.push('a lowercase letter');
  if (!/[A-Z]/.test(password)) problems.push('an uppercase letter');
  if (!/\d/.test(password)) problems.push('a digit');
  if (!/[^A-Za-z0-9\s]/.test(password)) problems.push('a symbol');
  if (/\s/.test(password)) problems.push('no whitespace');

  const lower = password.toLowerCase();
  // Strip trailing digits/symbols so "Password1!" is caught as "password".
  const base = lower.replace(/[^a-z]+$/, '');
  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(base))
    problems.push('not be a very common password');

  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local))
    problems.push('not contain your email name');
  const name = context.name?.trim().toLowerCase();
  if (name && name.length >= 4 && !/\s/.test(name) && lower.includes(name))
    problems.push('not contain your name');
  return problems;
}

// Public, non-secret description of the policy — the web and mobile apps
// load it so their live checklists match what the server will enforce.
export function publicPasswordPolicy() {
  return {
    minLength: PASSWORD_MIN_LENGTH,
    maxLength: PASSWORD_MAX_LENGTH,
    commonPasswords: [...COMMON_PASSWORDS],
  };
}

export function passwordPolicyMessage(problems: string[]): string {
  return `Password must have: ${problems.join('; ')}.`;
}

/** class-validator decorator; reads email/name off the DTO when present. */
export function IsStrongPassword(options?: ValidationOptions) {
  return (object: object, propertyName: string) => {
    registerDecorator({
      name: 'isStrongPassword',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const o = args.object as { email?: string; name?: string };
          return validatePasswordPolicy(value, o).length === 0;
        },
        defaultMessage(args: ValidationArguments) {
          const o = args.object as { email?: string; name?: string };
          return passwordPolicyMessage(validatePasswordPolicy(args.value, o));
        },
      },
    });
  };
}

// Short, easy-to-read words for the temporary password (all 4-6 letters).
const TEMP_PASSWORD_WORDS = ['Apple', 'Arrow', 'Beach', 'Bison', 'Blaze', 'Bloom', 'Brave', 'Bread', 'Brook', 'Candy', 'Cedar', 'Charm', 'Cherry', 'Cloud', 'Clover', 'Coral', 'Crane', 'Daisy', 'Dance', 'Eagle', 'Earth', 'Ember', 'Fairy', 'Falcon', 'Fern', 'Field', 'Flame', 'Flora', 'Forest', 'Frost', 'Garden', 'Ginger', 'Glade', 'Globe', 'Grape', 'Green', 'Happy', 'Harbor', 'Hazel', 'Heart', 'Honey', 'Horse', 'Ivory', 'Jolly', 'Jungle', 'Kitten', 'Lemon', 'Light', 'Lilac', 'Lotus', 'Lucky', 'Magic', 'Mango', 'Maple', 'Meadow', 'Melon', 'Mint', 'Moon', 'Ocean', 'Olive', 'Orange', 'Otter', 'Panda', 'Peach', 'Pearl', 'Pebble', 'Pilot', 'Plum', 'Polar', 'Pond', 'Poppy', 'Puppy', 'Quail', 'Quiet', 'Rabbit', 'Rain', 'River', 'Robin', 'Rocket', 'Rose', 'Ruby', 'Sandy', 'Shell', 'Silver', 'Sky', 'Smile', 'Snow', 'Solar', 'Spark', 'Spice', 'Spring', 'Star', 'Stone', 'Storm', 'Sunny', 'Swan', 'Sweet', 'Tiger', 'Tulip', 'Turtle', 'Velvet', 'Violet', 'Walnut', 'Water', 'Willow', 'Wind', 'Winter', 'Zebra'];

/**
 * A simple temporary password people can read out and type: two words and four digits, e.g. "Tiger-Maple-4827".
 * It always satisfies the policy (a capital, a lowercase letter, a digit, a hyphen as the symbol, 14+ characters).
 * It is single-use: the person must choose their own password at first sign-in, and repeated wrong tries lock the account.
 */
export function generatePolicyPassword(): string {
  const word = () => TEMP_PASSWORD_WORDS[crypto.randomInt(TEMP_PASSWORD_WORDS.length)];
  const first = word();
  let second = word();
  while (second === first) second = word();
  const digits = String(crypto.randomInt(1000, 10000));
  return `${first}-${second}-${digits}`;
}
