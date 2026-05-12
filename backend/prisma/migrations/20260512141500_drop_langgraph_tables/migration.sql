-- ============================================================================
-- drop_langgraph_tables
-- ----------------------------------------------------------------------------
-- As tabelas do PostgresSaver foram criadas erradas pelas migrations
-- anteriores (BYTEA onde o LangGraph espera JSONB) porque tinham models
-- correspondentes no schema.prisma. Removemos os models do schema e aqui
-- dropamos as tabelas para que `checkpointer.setup()` recrie com o schema
-- correto no próximo boot do backend.
--
-- CASCADE necessário porque a versão atual do LangGraph cria
-- `checkpoint_migrations` que pode ter FK pras outras.
-- ============================================================================

DROP TABLE IF EXISTS "checkpoint_writes" CASCADE;
DROP TABLE IF EXISTS "checkpoint_blobs" CASCADE;
DROP TABLE IF EXISTS "checkpoints" CASCADE;
DROP TABLE IF EXISTS "checkpoint_migrations" CASCADE;
