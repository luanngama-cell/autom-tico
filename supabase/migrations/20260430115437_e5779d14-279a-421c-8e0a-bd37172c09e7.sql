
-- ============================================================
-- Pilar 5: Índices JSONB para acelerar queries BI
-- ============================================================

-- 1) Índice combinado (sync_table_id + chave JSONB) — usa expression index
--    Estes índices ajudam tanto a view mirror quanto qualquer query direta
--    em synced_rows.

-- FICHAS (PK: NROFICHA)
CREATE INDEX IF NOT EXISTS idx_sr_fichas_nroficha
  ON public.synced_rows (sync_table_id, ((data->>'NROFICHA')))
  WHERE sync_table_id = '7d1c21f7-8ee5-4b09-9701-a242fa793b0b';

CREATE INDEX IF NOT EXISTS idx_sr_fichas_nome
  ON public.synced_rows (sync_table_id, ((data->>'NOME')))
  WHERE sync_table_id = '7d1c21f7-8ee5-4b09-9701-a242fa793b0b';

CREATE INDEX IF NOT EXISTS idx_sr_fichas_cpf
  ON public.synced_rows (sync_table_id, ((data->>'CPF')))
  WHERE sync_table_id = '7d1c21f7-8ee5-4b09-9701-a242fa793b0b';

-- fichas_atendimento (PK: codigo, FK comum: NROFICHA, codigo_medico, dt_atendimento)
CREATE INDEX IF NOT EXISTS idx_sr_fa_codigo
  ON public.synced_rows (sync_table_id, ((data->>'codigo')))
  WHERE sync_table_id = '25de7053-250d-43e2-89d4-8fb8d5b7993e';

CREATE INDEX IF NOT EXISTS idx_sr_fa_nroficha
  ON public.synced_rows (sync_table_id, ((data->>'NROFICHA')))
  WHERE sync_table_id = '25de7053-250d-43e2-89d4-8fb8d5b7993e';

CREATE INDEX IF NOT EXISTS idx_sr_fa_dt
  ON public.synced_rows (sync_table_id, ((data->>'dt_atendimento')))
  WHERE sync_table_id = '25de7053-250d-43e2-89d4-8fb8d5b7993e';

CREATE INDEX IF NOT EXISTS idx_sr_fa_medico
  ON public.synced_rows (sync_table_id, ((data->>'codigo_medico')))
  WHERE sync_table_id = '25de7053-250d-43e2-89d4-8fb8d5b7993e';

-- AGENDA (PK: CODIGO)
CREATE INDEX IF NOT EXISTS idx_sr_agenda_codigo
  ON public.synced_rows (sync_table_id, ((data->>'CODIGO')))
  WHERE sync_table_id = '92882193-9024-4a47-ac71-be1d713ae150';

-- AGENDAHS (PK: CODIGO, FKs: CODIGO_MEDICOS, DT, NROFICHA)
CREATE INDEX IF NOT EXISTS idx_sr_agendahs_codigo
  ON public.synced_rows (sync_table_id, ((data->>'CODIGO')))
  WHERE sync_table_id = '5289aa6b-6a5a-474f-9920-47a929c647bc';

CREATE INDEX IF NOT EXISTS idx_sr_agendahs_dt
  ON public.synced_rows (sync_table_id, ((data->>'DT')))
  WHERE sync_table_id = '5289aa6b-6a5a-474f-9920-47a929c647bc';

CREATE INDEX IF NOT EXISTS idx_sr_agendahs_medico
  ON public.synced_rows (sync_table_id, ((data->>'CODIGO_MEDICOS')))
  WHERE sync_table_id = '5289aa6b-6a5a-474f-9920-47a929c647bc';

CREATE INDEX IF NOT EXISTS idx_sr_agendahs_nroficha
  ON public.synced_rows (sync_table_id, ((data->>'NROFICHA')))
  WHERE sync_table_id = '5289aa6b-6a5a-474f-9920-47a929c647bc';

-- ATENDIM (PK: NATENDIMENTO)
CREATE INDEX IF NOT EXISTS idx_sr_atendim_n
  ON public.synced_rows (sync_table_id, ((data->>'NATENDIMENTO')))
  WHERE sync_table_id = 'c575ec97-27b6-4528-8be2-8921fdaf7274';

-- fichas_convenios (PK: codigo, FK: NROFICHA)
CREATE INDEX IF NOT EXISTS idx_sr_fc_nroficha
  ON public.synced_rows (sync_table_id, ((data->>'NROFICHA')))
  WHERE sync_table_id = '89b9e925-d0c5-4bdb-a7ef-586bda92a4ca';

-- 2) Índice GIN geral em data — para queries com filtros arbitrários
CREATE INDEX IF NOT EXISTS idx_sr_data_gin
  ON public.synced_rows USING GIN (data jsonb_path_ops);

-- 3) Atualiza estatísticas
ANALYZE public.synced_rows;
