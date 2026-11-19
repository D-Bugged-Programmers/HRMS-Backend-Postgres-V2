import { BadRequestException } from '@nestjs/common';
import { normalizeWeeklyOffsOverride } from './weekly-off-override';

describe('normalizeWeeklyOffsOverride', () => {
  it('clears on null or an empty list', () => {
    expect(normalizeWeeklyOffsOverride(null)).toBeNull();
    expect(normalizeWeeklyOffsOverride(undefined)).toBeNull();
    expect(normalizeWeeklyOffsOverride([])).toBeNull();
  });
  it('keeps plain days and alternate-week days', () => {
    expect(normalizeWeeklyOffsOverride([0, 3])).toEqual([0, 3]);
    expect(normalizeWeeklyOffsOverride([0, { day: 6, occurrences: [4, 2, 2] }])).toEqual([0, { day: 6, occurrences: [2, 4] }]);
  });
  it('rejects bad input', () => {
    for (const bad of ['x', [7], [-1], [1.5], [1, 1], [{ day: 6, occurrences: [] }], [{ day: 6, occurrences: [6] }], [0, 1, 2, 3, 4, 5, 6, 0]]) {
      expect(() => normalizeWeeklyOffsOverride(bad)).toThrow(BadRequestException);
    }
  });
});
