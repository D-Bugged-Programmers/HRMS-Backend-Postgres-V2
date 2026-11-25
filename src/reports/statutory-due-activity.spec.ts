import { relevantDues, tdsRecordFor, type DueContext } from './statutory-due-activity';
import { upcomingStatutoryDues } from '../scheduled-reminders/reminder-dates';

const ctx = (over: Partial<DueContext> = {}): DueContext => ({
  runMonths: new Set(['2026-09', '2026-10', '2026-11']),
  tdsByMonth: new Map([['2026-09', 4000], ['2026-10', 0], ['2026-11', 0]]),
  moduleStart: new Map([['PF', '2026-09']]),
  challans: [],
  statements: [],
  ...over,
});
const all = new Set(['PF', 'ESI', 'PT', 'LWF']);
const window = Array.from({ length: 460 }, (_, i) => i - 400);
const dues = (today: string) => upcomingStatutoryDues(today, all, window, 14);
const keyDates = (list: { key: string; dueDate: string }[]) => list.map((d) => `${d.key}@${d.dueDate}`);

describe('relevantDues', () => {
  it('drops the TDS deposit for a month in which no TDS was deducted, keeps one where it was', () => {
    const got = keyDates(relevantDues(dues('2026-11-25'), ctx()));
    expect(got).toContain('TDS@2026-10-07'); // September's tax: 4,000 deducted
    expect(got).not.toContain('TDS@2026-11-07'); // October: nil
    expect(got).not.toContain('TDS@2026-12-07'); // November: nil (the run exists)
  });

  it('drops the quarterly return for a quarter with no TDS', () => {
    const got = keyDates(relevantDues(dues('2026-11-25'), ctx({ tdsByMonth: new Map([['2026-09', 0], ['2026-10', 0], ['2026-11', 0]]) })));
    expect(got.some((k) => k.startsWith('24Q@2026-10-31'))).toBe(false);
    const withTds = keyDates(relevantDues(dues('2026-11-25'), ctx()));
    expect(withTds).toContain('24Q@2026-10-31'); // July to September 2026 has TDS in September
  });

  it('keeps an unfiled overdue filing older than 45 days (the one that used to vanish)', () => {
    const got = relevantDues(dues('2026-12-20'), ctx({ tdsByMonth: new Map([['2026-09', 4000]]) }));
    const q2 = got.find((d) => d.key === '24Q' && d.dueDate === '2026-10-31');
    expect(q2).toBeDefined();
    expect(q2!.daysLeft).toBeLessThan(-45);
  });

  it('drops a past PF / ESI due for a month with no payroll or before the module was switched on, keeps a coming one', () => {
    const got = keyDates(relevantDues(dues('2026-11-25'), ctx()));
    expect(got).not.toContain('PF@2026-09-15'); // August: no payroll
    expect(got).toContain('PF@2026-10-15'); // September: payroll ran
    expect(got).toContain('PF@2026-12-15'); // November's, still to come
  });
});

describe('tdsRecordFor', () => {
  const due = (key: string, months: string[]) => ({ key, months });

  it('a TDS deposit is done once the challans cover the TDS deducted that month', () => {
    const partial = ctx({ challans: [{ month: 9, year: 2026, tdsAmount: 1000, bsrCode: '0510308', challanSerialNo: '00281', depositDate: '2026-10-06' }] });
    expect(tdsRecordFor(due('TDS', ['2026-09']), partial)).toBeNull(); // 4,000 deducted, 1,000 deposited
    const full = ctx({ challans: [{ month: 9, year: 2026, tdsAmount: 4000, bsrCode: '0510308', challanSerialNo: '00281', depositDate: '2026-10-06' }] });
    expect(tdsRecordFor(due('TDS', ['2026-09']), full)).toEqual({ filedOn: '2026-10-06', reference: '0510308/00281', amount: 4000 });
  });

  it('a quarterly return is done once its statement receipt is on record', () => {
    expect(tdsRecordFor(due('24Q', ['2026-07', '2026-08', '2026-09']), ctx())).toBeNull();
    const withStatement = ctx({ statements: [{ financialYear: '2026-27', quarter: 2, receiptNumber: 'RRN123456', filedOn: '2026-10-28' }] });
    expect(tdsRecordFor(due('24Q', ['2026-07', '2026-08', '2026-09']), withStatement)).toEqual({ filedOn: '2026-10-28', reference: 'RRN123456', amount: null });
  });

  it('says nothing for PF, ESI, PT or LWF', () => {
    expect(tdsRecordFor(due('PF', ['2026-09']), ctx())).toBeNull();
  });
});
