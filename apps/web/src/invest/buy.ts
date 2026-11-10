/* Pure money math for the invest page: exact yoctoNEAR strings, no float rounding on what gets signed. */
const YOCTO = 10n ** 24n;
/** City tokens have 6 decimals. */
const UNIT = 10n ** 6n;
/** What the token keeps from a first purchase: the buyer's token account (~0.00125 NEAR) and its buyers entry (200
    bytes, 0.002 NEAR); see contracts/city-token `buy`. */
export const STORAGE_FEE_YOCTO = 325n * 10n ** 19n;

/** "1.5" NEAR -> "1500000000000000000000000"; null if not a positive decimal with at most 24 places. */
export function nearToYocto(near: string): string | null {
  const m = /^(\d*)(?:\.(\d{0,24}))?$/.exec(near.trim());
  if (!m || (!m[1] && !m[2])) return null;
  const y = BigInt(m[1] || '0') * YOCTO + BigInt((m[2] ?? '').padEnd(24, '0') || '0');
  return y > 0n ? y.toString() : null;
}

/** Whole tokens (a display number) a deposit buys at `priceYocto` per whole token, after the first-buy fee,
    capped at the float left. 0 if the deposit does not even cover the fee. */
export function estimateTokens(depositYocto: string, priceYocto: string, firstBuy: boolean, remainingTokens: number): number {
  const net = BigInt(depositYocto) - (firstBuy ? STORAGE_FEE_YOCTO : 0n);
  const price = BigInt(priceYocto);
  if (net <= 0n || price <= 0n) return 0;
  const units = (net * UNIT) / price;
  return Math.min(Number(units) / Number(UNIT), remainingTokens);
}
