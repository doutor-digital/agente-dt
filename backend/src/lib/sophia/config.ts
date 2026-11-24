/**
 * Sophia, a IA do escritório de advocacia (fase 1: agenda dos advogados na Tramitação Inteligente).
 *
 * Automação `sophia-agenda` (SOPHIA_AGENDA_SLUGS), nasce DESLIGADA. Três estados, como o resto da casa:
 *  - desligado: as ferramentas da Sophia nem existem para o modelo;
 *  - seco ("só no papel"): consulta os horários de verdade (só leitura), decide e REGISTRA (trace + log + tela), mas não cria evento
 *    na Tramitação, não move o cartão e não manda nada ao grupo;
 *  - ligado: faz tudo.
 *
 * Toda configuração por escritório vem de variável de ambiente em JSON {"<slug>": ...}. Nada de telefone, id de grupo ou link
 * mora no repositório (ele é público).
 *  - SOPHIA_GRUPO_INTERNO:  {"<slug>": "<id do grupo>@g.us"}
 *  - SOPHIA_ADVOGADOS:      {"<slug>": {"amanda": {"numero": "55…", "tramitacao": "Amanda"}, "victor": {…}, "thiago": {"numero": "55…"}}}
 *                           `numero` é quem o grupo marca; `tramitacao` é o nome (ou parte do nome) do usuário na Tramitação, ou
 *                           `tramitacaoId` com o id público dele. Sem `tramitacao`, vale o primeiro nome (Amanda, Victor).
 *  - SOPHIA_MEET_URL:       {"<slug>": "https://meet.google.com/…"}  (vazio = a equipe envia o link)
 *  - SOPHIA_ETAPA_ANALISE_AGENDADA: {"<slug>": {"pipelineId": 1, "statusId": 2}}  (etapa "4 - Análise agendada" do funil Comercial)
 *  - SOPHIA_EVOLUTION_URL / _HEADER / _VALUE: a Evolution que fala no grupo (padrão: os EVOLUTION_ALERT_*). A instância tem de estar no grupo.
 */
import { estadoDaAutomacao, type Estado } from '../automacoes-estado.js';
import { logger } from '../logger.js';

export const ID_DA_AUTOMACAO = 'sophia-agenda';

/** Fuso do escritório (Araguaína/TO): UTC-3 o ano todo, sem horário de verão. */
export const FUSO_DO_ESCRITORIO = 'America/Araguaina';
export const OFFSET_DO_ESCRITORIO = '-03:00';

export type ChaveDoAdvogado = 'amanda' | 'victor' | 'thiago';
/** Quem a Sophia pode AGENDAR. O Dr. Thiago nunca agenda: só é avisado. */
export const QUEM_AGENDA: readonly ChaveDoAdvogado[] = ['amanda', 'victor'];

const PADRAO: Record<ChaveDoAdvogado, { tratamento: string; nome: string; tramitacao: string | null }> = {
  amanda: { tratamento: 'Dra Amanda', nome: 'Dra. Amanda', tramitacao: 'Amanda' },
  victor: { tratamento: 'Dr Victor', nome: 'Dr. Victor', tramitacao: 'Victor' },
  thiago: { tratamento: 'Dr Thiago', nome: 'Dr. Thiago', tramitacao: null },
};

export interface Advogado {
  chave: ChaveDoAdvogado;
  /** "Dra Amanda": o que vai entre parênteses no título do evento. */
  tratamento: string;
  /** "Dra. Amanda": como a Sophia fala. */
  nome: string;
  /** Só dígitos (com DDI) para marcar no grupo; null = sem número configurado. */
  numero: string | null;
  /** Nome (ou parte) do usuário na Tramitação. Null no Dr. Thiago. */
  tramitacao: string | null;
  tramitacaoId: string | null;
}

export function estadoDaSophia(slug: string): Estado {
  return estadoDaAutomacao(slug, ID_DA_AUTOMACAO, process.env.SOPHIA_AGENDA_SLUGS);
}

function lerMapa(nome: string, raw: string | undefined = process.env[nome]): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try {
    const j = JSON.parse(raw.trim().replace(/^'|'$/g, '')) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : {};
  } catch {
    logger.warn({ variavel: nome }, 'sophia: variável não é JSON válido — ignorada');
    return {};
  }
}

const texto = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const soDigitos = (v: unknown): string | null => {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length >= 10 ? d : null;
};

export function grupoInterno(slug: string, raw?: string): string | null {
  const g = texto(lerMapa('SOPHIA_GRUPO_INTERNO', raw)[slug]);
  return g && g.endsWith('@g.us') ? g : null;
}

export function linkDoMeet(slug: string, raw?: string): string | null {
  const l = texto(lerMapa('SOPHIA_MEET_URL', raw)[slug]);
  return l && /^https:\/\//i.test(l) ? l : null;
}

export function etapaAnaliseAgendada(slug: string, raw?: string): { pipelineId: number; statusId: number } | null {
  const e = lerMapa('SOPHIA_ETAPA_ANALISE_AGENDADA', raw)[slug] as { pipelineId?: unknown; statusId?: unknown } | undefined;
  const pipelineId = Number(e?.pipelineId);
  const statusId = Number(e?.statusId);
  return Number.isInteger(pipelineId) && pipelineId > 0 && Number.isInteger(statusId) && statusId > 0 ? { pipelineId, statusId } : null;
}

export function advogado(slug: string, chave: ChaveDoAdvogado, raw?: string): Advogado {
  const cfg = (lerMapa('SOPHIA_ADVOGADOS', raw)[slug] as Record<string, Record<string, unknown> | string> | undefined)?.[chave];
  const o: Record<string, unknown> = typeof cfg === 'string' ? { numero: cfg } : (cfg ?? {});
  const p = PADRAO[chave];
  return {
    chave,
    tratamento: p.tratamento,
    nome: p.nome,
    numero: soDigitos(o.numero),
    tramitacao: chave === 'thiago' ? null : (texto(o.tramitacao) ?? p.tramitacao),
    tramitacaoId: texto(o.tramitacaoId),
  };
}

export interface EvolutionDoGrupo {
  url: string;
  header: string;
  valor: string;
}

export function evolutionDoGrupo(): EvolutionDoGrupo | null {
  const url = process.env.SOPHIA_EVOLUTION_URL || process.env.EVOLUTION_ALERT_URL;
  const header = process.env.SOPHIA_EVOLUTION_HEADER || process.env.EVOLUTION_ALERT_HEADER;
  const valor = process.env.SOPHIA_EVOLUTION_VALUE || process.env.EVOLUTION_ALERT_VALUE;
  return url && header && valor ? { url, header, valor } : null;
}
