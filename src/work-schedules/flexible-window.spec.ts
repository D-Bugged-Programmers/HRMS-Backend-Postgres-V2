import { flexibleWindow } from './work-schedules.service';

describe('flexibleWindow', () => {
  it('blank times mean any time of day', () => {
    expect(flexibleWindow(undefined, undefined, 8, 60)).toEqual({
      startTime: '00:00',
      endTime: '23:59',
    });
    expect(flexibleWindow('', '', 8, 60)).toEqual({
      startTime: '00:00',
      endTime: '23:59',
    });
  });
  it('keeps a window that can hold the full day plus the break', () => {
    expect(flexibleWindow('07:00', '19:00', 8, 60)).toEqual({
      startTime: '07:00',
      endTime: '19:00',
    });
  });
  it('needs both times or neither', () => {
    expect(() => flexibleWindow('07:00', '', 8, 60)).toThrow(
      /both the allowed start and end/,
    );
  });
  it('rejects a window that ends before it starts, or is too short for the day', () => {
    expect(() => flexibleWindow('19:00', '07:00', 8, 60)).toThrow(
      /must end after it starts/,
    );
    expect(() => flexibleWindow('10:00', '17:00', 8, 60)).toThrow(
      /shorter than the full-day hours plus the break/,
    );
  });
});
