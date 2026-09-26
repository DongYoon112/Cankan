-- Defines durable identities, budgets, immutable actions, execution claims, dispatches, and audit records.
CREATE TABLE organizations (
  id uuid PRIMARY KEY, name text NOT NULL, paused boolean NOT NULL DEFAULT false
);
CREATE TABLE principals (
  id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations,
  role text NOT NULL CHECK (role IN ('agent','owner')), token_hash text UNIQUE NOT NULL,
  active boolean NOT NULL DEFAULT true, UNIQUE (id, org_id)
);
CREATE TABLE tasks (
  id uuid PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations,
  active boolean NOT NULL DEFAULT true, sellers text[] NOT NULL,
  requires_approval boolean NOT NULL DEFAULT false, requires_assessment boolean NOT NULL DEFAULT false,
  reserved_cents integer NOT NULL DEFAULT 0 CHECK (reserved_cents BETWEEN 0 AND 2000),
  UNIQUE (id, org_id)
);
CREATE TABLE task_agents (
  task_id uuid NOT NULL, principal_id uuid NOT NULL, org_id uuid NOT NULL,
  PRIMARY KEY (task_id, principal_id),
  FOREIGN KEY (task_id, org_id) REFERENCES tasks (id, org_id),
  FOREIGN KEY (principal_id, org_id) REFERENCES principals (id, org_id)
);
CREATE TABLE operations (
  id uuid PRIMARY KEY, org_id uuid NOT NULL, principal_id uuid NOT NULL,
  operation_key text NOT NULL CHECK (length(operation_key) BETWEEN 1 AND 80),
  task_id uuid NOT NULL, request jsonb NOT NULL, input jsonb NOT NULL,
  fingerprint text NOT NULL, provider_operation_id uuid UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (org_id, operation_key),
  FOREIGN KEY (principal_id, org_id) REFERENCES principals (id, org_id),
  FOREIGN KEY (task_id, org_id) REFERENCES tasks (id, org_id)
);
CREATE TABLE executions (
  id uuid PRIMARY KEY, operation_id uuid UNIQUE NOT NULL REFERENCES operations,
  capability text NOT NULL, principal_id text NOT NULL, idempotency_key text NOT NULL,
  input_fingerprint text NOT NULL, outcome jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), recorded_at timestamptz,
  UNIQUE (capability, principal_id, idempotency_key)
);
CREATE TABLE decisions (
  operation_id uuid PRIMARY KEY REFERENCES operations, allowed boolean NOT NULL,
  reason text NOT NULL, requires_approval boolean NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE dispatches (
  operation_id uuid PRIMARY KEY REFERENCES operations, execution_id uuid UNIQUE NOT NULL REFERENCES executions,
  reserved_cents integer NOT NULL CHECK (reserved_cents BETWEEN 0 AND 500),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE attempts (
  operation_id uuid PRIMARY KEY REFERENCES dispatches, provider_operation_id uuid UNIQUE NOT NULL,
  state text NOT NULL CHECK (state IN ('unresolved','succeeded')) DEFAULT 'unresolved',
  evidence jsonb, started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  CHECK ((state = 'succeeded') = (evidence IS NOT NULL))
);
CREATE TABLE controls (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, org_id uuid NOT NULL REFERENCES organizations,
  owner_id uuid NOT NULL REFERENCES principals, kind text NOT NULL, value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE rate_limits (
  principal_id uuid PRIMARY KEY REFERENCES principals, minute bigint NOT NULL, count integer NOT NULL
);
CREATE FUNCTION immutable_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'immutable record'; END $$;
CREATE TRIGGER immutable_operation BEFORE UPDATE OR DELETE ON operations FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_decision BEFORE UPDATE OR DELETE ON decisions FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_dispatch BEFORE UPDATE OR DELETE ON dispatches FOR EACH ROW EXECUTE FUNCTION immutable_record();
CREATE TRIGGER immutable_control BEFORE UPDATE OR DELETE ON controls FOR EACH ROW EXECUTE FUNCTION immutable_record();
