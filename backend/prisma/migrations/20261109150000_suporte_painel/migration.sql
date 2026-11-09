-- Painel do suporte (suporte.doutordigitalconsultoria.com): status da demanda (aberta/resolvida/reaberta) e a base de conhecimento
-- que a análise automática lê. Migration manual e aditiva. A base nasce com as causas conhecidas anotadas até 09/11/2026 (editáveis no painel).
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'aberta';
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "resolvida_em" TIMESTAMP(3);
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "resolvida_por" TEXT;
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "nota_resolucao" TEXT;
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "reaberta_em" TIMESTAMP(3);
ALTER TABLE "suporte_demandas" ADD COLUMN IF NOT EXISTS "vezes_reaberta" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "suporte_demandas_status_idx" ON "suporte_demandas"("status");

CREATE TABLE IF NOT EXISTS "suporte_conhecimento" (
    "id" TEXT NOT NULL,
    "titulo" TEXT NOT NULL,
    "texto" TEXT NOT NULL,
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "autor" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suporte_conhecimento_pkey" PRIMARY KEY ("id")
);

INSERT INTO "suporte_conhecimento" ("id", "titulo", "texto", "autor", "atualizado_em") VALUES
('kb-kommo-402', 'Kommo em modo só leitura (erro 402)', 'Conta Kommo com pagamento vencido fica SÓ LEITURA: a API responde HTTP 402, robôs não rodam, a Sofia não grava nada e os leads ficam parados. Salto estava assim desde 04/11/2026. Como reconhecer: erros "402" no log da unidade; a equipe diz que não consegue mexer nos cartões. O que fazer: regularizar o pagamento da conta Kommo da unidade (financeiro/franqueado); depois conferir se robôs e gatilhos voltaram.', 'anotado pelo Claude em 09/11/2026', CURRENT_TIMESTAMP),
('kb-meta-token', 'Rastreio de anúncios sem campanha/conjunto/anúncio', 'O token global META_ADS_TOKEN parou de funcionar em 01/10/2026: na rede toda, campanha, conjunto e anúncio chegam vazios. O rastreio passou para token próprio por unidade (13 unidades em 05/11/2026; 5 ainda dependiam de acesso no Business Manager). Unidade sem fluxo de rastreio (CTWA) no n8n não registra clique nenhum. O que conferir: se a unidade tem fluxo de rastreio ativo no n8n e token próprio válido; leads sem origem no cartão costumam vir daí.', 'anotado pelo Claude em 09/11/2026', CURRENT_TIMESTAMP),
('kb-mossoro-lite', 'Mossoró: anúncios caem no WhatsApp Lite (sem rastreio)', 'Em Mossoró a maioria dos anúncios leva para um WhatsApp sem API oficial ("Lite"), que não manda o clique do anúncio. Decisão do João (05/11/2026): fica sem rastreio. Leads sem origem em Mossoró são esperados por isso; não é defeito.', 'anotado pelo Claude em 09/11/2026', CURRENT_TIMESTAMP),
('kb-sem-unidade', 'Cartão sem "Unidade de atendimento" (Petrópolis/Caxias)', 'Petrópolis e Caxias usaram a MESMA conta Kommo; em 06/11/2026 Caxias ganhou conta própria, ainda sem token cadastrado no agente. Lead novo que nasce sem o campo "⌂ Unidade de atendimento" não entra nos relatórios de nenhuma das duas, e a Sofia de Petrópolis NÃO responde cartão sem unidade (bloqueio "sem-unidade", visto em 04/11/2026). O que conferir: se o campo está vazio nos cartões novos e por qual canal eles entraram.', 'anotado pelo Claude em 09/11/2026', CURRENT_TIMESTAMP),
('kb-tatui', 'Tatuí na estrutura antiga / fora da Kommo', 'Tatuí (05/11/2026) está na estrutura antiga do Kommo (54 campos, tudo visível, sem o molde por etapa) e a equipe trabalha os leads só no CRM da franquia, então a origem não é registrada. Não é defeito pontual: falta a implantação do molde e do rastreio na unidade.', 'anotado pelo Claude em 09/11/2026', CURRENT_TIMESTAMP),
('kb-obrigatorio', 'Cartão não muda de etapa', 'No Kommo, campo OBRIGATÓRIO é cumulativo: o obrigatório de uma etapa vale para todas as seguintes e trava a mudança de etapa (de robô ou de pessoa) se estiver vazio. Regra do molde (06/11/2026): nenhum obrigatório antes de GANHO. O que conferir: quais campos obrigatórios a etapa de destino exige e se estão vazios no cartão.', 'anotado pelo Claude em 09/11/2026', CURRENT_TIMESTAMP),
('kb-automacao-desligada', 'Robô/automação "não disparou"', 'As automações do agente nascem DESLIGADAS ou em "Só no papel" (registram o que fariam sem fazer). Antes de procurar defeito, conferir na tela Automações do console se ela está "Ligada" naquela unidade. Robôs do próprio Kommo (Salesbot/gatilhos) são outra coisa: conferir se o robô e o gatilho estão ativos e se a etiqueta/etapa que dispara foi mesmo aplicada.', 'anotado pelo Claude em 09/11/2026', CURRENT_TIMESTAMP),
('kb-sofia-nao-envia', 'Sofia não responde / não envia', 'Causas já vistas: (1) cartão sem unidade (bloqueio sem-unidade); (2) "Pausar IA" marcado no cartão; (3) campo de entrega do Salesbot (kommo_salesbot_id) vazio na unidade; (4) chave da IA vencida ou sem crédito (erro 401/429 no log; a de Taubaté venceu em 05/10/2026); (5) conta Kommo só leitura (402). O que conferir: os erros da unidade no log e o cartão citado.', 'anotado pelo Claude em 09/11/2026', CURRENT_TIMESTAMP),
('kb-duplicada', 'Mensagem duplicada da Sofia', 'Mensagem repetida para o paciente costuma vir do Salesbot relendo o campo "Resposta" do cartão, ou de dois workers rodando ao mesmo tempo depois de um deploy (corrigido com a trava de liderança dos workers). O que conferir: o histórico do cartão (de onde saiu cada envio) e se houve deploy na hora.', 'anotado pelo Claude em 09/11/2026', CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;
