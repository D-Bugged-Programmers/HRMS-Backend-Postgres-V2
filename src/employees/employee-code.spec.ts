import { codeFitsFormat, codeNumberFor } from './employee-code';

describe('employee code against an ID format', () => {
  it('reads the number from a code that fits', () => {
    expect(codeNumberFor('SIS2-{0000}', 'SIS2-0002')).toBe(2);
    expect(codeNumberFor('DSP-{00000}', 'DSP-00125')).toBe(125);
  });
  it('allows more digits than the format width, never fewer', () => {
    expect(codeFitsFormat('SIS2-{0000}', 'SIS2-12345')).toBe(true);
    expect(codeFitsFormat('SIS2-{0000}', 'SIS2-002')).toBe(false);
  });
  it('refuses another prefix, extra text and a missing prefix', () => {
    expect(codeFitsFormat('SIS2-{0000}', 'SIS-0002')).toBe(false);
    expect(codeFitsFormat('SIS2-{0000}', 'SIS2-0002X')).toBe(false);
    expect(codeFitsFormat('SIS2-{0000}', '0002')).toBe(false);
  });
  it('handles a plain number series and no format', () => {
    expect(codeNumberFor('{0000}', '0002')).toBe(2);
    expect(codeFitsFormat(undefined, 'ANY')).toBe(false);
  });
});
