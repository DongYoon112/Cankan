// Authenticates simulated payments and records immutable, idempotent provider charges.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Server } from 'node:http';
import type { Pool } from 'pg';
import { z } from 'zod';
import { transaction } from './db.js';
import { HttpError, json, readJson, serve } from './http.js';
import { fingerprint, identifier } from './shared.js';

const chargeInput = z.object({
  operationId: z.uuid().transform(value => value.toLowerCase()),
  quoteId: identifier,
  quoteFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

type QuoteRow = {
  id: string;
  org_id: string;
  seller: string;
  amount_cents: number;
  fee_cents: number;
  currency: string;
  expires_at: Date;
  behavior: 'normal' | 'drop_after_commit';
  unexpired: boolean;
};

function quoteEvidence(row: QuoteRow) {
  return {
    id: row.id,
    organizationId: row.org_id,
    seller: row.seller,
    amountCents: row.amount_cents,
    feeCents: row.fee_cents,
    currency: row.currency,
    expiresAt: row.expires_at.toISOString(),
  };
}

export function createProvider(pool: Pool, token: string, lookupToken?: string): Server {
  if (!token) throw new Error('Provider token is required');
  if (lookupToken === token) throw new Error('Lookup credential must be separate');
  const expected = Buffer.from(`Bearer ${token}`);
  const lookupExpected = lookupToken ? Buffer.from(`Bearer ${lookupToken}`) : undefined;
  return serve(async (req, res) => {
    const supplied = Buffer.from(req.headers.authorization ?? '');
    const payment = supplied.length === expected.length && timingSafeEqual(supplied, expected);
    const lookup = lookupExpected && supplied.length === lookupExpected.length && timingSafeEqual(supplied, lookupExpected);
    if (!payment && !lookup) {
      throw new HttpError(401, 'Unauthorized');
    }
    const path = new URL(req.url ?? '/', 'http://provider').pathname;
    const outcomeMatch = /^\/organizations\/([a-fA-F0-9-]{36})\/operations\/([a-fA-F0-9-]{36})$/.exec(path);
    if (req.method === 'GET' && outcomeMatch) {
      if (!lookup) throw new HttpError(403, 'Lookup permission required');
      const organizationId = z.uuid().parse(outcomeMatch[1]), operationId = z.uuid().parse(outcomeMatch[2]);
      const row = (await pool.query<QuoteRow & { evidence: unknown }>(`SELECT q.*, c.evidence
        FROM provider_charges c JOIN provider_quotes q ON q.id=c.quote_id
        WHERE c.operation_id=$1 AND q.org_id=$2`, [operationId, organizationId])).rows[0];
      if (!row) throw new HttpError(404, 'Outcome not found');
      json(res, 200, { organizationId: row.org_id, quote: quoteEvidence(row), receipt: row.evidence });
      return;
    }
    if (!payment) throw new HttpError(403, 'Payment permission required');
    const quoteMatch = /^\/quotes\/([A-Za-z0-9_-]{1,80})$/.exec(path);
    if (req.method === 'GET' && quoteMatch) {
      const result = await pool.query<QuoteRow>('SELECT * FROM provider_quotes WHERE id = $1', [quoteMatch[1]]);
      const quote = result.rows[0];
      if (!quote) throw new HttpError(404, 'Quote not found');
      json(res, 200, quoteEvidence(quote));
      return;
    }
    if (req.method !== 'POST' || path !== '/charges') throw new HttpError(404, 'Not found');
    const input = chargeInput.parse(await readJson(req));
    const result = await transaction(pool, async db => {
      // Serialize only callers sharing an operation identity, including separate processes.
      await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [input.operationId]);
      const existing = await db.query<{
        quote_id: string; quote_fingerprint: string; evidence: unknown;
      }>('SELECT quote_id, quote_fingerprint, evidence FROM provider_charges WHERE operation_id = $1', [input.operationId]);
      const previous = existing.rows[0];
      if (previous) {
        if (previous.quote_id !== input.quoteId || previous.quote_fingerprint !== input.quoteFingerprint) {
          throw new HttpError(409, 'Operation identity already used with different inputs');
        }
        return { status: 200, evidence: previous.evidence, dropResponse: false };
      }
      const result = await db.query<QuoteRow>(
        'SELECT *, expires_at > clock_timestamp() AS unexpired FROM provider_quotes WHERE id = $1', [input.quoteId],
      );
      const quote = result.rows[0];
      if (!quote) throw new HttpError(404, 'Quote not found');
      if (fingerprint(quoteEvidence(quote)) !== input.quoteFingerprint) {
        throw new HttpError(409, 'Quote fingerprint does not match');
      }
      if (quote.currency !== 'SIM_CENTS') throw new HttpError(422, 'Unsupported simulated currency');
      if (!quote.unexpired) throw new HttpError(409, 'Quote expired');
      const evidence = {
        operationId: input.operationId,
        receiptId: randomUUID(),
        quoteId: quote.id,
        quoteFingerprint: input.quoteFingerprint,
        seller: quote.seller,
        amountCents: quote.amount_cents,
        feeCents: quote.fee_cents,
        totalCents: quote.amount_cents + quote.fee_cents,
        currency: quote.currency,
        chargedAt: new Date().toISOString(),
      };
      await db.query(
        `INSERT INTO provider_charges (operation_id, receipt_id, quote_id, quote_fingerprint, evidence)
         VALUES ($1, $2, $3, $4, $5)`,
        [input.operationId, evidence.receiptId, quote.id, input.quoteFingerprint, evidence],
      );
      return { status: 201, evidence, dropResponse: quote.behavior === 'drop_after_commit' };
    });
    // A response (including the fault fixture) is emitted only after the ledger commit.
    if (result.dropResponse) res.destroy();
    else json(res, result.status, result.evidence);
  });
}
