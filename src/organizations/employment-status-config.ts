// Purpose: the company's own list of employment statuses - the built-in ones (renamable, a few can be switched off) plus statuses
//   the company adds - and which built-in status each one behaves like.
// Responsibilities: turn the stored config into the list the screens show, say what a person's status is called, and work out which
//   built-in status (the EmploymentStatus enum) a chosen status is stored as. Pure functions only; EmploymentStatusesService owns the writes.
// Important: the enum still drives every rule (probation, payroll, login, settlement, reminders). A custom status never adds a rule: it
//   FOLLOWS a built-in one - Working behaves like Confirmed, Paused like On Hold - so nothing else in the app needs to know about it.
//   Statuses that mean "has left" are not custom: Resigned, Released, Terminated and Absconded go through Resignation / Offboarding.
import { EmploymentStatus } from '@prisma/client';

export type StatusBehavior = 'WORKING' | 'PAUSED';
export const STATUS_BEHAVIORS: StatusBehavior[] = ['WORKING', 'PAUSED'];
/** The built-in status a custom status is stored as. */
export const BEHAVIOR_BASE: Record<StatusBehavior, EmploymentStatus> = {
  WORKING: EmploymentStatus.CONFIRMED,
  PAUSED: EmploymentStatus.ON_HOLD,
};

export interface CustomStatus {
  key: string;
  label: string;
  behavior: StatusBehavior;
  isActive: boolean;
}
export interface EmploymentStatusConfig {
  custom: CustomStatus[];
  /** Built-in status -> the company's name for it. */
  labels: Record<string, string>;
  /** Built-in statuses switched off (only ones that are not core). */
  inactive: string[];
}

export const BUILTIN_STATUS_LABELS: Record<string, string> = {
  ONBOARDING: 'Onboarding',
  PROBATION: 'Probation',
  EXTENDED_PROBATION: 'Extended Probation',
  CONFIRMED: 'Confirmed',
  NOTICE_PERIOD: 'Notice Period',
  RESIGNED: 'Resigned',
  RELEASED: 'Released',
  TERMINATED: 'Terminated',
  ABSCONDED: 'Absconded',
  ON_HOLD: 'On Hold',
};
/** Built-in statuses that are set by a person's own edit (the rest are reached through Resignation / Offboarding or by the system). */
export const SELECTABLE_BUILTINS: string[] = ['ONBOARDING', 'PROBATION', 'EXTENDED_PROBATION', 'CONFIRMED', 'ON_HOLD'];
/** Built-in statuses that may be switched off: the rules and screens never depend on someone being in them. */
export const SWITCHABLE_BUILTINS: string[] = ['EXTENDED_PROBATION', 'ON_HOLD'];
/** Shown in the list but not part of it for the company: NOTICE_PERIOD is not used (RESIGNED is the notice stage). */
const HIDDEN_BUILTINS = ['NOTICE_PERIOD'];

export const MAX_CUSTOM_STATUSES = 20;
export const MAX_LABEL_LENGTH = 40;

export function readStatusConfig(raw: unknown): EmploymentStatusConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<EmploymentStatusConfig>;
  const custom = Array.isArray(r.custom)
    ? r.custom.filter(
        (c): c is CustomStatus =>
          !!c && typeof c.key === 'string' && typeof c.label === 'string' && STATUS_BEHAVIORS.includes(c.behavior as StatusBehavior),
      ).map((c) => ({ key: c.key, label: c.label, behavior: c.behavior, isActive: c.isActive !== false }))
    : [];
  const labels: Record<string, string> = {};
  if (r.labels && typeof r.labels === 'object') {
    for (const [k, v] of Object.entries(r.labels)) {
      if (k in BUILTIN_STATUS_LABELS && typeof v === 'string' && v.trim()) labels[k] = v.trim().slice(0, MAX_LABEL_LENGTH);
    }
  }
  const inactive = Array.isArray(r.inactive) ? r.inactive.filter((k) => SWITCHABLE_BUILTINS.includes(k)) : [];
  return { custom, labels, inactive };
}

export interface StatusListItem {
  /** The built-in enum value, or the custom status key. */
  key: string;
  label: string;
  builtIn: boolean;
  /** The built-in status it is stored as (itself for a built-in). */
  baseStatus: string;
  behavior: StatusBehavior | null;
  isActive: boolean;
  /** Can be chosen directly when editing a person. */
  selectable: boolean;
  /** Label, and switching off, can be changed. */
  canSwitchOff: boolean;
}

export function buildStatusList(rawConfig: unknown): StatusListItem[] {
  const cfg = readStatusConfig(rawConfig);
  const builtins: StatusListItem[] = Object.keys(BUILTIN_STATUS_LABELS)
    .filter((k) => !HIDDEN_BUILTINS.includes(k))
    .map((k) => ({
      key: k,
      label: cfg.labels[k] ?? BUILTIN_STATUS_LABELS[k],
      builtIn: true,
      baseStatus: k,
      behavior: null,
      isActive: !cfg.inactive.includes(k),
      selectable: SELECTABLE_BUILTINS.includes(k),
      canSwitchOff: SWITCHABLE_BUILTINS.includes(k),
    }));
  const customs: StatusListItem[] = cfg.custom.map((c) => ({
    key: c.key,
    label: c.label,
    builtIn: false,
    baseStatus: BEHAVIOR_BASE[c.behavior],
    behavior: c.behavior,
    isActive: c.isActive,
    selectable: true,
    canSwitchOff: true,
  }));
  return [...builtins, ...customs];
}

/** What a person's status is called for this company: their own status's name, else the built-in one (renamed or not). */
export function statusLabel(rawConfig: unknown, status: string, customKey?: string | null): string {
  const cfg = readStatusConfig(rawConfig);
  // The custom name only counts while the person is still in the built-in status it follows: a resignation or confirmation done by the
  // system moves them on without touching their key, and a removed custom status also falls back to the built-in name.
  const found = customKey ? cfg.custom.find((c) => c.key === customKey) : undefined;
  const own = found && BEHAVIOR_BASE[found.behavior] === status ? found : undefined;
  return own?.label ?? cfg.labels[status] ?? BUILTIN_STATUS_LABELS[status] ?? status;
}

export type ChosenStatus = { employmentStatus: EmploymentStatus; employmentStatusKey: string | null };

/**
 * What to store when a status is chosen by its key (a built-in enum value or a custom key): the enum value and the custom key.
 * Throws a plain-language Error when the choice is not allowed.
 */
export function resolveChosenStatus(rawConfig: unknown, key: string): ChosenStatus {
  const cfg = readStatusConfig(rawConfig);
  const custom = cfg.custom.find((c) => c.key === key);
  if (custom) {
    if (!custom.isActive) throw new Error(`"${custom.label}" is switched off. Pick another status.`);
    return { employmentStatus: BEHAVIOR_BASE[custom.behavior], employmentStatusKey: custom.key };
  }
  if (key in BUILTIN_STATUS_LABELS) {
    if (cfg.inactive.includes(key)) throw new Error(`"${cfg.labels[key] ?? BUILTIN_STATUS_LABELS[key]}" is switched off for your company. Pick another status.`);
    if (!SELECTABLE_BUILTINS.includes(key)) {
      throw new Error(`${BUILTIN_STATUS_LABELS[key]} is set through Resignation / Offboarding, not by editing the status.`);
    }
    return { employmentStatus: key as EmploymentStatus, employmentStatusKey: null };
  }
  throw new Error('That employment status does not exist.');
}

/** True when a built-in status has been switched off for the company (so it cannot be given to anyone new). */
export function isBuiltinSwitchedOff(rawConfig: unknown, status: string): boolean {
  return readStatusConfig(rawConfig).inactive.includes(status);
}

/** A key for a new custom status from its label, unique among the existing ones. */
export function newStatusKey(label: string, taken: string[]): string {
  const base = label.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 30) || 'STATUS';
  const root = `CUSTOM_${base}`;
  let key = root;
  for (let n = 2; taken.includes(key) || key in BUILTIN_STATUS_LABELS; n++) key = `${root}_${n}`;
  return key;
}
