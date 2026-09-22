# On-chain layout, RULE_VERSION = 1

This file is the authority. `web/lib/chain/layout.ts` mirrors it and must be changed in the same
commit. Everything is little-endian with no implicit padding.

## Program id and PDAs

| Thing | Seeds |
|---|---|
| Campaign | `["camp", sponsor_pubkey, campaign_id_u64_le]` |
| Vault (SPL token account, authority = Campaign PDA) | `["vault", campaign_pubkey]` |

## Campaign account, 368 bytes

| Offset | Size | Field | Type | Notes |
|---|---|---|---|---|
| 0 | 1 | tag | u8 | always 1 |
| 1 | 1 | bump | u8 | campaign PDA bump |
| 2 | 1 | status | u8 | see status table |
| 3 | 1 | flags | u8 | bit0 PLEDGE, bits1-2 outcome |
| 4 | 1 | vault_bump | u8 | vault PDA bump |
| 5 | 1 | rule_version | u8 | 1 |
| 6 | 2 | reserved | [u8;2] | zero |
| 8 | 4 | units | u32 | recipients in the locked roster |
| 12 | 4 | reserved2 | [u8;4] | zero |
| 16 | 8 | campaign_id | u64 | |
| 24 | 32 | sponsor | Pubkey | receives leftover funds and rent |
| 56 | 32 | operator | Pubkey | LockRoster, Settle, PostReceipts |
| 88 | 32 | auditor | Pubkey | Dispute, co-signs a re-settle |
| 120 | 32 | disburser | Pubkey | owner of the token account that receives the payout |
| 152 | 32 | mint | Pubkey | |
| 184 | 8 | freeze_ts | i64 | LockRoster deadline |
| 192 | 8 | window_end_ts | i64 | Settle opens at this time |
| 200 | 8 | settled_ts | i64 | start of the dispute window |
| 208 | 8 | amount_full | u64 | per recipient, token base units |
| 216 | 8 | amount_half | u64 | |
| 224 | 4 | thr_full | i32 | mm x 10 |
| 228 | 4 | thr_half | i32 | mm x 10 |
| 232 | 4 | observed | i32 | mm x 10 |
| 236 | 4 | reserved3 | [u8;4] | zero |
| 240 | 32 | terms_hash | [u8;32] | |
| 272 | 32 | roster_root | [u8;32] | |
| 304 | 32 | data_hash | [u8;32] | |
| 336 | 32 | receipts_root | [u8;32] | |

## Status

| Value | Name | Reached by |
|---|---|---|
| 0 | OPEN | CreateCampaign |
| 1 | SETTLED | Settle from OPEN |
| 2 | DISPUTED | Dispute |
| 3 | SETTLED_FINAL | Settle from DISPUTED, auditor co-signed |
| 4 | RELEASED | Release on a settled campaign |
| 5 | RECEIPTED | PostReceipts |
| 6 | REFUNDED | Release after the operator timeout |

## Outcome, bits 1-2 of flags

`observed <= thr_full` → FULL (2). Else `observed <= thr_half` → HALF (1). Else NONE (0).

## Instructions

Tag is one byte, then a fixed-size body. Any other length is rejected.

| Tag | Name | Signer | Accounts in order | Body |
|---|---|---|---|---|
| 0 | CreateCampaign | sponsor | sponsor(w), campaign(w), vault(w), mint, sponsor_token(w), system_program, token_program | 185 B: campaign_id u64, operator 32, auditor 32, disburser 32, freeze_ts i64, window_end_ts i64, amount_full u64, amount_half u64, thr_full i32, thr_half i32, terms_hash 32, deposit u64, pledge u8 |
| 1 | LockRoster | operator | operator, campaign(w), vault | 36 B: units u32, roster_root 32 |
| 2 | Settle | operator, plus auditor when status is DISPUTED | operator, campaign(w), [auditor] | 36 B: observed i32, data_hash 32 |
| 3 | Dispute | auditor | auditor, campaign(w) | empty |
| 4 | Release | none | campaign(w), vault(w), disburser_token(w), sponsor_token(w), sponsor(w), token_program | empty |
| 5 | PostReceipts | operator | operator, campaign(w) | 32 B: receipts_root |

## Timing rules

| Constant | Seconds | Meaning |
|---|---|---|
| DISPUTE_SECS | 172800 | the auditor has 48 h after settlement to dispute; Release waits it out |
| OPERATOR_TIMEOUT_SECS | 2592000 | 30 days after window_end_ts with no settlement, anyone can refund the sponsor |

## Errors

1 InvalidTag, 2 InvalidData, 3 MissingSigner, 4 BadPda, 5 BadOwner, 6 BadMint, 7 WrongStatus,
8 TooEarly, 9 TooLate, 10 Underfunded, 11 Overflow, 12 BadParams.

## What is deliberately not on chain

No Merkle verification and no sha256. Farmers never submit a claim on chain, so the program never
needs to check a proof; the roster root and the receipts root are commitments that anyone verifies
off chain with `scripts/verify.mjs`. This keeps the binary small and the compute budget trivial.
