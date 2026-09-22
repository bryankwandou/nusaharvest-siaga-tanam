#![cfg_attr(any(target_os = "solana", target_arch = "bpf"), no_std)]
//! NusaHarvest Siaga Tanam, RULE_VERSION = 1.
//!
//! One program, six instructions, no Anchor, no Borsh, no allocator. The byte layout below is
//! the contract with web/lib/chain/layout.ts; the two must be changed together.
//!
//! What the chain is for, and nothing more:
//!   1. funds are locked before the season and the sponsor cannot pull them back early,
//!   2. the recipient roster is frozen before the hazard window closes,
//!   3. the settlement input is committed as a hash anyone can recompute off-chain.

use pinocchio::{
    cpi::Signer,
    error::ProgramError,
    instruction::seeds,
    no_allocator, nostd_panic_handler, program_entrypoint,
    sysvars::{clock::Clock, rent::Rent, Sysvar},
    AccountView, Address, ProgramResult,
};
use pinocchio_system::instructions::CreateAccount;
use pinocchio_token::instructions::{CloseAccount, InitializeAccount3, Transfer};

program_entrypoint!(process_instruction);
no_allocator!();
nostd_panic_handler!();

// ---------------------------------------------------------------------------
// Constants. Mirrored in web/lib/chain/layout.ts.
// ---------------------------------------------------------------------------

const TAG_CAMPAIGN: u8 = 1;
const RULE_VERSION: u8 = 1;
const CAMPAIGN_LEN: usize = 368;
const TOKEN_ACCOUNT_LEN: u64 = 165;

const DISPUTE_SECS: i64 = 172_800; // 48 hours
const OPERATOR_TIMEOUT_SECS: i64 = 2_592_000; // 30 days

const STATUS_OPEN: u8 = 0;
const STATUS_SETTLED: u8 = 1;
const STATUS_DISPUTED: u8 = 2;
const STATUS_SETTLED_FINAL: u8 = 3;
const STATUS_RELEASED: u8 = 4;
const STATUS_RECEIPTED: u8 = 5;
const STATUS_REFUNDED: u8 = 6;

const FLAG_PLEDGE: u8 = 0b0000_0001;
const FLAG_OUTCOME_SHIFT: u8 = 1;
const FLAG_OUTCOME_MASK: u8 = 0b0000_0110;

const OUTCOME_NONE: u8 = 0;
const OUTCOME_HALF: u8 = 1;
const OUTCOME_FULL: u8 = 2;

// Campaign field offsets.
const O_TAG: usize = 0;
const O_BUMP: usize = 1;
const O_STATUS: usize = 2;
const O_FLAGS: usize = 3;
const O_VAULT_BUMP: usize = 4;
const O_RULE_VERSION: usize = 5;
const O_UNITS: usize = 8;
const O_CAMPAIGN_ID: usize = 16;
const O_SPONSOR: usize = 24;
const O_OPERATOR: usize = 56;
const O_AUDITOR: usize = 88;
const O_DISBURSER: usize = 120;
const O_MINT: usize = 152;
const O_FREEZE_TS: usize = 184;
const O_WINDOW_END_TS: usize = 192;
const O_SETTLED_TS: usize = 200;
const O_AMOUNT_FULL: usize = 208;
const O_AMOUNT_HALF: usize = 216;
const O_THR_FULL: usize = 224;
const O_THR_HALF: usize = 228;
const O_OBSERVED: usize = 232;
const O_TERMS_HASH: usize = 240;
const O_ROSTER_ROOT: usize = 272;
const O_DATA_HASH: usize = 304;
const O_RECEIPTS_ROOT: usize = 336;

// SPL token account field offsets.
const T_MINT: usize = 0;
const T_OWNER: usize = 32;
const T_AMOUNT: usize = 64;

// Error codes.
const E_INVALID_TAG: u32 = 1;
const E_INVALID_DATA: u32 = 2;
const E_MISSING_SIGNER: u32 = 3;
const E_BAD_PDA: u32 = 4;
const E_BAD_OWNER: u32 = 5;
const E_BAD_MINT: u32 = 6;
const E_WRONG_STATUS: u32 = 7;
const E_TOO_EARLY: u32 = 8;
const E_TOO_LATE: u32 = 9;
const E_UNDERFUNDED: u32 = 10;
const E_OVERFLOW: u32 = 11;
const E_BAD_PARAMS: u32 = 12;

#[inline(always)]
fn err(code: u32) -> ProgramError {
    ProgramError::Custom(code)
}

/// Views a slice as a fixed-size array so constant offsets need no bounds checks.
#[inline(always)]
fn fixed<const N: usize>(d: &[u8]) -> Result<&[u8; N], ProgramError> {
    d.try_into().map_err(|_| err(E_INVALID_DATA))
}

#[inline(always)]
fn fixed_mut<const N: usize>(d: &mut [u8]) -> Result<&mut [u8; N], ProgramError> {
    d.try_into().map_err(|_| err(E_INVALID_DATA))
}

// ---------------------------------------------------------------------------
// Little-endian readers. Every caller has already length-checked the slice.
// ---------------------------------------------------------------------------

#[inline(always)]
fn rd_u32(d: &[u8], o: usize) -> u32 {
    u32::from_le_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]])
}

#[inline(always)]
fn rd_i32(d: &[u8], o: usize) -> i32 {
    i32::from_le_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]])
}

#[inline(always)]
fn rd_u64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes([
        d[o],
        d[o + 1],
        d[o + 2],
        d[o + 3],
        d[o + 4],
        d[o + 5],
        d[o + 6],
        d[o + 7],
    ])
}

#[inline(always)]
fn rd_i64(d: &[u8], o: usize) -> i64 {
    i64::from_le_bytes([
        d[o],
        d[o + 1],
        d[o + 2],
        d[o + 3],
        d[o + 4],
        d[o + 5],
        d[o + 6],
        d[o + 7],
    ])
}

#[inline(always)]
fn rd_key(d: &[u8], o: usize) -> Address {
    let mut k = [0u8; 32];
    k.copy_from_slice(&d[o..o + 32]);
    Address::new_from_array(k)
}

#[inline(always)]
fn now() -> Result<i64, ProgramError> {
    Ok(Clock::get()?.unix_timestamp)
}

#[inline(always)]
fn outcome_of(flags: u8) -> u8 {
    (flags & FLAG_OUTCOME_MASK) >> FLAG_OUTCOME_SHIFT
}

/// Confirms the account really is our Campaign PDA and not a look-alike someone passed in.
fn check_campaign(campaign: &AccountView, program_id: &Address) -> Result<(), ProgramError> {
    if campaign.owner() != program_id {
        return Err(err(E_BAD_OWNER));
    }
    if campaign.data_len() != CAMPAIGN_LEN {
        return Err(err(E_INVALID_DATA));
    }
    let (sponsor, id_le, bump) = {
        let g = campaign.try_borrow()?;
        let d = fixed::<CAMPAIGN_LEN>(&g)?;
        if d[O_TAG] != TAG_CAMPAIGN || d[O_RULE_VERSION] != RULE_VERSION {
            return Err(err(E_INVALID_DATA));
        }
        (
            rd_key(d, O_SPONSOR),
            rd_u64(d, O_CAMPAIGN_ID).to_le_bytes(),
            d[O_BUMP],
        )
    };
    // The account is owned by this program and tagged, so it was created by CreateCampaign via
    // invoke_signed; re-hashing the stored seeds is enough to prove it is the canonical PDA.
    let expect = Address::derive_address(
        &[b"camp".as_slice(), sponsor.as_array(), &id_le],
        Some(bump),
        program_id,
    );
    if expect != *campaign.address() {
        return Err(err(E_BAD_PDA));
    }
    Ok(())
}

/// Reads mint, owner and amount out of an SPL token account after checking it is one.
fn token_fields(ai: &AccountView) -> Result<(Address, Address, u64), ProgramError> {
    if ai.owner() != &pinocchio_token::ID {
        return Err(err(E_BAD_OWNER));
    }
    if ai.data_len() < 72 {
        return Err(err(E_INVALID_DATA));
    }
    let g = ai.try_borrow()?;
    let d = fixed::<72>(g.get(..72).ok_or(err(E_INVALID_DATA))?)?;
    Ok((
        rd_key(d, T_MINT),
        rd_key(d, T_OWNER),
        rd_u64(d, T_AMOUNT),
    ))
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

fn process_instruction(program_id: &Address, accounts: &mut [AccountView], data: &[u8]) -> ProgramResult {
    let (tag, body) = data.split_first().ok_or(err(E_INVALID_DATA))?;
    match *tag {
        0 => create_campaign(program_id, accounts, body),
        1 => lock_roster(program_id, accounts, body),
        2 => settle(program_id, accounts, body),
        3 => dispute(program_id, accounts, body),
        4 => release(program_id, accounts, body),
        5 => post_receipts(program_id, accounts, body),
        _ => Err(err(E_INVALID_TAG)),
    }
}

// ---------------------------------------------------------------------------
// 0: CreateCampaign
// accounts: sponsor(s,w), campaign(w), vault(w), mint, sponsor_token(w), system_program, token_program
// data: campaign_id u64 | operator 32 | auditor 32 | disburser 32 | freeze_ts i64 | window_end_ts i64
//       | amount_full u64 | amount_half u64 | thr_full i32 | thr_half i32 | terms_hash 32
//       | deposit u64 | pledge u8                                     (185 bytes after the tag)
// ---------------------------------------------------------------------------

fn create_campaign(program_id: &Address, accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    let d = fixed::<185>(d)?;
    let [sponsor, campaign, vault, mint, sponsor_token, _system_program, _token_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !sponsor.is_signer() {
        return Err(err(E_MISSING_SIGNER));
    }

    let campaign_id = rd_u64(d, 0);
    let operator = rd_key(d, 8);
    let auditor = rd_key(d, 40);
    let disburser = rd_key(d, 72);
    let freeze_ts = rd_i64(d, 104);
    let window_end_ts = rd_i64(d, 112);
    let amount_full = rd_u64(d, 120);
    let amount_half = rd_u64(d, 128);
    let thr_full = rd_i32(d, 136);
    let thr_half = rd_i32(d, 140);
    let terms_hash = &d[144..176];
    let deposit = rd_u64(d, 176);
    let pledge = d[184];

    if pledge > 1 {
        return Err(err(E_INVALID_DATA));
    }
    let t = now()?;
    if !(t < freeze_ts && freeze_ts < window_end_ts) {
        return Err(err(E_BAD_PARAMS));
    }
    if thr_full > thr_half || amount_half > amount_full || amount_full == 0 {
        return Err(err(E_BAD_PARAMS));
    }
    if pledge == 1 && deposit != 0 {
        return Err(err(E_BAD_PARAMS));
    }

    let id_le = campaign_id.to_le_bytes();
    let (camp_key, camp_bump) =
        Address::try_find_program_address(&[b"camp", sponsor.address().as_ref(), &id_le], program_id)
            .ok_or(err(E_BAD_PDA))?;
    if camp_key != *campaign.address() {
        return Err(err(E_BAD_PDA));
    }
    let (vault_key, vault_bump) =
        Address::try_find_program_address(&[b"vault", campaign.address().as_ref()], program_id)
            .ok_or(err(E_BAD_PDA))?;
    if vault_key != *vault.address() {
        return Err(err(E_BAD_PDA));
    }

    let rent = Rent::get()?;

    let camp_bump_arr = [camp_bump];
    let camp_seeds = seeds!(b"camp", sponsor.address().as_ref(), &id_le, &camp_bump_arr);
    CreateAccount {
        from: sponsor,
        to: campaign,
        lamports: rent.try_minimum_balance(CAMPAIGN_LEN)?,
        space: CAMPAIGN_LEN as u64,
        owner: program_id,
    }
    .invoke_signed(&[Signer::from(&camp_seeds[..])])?;

    let vault_bump_arr = [vault_bump];
    let vault_seeds = seeds!(b"vault", campaign.address().as_ref(), &vault_bump_arr);
    CreateAccount {
        from: sponsor,
        to: vault,
        lamports: rent.try_minimum_balance(TOKEN_ACCOUNT_LEN as usize)?,
        space: TOKEN_ACCOUNT_LEN,
        owner: &pinocchio_token::ID,
    }
    .invoke_signed(&[Signer::from(&vault_seeds[..])])?;

    InitializeAccount3::new(vault, mint, campaign.address()).invoke()?;

    {
        let mut g = campaign.try_borrow_mut()?;
    let c = fixed_mut::<CAMPAIGN_LEN>(&mut g)?;
        c[O_TAG] = TAG_CAMPAIGN;
        c[O_BUMP] = camp_bump;
        c[O_STATUS] = STATUS_OPEN;
        c[O_FLAGS] = if pledge == 1 { FLAG_PLEDGE } else { 0 };
        c[O_VAULT_BUMP] = vault_bump;
        c[O_RULE_VERSION] = RULE_VERSION;
        c[O_CAMPAIGN_ID..O_CAMPAIGN_ID + 8].copy_from_slice(&id_le);
        c[O_SPONSOR..O_SPONSOR + 32].copy_from_slice(sponsor.address().as_array());
        c[O_OPERATOR..O_OPERATOR + 32].copy_from_slice(operator.as_array());
        c[O_AUDITOR..O_AUDITOR + 32].copy_from_slice(auditor.as_array());
        c[O_DISBURSER..O_DISBURSER + 32].copy_from_slice(disburser.as_array());
        c[O_MINT..O_MINT + 32].copy_from_slice(mint.address().as_array());
        c[O_FREEZE_TS..O_FREEZE_TS + 8].copy_from_slice(&freeze_ts.to_le_bytes());
        c[O_WINDOW_END_TS..O_WINDOW_END_TS + 8].copy_from_slice(&window_end_ts.to_le_bytes());
        c[O_AMOUNT_FULL..O_AMOUNT_FULL + 8].copy_from_slice(&amount_full.to_le_bytes());
        c[O_AMOUNT_HALF..O_AMOUNT_HALF + 8].copy_from_slice(&amount_half.to_le_bytes());
        c[O_THR_FULL..O_THR_FULL + 4].copy_from_slice(&thr_full.to_le_bytes());
        c[O_THR_HALF..O_THR_HALF + 4].copy_from_slice(&thr_half.to_le_bytes());
        c[O_TERMS_HASH..O_TERMS_HASH + 32].copy_from_slice(terms_hash);
    }

    if deposit > 0 {
        let (st_mint, st_owner, _) = token_fields(sponsor_token)?;
        if &st_mint != mint.address() {
            return Err(err(E_BAD_MINT));
        }
        if &st_owner != sponsor.address() {
            return Err(err(E_BAD_OWNER));
        }
        Transfer::new(sponsor_token, vault, sponsor, deposit)
        .invoke()?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// 1: LockRoster. accounts: operator(s), campaign(w), vault. data: units u32 | roster_root 32
// ---------------------------------------------------------------------------

fn lock_roster(program_id: &Address, accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    let d = fixed::<36>(d)?;
    let [operator, campaign, vault, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !operator.is_signer() {
        return Err(err(E_MISSING_SIGNER));
    }
    check_campaign(campaign, program_id)?;

    let units = rd_u32(d, 0);
    if units == 0 {
        return Err(err(E_BAD_PARAMS));
    }

    let t = now()?;
    let campaign_key = *campaign.address();
    let mut g = campaign.try_borrow_mut()?;
    let c = fixed_mut::<CAMPAIGN_LEN>(&mut g)?;
    if &rd_key(c, O_OPERATOR) != operator.address() {
        return Err(err(E_BAD_OWNER));
    }
    if c[O_STATUS] != STATUS_OPEN {
        return Err(err(E_WRONG_STATUS));
    }
    if t >= rd_i64(c, O_FREEZE_TS) {
        return Err(err(E_TOO_LATE));
    }

    if c[O_FLAGS] & FLAG_PLEDGE == 0 {
        // Escrow mode: the vault must already hold enough for the worst case.
        let (v_mint, v_owner, v_amount) = token_fields(vault)?;
        if v_mint != rd_key(c, O_MINT) {
            return Err(err(E_BAD_MINT));
        }
        if v_owner != campaign_key {
            return Err(err(E_BAD_OWNER));
        }
        let need = (units as u64)
            .checked_mul(rd_u64(c, O_AMOUNT_FULL))
            .ok_or(err(E_OVERFLOW))?;
        if v_amount < need {
            return Err(err(E_UNDERFUNDED));
        }
    }

    c[O_UNITS..O_UNITS + 4].copy_from_slice(&units.to_le_bytes());
    c[O_ROSTER_ROOT..O_ROSTER_ROOT + 32].copy_from_slice(&d[4..36]);
    Ok(())
}

// ---------------------------------------------------------------------------
// 2: Settle. accounts: operator(s), campaign(w), [auditor(s) when re-settling a dispute]
// data: observed i32 | data_hash 32
// ---------------------------------------------------------------------------

fn settle(program_id: &Address, accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    let d = fixed::<36>(d)?;
    let [operator, campaign, rest @ ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !operator.is_signer() {
        return Err(err(E_MISSING_SIGNER));
    }
    check_campaign(campaign, program_id)?;

    let observed = rd_i32(d, 0);
    let t = now()?;
    let mut g = campaign.try_borrow_mut()?;
    let c = fixed_mut::<CAMPAIGN_LEN>(&mut g)?;

    if &rd_key(c, O_OPERATOR) != operator.address() {
        return Err(err(E_BAD_OWNER));
    }
    if t < rd_i64(c, O_WINDOW_END_TS) {
        return Err(err(E_TOO_EARLY));
    }
    if rd_u32(c, O_UNITS) == 0 {
        return Err(err(E_WRONG_STATUS));
    }

    let next_status = match c[O_STATUS] {
        STATUS_OPEN => STATUS_SETTLED,
        STATUS_DISPUTED => {
            // Re-settling after a dispute needs the auditor to co-sign.
            let auditor_key = rd_key(c, O_AUDITOR);
            let signed = rest.iter().any(|a| a.is_signer() && a.address() == &auditor_key);
            if !signed {
                return Err(err(E_MISSING_SIGNER));
            }
            STATUS_SETTLED_FINAL
        }
        _ => return Err(err(E_WRONG_STATUS)),
    };

    let thr_full = rd_i32(c, O_THR_FULL);
    let thr_half = rd_i32(c, O_THR_HALF);
    let outcome = if observed <= thr_full {
        OUTCOME_FULL
    } else if observed <= thr_half {
        OUTCOME_HALF
    } else {
        OUTCOME_NONE
    };

    c[O_FLAGS] = (c[O_FLAGS] & !FLAG_OUTCOME_MASK) | (outcome << FLAG_OUTCOME_SHIFT);
    c[O_OBSERVED..O_OBSERVED + 4].copy_from_slice(&observed.to_le_bytes());
    c[O_DATA_HASH..O_DATA_HASH + 32].copy_from_slice(&d[4..36]);
    c[O_SETTLED_TS..O_SETTLED_TS + 8].copy_from_slice(&t.to_le_bytes());
    c[O_STATUS] = next_status;
    Ok(())
}

// ---------------------------------------------------------------------------
// 3: Dispute. accounts: auditor(s), campaign(w). data: empty
// ---------------------------------------------------------------------------

fn dispute(program_id: &Address, accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    if !d.is_empty() {
        return Err(err(E_INVALID_DATA));
    }
    let [auditor, campaign, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !auditor.is_signer() {
        return Err(err(E_MISSING_SIGNER));
    }
    check_campaign(campaign, program_id)?;

    let t = now()?;
    let mut g = campaign.try_borrow_mut()?;
    let c = fixed_mut::<CAMPAIGN_LEN>(&mut g)?;
    if &rd_key(c, O_AUDITOR) != auditor.address() {
        return Err(err(E_BAD_OWNER));
    }
    if c[O_STATUS] != STATUS_SETTLED {
        return Err(err(E_WRONG_STATUS));
    }
    let deadline = rd_i64(c, O_SETTLED_TS)
        .checked_add(DISPUTE_SECS)
        .ok_or(err(E_OVERFLOW))?;
    if t >= deadline {
        return Err(err(E_TOO_LATE));
    }
    c[O_STATUS] = STATUS_DISPUTED;
    Ok(())
}

// ---------------------------------------------------------------------------
// 4: Release. Permissionless.
// accounts: campaign(w), vault(w), disburser_token(w), sponsor_token(w), sponsor(w), token_program
// ---------------------------------------------------------------------------

fn release(program_id: &Address, accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    if !d.is_empty() {
        return Err(err(E_INVALID_DATA));
    }
    let [campaign, vault, disburser_token, sponsor_token, sponsor, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    check_campaign(campaign, program_id)?;

    let t = now()?;
    let (
        status,
        flags,
        mint,
        camp_sponsor,
        camp_disburser,
        units,
        amount_full,
        amount_half,
        settled_ts,
        window_end_ts,
        camp_id_le,
        camp_bump,
    ) = {
        let g = campaign.try_borrow()?;
        let c = fixed::<CAMPAIGN_LEN>(&g)?;
        (
            c[O_STATUS],
            c[O_FLAGS],
            rd_key(c, O_MINT),
            rd_key(c, O_SPONSOR),
            rd_key(c, O_DISBURSER),
            rd_u32(c, O_UNITS) as u64,
            rd_u64(c, O_AMOUNT_FULL),
            rd_u64(c, O_AMOUNT_HALF),
            rd_i64(c, O_SETTLED_TS),
            rd_i64(c, O_WINDOW_END_TS),
            rd_u64(c, O_CAMPAIGN_ID).to_le_bytes(),
            c[O_BUMP],
        )
    };

    if &camp_sponsor != sponsor.address() {
        return Err(err(E_BAD_OWNER));
    }

    // Which of the two exit paths are we on?
    let refund_only = match status {
        STATUS_SETTLED => {
            let deadline = settled_ts.checked_add(DISPUTE_SECS).ok_or(err(E_OVERFLOW))?;
            if t < deadline {
                return Err(err(E_TOO_EARLY));
            }
            false
        }
        STATUS_SETTLED_FINAL => false,
        STATUS_OPEN => {
            // The operator never settled. After the timeout anyone can return the money.
            let deadline = window_end_ts
                .checked_add(OPERATOR_TIMEOUT_SECS)
                .ok_or(err(E_OVERFLOW))?;
            if t < deadline {
                return Err(err(E_TOO_EARLY));
            }
            true
        }
        _ => return Err(err(E_WRONG_STATUS)),
    };

    let final_status = if refund_only {
        STATUS_REFUNDED
    } else {
        STATUS_RELEASED
    };

    if flags & FLAG_PLEDGE != 0 {
        // Nothing was escrowed, so there is nothing to move. The status change is the whole point:
        // it is the on-chain record that the obligation of the sponsor came due.
        let mut g = campaign.try_borrow_mut()?;
    let c = fixed_mut::<CAMPAIGN_LEN>(&mut g)?;
        c[O_STATUS] = final_status;
        return Ok(());
    }

    let (v_mint, v_owner, v_amount) = token_fields(vault)?;
    if v_mint != mint {
        return Err(err(E_BAD_MINT));
    }
    if &v_owner != campaign.address() {
        return Err(err(E_BAD_OWNER));
    }

    let payout_per = if refund_only {
        0
    } else {
        match outcome_of(flags) {
            OUTCOME_FULL => amount_full,
            OUTCOME_HALF => amount_half,
            _ => 0,
        }
    };
    let mut payout = units.checked_mul(payout_per).ok_or(err(E_OVERFLOW))?;
    if payout > v_amount {
        // Cannot happen for a correctly funded escrow campaign, but never over-draw the vault.
        payout = v_amount;
    }
    let remainder = v_amount - payout;

    let bump_arr = [camp_bump];
    let camp_seeds = seeds!(b"camp", camp_sponsor.as_ref(), &camp_id_le, &bump_arr);

    if payout > 0 {
        let (dt_mint, dt_owner, _) = token_fields(disburser_token)?;
        if dt_mint != mint {
            return Err(err(E_BAD_MINT));
        }
        if dt_owner != camp_disburser {
            return Err(err(E_BAD_OWNER));
        }
        Transfer::new(vault, disburser_token, campaign, payout)
        .invoke_signed(&[Signer::from(&camp_seeds[..])])?;
    }

    if remainder > 0 {
        let (st_mint, st_owner, _) = token_fields(sponsor_token)?;
        if st_mint != mint {
            return Err(err(E_BAD_MINT));
        }
        if &st_owner != sponsor.address() {
            return Err(err(E_BAD_OWNER));
        }
        Transfer::new(vault, sponsor_token, campaign, remainder)
        .invoke_signed(&[Signer::from(&camp_seeds[..])])?;
    }

    // The vault is empty now; return its rent to the sponsor.
    CloseAccount::new(vault, sponsor, campaign)
    .invoke_signed(&[Signer::from(&camp_seeds[..])])?;

    let mut g = campaign.try_borrow_mut()?;
    let c = fixed_mut::<CAMPAIGN_LEN>(&mut g)?;
    c[O_STATUS] = final_status;
    Ok(())
}

// ---------------------------------------------------------------------------
// 5: PostReceipts. accounts: operator(s), campaign(w). data: receipts_root 32
// ---------------------------------------------------------------------------

fn post_receipts(program_id: &Address, accounts: &mut [AccountView], d: &[u8]) -> ProgramResult {
    let d = fixed::<32>(d)?;
    let [operator, campaign, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    if !operator.is_signer() {
        return Err(err(E_MISSING_SIGNER));
    }
    check_campaign(campaign, program_id)?;

    let mut g = campaign.try_borrow_mut()?;
    let c = fixed_mut::<CAMPAIGN_LEN>(&mut g)?;
    if &rd_key(c, O_OPERATOR) != operator.address() {
        return Err(err(E_BAD_OWNER));
    }
    if c[O_STATUS] != STATUS_RELEASED {
        return Err(err(E_WRONG_STATUS));
    }
    let outcome = outcome_of(c[O_FLAGS]);
    if outcome != OUTCOME_FULL && outcome != OUTCOME_HALF {
        return Err(err(E_WRONG_STATUS));
    }
    c[O_RECEIPTS_ROOT..O_RECEIPTS_ROOT + 32].copy_from_slice(d);
    c[O_STATUS] = STATUS_RECEIPTED;
    Ok(())
}
