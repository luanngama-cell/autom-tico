-- Tabela de scripts SQL para BI
CREATE TABLE public.bi_scripts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  sql_code text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  run_interval_minutes integer NOT NULL DEFAULT 5 CHECK (run_interval_minutes >= 1),
  last_run_at timestamptz,
  last_status text,
  last_error text,
  last_duration_ms integer,
  last_row_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.bi_scripts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Master full bi_scripts"
ON public.bi_scripts FOR ALL TO authenticated
USING (has_role(auth.uid(), 'master'::app_role))
WITH CHECK (has_role(auth.uid(), 'master'::app_role));

CREATE TRIGGER set_updated_at_bi_scripts
BEFORE UPDATE ON public.bi_scripts
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Liga destino BI a um script
ALTER TABLE public.bi_destinations
ADD COLUMN bi_script_id uuid REFERENCES public.bi_scripts(id) ON DELETE SET NULL;

-- Função: executa script SQL em modo SOMENTE LEITURA e retorna JSON
-- Uma transação READ ONLY rejeita qualquer escrita, garantindo segurança
CREATE OR REPLACE FUNCTION public.execute_bi_script(_sql text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  result jsonb;
  wrapped_sql text;
BEGIN
  -- Força a query a ser executada como subquery agregada em JSON.
  -- Se o script tentar INSERT/UPDATE/DELETE/DDL, falha com erro.
  -- Limite implícito: o script DEVE ser um SELECT que produza linhas.
  wrapped_sql := format(
    'SELECT COALESCE(jsonb_agg(row_to_json(_sub)::jsonb), ''[]''::jsonb) FROM (%s) _sub',
    _sql
  );

  -- Define a transação como read-only para esta execução
  SET LOCAL transaction_read_only = on;
  SET LOCAL statement_timeout = '120s';

  EXECUTE wrapped_sql INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.execute_bi_script(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.execute_bi_script(text) TO service_role;