import { describe, expect, it } from 'vitest';
import { rosterGate, settleGate, fundedCapacity, windowEndTsFor } from '../roster';
import { DISPUTE_SECS, OPERATOR_TIMEOUT_SECS } from '../chain/layout';
import { DATA_LAG_DAYS } from '../climate';

const END = windowEndTsFor('2026-12-31');
const LAG = DATA_LAG_DAYS * 86_400;
const base = { windowEndTs: END, settledTs: 0, units: 120, reviewPending: false };

describe('settlement trigger boundaries', () => {
  it('window_end_ts is the end of the day in WIB', () => {
    expect(END).toBe(Date.UTC(2026, 11, 31, 17, 0, 0) / 1000);
  });
  it('waits before window_end_ts', () => {
    expect(settleGate({ ...base, nowSecs: END - 1, chainStatus: 'OPEN' })).toEqual({ action: 'wait', reason: 'before_window_end' });
  });
  it('waits for the data lag after window_end_ts', () => {
    expect(settleGate({ ...base, nowSecs: END, chainStatus: 'OPEN' })).toEqual({ action: 'wait', reason: 'data_lag' });
    expect(settleGate({ ...base, nowSecs: END + LAG - 1, chainStatus: 'OPEN' })).toEqual({ action: 'wait', reason: 'data_lag' });
  });
  it('settles exactly at window_end_ts + lag', () => {
    expect(settleGate({ ...base, nowSecs: END + LAG, chainStatus: 'OPEN' })).toEqual({ action: 'settle' });
  });
  it('does not settle an empty roster or a campaign under review', () => {
    expect(settleGate({ ...base, units: 0, nowSecs: END + LAG, chainStatus: 'OPEN' })).toEqual({ action: 'wait', reason: 'no_roster' });
    expect(settleGate({ ...base, reviewPending: true, nowSecs: END + LAG, chainStatus: 'OPEN' })).toEqual({ action: 'wait', reason: 'review_pending' });
  });
  it('holds release during the 48 h dispute window and releases at its end', () => {
    const settled = END + LAG + 3600;
    const s = { ...base, settledTs: settled, chainStatus: 'SETTLED' };
    expect(settleGate({ ...s, nowSecs: settled })).toEqual({ action: 'wait', reason: 'dispute_window' });
    expect(settleGate({ ...s, nowSecs: settled + DISPUTE_SECS - 1 })).toEqual({ action: 'wait', reason: 'dispute_window' });
    expect(settleGate({ ...s, nowSecs: settled + DISPUTE_SECS })).toEqual({ action: 'release' });
  });
  it('never acts alone on a disputed campaign', () => {
    expect(settleGate({ ...base, settledTs: END + LAG, nowSecs: END + LAG + 10 * DISPUTE_SECS, chainStatus: 'DISPUTED' })).toEqual({ action: 'wait', reason: 'disputed_needs_cosign' });
  });
  it('releases SETTLED_FINAL immediately', () => {
    expect(settleGate({ ...base, settledTs: END + LAG, nowSecs: END + LAG + 1, chainStatus: 'SETTLED_FINAL' })).toEqual({ action: 'release' });
  });
  it('refunds an unsettled campaign at window_end_ts + 30 days', () => {
    expect(settleGate({ ...base, nowSecs: END + OPERATOR_TIMEOUT_SECS - 1, chainStatus: 'OPEN' })).toEqual({ action: 'settle' });
    expect(settleGate({ ...base, nowSecs: END + OPERATOR_TIMEOUT_SECS, chainStatus: 'OPEN' })).toEqual({ action: 'refund' });
  });
  it('does nothing on terminal states', () => {
    for (const s of ['RELEASED', 'RECEIPTED', 'REFUNDED']) expect(settleGate({ ...base, nowSecs: END * 2, chainStatus: s }).action).toBe('wait');
  });
});

describe('roster lock boundaries', () => {
  const freezeTs = 1_790_000_000;
  it('locks strictly before freeze_ts', () => {
    expect(rosterGate({ nowSecs: freezeTs - 1, freezeTs, chainStatus: 'OPEN', validCount: 3 })).toEqual({ action: 'lock' });
    expect(rosterGate({ nowSecs: freezeTs, freezeTs, chainStatus: 'OPEN', validCount: 3 })).toEqual({ action: 'skip', reason: 'frozen' });
  });
  it('skips non-OPEN and empty rosters', () => {
    expect(rosterGate({ nowSecs: 0, freezeTs, chainStatus: 'SETTLED', validCount: 3 }).action).toBe('skip');
    expect(rosterGate({ nowSecs: 0, freezeTs, chainStatus: 'OPEN', validCount: 0 })).toEqual({ action: 'skip', reason: 'no_enrollments' });
  });
  it('caps ESCROW units by vault balance and ignores balance for PLEDGE', () => {
    expect(fundedCapacity({ pledge: false, vaultBalance: 950n, amountFull: 100n, unitsMax: 50 })).toBe(9);
    expect(fundedCapacity({ pledge: false, vaultBalance: 10_000n, amountFull: 100n, unitsMax: 50 })).toBe(50);
    expect(fundedCapacity({ pledge: true, vaultBalance: 0n, amountFull: 100n, unitsMax: 50 })).toBe(50);
  });
});