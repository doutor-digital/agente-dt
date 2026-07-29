-- Integração com a API Spine (franquia Doutor Hérnia) + kill switch da agenda.
--
-- POR QUE O KILL SWITCH VIVE NO BANCO, e não em memória:
-- a API da franquia não expõe bloqueios de agenda. Quando o médico bloqueia
-- um horário manualmente no sistema dela, isso é invisível para nós — a IA
-- marcaria em cima. A recepção precisa conseguir parar a IA em segundos, e
-- esse estado tem que sobreviver a deploy e valer para todas as réplicas do
-- container ao mesmo tempo. Cache em memória falharia justamente na hora do
-- incidente, que é quando ele importa.
ALTER TABLE "units" ADD COLUMN "spine_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "units" ADD COLUMN "spine_base_url" TEXT NOT NULL DEFAULT 'https://app-api-prod.doutorhernia.com.br';
ALTER TABLE "units" ADD COLUMN "spine_token" TEXT;

ALTER TABLE "units" ADD COLUMN "spine_ai_paused" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "units" ADD COLUMN "spine_paused_at" TIMESTAMP(3);
ALTER TABLE "units" ADD COLUMN "spine_paused_reason" TEXT;

-- Janela de ATENDIMENTO da clínica — distinta de business_hours_*, que diz
-- quando a IA responde. A IA pode conversar às 19h e mesmo assim não poder
-- marcar às 19h.
ALTER TABLE "units" ADD COLUMN "spine_agenda_start" TEXT NOT NULL DEFAULT '08:00';
ALTER TABLE "units" ADD COLUMN "spine_agenda_end" TEXT NOT NULL DEFAULT '18:00';
ALTER TABLE "units" ADD COLUMN "spine_lunch_start" TEXT DEFAULT '12:00';
ALTER TABLE "units" ADD COLUMN "spine_lunch_end" TEXT DEFAULT '13:00';
ALTER TABLE "units" ADD COLUMN "spine_agenda_days" INTEGER[] DEFAULT ARRAY[1, 2, 3, 4, 5];
ALTER TABLE "units" ADD COLUMN "spine_slot_minutes" INTEGER NOT NULL DEFAULT 30;

-- Fuso IANA por unidade. Offset fixo (-3) quebraria em Manaus (UTC-4) ou Rio
-- Branco (UTC-5) — e quebraria calado: o horário pareceria plausível e o
-- paciente chegaria na hora errada.
ALTER TABLE "units" ADD COLUMN "spine_timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo';
