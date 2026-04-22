-- ============ ROLES ============
CREATE TYPE public.app_role AS ENUM ('master');

CREATE TABLE public.user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.has_role(_user_id UUID, _role app_role)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;

CREATE POLICY "Masters read roles" ON public.user_roles
  FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(), 'master'));

CREATE POLICY "Users see own role" ON public.user_roles
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ============ SQL CONNECTIONS ============
CREATE TABLE public.sql_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL DEFAULT 1433,
  database_name TEXT NOT NULL,
  username TEXT NOT NULL,
  encrypt BOOLEAN NOT NULL DEFAULT true,
  trust_server_cert BOOLEAN NOT NULL DEFAULT true,
  status TEXT NOT NULL DEFAULT 'pending',
  last_seen_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.sql_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Master full sql_connections" ON public.sql_connections
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'master'))
  WITH CHECK (public.has_role(auth.uid(), 'master'));

CREATE TRIGGER sql_connections_updated
  BEFORE UPDATE ON public.sql_connections
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ SYNC TABLES ============
CREATE TABLE public.sync_tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES public.sql_connections(id) ON DELETE CASCADE,
  schema_name TEXT NOT NULL DEFAULT 'dbo',
  table_name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  strategy TEXT NOT NULL DEFAULT 'full_scan',
  primary_keys TEXT[] NOT NULL DEFAULT '{}',
  has_rowversion BOOLEAN NOT NULL DEFAULT false,
  row_count BIGINT NOT NULL DEFAULT 0,
  last_checksum TEXT,
  schema_hash TEXT,
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (connection_id, schema_name, table_name)
);

ALTER TABLE public.sync_tables ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Master full sync_tables" ON public.sync_tables
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'master'))
  WITH CHECK (public.has_role(auth.uid(), 'master'));

CREATE TRIGGER sync_tables_updated
  BEFORE UPDATE ON public.sync_tables
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ SYNCED ROWS (mirror) ============
CREATE TABLE public.synced_rows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sync_table_id UUID NOT NULL REFERENCES public.sync_tables(id) ON DELETE CASCADE,
  pk_hash TEXT NOT NULL,
  pk JSONB NOT NULL,
  data JSONB NOT NULL,
  row_hash TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (sync_table_id, pk_hash)
);

CREATE INDEX idx_synced_rows_table ON public.synced_rows(sync_table_id);
CREATE INDEX idx_synced_rows_data ON public.synced_rows USING GIN (data);

ALTER TABLE public.synced_rows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Master full synced_rows" ON public.synced_rows
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'master'))
  WITH CHECK (public.has_role(auth.uid(), 'master'));

-- ============ CUSTOM APIS ============
CREATE TABLE public.custom_apis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  method TEXT NOT NULL DEFAULT 'GET',
  route TEXT NOT NULL UNIQUE,
  sync_table_id UUID REFERENCES public.sync_tables(id) ON DELETE SET NULL,
  query_definition JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft',
  is_public BOOLEAN NOT NULL DEFAULT false,
  last_tested_at TIMESTAMPTZ,
  last_test_result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.custom_apis ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Master full custom_apis" ON public.custom_apis
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'master'))
  WITH CHECK (public.has_role(auth.uid(), 'master'));

CREATE TRIGGER custom_apis_updated
  BEFORE UPDATE ON public.custom_apis
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ============ SYNC LOGS ============
CREATE TABLE public.sync_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID REFERENCES public.sql_connections(id) ON DELETE CASCADE,
  sync_table_id UUID REFERENCES public.sync_tables(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info',
  event TEXT NOT NULL,
  message TEXT,
  rows_inserted INTEGER NOT NULL DEFAULT 0,
  rows_updated INTEGER NOT NULL DEFAULT 0,
  rows_deleted INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sync_logs_created ON public.sync_logs(created_at DESC);
CREATE INDEX idx_sync_logs_conn ON public.sync_logs(connection_id);

ALTER TABLE public.sync_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Master full sync_logs" ON public.sync_logs
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'master'))
  WITH CHECK (public.has_role(auth.uid(), 'master'));

-- ============ AGENT TOKENS ============
CREATE TABLE public.agent_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES public.sql_connections(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.agent_tokens ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Master full agent_tokens" ON public.agent_tokens
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'master'))
  WITH CHECK (public.has_role(auth.uid(), 'master'));