import { isNoticePeriodQuestion, namedDisciplinaryLetter, noticeAnswer, type NoticeFacts } from './notice-period';

const same = (d: string) => d;
const facts = (o: Partial<NoticeFacts> = {}): NoticeFacts => ({ resignation: null, companyDefaultDays: 0, onProbation: false, ...o });

describe('isNoticePeriodQuestion', () => {
  it.each([
    'What is the notice period?', 'What is my notice period?', 'How many days is my notice period?', 'What is the notice period during probation?',
    'What is the notice period after confirmation?', 'notice period', 'How much notice do I need to give if I resign?', 'How long is the notice if I quit?',
  ])('yes: %s', (q) => expect(isNoticePeriodQuestion(q)).toBe(true));
  it.each([
    'Show my show cause notice', 'absconding notice', 'Do I have a show-cause letter?', 'notice period waiver letter', 'notice period recovery in my payslip',
    'How much notice do I need to apply for leave?', 'privacy notice', 'Show my letters', 'What is my salary?',
  ])('no: %s', (q) => expect(isNoticePeriodQuestion(q)).toBe(false));
});

describe('namedDisciplinaryLetter', () => {
  it('picks the letter that is named', () => {
    expect(namedDisciplinaryLetter('Show cause notice')?.label).toBe('show-cause');
    expect(namedDisciplinaryLetter('Do I have an absconding letter?')?.label).toBe('absconding');
    expect(namedDisciplinaryLetter('my warning letter')?.label).toBe('warning');
  });
  it('leaves other questions alone', () => {
    for (const q of ['Show my letters', 'offer letter', 'What is the notice period?', 'What is the termination policy?']) expect(namedDisciplinaryLetter(q)).toBeNull();
  });
});

describe('noticeAnswer', () => {
  const resignation = { status: 'APPROVED' as const, noticePeriodDays: 45, submittedOn: '2026-11-01' };
  it("prefers the person's resignation record over the company default", () => {
    const r = noticeAnswer('What is my notice period?', facts({ resignation, companyDefaultDays: 30 }), same);
    expect(r.answer).toContain('Your notice period is 45 days');
    expect(r.sources).toEqual(['Your resignation record']);
  });
  it('uses the company default, and says when it is not set', () => {
    expect(noticeAnswer('notice period', facts({ companyDefaultDays: 30 }), same).answer).toContain('default notice period is 30 days');
    expect(noticeAnswer('notice period', facts({ companyDefaultDays: 1 }), same).answer).toContain('1 day.');
    const none = noticeAnswer('notice period', facts(), same);
    expect(none.answer).toContain("couldn't find");
    expect(none.sources).toEqual([]);
    expect(none.answer).not.toMatch(/\d/);
  });
  it('never presents a figure as the probation or confirmation notice period', () => {
    for (const q of ['notice period during probation', 'notice period after confirmation']) {
      const r = noticeAnswer(q, facts({ companyDefaultDays: 30 }), same);
      expect(r.answer).toMatch(/^I couldn't find a notice period recorded specifically for/);
      expect(r.answer).toContain("For reference, your company's default notice period is 30 days.");
    }
    expect(noticeAnswer('notice period', facts({ companyDefaultDays: 30, onProbation: true }), same).answer).toContain('You are on probation.');
  });
  it('ignores a pending resignation that only carries an unset 0', () => {
    const r = noticeAnswer('notice period', facts({ resignation: { status: 'PENDING', noticePeriodDays: 0, submittedOn: '2026-11-01' } }), same);
    expect(r.sources).toEqual([]);
  });
});
