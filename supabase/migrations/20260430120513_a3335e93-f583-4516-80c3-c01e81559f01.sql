-- =========================================================
-- APROVAÇÃO 2 — Schema changes
-- 1) Blacklist visual: coluna `excluded` em sync_tables
-- 2) Delta sync infra: coluna `last_rowversion` em sync_tables
-- 3) Materialized view registry + refresh tracking
-- =========================================================

-- 1 + 2: sync_tables ------------------------------------------------
ALTER TABLE public.sync_tables
  ADD COLUMN IF NOT EXISTS excluded boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS excluded_reason text,
  ADD COLUMN IF NOT EXISTS excluded_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_rowversion text;

CREATE INDEX IF NOT EXISTS idx_sync_tables_excluded
  ON public.sync_tables(excluded) WHERE excluded = true;

-- 3: Materialized view registry ------------------------------------
CREATE TABLE IF NOT EXISTS public.mv_registry (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  sql_definition text NOT NULL,
  refresh_interval_minutes int NOT NULL DEFAULT 5,
  enabled boolean NOT NULL DEFAULT true,
  last_refreshed_at timestamptz,
  last_refresh_duration_ms int,
  last_refresh_status text,
  last_refresh_error text,
  row_count bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.mv_registry ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Master full mv_registry"
  ON public.mv_registry FOR ALL TO authenticated
  USING (has_role(auth.uid(), 'master'))
  WITH CHECK (has_role(auth.uid(), 'master'));

CREATE TRIGGER trg_mv_registry_updated_at
  BEFORE UPDATE ON public.mv_registry
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Function: refresh a materialized view by registry name -----------
CREATE OR REPLACE FUNCTION public.refresh_mv(_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec public.mv_registry%ROWTYPE;
  v_started timestamptz := clock_timestamp();
  v_duration_ms int;
  v_rows bigint;
BEGIN
  SELECT * INTO v_rec FROM public.mv_registry WHERE name = _name;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'mv not found');
  END IF;

  IF NOT v_rec.enabled THEN
    RETURN jsonb_build_object('ok', false, 'error', 'mv disabled');
  END IF;

  BEGIN
    -- Drop and recreate (simpler than tracking REFRESH MATERIALIZED VIEW dependencies)
    EXECUTE format('DROP MATERIALIZED VIEW IF EXISTS mirror.%I CASCADE', _name);
    EXECUTE format('CREATE MATERIALIZED VIEW mirror.%I AS %s', _name, v_rec.sql_definition);
    EXECUTE format('SELECT count(*) FROM mirror.%I', _name) INTO v_rows;

    v_duration_ms := EXTRACT(MILLISECOND FROM (clock_timestamp() - v_started))::int
                   + EXTRACT(SECOND  FROM (clock_timestamp() - v_started))::int * 1000;

    UPDATE public.mv_registry
       SET last_refreshed_at = now(),
           last_refresh_duration_ms = v_duration_ms,
           last_refresh_status = 'ok',
           last_refresh_error = NULL,
           row_count = v_rows
     WHERE id = v_rec.id;

    RETURN jsonb_build_object('ok', true, 'rows', v_rows, 'duration_ms', v_duration_ms);
  EXCEPTION WHEN OTHERS THEN
    UPDATE public.mv_registry
       SET last_refreshed_at = now(),
           last_refresh_status = 'error',
           last_refresh_error = SQLERRM
     WHERE id = v_rec.id;
    RETURN jsonb_build_object('ok', false, 'error', SQLERRM);
  END;
END;
$$;

-- Function: refresh all due materialized views ---------------------
CREATE OR REPLACE FUNCTION public.refresh_due_mvs()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
  results jsonb := '[]'::jsonb;
  one jsonb;
BEGIN
  FOR r IN
    SELECT name FROM public.mv_registry
    WHERE enabled = true
      AND (
        last_refreshed_at IS NULL
        OR last_refreshed_at < now() - (refresh_interval_minutes || ' minutes')::interval
      )
    ORDER BY COALESCE(last_refreshed_at, 'epoch'::timestamptz) ASC
    LIMIT 10
  LOOP
    one := public.refresh_mv(r.name);
    results := results || jsonb_build_object('name', r.name, 'result', one);
  END LOOP;
  RETURN results;
END;
$$;