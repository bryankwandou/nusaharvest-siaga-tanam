import { z } from 'zod';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');
const idr = z.number().int().positive().max(100_000_000);

export const QuoteBody = z
  .object({
    regency: z.string().trim().min(2).max(80),
    province: z.string().trim().min(2).max(80),
    commodity: z.enum(['padi_tadah_hujan', 'jagung_lahan_kering']),
    windowStartDate: isoDate,
    windowEndDate: isoDate,
    amountFullIdr: idr,
    amountHalfIdr: idr,
    unitsMax: z.number().int().min(1).max(100_000),
  })
  .refine((b) => b.amountHalfIdr <= b.amountFullIdr, { message: 'amountHalfIdr must not exceed amountFullIdr', path: ['amountHalfIdr'] })
  .refine((b) => b.windowStartDate <= b.windowEndDate, { message: 'window must start before it ends', path: ['windowEndDate'] })
  .refine((b) => {
    const days = (Date.parse(b.windowEndDate) - Date.parse(b.windowStartDate)) / 86_400_000;
    return days >= 14 && days <= 200;
  }, { message: 'window must be 14..200 days', path: ['windowEndDate'] });

const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'expected a base58 address');

export const CreateCampaignBody = z
  .object({
    regency: z.string().trim().min(2).max(80),
    province: z.string().trim().min(2).max(80),
    commodity: z.enum(['padi_tadah_hujan', 'jagung_lahan_kering']),
    windowStartDate: isoDate,
    windowEndDate: isoDate,
    amountFullIdr: idr,
    amountHalfIdr: idr,
    unitsMax: z.number().int().min(1).max(100_000),
    sponsorName: z.string().trim().min(2).max(160),
    mode: z.enum(['escrow', 'pledge']),
    sponsorWallet: base58.nullable(),
    contactEmail: z.email().max(200),
    /** Optional unix seconds; defaults to 00:00 WIB on windowStartDate. */
    freezeTs: z.number().int().positive().optional(),
    /** Accepted threshold values from the quote step; must equal the server recomputation. */
    thrFullMm10: z.number().int(),
    thrHalfMm10: z.number().int(),
  })
  .refine((b) => b.mode === 'pledge' || b.sponsorWallet !== null, { message: 'escrow mode needs sponsorWallet', path: ['sponsorWallet'] })
  .refine((b) => b.amountHalfIdr <= b.amountFullIdr, { message: 'amountHalfIdr must not exceed amountFullIdr', path: ['amountHalfIdr'] });

export const ProofBody = z.object({
  code: z.string().trim().min(3).max(32),
  phone: z.string().trim().min(8).max(24),
  proofCode: z.string().trim().min(8).max(12),
});
