CREATE OR REPLACE FUNCTION public.validate_bi_cron_token(_token text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, vault
AS $$
DECLARE
  stored_token text;
BEGIN
  SELECT decrypted_secret INTO stored_token
  FROM vault.decrypted_secrets
  WHERE name = 'bi_cron_token'
  LIMIT 1;

  IF stored_token IS NULL THEN
    RETURN false;
  END IF;

  RETURN stored_token = _token;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_bi_cron_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.validate_bi_cron_token(text) TO service_role;