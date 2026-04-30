
DROP FUNCTION IF EXISTS mirror.refresh_all_views();

CREATE FUNCTION mirror.refresh_all_views()
RETURNS TABLE (tbl_name text, result text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT st.id AS sid, st.table_name AS tn
    FROM public.sync_tables st
    WHERE st.enabled = true
      AND st.row_count > 0
    ORDER BY st.table_name
  LOOP
    tbl_name := r.tn;
    BEGIN
      result := mirror.refresh_view_for_table(r.sid);
    EXCEPTION WHEN OTHERS THEN
      result := 'ERRO: ' || SQLERRM;
    END;
    RETURN NEXT;
  END LOOP;
END;
$$;
