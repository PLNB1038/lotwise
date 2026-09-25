// Money legs of a swap: the stable counter-leg that turns a token transfer
// into a priced trade. v1 is deliberately USDC-only — a fixed, verifiable set; adding
// more mints here changes what /lots can price and must be a documented decision,
// not an accident of registry drift.
export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDC_DECIMALS = 6;
export const MONEY_MINTS = new Set([USDC_MINT]);
