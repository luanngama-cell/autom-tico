
-- ============================================================
-- FASE 2: Schema MIRROR + views tipadas automáticas
-- ============================================================

CREATE SCHEMA IF NOT EXISTS mirror;

-- Garante índice rápido pro filtro por tabela
CREATE INDEX IF NOT EXISTS idx_synced_rows_sync_table_id
  ON public.synced_rows (sync_table_id);

-- ============================================================
-- Função: inferir tipo SQL a partir de amostra de valores JSONB
-- ============================================================
CREATE OR REPLACE FUNCTION mirror.infer_sql_type(
  _sync_table_id uuid,
  _column_name text,
  _sample_size int DEFAULT 200
) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_total int := 0;
  v_int int := 0;
  v_num int := 0;
  v_ts int := 0;
  v_bool int := 0;
  v_val text;
BEGIN
  FOR v_val IN
    SELECT data->>_column_name
    FROM public.synced_rows
    WHERE sync_table_id = _sync_table_id
      AND data ? _column_name
      AND data->>_column_name IS NOT NULL
    LIMIT _sample_size
  LOOP
    v_total := v_total + 1;

    -- bool
    IF v_val IN ('true','false','True','False','TRUE','FALSE','0','1') THEN
      v_bool := v_bool + 1;
    END IF;

    -- int
    IF v_val ~ '^-?\d+$' THEN
      v_int := v_int + 1;
    END IF;

    -- numeric
    IF v_val ~ '^-?\d+(\.\d+)?$' THEN
      v_num := v_num + 1;
    END IF;

    -- timestamp ISO 8601 (2026-04-29T21:15:14...)
    IF v_val ~ '^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}' THEN
      v_ts := v_ts + 1;
    END IF;
  END LOOP;

  IF v_total = 0 THEN
    RETURN 'text';
  END IF;

  -- threshold: 95% das amostras precisam bater no tipo
  IF v_ts::numeric / v_total >= 0.95 THEN RETURN 'timestamptz'; END IF;
  IF v_int::numeric / v_total >= 0.95 THEN RETURN 'bigint'; END IF;
  IF v_num::numeric / v_total >= 0.95 THEN RETURN 'numeric'; END IF;
  -- bool é arriscado (0/1 também é int) — só se TODOS forem true/false literais
  RETURN 'text';
END;
$$;

-- ============================================================
-- Função: criar/recriar view tipada para UMA tabela
-- ============================================================
CREATE OR REPLACE FUNCTION mirror.refresh_view_for_table(
  _sync_table_id uuid
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_table_name text;
  v_columns text[];
  v_col text;
  v_type text;
  v_select_parts text[] := ARRAY[]::text[];
  v_sql text;
  v_view_name text;
BEGIN
  SELECT table_name INTO v_table_name
  FROM public.sync_tables
  WHERE id = _sync_table_id;

  IF v_table_name IS NULL THEN
    RETURN 'sync_table não encontrada';
  END IF;

  -- Coleta TODAS as chaves existentes na amostra de até 500 linhas
  SELECT ARRAY(
    SELECT DISTINCT k
    FROM (
      SELECT data FROM public.synced_rows
      WHERE sync_table_id = _sync_table_id
      LIMIT 500
    ) s,
    LATERAL jsonb_object_keys(s.data) k
    ORDER BY k
  ) INTO v_columns;

  IF v_columns IS NULL OR array_length(v_columns, 1) IS NULL THEN
    RETURN format('tabela %s sem dados — view não criada', v_table_name);
  END IF;

  FOREACH v_col IN ARRAY v_columns LOOP
    v_type := mirror.infer_sql_type(_sync_table_id, v_col);
    -- cast seguro: NULLIF pra string vazia, e cast tolerante
    IF v_type = 'timestamptz' THEN
      v_select_parts := v_select_parts || format(
        '(NULLIF(data->>%L, %L))::timestamptz AS %I',
        v_col, '', v_col
      );
    ELSIF v_type IN ('bigint','numeric') THEN
      v_select_parts := v_select_parts || format(
        '(NULLIF(data->>%L, %L))::%s AS %I',
        v_col, '', v_type, v_col
      );
    ELSE
      v_select_parts := v_select_parts || format(
        '(data->>%L) AS %I',
        v_col, v_col
      );
    END IF;
  END LOOP;

  v_view_name := format('mirror.%I', v_table_name);

  v_sql := format(
    'CREATE OR REPLACE VIEW %s AS SELECT %s FROM public.synced_rows WHERE sync_table_id = %L',
    v_view_name,
    array_to_string(v_select_parts, ', '),
    _sync_table_id
  );

  EXECUTE v_sql;

  RETURN format('view %s criada com %s colunas', v_view_name, array_length(v_columns, 1));
END;
$$;

-- ============================================================
-- Função: refresh em TODAS as tabelas ativas
-- ============================================================
CREATE OR REPLACE FUNCTION mirror.refresh_all_views()
RETURNS TABLE (table_name text, result text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT id, table_name AS tn
    FROM public.sync_tables
    WHERE enabled = true
      AND row_count > 0
    ORDER BY table_name
  LOOP
    table_name := r.tn;
    BEGIN
      result := mirror.refresh_view_for_table(r.id);
    EXCEPTION WHEN OTHERS THEN
      result := 'ERRO: ' || SQLERRM;
    END;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- ============================================================
-- Atualiza execute_bi_script: agora pode usar schema mirror
-- ============================================================
CREATE OR REPLACE FUNCTION public.execute_bi_script(_sql text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, mirror
AS $function$
DECLARE
  result jsonb;
  wrapped_sql text;
BEGIN
  wrapped_sql := format(
    'SELECT COALESCE(jsonb_agg(row_to_json(_sub)::jsonb), ''[]''::jsonb) FROM (%s) _sub',
    _sql
  );

  SET LOCAL transaction_read_only = on;
  SET LOCAL statement_timeout = '120s';

  EXECUTE wrapped_sql INTO result;
  RETURN result;
END;
$function$;

-- Permissões: master role já consegue ler via SECURITY DEFINER
GRANT USAGE ON SCHEMA mirror TO authenticated, anon, service_role;
