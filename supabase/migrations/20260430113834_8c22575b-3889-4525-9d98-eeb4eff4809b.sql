
DO $$
DECLARE
  r record;
  ok_count int := 0;
  err_count int := 0;
  res text;
BEGIN
  FOR r IN
    SELECT st.id AS sid, st.table_name AS tn
    FROM public.sync_tables st
    WHERE st.enabled = true
      AND st.row_count > 0
    ORDER BY st.table_name
  LOOP
    BEGIN
      res := mirror.refresh_view_for_table(r.sid);
      IF res LIKE 'view %' THEN
        ok_count := ok_count + 1;
      ELSE
        err_count := err_count + 1;
        RAISE NOTICE 'Skip %: %', r.tn, res;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      err_count := err_count + 1;
      RAISE NOTICE 'ERRO %: %', r.tn, SQLERRM;
    END;
  END LOOP;
  RAISE NOTICE 'Views criadas: % | Pulos/erros: %', ok_count, err_count;
END $$;
