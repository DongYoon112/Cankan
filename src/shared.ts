// Defines strict action, quote, and receipt schemas plus stable fingerprints and token hashes.
import { createHash } from 'node:crypto';
import { z } from 'zod';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
  }
  if (value === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Not JSON');
  return JSON.stringify(value);
}
export const fingerprint = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
export const tokenHash = (value: string): string => createHash('sha256').update(value).digest('hex');
export const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const cents = z.number().int().min(0).max(1_000_000);
export const quoteSchema = z.strictObject({
  id: identifier, organizationId: z.uuid(), seller: identifier,
  amountCents: cents, feeCents: cents, currency: z.string().min(1).max(24),
  expiresAt: z.iso.datetime(),
});
export const requestSchema = z.strictObject({
  operationId: identifier, action: z.literal('payments.purchase'), taskId: z.uuid(), quoteId: identifier,
});
export const canonicalSchema = z.strictObject({
  operationId: z.uuid(), organizationId: z.uuid(), principalId: z.uuid(),
  action: z.literal('payments.purchase'), taskId: z.uuid(), quote: quoteSchema,
});
export type CanonicalInput = z.infer<typeof canonicalSchema>;
export const receiptSchema = z.strictObject({
  operationId: z.uuid(), receiptId: z.uuid(), quoteId: identifier,
  quoteFingerprint: z.string().regex(/^[a-f0-9]{64}$/), seller: identifier,
  amountCents: cents, feeCents: cents, totalCents: z.number().int().min(0).max(2_000_000),
  currency: z.literal('SIM_CENTS'), chargedAt: z.iso.datetime(),
});
