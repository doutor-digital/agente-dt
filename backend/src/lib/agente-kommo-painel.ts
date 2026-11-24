/**
 * O painel da Sofia para as unidades que usam o Kommo (pedido do João, 24/11/2026: «eu quero pra Kommo!» — a tela Agente do CRM).
 *
 * Os números do CRM vêm de `sofia_mensagem`/`sofia_evento`, que só o caminho do Chatwoot grava. No caminho do Kommo a fonte é o
 * rastro de execução (`execution_traces` + `execution_steps`), o MESMO que a página `/ia/:slug` e a tela «Como a Sofia funciona» já
 * contam — então um número aqui bate com o de lá (para «hoje»). Nada novo é gravado: só leitura.
 *
 *  - PESSOAS RESPONDIDAS: cartões com passo «Resposta entregue ao paciente via …» (menos `lead_note`, que é nota interna e o paciente
 *    não recebe) ou «🔊 Resposta enviada em áudio». Régua de cobrança, reativação e cartão de chegada NÃO entram: não são resposta.
 *  - CONSULTAS MARCADAS: passo «Consulta marcada: …», gravado só depois que a franquia aceitou o agendamento. Desmarcar depois não apaga.
 *  - PASSOU PARA A EQUIPE: passo «IA pausada no lead …», gravado depois que a marca «Pausar IA» foi escrita no cartão (handoff da Sofia).
 *  - PIX DO SINAL: `sinais_pix` da unidade (link criado; a reserva «criando» ainda não é Pix).
 *  - À NOITE OU NO FIM DE SEMANA: a hora do passo de resposta, no fuso da unidade.
 *  - FICAM DE FORA (sem fonte confiável no Kommo): avaliações 👍/👎 e «respostas para revisar» (só o balão do CRM tem o polegar) e o
 *    «Registro» por conversa. Número que não existe não é mostrado.
 *
 * A conta, a variação contra o período anterior e o gráfico são os MESMOS do CRM (`montarPainel`): uma regra só, dois lugares.
 *
 * Custo: o passo não tem índice próprio; a leitura entra pelos rastros da unidade (índice) e custa segundos em conta grande. Por isso a
 * leitura bruta é guardada 5 min por unidade, só uma roda por vez no servidor e ela tem prazo no banco (`statement_timeout`).
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { fusoDaUnidade } from './fuso.js';
import { CacheQueAguentaFalha, criarFilaDeUm, type LeituraComCache } from './ia-unidade.js';
import { janelas, montarPainel, type EventoDoPainel, type MarcadaDoPainel, type Painel, type Periodo, type RespostaDoPainel } from './agente-painel.js';

const DIA_MS = 86_400_000;
/** Os 14 dias do gráfico + 1: a leitura curta serve «hoje» e «7 dias» (o anterior de 7 dias cabe nela). */
const DIAS_CURTA = 15;
/** «30 dias» precisa dos 30 anteriores. */
const DIAS_LONGA = 61;
export const CACHE_DO_PAINEL_MS = 5 * 60_000;
const PRAZO_NO_BANCO_MS = 45_000;

export interface LinhaDoRastro {
  leadId: string;
  criadoEm: Date;
  tipo: 'resposta' | 'marcou' | 'equipe';
  /** só em `marcou`: "AAAA-MM-DD" e "HH:mm" da consulta */
  data: string | null;
  hora: string | null;
}

export interface LeituraBruta {
  linhas: LinhaDoRastro[];
  pix: Array<{ leadId: string; criadoEm: Date }>;
  /** a unidade já gerou algum Pix de sinal alguma vez (senão o número «0» na tela só confunde) */
  pixUsado: boolean;
  desde: Date;
}

const leadNumero = (id: string): number | null => {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/** PURA: das linhas cruas ao painel (a mesma conta do CRM). Linha com cartão que não é número é ignorada. */
export function painelDasLinhas(
  bruta: Pick<LeituraBruta, 'linhas' | 'pix'>,
  nomes: ReadonlyMap<number, string>,
  e: { agora: Date; periodo: Periodo; fuso: string },
): Painel {
  const respostas: RespostaDoPainel[] = [];
  const marcadas: MarcadaDoPainel[] = [];
  const eventos: EventoDoPainel[] = [];
  for (const l of bruta.linhas) {
    const conversa = leadNumero(l.leadId);
    if (conversa === null) continue;
    if (l.tipo === 'resposta') respostas.push({ conversa, criadoEm: l.criadoEm });
    else if (l.tipo === 'marcou') {
      marcadas.push({ conversa, nome: nomes.get(conversa) ?? null, agendadoPara: l.data && l.hora ? `${l.data}T${l.hora}` : null, criadoEm: l.criadoEm });
    } else eventos.push({ conversa, tipo: 'equipe', criadoEm: l.criadoEm });
  }
  for (const p of bruta.pix) {
    const conversa = leadNumero(p.leadId);
    if (conversa !== null) eventos.push({ conversa, tipo: 'pix', criadoEm: p.criadoEm });
  }
  return montarPainel({ respostas, marcadas, avaliacoes: [], eventos, agora: e.agora, periodo: e.periodo, fuso: e.fuso });
}

/** Quanto do passado a leitura precisa para o período pedido. */
export function diasDaLeitura(periodo: Periodo): number {
  return periodo === '30' ? DIAS_LONGA : DIAS_CURTA;
}

async function lerDoBanco(unitId: string, agora: Date, dias: number): Promise<LeituraBruta> {
  const inicio = Date.now();
  const desde = new Date(agora.getTime() - dias * DIA_MS);
  // o rastro nasce antes dos seus passos: o corte do rastro é um dia mais largo que o do passo
  const desdeRastro = new Date(desde.getTime() - DIA_MS);
  const [linhas, pix, pixAlgumaVez] = await Promise.all([
    prisma.$transaction(
      async (tx) => {
        // SET não aceita parâmetro ($1): o número é constante nossa, não vem de ninguém
        await tx.$executeRawUnsafe(`set local statement_timeout = ${PRAZO_NO_BANCO_MS}`);
        return tx.$queryRaw<LinhaDoRastro[]>`
          select t.lead_id as "leadId", s.created_at as "criadoEm",
            case when s.title like 'Consulta marcada:%' then 'marcou'
                 when s.title like 'IA pausada no lead%' then 'equipe'
                 else 'resposta' end as tipo,
            case when s.title like 'Consulta marcada:%' then s.payload->>'data' end as data,
            case when s.title like 'Consulta marcada:%' then s.payload->>'hora' end as hora
          from execution_traces t
          join execution_steps s on s.trace_id = t.id
          where t.unit_id = ${unitId}
            and t.created_at >= ${desdeRastro}
            and s.created_at >= ${desde}
            and ((s.title like 'Resposta entregue ao paciente via%' and strpos(s.title, 'lead_note') = 0)
              or s.title like '🔊 Resposta enviada em áudio%'
              or (s.kind = 'TOOL_RESULT' and s.title like 'Consulta marcada:%')
              or s.title like 'IA pausada no lead%')`;
      },
      { timeout: PRAZO_NO_BANCO_MS + 5_000, maxWait: 5_000 },
    ),
    prisma.sinalPix.findMany({ where: { unitId, criadoEm: { gte: desde }, status: { not: 'criando' } }, select: { leadId: true, criadoEm: true } }),
    prisma.sinalPix.findFirst({ where: { unitId, status: { not: 'criando' } }, select: { id: true } }),
  ]);
  // a leitura que DEU CERTO: é daqui que se prova o custo (e se cruza com o p95 da Sofia) depois do deploy
  logger.info({ unitId, dias, ms: Date.now() - inicio, linhas: linhas.length, pix: pix.length }, 'agente-kommo: painel lido');
  return { linhas, pix, pixUsado: pixAlgumaVez !== null, desde };
}

const cache = new CacheQueAguentaFalha<LeituraBruta>(CACHE_DO_PAINEL_MS, 60_000);
const emFila = criarFilaDeUm();

/** A leitura bruta da unidade (cache de 5 min; uma leitura de cada vez no servidor). */
export function leituraDaUnidade(unit: Pick<Unit, 'id'>, periodo: Periodo, agora = new Date()): Promise<LeituraComCache<LeituraBruta>> {
  const dias = diasDaLeitura(periodo);
  return cache.obter(`${unit.id}|${dias}`, () => emFila(() => lerDoBanco(unit.id, agora, dias)));
}

/** A leitura que já está guardada, mesmo vencida (para responder «atualizando…» sem esperar o banco). */
export function leituraGuardada(unit: Pick<Unit, 'id'>, periodo: Periodo): { valor: LeituraBruta; lidoEm: number } | null {
  return cache.espiar(`${unit.id}|${diasDaLeitura(periodo)}`);
}

/** Os nomes dos cartões (só dos poucos que aparecem na lista). */
export async function nomesDosCartoes(unitId: string, ids: readonly number[]): Promise<Map<number, string>> {
  if (!ids.length) return new Map();
  const l = await prisma.conversation.findMany({ where: { unitId, leadId: { in: ids.map(String) } }, select: { leadId: true, contactName: true } });
  const m = new Map<number, string>();
  for (const c of l) if (c.contactName?.trim()) m.set(Number(c.leadId), c.contactName.trim());
  return m;
}

export const linkDoCartao = (unit: Pick<Unit, 'kommoSubdomain'>, id: number): string | null =>
  unit.kommoSubdomain ? `https://${unit.kommoSubdomain}.kommo.com/leads/detail/${id}` : null;

export const semAnterior = (p: Painel): boolean => p.respondidas.antes === 0 && p.marcadas.antes === 0 && p.equipe.antes === 0 && p.pix.antes === 0;

export interface PainelDoKommo extends Painel {
  /** nada aconteceu no período anterior (o histórico da unidade é mais curto, ou a Sofia estava parada): a tela não compara com zero */
  semAnterior: boolean;
  pixUsado: boolean;
  lidoEm: string;
  desatualizado: boolean;
  /** a leitura nova está em andamento por trás: a página pergunta de novo sozinha */
  atualizando: boolean;
  ultimasMarcadas: Array<Painel['ultimasMarcadas'][number] & { link: string | null }>;
  consultasDoPeriodo: Array<Painel['ultimasMarcadas'][number] & { link: string | null }>;
}

export async function painelDoKommo(
  unit: Pick<Unit, 'id' | 'slug' | 'kommoSubdomain' | 'spineTimezone' | 'businessHoursTimezone'>,
  periodo: Periodo,
  leitura: { valor: LeituraBruta; lidoEm: number; desatualizado: boolean; atualizando?: boolean },
  agora = new Date(),
): Promise<PainelDoKommo> {
  const fuso = fusoDaUnidade(unit);
  // quem aparece na lista: só as 10 últimas marcadas do período (os nomes vêm do banco, só delas)
  const j = janelas(agora, periodo, fuso);
  const ids = [...new Set(leitura.valor.linhas.filter((l) => l.tipo === 'marcou' && l.criadoEm >= j.inicio).sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime()).map((l) => Number(l.leadId)).filter((n) => Number.isInteger(n) && n > 0).slice(0, 10))];
  const nomes = await nomesDosCartoes(unit.id, ids);
  const painel = painelDasLinhas(leitura.valor, nomes, { agora, periodo, fuso });
  const ultimas = painel.ultimasMarcadas.map((m) => ({ ...m, link: linkDoCartao(unit, m.conversa) }));
  return {
    ...painel,
    semAnterior: semAnterior(painel),
    pixUsado: leitura.valor.pixUsado,
    lidoEm: new Date(leitura.lidoEm).toISOString(),
    desatualizado: leitura.desatualizado,
    atualizando: leitura.atualizando === true,
    ultimasMarcadas: ultimas,
    // a lista completa do card «Consultas marcadas»: no Kommo só as 10 últimas têm nome e link (os nomes vêm do banco só delas); o total real vai em `consultasTotal`
    consultasDoPeriodo: ultimas,
  };
}

// ── pausadas ─────────────────────────────────────────────────────────────────────────────────────────────

export interface PausadaDoKommo {
  leadId: number;
  nome: string;
  /** equipe = a Sofia se calou porque a equipe falou com o paciente (volta depois que a equipe para de falar); janela = pausa com data pedida por alguém */
  tipo: 'equipe' | 'janela';
  /** a equipe também está atendendo este cartão (pausa da equipe aberta): «devolver» tira só a pausa com data */
  equipeTambem: boolean;
  por: string | null;
  desde: Date;
  ate: Date | null;
  link: string | null;
}

export async function pausadasDaUnidade(unit: Pick<Unit, 'id' | 'kommoSubdomain'>, agora = new Date()): Promise<PausadaDoKommo[]> {
  const [equipe, janela] = await Promise.all([
    prisma.pausaDaEquipe.findMany({ where: { unitId: unit.id, encerradaEm: null }, orderBy: { pausadoEm: 'desc' }, take: 100 }),
    prisma.leadPausa.findMany({ where: { unitId: unit.id, ate: { gt: agora } }, orderBy: { criadoEm: 'desc' }, take: 100 }),
  ]);
  const nomes = await nomesDosCartoes(unit.id, [...new Set([...equipe.map((p) => p.kommoLeadId), ...janela.map((p) => p.kommoLeadId)])]);
  const nome = (id: number) => nomes.get(id) ?? `Cartão ${id}`;
  const lista: PausadaDoKommo[] = [
    ...janela.map((p): PausadaDoKommo => ({ leadId: p.kommoLeadId, nome: nome(p.kommoLeadId), tipo: 'janela', equipeTambem: equipe.some((x) => x.kommoLeadId === p.kommoLeadId), por: p.por, desde: p.criadoEm, ate: p.ate, link: linkDoCartao(unit, p.kommoLeadId) })),
    // o cartão que tem as duas pausas aparece uma vez só, pela que o João/recepção pediu (a que tem data)
    ...equipe
      .filter((p) => !janela.some((x) => x.kommoLeadId === p.kommoLeadId))
      .map((p): PausadaDoKommo => ({ leadId: p.kommoLeadId, nome: nome(p.kommoLeadId), tipo: 'equipe', equipeTambem: true, por: p.falaAutor, desde: p.pausadoEm, ate: null, link: linkDoCartao(unit, p.kommoLeadId) })),
  ];
  return lista.sort((a, b) => b.desde.getTime() - a.desde.getTime());
}
