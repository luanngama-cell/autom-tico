-- =========================================================
-- Webhook destinations (BI Hospital CMO and future systems)
-- =========================================================
CREATE TABLE public.bi_destinations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  endpoint_url TEXT NOT NULL,
  allowed_ips TEXT[] NOT NULL DEFAULT '{}',
  push_interval_minutes INTEGER NOT NULL DEFAULT 5 CHECK (push_interval_minutes >= 1),
  enabled BOOLEAN NOT NULL DEFAULT true,
  include_patient_registry BOOLEAN NOT NULL DEFAULT true,
  source_database_name TEXT,
  last_pushed_at TIMESTAMPTZ,
  last_status TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.bi_destinations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Master full bi_destinations"
  ON public.bi_destinations FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'master'::app_role))
  WITH CHECK (has_role(auth.uid(), 'master'::app_role));

CREATE TRIGGER bi_destinations_updated_at
  BEFORE UPDATE ON public.bi_destinations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =========================================================
-- API tokens for each destination
-- =========================================================
CREATE TABLE public.bi_destination_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id UUID NOT NULL REFERENCES public.bi_destinations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  token_prefix TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

ALTER TABLE public.bi_destination_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Master full bi_destination_tokens"
  ON public.bi_destination_tokens FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'master'::app_role))
  WITH CHECK (has_role(auth.uid(), 'master'::app_role));

CREATE INDEX bi_destination_tokens_destination_idx
  ON public.bi_destination_tokens(destination_id) WHERE revoked_at IS NULL;

-- =========================================================
-- Delivery log (audit trail for LGPD)
-- =========================================================
CREATE TABLE public.bi_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  destination_id UUID NOT NULL REFERENCES public.bi_destinations(id) ON DELETE CASCADE,
  triggered_by TEXT NOT NULL DEFAULT 'cron',  -- 'cron' | 'manual' | 'initial'
  payload_kind TEXT NOT NULL DEFAULT 'snapshot', -- 'snapshot' | 'delta'
  status TEXT NOT NULL,  -- 'success' | 'error' | 'skipped' | 'retrying'
  http_status INTEGER,
  payload_bytes INTEGER,
  duration_ms INTEGER,
  changed_sections TEXT[] NOT NULL DEFAULT '{}',
  rows_affected INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  request_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.bi_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Master full bi_deliveries"
  ON public.bi_deliveries FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'master'::app_role))
  WITH CHECK (has_role(auth.uid(), 'master'::app_role));

CREATE INDEX bi_deliveries_destination_created_idx
  ON public.bi_deliveries(destination_id, created_at DESC);

-- =========================================================
-- Snapshot cache (last JSON sent per destination)
-- =========================================================
CREATE TABLE public.bi_snapshots (
  destination_id UUID PRIMARY KEY REFERENCES public.bi_destinations(id) ON DELETE CASCADE,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_hash TEXT,
  -- Per-section row counters / hashes for delta detection
  section_hashes JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Watermark per source table: { "FICHAS": "2026-04-23T...", "ATENDIM": "..." }
  source_watermarks JSONB NOT NULL DEFAULT '{}'::jsonb,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.bi_snapshots ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Master full bi_snapshots"
  ON public.bi_snapshots FOR ALL
  TO authenticated
  USING (has_role(auth.uid(), 'master'::app_role))
  WITH CHECK (has_role(auth.uid(), 'master'::app_role));

CREATE TRIGGER bi_snapshots_updated_at
  BEFORE UPDATE ON public.bi_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();