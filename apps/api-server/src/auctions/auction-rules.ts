export type BidRuleInput = {
  amountCent: number;
  userId?: string;
  leaderUserId?: string | null;
  currentPriceCent: number;
  incrementCent: number;
  capPriceCent: number;
  endAt: Date;
  extensionWindowSec: number;
  extensionSec: number;
  now: number;
};

export function evaluateBid(input: BidRuleInput) {
  if (input.userId && input.leaderUserId === input.userId) {
    return { accepted: false as const, reason: 'SELF_LEADING' as const };
  }

  const minimumAmountCent = input.currentPriceCent + input.incrementCent;
  if (input.amountCent < minimumAmountCent) {
    return { accepted: false as const, minimumAmountCent };
  }

  const acceptedAmountCent = Math.min(input.amountCent, input.capPriceCent);
  const isSold = acceptedAmountCent >= input.capPriceCent;
  const isExtended =
    !isSold && input.endAt.getTime() - input.now <= input.extensionWindowSec * 1000;

  return {
    accepted: true as const,
    minimumAmountCent,
    acceptedAmountCent,
    isSold,
    isExtended,
    endAt: isExtended
      ? new Date(input.endAt.getTime() + input.extensionSec * 1000)
      : input.endAt,
  };
}
