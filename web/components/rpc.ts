// Reads the Campaign account straight from a Solana RPC node in the browser, so roots used
// for verification never come from our own API.
import { decodeCampaign, type Campaign } from '@/lib/chain/decode';
import type { SolanaCluster } from '@/types/api';

const DEFAULT_RPC: Record<SolanaCluster, string> = {
  'mainnet-beta': 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  testnet: 'https://api.testnet.solana.com',
};

export function rpcUrlFor(cluster: SolanaCluster): string {
  const override = cluster === 'devnet' ? process.env.NEXT_PUBLIC_SOLANA_RPC_DEVNET : process.env.NEXT_PUBLIC_SOLANA_RPC_MAINNET;
  return override && override.length > 0 ? override : DEFAULT_RPC[cluster];
}

export async function fetchCampaignAccount(pubkey: string, cluster: SolanaCluster): Promise<Campaign | null> {
  const res = await fetch(rpcUrlFor(cluster), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [pubkey, { encoding: 'base64', commitment: 'confirmed' }] }),
  });
  if (!res.ok) throw new Error(`rpc ${res.status}`);
  const body = (await res.json()) as { result?: { value?: { data?: [string, string] } | null } };
  const b64 = body.result?.value?.data?.[0];
  if (!b64) return null;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return decodeCampaign(bytes);
}
