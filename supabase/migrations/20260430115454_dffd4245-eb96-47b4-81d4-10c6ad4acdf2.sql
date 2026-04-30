
CREATE TABLE IF NOT EXISTS public.bi_query_metrics (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  destination_id uuid,
  sql_hash text NOT NULL,
  sql_preview text NOT NULL,
  duration_ms integer NOT NULL,
  row_count integer NOT NULL DEFAULT 0,
  cache_hit boolean NOT NULL DEFAULT false,
  error text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bi_query_metrics_hash
  ON public.bi_query_metrics (sql_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bi_query_metrics_created
  ON public.bi_query_metrics (created_at DESC);

ALTER TABLE public.bi_query_metrics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Master read bi_query_metrics"
  ON public.bi_query_metrics
  FOR SELECT
  TO authenticated
  USING (has_role(auth.uid(), 'master'::app_role));
