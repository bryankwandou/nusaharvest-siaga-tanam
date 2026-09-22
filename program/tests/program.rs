//! LiteSVM tests for the NusaHarvest program. They load the SBF binary, so run
//! `cargo build-sbf` before `cargo test`.

use litesvm::LiteSVM;
use solana_account::Account;
use solana_address::Address;
use solana_clock::Clock;
use solana_instruction::{error::InstructionError, AccountMeta, Instruction};
use solana_keypair::Keypair;
use solana_signer::Signer;
use solana_transaction::Transaction;
use solana_transaction_error::TransactionError;

// ---- constants mirrored from LAYOUT.md --------------------------------------------------------

const TOKEN: Address = Address::from_str_const("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const SYSTEM: Address = Address::from_str_const("11111111111111111111111111111111");

const DISPUTE_SECS: i64 = 172_800;
const OPERATOR_TIMEOUT_SECS: i64 = 2_592_000;

const OPEN: u8 = 0;
const SETTLED: u8 = 1;
const DISPUTED: u8 = 2;
const SETTLED_FINAL: u8 = 3;
const RELEASED: u8 = 4;
const RECEIPTED: u8 = 5;
const REFUNDED: u8 = 6;

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

const T0: i64 = 1_700_000_000;
const FREEZE: i64 = T0 + 1_000;
const WINDOW_END: i64 = T0 + 2_000;
const AMOUNT_FULL: u64 = 100;
const AMOUNT_HALF: u64 = 40;
const THR_FULL: i32 = 100;
const THR_HALF: i32 = 200;
const UNITS: u32 = 3;
const EXTRA: u64 = 7; // deposit above the worst case, goes back to the sponsor
const DEPOSIT: u64 = UNITS as u64 * AMOUNT_FULL + EXTRA;
const SPONSOR_START: u64 = 1_000_000;

// ---- fixture ---------------------------------------------------------------------------------

struct Env {
    svm: LiteSVM,
    pid: Address,
    sponsor: Keypair,
    operator: Keypair,
    auditor: Keypair,
    disburser: Address,
    mint: Address,
    sponsor_token: Address,
    disburser_token: Address,
}

#[derive(Clone)]
struct Params {
    campaign_id: u64,
    freeze: i64,
    window_end: i64,
    amount_full: u64,
    amount_half: u64,
    thr_full: i32,
    thr_half: i32,
    deposit: u64,
    pledge: u8,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            campaign_id: 7,
            freeze: FREEZE,
            window_end: WINDOW_END,
            amount_full: AMOUNT_FULL,
            amount_half: AMOUNT_HALF,
            thr_full: THR_FULL,
            thr_half: THR_HALF,
            deposit: DEPOSIT,
            pledge: 0,
        }
    }
}

fn so_path() -> String {
    format!("{}/target/deploy/nusaharvest.so", env!("CARGO_MANIFEST_DIR"))
}

fn mint_data() -> Vec<u8> {
    let mut d = vec![0u8; 82];
    d[44] = 6; // decimals
    d[45] = 1; // is_initialized
    d
}

fn token_data(mint: &Address, owner: &Address, amount: u64) -> Vec<u8> {
    let mut d = vec![0u8; 165];
    d[0..32].copy_from_slice(mint.as_ref());
    d[32..64].copy_from_slice(owner.as_ref());
    d[64..72].copy_from_slice(&amount.to_le_bytes());
    d[108] = 1; // AccountState::Initialized
    d
}

impl Env {
    fn new() -> Self {
        let mut svm = LiteSVM::new();
        let pid = Address::new_unique();
        svm.add_program_from_file(pid, so_path()).expect("build the program with cargo build-sbf first");
        let sponsor = Keypair::new();
        let operator = Keypair::new();
        let auditor = Keypair::new();
        for k in [&sponsor, &operator, &auditor] {
            svm.airdrop(&k.pubkey(), 10_000_000_000).unwrap();
        }
        let disburser = Address::new_unique();
        let mint = Address::new_unique();
        let mut env = Env {
            svm,
            pid,
            sponsor,
            operator,
            auditor,
            disburser,
            mint,
            sponsor_token: Address::new_unique(),
            disburser_token: Address::new_unique(),
        };
        env.put(mint, TOKEN, mint_data());
        let s = env.sponsor.pubkey();
        env.put(env.sponsor_token, TOKEN, token_data(&mint, &s, SPONSOR_START));
        env.put(env.disburser_token, TOKEN, token_data(&mint, &disburser, 0));
        env.set_time(T0);
        env
    }

    fn put(&mut self, addr: Address, owner: Address, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm
            .set_account(addr, Account { lamports, data, owner, executable: false, rent_epoch: 0 })
            .unwrap();
    }

    fn new_token_account(&mut self, mint: &Address, owner: &Address, amount: u64) -> Address {
        let a = Address::new_unique();
        self.put(a, TOKEN, token_data(mint, owner, amount));
        a
    }

    fn set_time(&mut self, ts: i64) {
        let mut c: Clock = self.svm.get_sysvar();
        c.unix_timestamp = ts;
        self.svm.set_sysvar(&c);
    }

    fn campaign(&self, id: u64) -> Address {
        Address::find_program_address(
            &[b"camp", self.sponsor.pubkey().as_ref(), &id.to_le_bytes()],
            &self.pid,
        )
        .0
    }

    fn vault(&self, campaign: &Address) -> Address {
        Address::find_program_address(&[b"vault", campaign.as_ref()], &self.pid).0
    }

    fn send(&mut self, ix: Instruction, payer: &Keypair, signers: &[&Keypair]) -> Result<(), TransactionError> {
        self.svm.expire_blockhash();
        let tx = Transaction::new_signed_with_payer(
            &[ix],
            Some(&payer.pubkey()),
            signers,
            self.svm.latest_blockhash(),
        );
        self.svm.send_transaction(tx).map(|_| ()).map_err(|e| e.err)
    }

    fn data(&self, a: &Address) -> Vec<u8> {
        self.svm.get_account(a).map(|a| a.data).unwrap_or_default()
    }

    fn status(&self, id: u64) -> u8 {
        self.data(&self.campaign(id))[2]
    }

    fn outcome(&self, id: u64) -> u8 {
        (self.data(&self.campaign(id))[3] & 0b110) >> 1
    }

    fn token_amount(&self, a: &Address) -> u64 {
        let d = self.data(a);
        u64::from_le_bytes(d[64..72].try_into().unwrap())
    }

    // ---- instruction builders ----

    fn create_ix(&self, p: &Params) -> Instruction {
        let campaign = self.campaign(p.campaign_id);
        let vault = self.vault(&campaign);
        self.create_ix_with(p, campaign, vault, self.sponsor_token, true)
    }

    fn create_ix_with(&self, p: &Params, campaign: Address, vault: Address, sponsor_token: Address, sponsor_signs: bool) -> Instruction {
        let mut d = vec![0u8];
        d.extend_from_slice(&p.campaign_id.to_le_bytes());
        d.extend_from_slice(self.operator.pubkey().as_ref());
        d.extend_from_slice(self.auditor.pubkey().as_ref());
        d.extend_from_slice(self.disburser.as_ref());
        d.extend_from_slice(&p.freeze.to_le_bytes());
        d.extend_from_slice(&p.window_end.to_le_bytes());
        d.extend_from_slice(&p.amount_full.to_le_bytes());
        d.extend_from_slice(&p.amount_half.to_le_bytes());
        d.extend_from_slice(&p.thr_full.to_le_bytes());
        d.extend_from_slice(&p.thr_half.to_le_bytes());
        d.extend_from_slice(&[0xAB; 32]);
        d.extend_from_slice(&p.deposit.to_le_bytes());
        d.push(p.pledge);
        assert_eq!(d.len(), 186);
        Instruction {
            program_id: self.pid,
            accounts: vec![
                AccountMeta::new(self.sponsor.pubkey(), sponsor_signs),
                AccountMeta::new(campaign, false),
                AccountMeta::new(vault, false),
                AccountMeta::new_readonly(self.mint, false),
                AccountMeta::new(sponsor_token, false),
                AccountMeta::new_readonly(SYSTEM, false),
                AccountMeta::new_readonly(TOKEN, false),
            ],
            data: d,
        }
    }

    fn create(&mut self, p: &Params) -> Result<(), TransactionError> {
        let ix = self.create_ix(p);
        let s = self.sponsor.insecure_clone();
        self.send(ix, &s, &[&s])
    }

    fn lock_ix(&self, id: u64, units: u32, operator: &Address, signer: bool, vault: Option<Address>) -> Instruction {
        let campaign = self.campaign(id);
        let vault = vault.unwrap_or_else(|| self.vault(&campaign));
        let mut d = vec![1u8];
        d.extend_from_slice(&units.to_le_bytes());
        d.extend_from_slice(&[0x11; 32]);
        Instruction {
            program_id: self.pid,
            accounts: vec![
                AccountMeta::new_readonly(*operator, signer),
                AccountMeta::new(campaign, false),
                AccountMeta::new_readonly(vault, false),
            ],
            data: d,
        }
    }

    fn lock(&mut self, id: u64, units: u32) -> Result<(), TransactionError> {
        let ix = self.lock_ix(id, units, &self.operator.pubkey(), true, None);
        let o = self.operator.insecure_clone();
        self.send(ix, &o, &[&o])
    }

    fn settle_ix(&self, id: u64, observed: i32, operator: &Address, op_signs: bool, auditor: Option<(Address, bool)>) -> Instruction {
        let mut d = vec![2u8];
        d.extend_from_slice(&observed.to_le_bytes());
        d.extend_from_slice(&[0x22; 32]);
        let mut accounts = vec![
            AccountMeta::new_readonly(*operator, op_signs),
            AccountMeta::new(self.campaign(id), false),
        ];
        if let Some((a, s)) = auditor {
            accounts.push(AccountMeta::new_readonly(a, s));
        }
        Instruction { program_id: self.pid, accounts, data: d }
    }

    fn settle(&mut self, id: u64, observed: i32) -> Result<(), TransactionError> {
        let ix = self.settle_ix(id, observed, &self.operator.pubkey(), true, None);
        let o = self.operator.insecure_clone();
        self.send(ix, &o, &[&o])
    }

    fn resettle(&mut self, id: u64, observed: i32) -> Result<(), TransactionError> {
        let ix = self.settle_ix(id, observed, &self.operator.pubkey(), true, Some((self.auditor.pubkey(), true)));
        let o = self.operator.insecure_clone();
        let a = self.auditor.insecure_clone();
        self.send(ix, &o, &[&o, &a])
    }

    fn dispute_ix(&self, id: u64, auditor: &Address, signer: bool) -> Instruction {
        Instruction {
            program_id: self.pid,
            accounts: vec![
                AccountMeta::new_readonly(*auditor, signer),
                AccountMeta::new(self.campaign(id), false),
            ],
            data: vec![3u8],
        }
    }

    fn dispute(&mut self, id: u64) -> Result<(), TransactionError> {
        let ix = self.dispute_ix(id, &self.auditor.pubkey(), true);
        let a = self.auditor.insecure_clone();
        self.send(ix, &a, &[&a])
    }

    fn release_ix_with(&self, id: u64, disburser_token: Address, sponsor_token: Address, sponsor: Address) -> Instruction {
        let campaign = self.campaign(id);
        Instruction {
            program_id: self.pid,
            accounts: vec![
                AccountMeta::new(campaign, false),
                AccountMeta::new(self.vault(&campaign), false),
                AccountMeta::new(disburser_token, false),
                AccountMeta::new(sponsor_token, false),
                AccountMeta::new(sponsor, false),
                AccountMeta::new_readonly(TOKEN, false),
            ],
            data: vec![4u8],
        }
    }

    /// Release is permissionless: a stranger pays for it.
    fn release(&mut self, id: u64) -> Result<(), TransactionError> {
        let ix = self.release_ix_with(id, self.disburser_token, self.sponsor_token, self.sponsor.pubkey());
        self.send_as_stranger(ix)
    }

    fn send_as_stranger(&mut self, ix: Instruction) -> Result<(), TransactionError> {
        let stranger = Keypair::new();
        self.svm.airdrop(&stranger.pubkey(), 1_000_000_000).unwrap();
        self.send(ix, &stranger, &[&stranger])
    }

    fn receipts_ix(&self, id: u64, operator: &Address, signer: bool, len: usize) -> Instruction {
        let mut d = vec![5u8];
        d.extend(std::iter::repeat(0x33).take(len));
        Instruction {
            program_id: self.pid,
            accounts: vec![
                AccountMeta::new_readonly(*operator, signer),
                AccountMeta::new(self.campaign(id), false),
            ],
            data: d,
        }
    }

    fn receipts(&mut self, id: u64) -> Result<(), TransactionError> {
        let ix = self.receipts_ix(id, &self.operator.pubkey(), true, 32);
        let o = self.operator.insecure_clone();
        self.send(ix, &o, &[&o])
    }

    /// OPEN, funded, roster locked.
    fn locked(&mut self) -> u64 {
        self.create(&Params::default()).unwrap();
        self.lock(7, UNITS).unwrap();
        7
    }

    /// SETTLED with the given observation, clock at settlement time.
    fn settled(&mut self, observed: i32) -> u64 {
        let id = self.locked();
        self.set_time(WINDOW_END);
        self.settle(id, observed).unwrap();
        id
    }
}

fn custom(code: u32) -> Result<(), TransactionError> {
    Err(TransactionError::InstructionError(0, InstructionError::Custom(code)))
}

fn rd_i64(d: &[u8], o: usize) -> i64 {
    i64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}

// ---- CreateCampaign --------------------------------------------------------------------------

#[test]
fn create_escrow_writes_layout_and_funds_vault() {
    let mut e = Env::new();
    e.create(&Params::default()).unwrap();
    let c = e.campaign(7);
    let d = e.data(&c);
    assert_eq!(d.len(), 368);
    assert_eq!(e.svm.get_account(&c).unwrap().owner, e.pid);
    let (_, bump) = Address::find_program_address(&[b"camp", e.sponsor.pubkey().as_ref(), &7u64.to_le_bytes()], &e.pid);
    let (vault, vbump) = Address::find_program_address(&[b"vault", c.as_ref()], &e.pid);
    assert_eq!(&d[0..8], &[1, bump, OPEN, 0, vbump, 1, 0, 0]);
    assert_eq!(&d[8..16], &[0; 8]); // units + reserved2
    assert_eq!(&d[16..24], &7u64.to_le_bytes());
    assert_eq!(&d[24..56], e.sponsor.pubkey().as_ref());
    assert_eq!(&d[56..88], e.operator.pubkey().as_ref());
    assert_eq!(&d[88..120], e.auditor.pubkey().as_ref());
    assert_eq!(&d[120..152], e.disburser.as_ref());
    assert_eq!(&d[152..184], e.mint.as_ref());
    assert_eq!(rd_i64(&d, 184), FREEZE);
    assert_eq!(rd_i64(&d, 192), WINDOW_END);
    assert_eq!(rd_i64(&d, 200), 0);
    assert_eq!(&d[208..216], &AMOUNT_FULL.to_le_bytes());
    assert_eq!(&d[216..224], &AMOUNT_HALF.to_le_bytes());
    assert_eq!(&d[224..228], &THR_FULL.to_le_bytes());
    assert_eq!(&d[228..232], &THR_HALF.to_le_bytes());
    assert_eq!(&d[232..240], &[0; 8]);
    assert_eq!(&d[240..272], &[0xAB; 32]);
    assert_eq!(&d[272..368], &[0; 96]);
    // Vault: SPL token account owned by the token program, authority = campaign PDA.
    let v = e.svm.get_account(&vault).unwrap();
    assert_eq!(v.owner, TOKEN);
    assert_eq!(&v.data[0..32], e.mint.as_ref());
    assert_eq!(&v.data[32..64], c.as_ref());
    assert_eq!(e.token_amount(&vault), DEPOSIT);
    assert_eq!(e.token_amount(&e.sponsor_token), SPONSOR_START - DEPOSIT);
}

#[test]
fn create_pledge_moves_no_tokens() {
    let mut e = Env::new();
    e.create(&Params { deposit: 0, pledge: 1, ..Default::default() }).unwrap();
    let d = e.data(&e.campaign(7));
    assert_eq!(d[3], 1); // FLAG_PLEDGE
    assert_eq!(e.token_amount(&e.vault(&e.campaign(7))), 0);
    assert_eq!(e.token_amount(&e.sponsor_token), SPONSOR_START);
}

#[test]
fn create_escrow_with_zero_deposit_is_allowed() {
    let mut e = Env::new();
    e.create(&Params { deposit: 0, ..Default::default() }).unwrap();
    assert_eq!(e.status(7), OPEN);
}

#[test]
fn create_rejects_bad_params() {
    let mut e = Env::new();
    let cases = [
        Params { freeze: T0, ..Default::default() },               // freeze not in the future
        Params { freeze: T0 - 1, ..Default::default() },
        Params { window_end: FREEZE, ..Default::default() },       // window_end must be after freeze
        Params { thr_full: THR_HALF + 1, ..Default::default() },   // thr_full > thr_half
        Params { amount_half: AMOUNT_FULL + 1, ..Default::default() },
        Params { amount_full: 0, amount_half: 0, ..Default::default() },
        Params { pledge: 1, deposit: 1, ..Default::default() },    // pledge with a deposit
    ];
    for p in cases.iter() {
        assert_eq!(e.create(p), custom(E_BAD_PARAMS));
    }
    assert!(e.svm.get_account(&e.campaign(7)).is_none());
}

#[test]
fn create_rejects_invalid_data() {
    let mut e = Env::new();
    assert_eq!(e.create(&Params { pledge: 2, ..Default::default() }), custom(E_INVALID_DATA));
    let s = e.sponsor.insecure_clone();
    for len in [185usize, 187] {
        let mut ix = e.create_ix(&Params::default());
        ix.data.resize(len, 0);
        assert_eq!(e.send(ix, &s, &[&s]), custom(E_INVALID_DATA));
    }
}

#[test]
fn create_requires_sponsor_signature() {
    let mut e = Env::new();
    let p = Params::default();
    let c = e.campaign(7);
    let ix = e.create_ix_with(&p, c, e.vault(&c), e.sponsor_token, false);
    let o = e.operator.insecure_clone();
    assert_eq!(e.send(ix, &o, &[&o]), custom(E_MISSING_SIGNER));
}

#[test]
fn create_rejects_wrong_pdas() {
    let mut e = Env::new();
    let p = Params::default();
    let s = e.sponsor.insecure_clone();
    let c = e.campaign(7);
    let ix = e.create_ix_with(&p, e.campaign(8), e.vault(&c), e.sponsor_token, true);
    assert_eq!(e.send(ix, &s, &[&s]), custom(E_BAD_PDA));
    let ix = e.create_ix_with(&p, c, e.vault(&e.campaign(8)), e.sponsor_token, true);
    assert_eq!(e.send(ix, &s, &[&s]), custom(E_BAD_PDA));
}

#[test]
fn create_checks_sponsor_token_account() {
    let mut e = Env::new();
    let p = Params::default();
    let s = e.sponsor.insecure_clone();
    let c = e.campaign(7);
    let v = e.vault(&c);
    let other_mint = Address::new_unique();
    e.put(other_mint, TOKEN, mint_data());
    let wrong_mint = e.new_token_account(&other_mint, &s.pubkey(), SPONSOR_START);
    let ix = e.create_ix_with(&p, c, v, wrong_mint, true);
    assert_eq!(e.send(ix, &s, &[&s]), custom(E_BAD_MINT));
    let wrong_owner = e.new_token_account(&e.mint.clone(), &e.operator.pubkey(), SPONSOR_START);
    let ix = e.create_ix_with(&p, c, v, wrong_owner, true);
    assert_eq!(e.send(ix, &s, &[&s]), custom(E_BAD_OWNER));
    let not_token = Address::new_unique();
    e.put(not_token, SYSTEM, token_data(&e.mint.clone(), &s.pubkey(), SPONSOR_START));
    let ix = e.create_ix_with(&p, c, v, not_token, true);
    assert_eq!(e.send(ix, &s, &[&s]), custom(E_BAD_OWNER));
}

// ---- dispatch ----------------------------------------------------------------------------------

#[test]
fn unknown_tag_and_empty_data() {
    let mut e = Env::new();
    let s = e.sponsor.insecure_clone();
    for tag in [6u8, 255] {
        let ix = Instruction { program_id: e.pid, accounts: vec![AccountMeta::new(s.pubkey(), true)], data: vec![tag] };
        assert_eq!(e.send(ix, &s, &[&s]), custom(E_INVALID_TAG));
    }
    let ix = Instruction { program_id: e.pid, accounts: vec![AccountMeta::new(s.pubkey(), true)], data: vec![] };
    assert_eq!(e.send(ix, &s, &[&s]), custom(E_INVALID_DATA));
}

#[test]
fn empty_body_instructions_reject_trailing_bytes() {
    let mut e = Env::new();
    let id = e.settled(50);
    let a = e.auditor.insecure_clone();
    let mut ix = e.dispute_ix(id, &a.pubkey(), true);
    ix.data.push(0);
    assert_eq!(e.send(ix, &a, &[&a]), custom(E_INVALID_DATA));
    let mut ix = e.release_ix_with(id, e.disburser_token, e.sponsor_token, e.sponsor.pubkey());
    ix.data.push(0);
    assert_eq!(e.send_as_stranger(ix), custom(E_INVALID_DATA));
}

// ---- LockRoster --------------------------------------------------------------------------------

#[test]
fn lock_roster_records_units_and_root() {
    let mut e = Env::new();
    let id = e.locked();
    let d = e.data(&e.campaign(id));
    assert_eq!(&d[8..12], &UNITS.to_le_bytes());
    assert_eq!(&d[272..304], &[0x11; 32]);
    assert_eq!(d[2], OPEN);
    // Can be re-locked (e.g. a corrected roster) while still before freeze.
    e.lock(id, 2).unwrap();
    assert_eq!(&e.data(&e.campaign(id))[8..12], &2u32.to_le_bytes());
}

#[test]
fn lock_roster_errors() {
    let mut e = Env::new();
    e.create(&Params::default()).unwrap();
    let o = e.operator.insecure_clone();
    let a = e.auditor.insecure_clone();

    let mut ix = e.lock_ix(7, UNITS, &o.pubkey(), true, None);
    ix.data.pop();
    assert_eq!(e.send(ix, &o, &[&o]), custom(E_INVALID_DATA));

    let ix = e.lock_ix(7, UNITS, &o.pubkey(), false, None);
    assert_eq!(e.send(ix, &a, &[&a]), custom(E_MISSING_SIGNER));

    let ix = e.lock_ix(7, UNITS, &a.pubkey(), true, None);
    assert_eq!(e.send(ix, &a, &[&a]), custom(E_BAD_OWNER));

    assert_eq!(e.lock(7, 0), custom(E_BAD_PARAMS));
    assert_eq!(e.lock(7, UNITS + 1), custom(E_UNDERFUNDED)); // deposit covers 3 units + 7

    // Vault account substitution.
    let c = e.campaign(7);
    let other_mint = Address::new_unique();
    e.put(other_mint, TOKEN, mint_data());
    let fake = e.new_token_account(&other_mint, &c, DEPOSIT);
    let ix = e.lock_ix(7, UNITS, &o.pubkey(), true, Some(fake));
    assert_eq!(e.send(ix, &o, &[&o]), custom(E_BAD_MINT));
    let fake = e.new_token_account(&e.mint.clone(), &o.pubkey(), DEPOSIT);
    let ix = e.lock_ix(7, UNITS, &o.pubkey(), true, Some(fake));
    assert_eq!(e.send(ix, &o, &[&o]), custom(E_BAD_OWNER));

    // Freeze deadline: allowed at freeze-1, rejected at freeze.
    e.set_time(FREEZE - 1);
    e.lock(7, UNITS).unwrap();
    e.set_time(FREEZE);
    assert_eq!(e.lock(7, UNITS), custom(E_TOO_LATE));
}

#[test]
fn lock_roster_overflow() {
    let mut e = Env::new();
    e.create(&Params { amount_full: u64::MAX, amount_half: 0, deposit: 0, ..Default::default() }).unwrap();
    assert_eq!(e.lock(7, 2), custom(E_OVERFLOW));
}

#[test]
fn lock_roster_pledge_needs_no_funds() {
    let mut e = Env::new();
    e.create(&Params { deposit: 0, pledge: 1, ..Default::default() }).unwrap();
    e.lock(7, 1_000).unwrap();
}

#[test]
fn lock_roster_after_settle_is_wrong_status() {
    let mut e = Env::new();
    let id = e.settled(50);
    assert_eq!(e.lock(id, UNITS), custom(E_WRONG_STATUS));
}

#[test]
fn campaign_account_checks() {
    let mut e = Env::new();
    let id = e.locked();
    let real = e.campaign(id);
    let data = e.data(&real);
    let o = e.operator.insecure_clone();
    let pid = e.pid;

    // Not owned by the program.
    let imposter = Address::new_unique();
    e.put(imposter, SYSTEM, data.clone());
    let mut ix = e.settle_ix(id, 0, &o.pubkey(), true, None);
    ix.accounts[1] = AccountMeta::new(imposter, false);
    assert_eq!(e.send(ix.clone(), &o, &[&o]), custom(E_BAD_OWNER));

    // Owned by the program, right data, wrong address.
    e.put(imposter, pid, data.clone());
    e.set_time(WINDOW_END);
    assert_eq!(e.send(ix.clone(), &o, &[&o]), custom(E_BAD_PDA));

    // Wrong length / wrong tag.
    let mut short = data.clone();
    short.pop();
    e.put(imposter, pid, short);
    assert_eq!(e.send(ix.clone(), &o, &[&o]), custom(E_INVALID_DATA));
    let mut bad_tag = data.clone();
    bad_tag[0] = 2;
    e.put(imposter, pid, bad_tag);
    assert_eq!(e.send(ix.clone(), &o, &[&o]), custom(E_INVALID_DATA));
    let mut bad_rule = data;
    bad_rule[5] = 2;
    e.put(imposter, pid, bad_rule);
    assert_eq!(e.send(ix, &o, &[&o]), custom(E_INVALID_DATA));
}

// ---- Settle ------------------------------------------------------------------------------------

#[test]
fn settle_outcomes_and_fields() {
    for (obs, outcome) in [(THR_FULL - 5, 2u8), (THR_FULL, 2), (THR_FULL + 1, 1), (THR_HALF, 1), (THR_HALF + 1, 0)] {
        let mut e = Env::new();
        let id = e.settled(obs);
        let d = e.data(&e.campaign(id));
        assert_eq!(d[2], SETTLED);
        assert_eq!(e.outcome(id), outcome, "observed {obs}");
        assert_eq!(d[3] & 1, 0);
        assert_eq!(&d[232..236], &obs.to_le_bytes());
        assert_eq!(&d[304..336], &[0x22; 32]);
        assert_eq!(rd_i64(&d, 200), WINDOW_END);
    }
}

#[test]
fn settle_keeps_pledge_flag() {
    let mut e = Env::new();
    e.create(&Params { deposit: 0, pledge: 1, ..Default::default() }).unwrap();
    e.lock(7, UNITS).unwrap();
    e.set_time(WINDOW_END);
    e.settle(7, THR_HALF).unwrap();
    assert_eq!(e.data(&e.campaign(7))[3], 1 | (1 << 1));
}

#[test]
fn settle_errors() {
    let mut e = Env::new();
    e.create(&Params::default()).unwrap();
    let o = e.operator.insecure_clone();
    let a = e.auditor.insecure_clone();

    e.set_time(WINDOW_END);
    assert_eq!(e.settle(7, 0), custom(E_WRONG_STATUS)); // roster never locked
    e.set_time(T0);
    e.lock(7, UNITS).unwrap();

    let mut ix = e.settle_ix(7, 0, &o.pubkey(), true, None);
    ix.data.push(0);
    assert_eq!(e.send(ix, &o, &[&o]), custom(E_INVALID_DATA));
    let ix = e.settle_ix(7, 0, &o.pubkey(), false, None);
    assert_eq!(e.send(ix, &a, &[&a]), custom(E_MISSING_SIGNER));
    let ix = e.settle_ix(7, 0, &a.pubkey(), true, None);
    assert_eq!(e.send(ix, &a, &[&a]), custom(E_BAD_OWNER));

    e.set_time(WINDOW_END - 1);
    assert_eq!(e.settle(7, 0), custom(E_TOO_EARLY));
    e.set_time(WINDOW_END);
    e.settle(7, 0).unwrap();
    assert_eq!(e.settle(7, 0), custom(E_WRONG_STATUS)); // already SETTLED
}

// ---- Dispute and re-settle ---------------------------------------------------------------------

#[test]
fn dispute_window_is_48h() {
    let mut e = Env::new();
    let id = e.settled(50);
    e.set_time(WINDOW_END + DISPUTE_SECS - 1);
    e.dispute(id).unwrap();
    assert_eq!(e.status(id), DISPUTED);

    let mut e = Env::new();
    let id = e.settled(50);
    e.set_time(WINDOW_END + DISPUTE_SECS);
    assert_eq!(e.dispute(id), custom(E_TOO_LATE));
    assert_eq!(e.status(id), SETTLED);
}

#[test]
fn dispute_errors() {
    let mut e = Env::new();
    let id = e.locked();
    let a = e.auditor.insecure_clone();
    let o = e.operator.insecure_clone();
    assert_eq!(e.dispute(id), custom(E_WRONG_STATUS)); // OPEN
    e.set_time(WINDOW_END);
    e.settle(id, 50).unwrap();
    let ix = e.dispute_ix(id, &a.pubkey(), false);
    assert_eq!(e.send(ix, &o, &[&o]), custom(E_MISSING_SIGNER));
    let ix = e.dispute_ix(id, &o.pubkey(), true);
    assert_eq!(e.send(ix, &o, &[&o]), custom(E_BAD_OWNER));
    e.dispute(id).unwrap();
    assert_eq!(e.dispute(id), custom(E_WRONG_STATUS)); // already DISPUTED
}

#[test]
fn resettle_needs_auditor_and_becomes_final() {
    let mut e = Env::new();
    let id = e.settled(THR_HALF + 50); // NONE
    e.dispute(id).unwrap();
    let o = e.operator.insecure_clone();
    let a = e.auditor.insecure_clone();

    assert_eq!(e.settle(id, THR_FULL), custom(E_MISSING_SIGNER)); // no auditor account
    let ix = e.settle_ix(id, THR_FULL, &o.pubkey(), true, Some((a.pubkey(), false)));
    assert_eq!(e.send(ix, &o, &[&o]), custom(E_MISSING_SIGNER)); // auditor present, not signing
    let stranger = Keypair::new();
    let ix = e.settle_ix(id, THR_FULL, &o.pubkey(), true, Some((stranger.pubkey(), true)));
    assert_eq!(e.send(ix, &o, &[&o, &stranger]), custom(E_MISSING_SIGNER)); // wrong co-signer

    e.set_time(WINDOW_END + 10 * DISPUTE_SECS); // no deadline on re-settling
    e.resettle(id, THR_FULL).unwrap();
    assert_eq!(e.status(id), SETTLED_FINAL);
    assert_eq!(e.outcome(id), 2);
    assert_eq!(rd_i64(&e.data(&e.campaign(id)), 200), WINDOW_END + 10 * DISPUTE_SECS);
    assert_eq!(e.dispute(id), custom(E_WRONG_STATUS));
    assert_eq!(e.resettle(id, 0), custom(E_WRONG_STATUS));
}

// ---- Release -----------------------------------------------------------------------------------

fn assert_released(e: &Env, id: u64, payout: u64, status: u8) {
    let c = e.campaign(id);
    assert_eq!(e.status(id), status);
    assert_eq!(e.token_amount(&e.disburser_token), payout);
    assert_eq!(e.token_amount(&e.sponsor_token), SPONSOR_START - payout);
    assert!(e.svm.get_account(&e.vault(&c)).map_or(true, |a| a.lamports == 0), "vault closed");
}

#[test]
fn release_waits_out_dispute_window_then_pays_full() {
    let mut e = Env::new();
    let id = e.settled(THR_FULL);
    e.set_time(WINDOW_END + DISPUTE_SECS - 1);
    assert_eq!(e.release(id), custom(E_TOO_EARLY));
    e.set_time(WINDOW_END + DISPUTE_SECS);
    let before = e.svm.get_account(&e.sponsor.pubkey()).unwrap().lamports;
    let vault_rent = e.svm.get_account(&e.vault(&e.campaign(id))).unwrap().lamports;
    e.release(id).unwrap();
    assert_released(&e, id, UNITS as u64 * AMOUNT_FULL, RELEASED);
    assert_eq!(e.svm.get_account(&e.sponsor.pubkey()).unwrap().lamports, before + vault_rent);
    assert_eq!(e.release(id), custom(E_WRONG_STATUS));
}

#[test]
fn release_half_and_none() {
    let mut e = Env::new();
    let id = e.settled(THR_HALF);
    e.set_time(WINDOW_END + DISPUTE_SECS);
    e.release(id).unwrap();
    assert_released(&e, id, UNITS as u64 * AMOUNT_HALF, RELEASED);

    let mut e = Env::new();
    let id = e.settled(THR_HALF + 1);
    e.set_time(WINDOW_END + DISPUTE_SECS);
    e.release(id).unwrap();
    assert_released(&e, id, 0, RELEASED);
}

#[test]
fn release_settled_final_is_immediate() {
    let mut e = Env::new();
    let id = e.settled(THR_HALF + 1);
    e.dispute(id).unwrap();
    assert_eq!(e.release(id), custom(E_WRONG_STATUS)); // DISPUTED cannot be released
    e.resettle(id, THR_HALF).unwrap();
    e.release(id).unwrap();
    assert_released(&e, id, UNITS as u64 * AMOUNT_HALF, RELEASED);
}

#[test]
fn release_refunds_after_30_day_operator_timeout() {
    let mut e = Env::new();
    let id = e.locked();
    e.set_time(WINDOW_END + OPERATOR_TIMEOUT_SECS - 1);
    assert_eq!(e.release(id), custom(E_TOO_EARLY));
    e.set_time(WINDOW_END + OPERATOR_TIMEOUT_SECS);
    e.release(id).unwrap();
    assert_released(&e, id, 0, REFUNDED);
    assert_eq!(e.release(id), custom(E_WRONG_STATUS));
    // Operator can no longer settle a refunded campaign.
    assert_eq!(e.settle(id, 0), custom(E_WRONG_STATUS));
}

#[test]
fn refund_works_without_a_locked_roster() {
    let mut e = Env::new();
    e.create(&Params::default()).unwrap();
    e.set_time(WINDOW_END + OPERATOR_TIMEOUT_SECS);
    e.release(7).unwrap();
    assert_released(&e, 7, 0, REFUNDED);
}

#[test]
fn release_pledge_changes_status_only() {
    let mut e = Env::new();
    e.create(&Params { deposit: 0, pledge: 1, ..Default::default() }).unwrap();
    e.lock(7, UNITS).unwrap();
    e.set_time(WINDOW_END);
    e.settle(7, THR_FULL).unwrap();
    e.set_time(WINDOW_END + DISPUTE_SECS);
    e.release(7).unwrap();
    assert_eq!(e.status(7), RELEASED);
    assert_eq!(e.token_amount(&e.disburser_token), 0);
    assert_eq!(e.token_amount(&e.sponsor_token), SPONSOR_START);
    assert!(e.svm.get_account(&e.vault(&e.campaign(7))).is_some()); // pledge vault not closed

    let mut e = Env::new();
    e.create(&Params { deposit: 0, pledge: 1, ..Default::default() }).unwrap();
    e.set_time(WINDOW_END + OPERATOR_TIMEOUT_SECS);
    e.release(7).unwrap();
    assert_eq!(e.status(7), REFUNDED);
}

#[test]
fn release_account_checks() {
    let mut e = Env::new();
    let id = e.settled(THR_FULL);
    e.set_time(WINDOW_END + DISPUTE_SECS);
    let s = e.sponsor.pubkey();
    let mint = e.mint;

    let ix = e.release_ix_with(id, e.disburser_token, e.sponsor_token, Address::new_unique());
    assert_eq!(e.send_as_stranger(ix), custom(E_BAD_OWNER)); // wrong sponsor

    let other_mint = Address::new_unique();
    e.put(other_mint, TOKEN, mint_data());
    let d = e.disburser;
    let bad = e.new_token_account(&other_mint, &d, 0);
    let ix = e.release_ix_with(id, bad, e.sponsor_token, s);
    assert_eq!(e.send_as_stranger(ix), custom(E_BAD_MINT));
    let bad = e.new_token_account(&mint, &s, 0); // right mint, not the disburser's
    let ix = e.release_ix_with(id, bad, e.sponsor_token, s);
    assert_eq!(e.send_as_stranger(ix), custom(E_BAD_OWNER));

    let bad = e.new_token_account(&other_mint, &s, 0);
    let ix = e.release_ix_with(id, e.disburser_token, bad, s);
    assert_eq!(e.send_as_stranger(ix), custom(E_BAD_MINT));
    let bad = e.new_token_account(&mint, &d, 0); // right mint, not the sponsor's
    let ix = e.release_ix_with(id, e.disburser_token, bad, s);
    assert_eq!(e.send_as_stranger(ix), custom(E_BAD_OWNER));

    assert_eq!(e.status(id), SETTLED);
    e.release(id).unwrap();
}

#[test]
fn release_rejects_substituted_vault() {
    let mut e = Env::new();
    let id = e.settled(THR_FULL);
    e.set_time(WINDOW_END + DISPUTE_SECS);
    let c = e.campaign(id);
    // Overwrite the real vault's data with a different mint / owner.
    let v = e.vault(&c);
    let other_mint = Address::new_unique();
    e.put(other_mint, TOKEN, mint_data());
    let orig = e.data(&v);
    e.put(v, TOKEN, token_data(&other_mint, &c, DEPOSIT));
    assert_eq!(e.release(id), custom(E_BAD_MINT));
    e.put(v, TOKEN, token_data(&e.mint.clone(), &Address::new_unique(), DEPOSIT));
    assert_eq!(e.release(id), custom(E_BAD_OWNER));
    e.put(v, TOKEN, orig);
    e.release(id).unwrap();
}

#[test]
fn deadline_arithmetic_overflow() {
    // Settled at a time where settled_ts + 48h overflows i64.
    let mut e = Env::new();
    let far = i64::MAX - 10;
    e.create(&Params { freeze: T0 + 1, window_end: far, ..Default::default() }).unwrap();
    e.lock(7, UNITS).unwrap();
    e.set_time(far);
    assert_eq!(e.release(7), custom(E_OVERFLOW)); // OPEN: window_end + 30d overflows
    e.settle(7, 0).unwrap();
    assert_eq!(e.dispute(7), custom(E_OVERFLOW));
    assert_eq!(e.release(7), custom(E_OVERFLOW));
}

// ---- PostReceipts ------------------------------------------------------------------------------

#[test]
fn post_receipts_after_paying_release() {
    let mut e = Env::new();
    let id = e.settled(THR_FULL);
    assert_eq!(e.receipts(id), custom(E_WRONG_STATUS)); // not released yet
    e.set_time(WINDOW_END + DISPUTE_SECS);
    e.release(id).unwrap();

    let o = e.operator.insecure_clone();
    let a = e.auditor.insecure_clone();
    let ix = e.receipts_ix(id, &o.pubkey(), true, 31);
    assert_eq!(e.send(ix, &o, &[&o]), custom(E_INVALID_DATA));
    let ix = e.receipts_ix(id, &o.pubkey(), false, 32);
    assert_eq!(e.send(ix, &a, &[&a]), custom(E_MISSING_SIGNER));
    let ix = e.receipts_ix(id, &a.pubkey(), true, 32);
    assert_eq!(e.send(ix, &a, &[&a]), custom(E_BAD_OWNER));

    e.receipts(id).unwrap();
    let d = e.data(&e.campaign(id));
    assert_eq!(d[2], RECEIPTED);
    assert_eq!(&d[336..368], &[0x33; 32]);
    assert_eq!(e.receipts(id), custom(E_WRONG_STATUS)); // terminal
    assert_eq!(e.release(id), custom(E_WRONG_STATUS));
}

#[test]
fn post_receipts_half_ok_none_rejected_refund_rejected() {
    let mut e = Env::new();
    let id = e.settled(THR_HALF);
    e.set_time(WINDOW_END + DISPUTE_SECS);
    e.release(id).unwrap();
    e.receipts(id).unwrap();
    assert_eq!(e.status(id), RECEIPTED);

    let mut e = Env::new();
    let id = e.settled(THR_HALF + 1);
    e.set_time(WINDOW_END + DISPUTE_SECS);
    e.release(id).unwrap();
    assert_eq!(e.receipts(id), custom(E_WRONG_STATUS)); // outcome NONE: nothing was paid

    let mut e = Env::new();
    let id = e.locked();
    e.set_time(WINDOW_END + OPERATOR_TIMEOUT_SECS);
    e.release(id).unwrap();
    assert_eq!(e.receipts(id), custom(E_WRONG_STATUS)); // REFUNDED
}
