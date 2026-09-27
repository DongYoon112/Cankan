-- Adds durable, fenced lookup work without changing reservation accounting or attempt evidence rules.
ALTER TABLE attempts ADD COLUMN version integer NOT NULL DEFAULT 0 CHECK (version >= 0);
CREATE TABLE reconciliation_jobs (
  operation_id uuid PRIMARY KEY REFERENCES attempts(operation_id),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','resolved','attention')),
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  lookup_count integer NOT NULL DEFAULT 0 CHECK (lookup_count >= 0),
  next_check_at timestamptz DEFAULT clock_timestamp(),
  lease_until timestamptz,
  last_check_at timestamptz,
  last_error text,
  CHECK ((state = 'leased') = (lease_until IS NOT NULL)),
  CHECK ((state IN ('pending','leased')) = (next_check_at IS NOT NULL))
);
CREATE INDEX reconciliation_due ON reconciliation_jobs(next_check_at) WHERE state IN ('pending','leased');
CREATE TABLE reconciliation_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  operation_id uuid NOT NULL REFERENCES attempts(operation_id),
  generation integer NOT NULL,
  source text NOT NULL CHECK (source IN ('lookup','kaji')),
  code text NOT NULL,
  evidence jsonb,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX reconciliation_history ON reconciliation_observations(operation_id, id);
CREATE TRIGGER immutable_reconciliation_observation BEFORE UPDATE OR DELETE ON reconciliation_observations
  FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE FUNCTION enqueue_reconciliation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO reconciliation_jobs(operation_id, state, next_check_at)
    VALUES (NEW.operation_id, 'pending', clock_timestamp() + interval '5 seconds');
  RETURN NEW;
END;
$$;
CREATE TRIGGER enqueue_attempt_reconciliation AFTER INSERT ON attempts
  FOR EACH ROW EXECUTE FUNCTION enqueue_reconciliation();
INSERT INTO reconciliation_jobs(operation_id, state, next_check_at)
  SELECT operation_id, CASE WHEN state='succeeded' THEN 'resolved' ELSE 'pending' END,
    CASE WHEN state='unresolved' THEN clock_timestamp() ELSE NULL END FROM attempts;
