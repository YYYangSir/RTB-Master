import { evaluateBid } from './auction-rules';

declare const describe: (name: string, run: () => void) => void;
declare const it: (name: string, run: () => void) => void;
declare const expect: (value: unknown) => {
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toMatchObject(expected: unknown): void;
};

const base = {
  currentPriceCent: 10000,
  incrementCent: 10000,
  capPriceCent: 50000,
  endAt: new Date('2026-06-02T12:00:30.000Z'),
  extensionWindowSec: 10,
  extensionSec: 20,
  now: new Date('2026-06-02T12:00:00.000Z').getTime(),
};

describe('evaluateBid', () => {
  it('rejects an illegal low bid', () => {
    expect(evaluateBid({ ...base, amountCent: 19999 })).toEqual({
      accepted: false,
      minimumAmountCent: 20000,
    });
  });

  it('rejects a consecutive bid from the current leader', () => {
    expect(evaluateBid({
      ...base,
      amountCent: 20000,
      userId: 'user-a',
      leaderUserId: 'user-a',
    })).toEqual({
      accepted: false,
      reason: 'SELF_LEADING',
    });
  });

  it('accepts the minimum legal bid without extension outside the window', () => {
    expect(evaluateBid({ ...base, amountCent: 20000 })).toMatchObject({
      accepted: true,
      acceptedAmountCent: 20000,
      isSold: false,
      isExtended: false,
    });
  });

  it('extends a legal last-second bid', () => {
    const result = evaluateBid({
      ...base,
      amountCent: 20000,
      now: new Date('2026-06-02T12:00:25.000Z').getTime(),
    });
    expect(result).toMatchObject({ accepted: true, isExtended: true });
    expect(result.accepted && result.endAt.toISOString()).toBe('2026-06-02T12:00:50.000Z');
  });

  it('sells at the cap price instead of extending', () => {
    expect(evaluateBid({
      ...base,
      amountCent: 60000,
      now: new Date('2026-06-02T12:00:25.000Z').getTime(),
    })).toMatchObject({
      accepted: true,
      acceptedAmountCent: 50000,
      isSold: true,
      isExtended: false,
    });
  });
});
