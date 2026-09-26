-- Defines immutable simulated quotes and the independent provider charge ledger.
CREATE TABLE provider_quotes (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9_-]{1,80}$'),
  org_id uuid NOT NULL,
  seller text NOT NULL CHECK (seller ~ '^[A-Za-z0-9_-]{1,80}$'),
  amount_cents integer NOT NULL CHECK (amount_cents BETWEEN 0 AND 1000000),
  fee_cents integer NOT NULL CHECK (fee_cents BETWEEN 0 AND 1000000),
  currency text NOT NULL CHECK (length(currency) BETWEEN 1 AND 24),
  expires_at timestamptz NOT NULL CHECK (isfinite(expires_at)),
  behavior text NOT NULL DEFAULT 'normal' CHECK (behavior IN ('normal', 'drop_after_commit'))
);

CREATE TABLE provider_charges (
  operation_id uuid PRIMARY KEY,
  receipt_id uuid NOT NULL UNIQUE,
  quote_id text NOT NULL REFERENCES provider_quotes(id),
  quote_fingerprint text NOT NULL CHECK (quote_fingerprint ~ '^[a-f0-9]{64}$'),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object')
);

CREATE FUNCTION reject_provider_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'provider records are immutable';
END;
$$;

CREATE TRIGGER immutable_provider_quotes BEFORE UPDATE OR DELETE ON provider_quotes
  FOR EACH ROW EXECUTE FUNCTION reject_provider_mutation();
CREATE TRIGGER immutable_provider_charges BEFORE UPDATE OR DELETE ON provider_charges
  FOR EACH ROW EXECUTE FUNCTION reject_provider_mutation();
CREATE TRIGGER immutable_provider_quotes_truncate BEFORE TRUNCATE ON provider_quotes
  FOR EACH STATEMENT EXECUTE FUNCTION reject_provider_mutation();
CREATE TRIGGER immutable_provider_charges_truncate BEFORE TRUNCATE ON provider_charges
  FOR EACH STATEMENT EXECUTE FUNCTION reject_provider_mutation();
