# NusaHarvest — Siaga Tanam

A climate-triggered emergency fund for Indonesian rainfed farmers. A sponsor locks money before the
planting season. The list of recipients is frozen before anyone knows whether the rains will fail.
When the season closes, rainfall is measured from public data that anyone can re-fetch, and the
money is released without a claim form, a committee, or a cooperative standing in the middle.

Farmers do not install an app, do not hold a wallet, and do not pay anything. They answer one
WhatsApp message.

## Why this is not the previous version

The earlier NusaHarvest was an AgroFi product: farmers bought cover with a wallet, investors chased
yield, and a cooperative sat between the money and the field. It never moved a single real rupiah,
and it was, in substance, an unlicensed insurance business. This version removes the wallet, the
yield, the cooperative, and the word "insurance". Nobody pays a premium, so nobody is sold a policy.

## What the blockchain is actually for

Three things a spreadsheet cannot do, and nothing else:

1. **The money is locked before the season.** The sponsor cannot quietly withdraw once the weather
   turns.
2. **The roster is frozen before the hazard.** Names cannot be added after the drought is visible.
3. **The settlement input is committed as a hash.** Anyone can re-run `scripts/verify.mjs`, fetch
   the same public rainfall data, and get the same number.

There is no token, no yield, and no on-chain claim. `Release` is permissionless: if the operator
disappears, anyone can trigger the payout, and after 30 days anyone can return the money to the
sponsor.

## Layout

| Path | What it is |
|---|---|
| `program/` | The Solana program. Rust, Pinocchio, `no_std`, six instructions. `program/LAYOUT.md` is the authoritative byte layout. |
| `web/` | Next.js app: landing page, sponsor console, public proof page, farmer lookup, and the API routes. |
| `web/lib/climate.ts` | The rainfall index pipeline. Integer arithmetic in hundredths of a millimetre so two machines get identical results. |
| `scripts/climate/` | Fetch, threshold calibration, and settlement scripts. |
| `scripts/verify.mjs` | The third-party reproducer. This is the proof. |
| `docs/` | Research, flows, and the build plan. |

## Verifying a settlement yourself

```bash
node scripts/verify.mjs --campaign <campaign_pubkey> --rpc <rpc_url>
```

It reads the campaign account from the chain, re-fetches the public rainfall data for the committed
grid cells and window, recomputes the canonical snapshot and its sha256, and tells you whether the
on-chain `data_hash` and outcome match. If they do not, the settlement was wrong, and it says so.

## Status

Research and the on-chain program are done. The web app, API, WhatsApp flow and climate scripts are
in progress. Nothing in this repository ships mock data in a production path; where real data is
missing, the interface says so instead of inventing it.

## Disclosure

This is a rebuild. The previous AgroFi version of NusaHarvest exists in a separate repository and is
disclosed as prior work.
