import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATABASE_URL: z.string().url(),

  KOMMO_SUBDOMAIN: z.string().min(1),
  KOMMO_ACCESS_TOKEN: z.string().min(10),

  KOMMO_SALESBOT_ID: z.coerce.number().int().positive().optional(),
  KOMMO_REPLY_FIELD_ID: z.coerce.number().int().positive().optional(),

  STALE_REPLY_ALERT_MINUTES: z.coerce.number().int().positive().default(3),

  OPENAI_API_KEY: z.string().min(10),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),

  OPENAI_TRANSCRIPTION_API_KEY: z.string().min(10).optional(),

  // Copiloto da recepção (widget do Kommo): chave PRÓPRIA da OpenAI, com teto de gasto, separada da do agente.
  // COPILOTO_UNIDADES = slugs (separados por vírgula) onde está liberado; vazio = desligado em toda a rede.
  COPILOTO_OPENAI_API_KEY: z.string().min(10).optional(),
  COPILOTO_MODELO: z.string().default('gpt-4.1-mini'),
  // Voz em tempo real do Copiloto (OpenAI Realtime). Só vale nas unidades de COPILOTO_UNIDADES e com a mesma chave.
  COPILOTO_VOZ_MODELO: z.string().default('gpt-realtime-2.1-mini'),
  COPILOTO_VOZ_VOZ: z.string().default('marin'),
  // conversas por voz que cada unidade pode abrir por dia (em memória; o teto de gasto da chave é a trava de verdade)
  COPILOTO_VOZ_SESSOES_DIA: z.coerce.number().int().positive().default(40),
  COPILOTO_UNIDADES: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean),
    ),

  FRONTEND_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim().replace(/\/$/, ''))
        .filter(Boolean),
    ),

  SESSION_JWT_SECRET: z.string().min(32, 'SESSION_JWT_SECRET precisa ter >=32 chars'),

  AUTH_COOKIE_NAME: z.string().default('dt_session'),
  AUTH_COOKIE_DOMAIN: z.string().optional(),
  AUTH_SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  INTERNAL_API_KEY: z.string().min(16).optional(),

  // Conector remoto do claude.ai (MCP com OAuth em /mcp). Sem esta variável, NADA do conector sobe.
  // Valor: a origem pública deste backend, ex. https://agente-vps.doutordigitalconsultoria.com
  MCP_URL_PUBLICA: z.string().url().optional(),
  // Endereços EXATOS pra onde o login do conector pode devolver o código (além de loopback, do Claude Code).
  MCP_RETORNOS_PERMITIDOS: z
    .string()
    .default('https://claude.ai/api/mcp/auth_callback,https://claude.com/api/mcp/auth_callback')
    .transform((v) =>
      v
        .split(',')
        .map((u) => u.trim())
        .filter(Boolean),
    ),
  // Hosts que podem publicar o documento de cliente (CIMD) — o claude.ai publica o dele.
  MCP_HOSTS_CIMD: z
    .string()
    .default('claude.ai,claude.com')
    .transform((v) =>
      v
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ),

  DASHBOARD_WEBHOOK_BASE_URL: z
    .string()
    .url()
    .default('https://doutor-digital-dash-production.up.railway.app/webhooks/agent'),

  // Ponte do widget "Números da unidade" (Kommo) com o dashboard (.NET, api-vps): a rota
  // `internal/audit/kpis` devolve número + conferência + lista nominal por card. Sem estes
  // três, a rota do widget responde `dashboard:false` e o widget mostra só as pendências do Kommo.
  DASHBOARD_API_URL: z.string().url().optional(),
  DASHBOARD_ADMIN_KEY: z.string().min(8).optional(),
  // JSON { "<subdomínio Kommo>": <unitId no dashboard> } — as duas bases não compartilham id nem slug (Porto: -porto × -porto-nacional)
  DASHBOARD_UNIT_IDS: z.string().optional(),
  /** Unidades onde a mudança de etapa carimba Início/Fim do tratamento e encerra a conversa (csv; `*` = todas). */
  CARIMBO_ETAPA_SLUGS: z.string().optional(),
  /** Fase 2 do sincronizador: unidades onde a franquia MOVE a etapa do cartão (csv; `*` = todas). */
  FRANQUIA_MOVE_SLUGS: z.string().optional(),
  /** Horas em COMPARECEU sem tratamento até o cartão ir pra EM NEGOCIAÇÃO (padrão 48). */
  FRANQUIA_NEGOCIACAO_HORAS: z.string().optional(),
  /** Unidades onde a Sofia fica calada em GANHO / ALTA / TRATAMENTO CANCELADO e só deixa nota (csv; `*` = todas). */
  SOFIA_CALADA_SLUGS: z.string().optional(),
  /** Unidades onde lead sem nome vira "Lead dd/mm/aaaa" ("Lead 2 dd/mm/aaaa" pro segundo do dia) na 1ª mensagem (csv; `*` = todas). */
  TITULO_PADRAO_SLUGS: z.string().optional(),
  /** Fase 2, revisão dos cartões em AGENDADO com consulta mais velha que D-3 pelo histórico do paciente (csv; `*` = todas; vazio = desligado). */
  FRANQUIA_REVISAO_SLUGS: z.string().optional(),
  /** `1` = a revisão pelo histórico só registra o que faria (rodada de prova em produção). */
  FRANQUIA_REVISAO_SECO: z.string().optional(),
  /** Cadastrar TODO lead na franquia, como lead e na 1ª mensagem (27/10/2026) — nasce desligada; a tela manda (csv; `*` = todas). */
  CADASTRO_TODO_LEAD_SLUGS: z.string().optional(),
  /** Telefones da rede (csv, número completo; compara pelos últimos 8 dígitos) que a IA nunca cadastra na franquia. */
  NUMEROS_INTERNOS: z.string().optional(),
  /** Regras de 16/10/2026 do casamento cartão × paciente e da jornada (csv; `*` = todas; vazio = desligado — a tela manda). */
  CASAMENTO_JORNADA_SLUGS: z.string().optional(),
  /** Unidades que saem do modo seco do worker de parados mesmo com PARADOS_SECO=1 (csv; `*` = todas). */
  PARADOS_LIGADO_SLUGS: z.string().optional(),
  /** Só a volta de EM ESPERA (paciente escreveu → EM QUALIFICAÇÃO), sem as regras de prazo do worker (csv; `*` = todas). */
  VOLTA_ESPERA_SLUGS: z.string().optional(),
  /** Parados também nos estoques que nenhuma regra alcançava (auditoria 16/10, item 11) — nasce desligada (csv; `*` = todas). */
  PARADOS_ESTOQUES_SLUGS: z.string().optional(),
  /** Unidades com o cartão enxuto: o vigia de cartão só cobra o que continua humano (csv; `*` = todas). */
  CARTAO_ENXUTO_SLUGS: z.string().optional(),
  /** Resumo diário da qualidade da Sofia no Telegram do João (global, não por unidade): `seco` (padrão; só loga) | `ligado` | `desligado`. */
  RESUMO_DIARIO_IA: z.string().optional(),
  /** Menu de suporte no WhatsApp (global): `desligado` (padrão) | `seco` (registra o que responderia, não envia nem grava) | `ligado`. Ver `suporte-menu.ts`. */
  SUPORTE_MENU: z.string().optional(),
  /** Segredo do webhook do menu (`?k=`). Sem ele o webhook recusa tudo. */
  SUPORTE_MENU_SEGREDO: z.string().optional(),
  /** Evolution do agente de suporte: URL https, nome da instância (padrão `analista-dt`) e a chave DA INSTÂNCIA. */
  SUPORTE_EVO_URL: z.string().optional(),
  SUPORTE_EVO_INSTANCIA: z.string().optional(),
  SUPORTE_EVO_APIKEY: z.string().optional(),
  /** Onde LER os grupos "Mkt | Dr Hérnia …" (padrão: a mesma instância acima; só leitura). */
  SUPORTE_GRUPOS_URL: z.string().optional(),
  SUPORTE_GRUPOS_INSTANCIA: z.string().optional(),
  SUPORTE_GRUPOS_APIKEY: z.string().optional(),
  /** Tetos anti-ban: conversas novas por hora (10) e respostas por dia (150). */
  SUPORTE_MENU_NOVAS_POR_HORA: z.string().optional(),
  SUPORTE_MENU_RESPOSTAS_POR_DIA: z.string().optional(),
  /** Bots do Telegram por canal (além do DD-Avisos, `TELEGRAM_BOT_TOKEN`). Sem token próprio o canal cai no DD-Avisos. Ver `telegram.ts`. */
  TELEGRAM_CHAMADOS_TOKEN: z.string().optional(),
  TELEGRAM_CHAMADOS_CHAT: z.string().optional(),
  TELEGRAM_SOFIA_TOKEN: z.string().optional(),
  TELEGRAM_SOFIA_CHAT: z.string().optional(),
  /** Análise automática das demandas do menu de suporte (global): `desligado` (padrão) | `seco` (só Telegram) | `ligado` (também responde o prazo). */
  SUPORTE_ANALISE: z.string().optional(),
  /** Chave da OpenAI SÓ do suporte (separada da da Sofia), o modelo (padrão gpt-4o-mini) e o teto de análises em 24 h (padrão 40). */
  SUPORTE_OPENAI_KEY: z.string().optional(),
  SUPORTE_IA_MODELO: z.string().optional(),
  SUPORTE_ANALISE_POR_DIA: z.string().optional(),
  SUPORTE_OPENAI_API: z.string().optional(),
  /** Agente de suporte 24 h (Claude Code na VPS): `desligado` (padrão) | `ligado`; e a chave do trabalhador (24+ caracteres). */
  SUPORTE_CLAUDE: z.string().optional(),
  SUPORTE_CLAUDE_CHAVE: z.string().optional(),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('[env] Configuração inválida:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
