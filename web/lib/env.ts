// Server environment. Every value is read through here so a missing variable fails
// loudly at the call site instead of silently producing a broken request.
//
// Nothing in this file is ever logged. Keys and secrets are returned, never printed.

export type WaTransport = 'meta' | 'local';
export type GatewayMode = 'live' | 'local';

function raw(name: string): string | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : v;
}

export function required(name: string): string {
  const v = raw(name);
  if (v === undefined) throw new Error(`missing required environment variable ${name}`);
  return v;
}

export const optional = (name: string): string | undefined => raw(name);

export const isProduction = (): boolean => process.env.NODE_ENV === 'production';

/**
 * Flags that replace a real external dependency with a local stand-in. They are
 * refused in production so a demo transport can never reach a production path.
 */
function devOnlyFlag(name: string, value: string, allowed: string): void {
  if (value === allowed && isProduction()) {
    throw new Error(`${name}=${allowed} is a development-only transport and is refused when NODE_ENV=production`);
  }
}

export function waTransport(): WaTransport {
  const v = (raw('WA_TRANSPORT') ?? 'meta').toLowerCase();
  if (v !== 'meta' && v !== 'local') throw new Error('WA_TRANSPORT must be "meta" or "local"');
  devOnlyFlag('WA_TRANSPORT', v, 'local');
  return v;
}

export function gatewayMode(): GatewayMode {
  const v = (raw('PAYOUT_GATEWAY_MODE') ?? 'live').toLowerCase();
  if (v !== 'live' && v !== 'local') throw new Error('PAYOUT_GATEWAY_MODE must be "live" or "local"');
  devOnlyFlag('PAYOUT_GATEWAY_MODE', v, 'local');
  return v;
}

export const env = {
  databaseUrl: () => required('DATABASE_URL'),
  databaseSsl: () => (raw('DATABASE_SSL') ?? 'false').toLowerCase() === 'true',

  piiEncKey: () => required('PII_ENC_KEY'),
  piiHmacKey: () => required('PII_HMAC_KEY'),

  cronSecret: () => required('CRON_SECRET'),
  sessionSecret: () => required('SESSION_SECRET'),

  waTransport,
  waAppSecret: () => required('WA_APP_SECRET'),
  waVerifyToken: () => required('WA_VERIFY_TOKEN'),
  waToken: () => required('WA_ACCESS_TOKEN'),
  waPhoneNumberId: () => required('WA_PHONE_NUMBER_ID'),
  waGraphVersion: () => raw('WA_GRAPH_VERSION') ?? 'v21.0',

  gatewayMode,
  gatewayBaseUrl: () => required('PAYOUT_GATEWAY_URL'),
  gatewayKey: () => required('PAYOUT_GATEWAY_KEY'),
  gatewaySecret: () => required('PAYOUT_GATEWAY_SECRET'),

  programId: () => required('NH_PROGRAM_ID'),
  rpcUrl: () => required('SOLANA_RPC_URL'),
  usdcMint: () => required('NH_MINT'),
  operatorPubkey: () => required('NH_OPERATOR_PUBKEY'),
  auditorPubkey: () => required('NH_AUDITOR_PUBKEY'),
  disburserPubkey: () => required('NH_DISBURSER_PUBKEY'),

  cluster: (): 'mainnet-beta' | 'devnet' | 'testnet' => {
    const v = raw('NH_CLUSTER') ?? 'mainnet-beta';
    if (v !== 'mainnet-beta' && v !== 'devnet' && v !== 'testnet') throw new Error('NH_CLUSTER must be mainnet-beta, devnet or testnet');
    return v;
  },
  mintDecimals: () => {
    const v = Number(raw('NH_MINT_DECIMALS') ?? '6');
    if (!Number.isInteger(v) || v < 0 || v > 12) throw new Error('NH_MINT_DECIMALS must be 0..12');
    return v;
  },
  mintSymbol: () => raw('NH_MINT_SYMBOL') ?? 'USDC',
  /** Rupiah per whole token, used to convert amount_*_idr into on-chain base units. Required, never defaulted. */
  idrPerToken: () => {
    const v = Number(required('NH_IDR_PER_TOKEN'));
    if (!Number.isFinite(v) || v <= 0) throw new Error('NH_IDR_PER_TOKEN must be a positive number');
    return v;
  },

  scriptCommit: () => raw('NH_SCRIPT_COMMIT') ?? required('VERCEL_GIT_COMMIT_SHA'),
  publicBaseUrl: () => (raw('NH_PUBLIC_BASE_URL') ?? 'https://nusaharvest.xyz').replace(/\/+$/, ''),

  /** Months of retention for *_enc columns after a campaign reaches RECEIPTED. Spec 4.1: 12. */
  piiRetentionMonths: () => {
    const v = Number(raw('PII_RETENTION_MONTHS') ?? '12');
    if (!Number.isInteger(v) || v < 1 || v > 120) throw new Error('PII_RETENTION_MONTHS must be 1..120');
    return v;
  },
} as const;
