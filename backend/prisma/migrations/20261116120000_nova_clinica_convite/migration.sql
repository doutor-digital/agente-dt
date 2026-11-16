-- Formulário «nova clínica»: convites de uso único (só o hash do código) e as respostas do franqueado. Tabela nova: nada a preencher, nada existente é alterado.
CREATE TABLE "nova_clinica_convite" (
    "id" TEXT NOT NULL,
    "codigo_hash" TEXT NOT NULL,
    "rotulo" TEXT,
    "criado_por" TEXT NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expira_em" TIMESTAMP(3) NOT NULL,
    "enviado_em" TIMESTAMP(3),
    "slug_sugerido" TEXT,
    "respostas" JSONB,
    "importado_em" TIMESTAMP(3),

    CONSTRAINT "nova_clinica_convite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "nova_clinica_convite_codigo_hash_key" ON "nova_clinica_convite"("codigo_hash");

CREATE INDEX "nova_clinica_convite_slug_sugerido_idx" ON "nova_clinica_convite"("slug_sugerido");
