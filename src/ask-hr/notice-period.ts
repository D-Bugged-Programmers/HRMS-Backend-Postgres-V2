// Purpose: "Ask HR" questions about the person's notice period: recognising them, and wording the answer from what is recorded.
// Important: pure. The system records a notice period in two places only - on a person's resignation (HR can set it) and as the
//   company's default (Organization Settings), which is what applies when someone resigns. Nothing is recorded by designation,
//   employment type, probation or confirmation, so a figure is never presented as one of those.

/** Whether the question asks how long the person's notice period is (not about a letter that has "notice" in its name). */
export function isNoticePeriodQuestion(question: string): boolean {
  const q = question.toLowerCase();
  // Letters and pay items that merely contain the word.
  if (/\bshow[- ]?cause\b|\babscond\w*|\bwaiver\b|\brecovery\b/.test(q)) return false;
  // How early leave must be applied for is a leave rule, not the notice period of employment.
  if (/\bnotice\b(\s+period)?\s+(for|to (apply|take|request))\b.*\bleaves?\b/.test(q) || (/\bleaves?\b/.test(q) && !/\bnotice[- ]?period\b/.test(q))) return false;
  return (
    /\bnotice[- ]?periods?\b|\bnotice days\b|\b(my|days? of) notice\b/.test(q) ||
    /\bhow (much|long|many days?)\b.*\bnotice\b/.test(q) ||
    /\bnotice\b.*\b(resign\w*|quit\w*)|\b(resign\w*|quit\w*)\b.*\bnotice\b/.test(q)
  );
}

/** A particular disciplinary letter the question names, as a test on a letter's name; null when it names none. */
export function namedDisciplinaryLetter(question: string): { label: string; name: RegExp } | null {
  const kinds: Array<[RegExp, string, RegExp]> = [
    [/\bshow[- ]?cause\b/i, 'show-cause', /show[- ]?cause/i],
    [/\babscond\w*/i, 'absconding', /abscond/i],
    [/\bwarning\b/i, 'warning', /warning/i],
    [/\bsuspension\b/i, 'suspension', /suspension/i],
    [/\btermination\b/i, 'termination', /termination/i],
  ];
  // Only when a document is being asked about: "what is the termination policy" is a policy question.
  if (!/\bletters?\b|\bnotices?\b/i.test(question)) return null;
  const hit = kinds.find(([asked]) => asked.test(question));
  return hit ? { label: hit[1], name: hit[2] } : null;
}

export interface NoticeFacts {
  resignation: { status: 'PENDING' | 'APPROVED'; noticePeriodDays: number | null; submittedOn: string } | null;
  companyDefaultDays: number;
  onProbation: boolean;
}

export function noticeAnswer(question: string, facts: NoticeFacts, formatDate: (d: string) => string): { answer: string; sources: string[] } {
  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  const askedProbation = /\bprobation\w*/i.test(question);
  const askedConfirmed = /\bconfirm\w*/i.test(question);
  const r = facts.resignation;
  // A pending resignation carrying 0 only means no company default was set when it was sent; an approved 0 is HR's decision.
  const own = r && r.noticePeriodDays !== null && (r.noticePeriodDays > 0 || r.status === 'APPROVED') ? r.noticePeriodDays : null;
  const fallback = facts.companyDefaultDays > 0 ? facts.companyDefaultDays : null;
  const noSeparate = 'The system records no separate notice period for probation or confirmation, or by designation or employment type, so check your appointment letter or company policy, or ask HR.';

  if (askedProbation || askedConfirmed) {
    const which = askedProbation && askedConfirmed ? 'during probation or after confirmation' : askedProbation ? 'during probation' : 'after confirmation';
    const reference =
      own !== null
        ? ` For reference, your resignation record shows ${days(own)}.`
        : fallback !== null
          ? ` For reference, your company's default notice period is ${days(fallback)}.`
          : '';
    return {
      answer: `I couldn't find a notice period recorded specifically for ${which}. ${noSeparate}${reference}`,
      sources: own !== null ? ['Your resignation record'] : fallback !== null ? ['Company settings'] : [],
    };
  }
  const probationNote = facts.onProbation ? ` You are on probation. ${noSeparate}` : '';
  if (own !== null && r) {
    return {
      answer: `Your notice period is ${days(own)}, as recorded on your ${r.status === 'APPROVED' ? 'approved' : 'pending'} resignation submitted on ${formatDate(r.submittedOn)}.${r.status === 'PENDING' ? ' HR can change it when deciding your resignation.' : ''}`,
      sources: ['Your resignation record'],
    };
  }
  if (fallback !== null) {
    return {
      answer: `Your company's default notice period is ${days(fallback)}. It applies when you submit a resignation; HR can set a different one when deciding it.${probationNote} Your appointment letter or company policy may say more.`,
      sources: ['Company settings'],
    };
  }
  return { answer: "I couldn't find a notice period in your records or your company's settings. Check your appointment letter or company policy, or ask HR.", sources: [] };
}
