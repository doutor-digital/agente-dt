/**
 * O worker que preenche o que a IA deixou vazio — depois da conversa, sem gastar token.
 *
 * O problema que ele resolve (medido em 26/09/2026): a IA grava Qualificação em 31% dos
 * leads na Serra, Sexo em 21%. Onde o número parece bom — Canaã 93% — é a recepção
 * preenchendo na mão porque o Kommo trava a etapa, não a IA trabalhando.
 *
 * POR QUE AQUI E NÃO NO PROMPT. Mandar mais instrução já foi tentado: a Serra manda
 * "OBRIGATÓRIO na 1ª resposta: deduza pelo nome" e entrega 21%. Cada palavra dessa
 * instrução viaja em TODA chamada da unidade. Este worker roda fora do caminho quente,
 * depois que a conversa esfriou, e custa **zero token** — a decisão é aritmética, não
 * julgamento de modelo.
 *
 * AS TRÊS TRAVAS, e nenhuma é negociável:
 *   1. Nunca sobrescreve campo com valor. Nem da IA, nem da recepção.
 *   2. O valor da IA sempre ganha do calculado. Medido: nos casos em que a função de
 *      nome e a IA discordam sobre sexo, a IA acerta em 9 de 12 — porque quem segura o
 *      telefone é parente do paciente em 8 a 12% das conversas ("Adriana Trindade" é o
 *      marido Vagner). A função nunca corrige a IA; só preenche o buraco.
 *   3. Desligado por padrão. Só roda nas unidades listadas em `PREENCHE_CAMPOS_SLUGS`.
 */
import { automacaoLigada } from './automacoes-estado.js';
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoFieldType, type KommoLead } from '../services/kommo.service.js';
import {
  classificar,
  PREFIXOS_DE_PASSO,
  sinaisDosPassos,
  type PassoDaConversa,
  type SinaisDaConversa,
} from './qualificacao-por-sinal.js';
import { sexoPeloNome } from './sexo-pelo-nome.js';
import { agoraLocalISO } from '../agent/consulta-que-passou.js';
import { fusoDaUnidade } from './fuso.js';

const PASSO_MS = 15 * 60_000;
/** Espera a conversa esfriar: antes disso ela pode continuar e mudar de temperatura. */
const ESFRIOU_HORAS = 6;
/** E não olha o que é velho demais — senão toda rodada revarre o histórico inteiro. */
const JANELA_HORAS = 72;

let timer: NodeJS.Timeout | null = null;
let rodando = false;

export function unidadesLigadas(): string[] {
  return String(process.env.PREENCHE_CAMPOS_SLUGS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface Alvo {
  leadId: number;
  mensagensDoPaciente: number;
  ferramentas: string[];
  /** a franquia tem consulta ligada ao cartão agora (`spine_lead_links.spine_id_schedule`) */
  temConsultaMarcada: boolean;
}

interface LinhaDeConversa {
  lead_id: string;
  msgs: bigint | number | null;
}

interface PassoDoLead extends PassoDaConversa {
  leadId: string;
}

/**
 * Junta o que o banco devolveu em um alvo por lead. Puro — é aqui que `temConsultaMarcada` passa a existir:
 * o worker antigo nunca o informava, e por isso cartão em AGENDADO ficava Morno. Só o vínculo ATUAL vale: o passo
 * "Consulta marcada" é histórico (a consulta pode ter sido cancelada) e entra como ferramenta, não como consulta viva.
 */
export function montarAlvos(linhas: LinhaDeConversa[], passos: PassoDoLead[], leadsComConsulta: number[]): Alvo[] {
  const comVinculo = new Set(leadsComConsulta);
  const passosPorLead = new Map<string, PassoDoLead[]>();
  for (const p of passos) {
    const lista = passosPorLead.get(p.leadId);
    if (lista) lista.push(p);
    else passosPorLead.set(p.leadId, [p]);
  }
  return linhas.map((l) => {
    const leadId = Number(l.lead_id);
    const sinais = sinaisDosPassos(passosPorLead.get(String(l.lead_id)) ?? []);
    return {
      leadId,
      mensagensDoPaciente: Number(l.msgs ?? 0),
      ferramentas: sinais.ferramentas,
      temConsultaMarcada: comVinculo.has(leadId),
    };
  });
}

/** O que o classificador recebe de cada alvo. */
export function sinaisDoAlvo(a: Alvo): SinaisDaConversa {
  return {
    mensagensDoPaciente: a.mensagensDoPaciente,
    ferramentasChamadas: a.ferramentas,
    temConsultaMarcada: a.temConsultaMarcada,
  };
}

/**
 * O vínculo com a franquia diz "tem consulta POR VIR"? `spineIdSchedule` preenchido não basta: NÃO COMPARECEU mantém o
 * vínculo, e a consulta que já passou não é limpa por ninguém — o cartão ficaria Quente para sempre. Sem data gravada
 * (`agendadoPara` nulo) não dá para dizer que passou: vale como viva, igual à memória do lead (lead-memory.service.ts).
 * Compara "AAAA-MM-DDTHH:mm" com o relógio da clínica; ISO ordena como texto.
 */
export function consultaViva(agendadoPara: string | null | undefined, agoraNaClinica: string): boolean {
  if (!agendadoPara) return true;
  return agendadoPara.slice(0, 16) >= agoraNaClinica.slice(0, 16);
}

/**
 * Conversas que esfriaram na janela, com os sinais já contados.
 *
 * A contagem de mensagens sai de uma consulta SÓ de conversas e mensagens. Antes ela dividia o JOIN com os passos
 * de execução (`LEFT JOIN LATERAL` sem ligação com a mensagem), que repetia cada mensagem uma vez por passo
 * "Decisão" e inflava `msgs`: 1 mensagem + 3 passos virava 3 e o lead saía Morno em vez de Frio.
 *
 * Os passos valem só dentro da janela de 72 h: o lead que pediu horário há uma semana e voltou ontem com uma
 * mensagem não herda o Quente de uma conversa que já esfriou. O vínculo olha também as unidades que dividem o
 * mesmo Kommo (Petrópolis/Caxias, resgate/comercial) — é o mesmo cartão.
 */
export async function alvos(unit: Unit, agora: Date = new Date()): Promise<Alvo[]> {
  const linhas = await prisma.$queryRawUnsafe<LinhaDeConversa[]>(
    `SELECT c.lead_id,
            count(*) FILTER (WHERE m.role = 'user') AS msgs
     FROM conversations c
     JOIN messages m ON m.conversation_id = c.id
     WHERE c.unit_id = $1
     GROUP BY c.lead_id
     HAVING max(m.created_at) < now() - ($2 || ' hours')::interval
        AND max(m.created_at) > now() - ($3 || ' hours')::interval
     ORDER BY max(m.created_at) DESC
     LIMIT 300`,
    unit.id,
    String(ESFRIOU_HORAS),
    String(JANELA_HORAS),
  );
  if (!linhas.length) return [];

  const ids = linhas.map((l) => String(l.lead_id));
  // `kommo_lead_id` é Int32 no banco: um id maior derrubaria o findMany inteiro
  const idsNumericos = ids.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 2_147_483_647);
  const desde = new Date(agora.getTime() - JANELA_HORAS * 3_600_000);
  const irmas = unit.kommoSubdomain
    ? (await prisma.unit.findMany({ where: { kommoSubdomain: unit.kommoSubdomain }, select: { id: true } })).map((u) => u.id)
    : [];
  const unidadesDoCartao = [...new Set([unit.id, ...irmas])];
  const [passos, vinculos] = await Promise.all([
    prisma.executionStep.findMany({
      where: {
        createdAt: { gte: desde },
        trace: { unitId: unit.id, leadId: { in: ids } },
        kind: { in: ['TOOL_RESULT', 'ERROR'] },
        OR: PREFIXOS_DE_PASSO.map((p) => ({ title: { startsWith: p } })),
      },
      select: { kind: true, title: true, trace: { select: { leadId: true } } },
    }),
    prisma.spineLeadLink.findMany({
      where: { unitId: { in: unidadesDoCartao }, kommoLeadId: { in: idsNumericos }, spineIdSchedule: { not: null } },
      select: { kommoLeadId: true, agendadoPara: true },
    }),
  ]);
  const agoraNaClinica = agoraLocalISO(fusoDaUnidade(unit), agora);
  return montarAlvos(
    linhas,
    passos.map((p) => ({ leadId: p.trace.leadId, kind: p.kind, title: p.title })),
    vinculos.filter((v) => consultaViva(v.agendadoPara, agoraNaClinica)).map((v) => v.kommoLeadId),
  );
}

export interface ResultadoPreenchimento {
  unidade: string;
  simulado: boolean;
  olhados: number;
  qualificacao: number;
  sexo: number;
  jaTinha: number;
  falhas: number;
  /** cartões que sumiram do Kommo (apagados ou juntados a outro) — pulados, sem contar como falha */
  apagados: number;
  amostra: Array<{ leadId: number; campo: string; valor: string; porque: string }>;
  erro?: string;
}

/**
 * A regra vem de `lead_field_rules` de propósito — a MESMA tabela que dá as ferramentas
 * à IA. Assim o worker grava no campo em que ela gravaria, com as opções daquela conta.
 * Procurar o campo por nome no Kommo daria uma segunda interpretação que ninguém revisou.
 */
async function campoDaRegra(unitId: string, padrao: RegExp) {
  const regras = await prisma.leadFieldRule.findMany({ where: { unitId, enabled: true } });
  return regras.find((r) => padrao.test(r.kommoFieldName)) ?? null;
}

/**
 * Cartão apagado (ou juntado a outro) volta do GET como 204 sem corpo, e não como erro. Sem esta checagem ele parecia
 * um cartão com tudo vazio: o worker tentava preencher, o PATCH respondia 400 "Lead not found", e isso se repetia a cada
 * 15 min até a conversa sair da janela de 72 h — ~260 tentativas por cartão (medido em 19/10/2026: Serra 24703143).
 */
export function cartaoExiste(lead: KommoLead | '' | null | undefined): lead is KommoLead {
  return !!lead && typeof lead === 'object' && Number.isInteger(lead.id) && lead.id > 0;
}

/** O pedaço do cliente do Kommo que o worker usa — e que o teste substitui. */
export type ClienteDoKommo = Pick<ReturnType<typeof createKommoClient>, 'getLead' | 'setLeadCustomFieldValue'>;

export async function preencherDaUnidade(
  unit: Unit,
  opts: { simular?: boolean; limite?: number; kommo?: ClienteDoKommo } = {},
): Promise<ResultadoPreenchimento> {
  const simular = opts.simular !== false;
  const base: ResultadoPreenchimento = {
    unidade: unit.slug,
    simulado: simular,
    olhados: 0,
    qualificacao: 0,
    sexo: 0,
    jaTinha: 0,
    falhas: 0,
    apagados: 0,
    amostra: [],
  };
  if (!unit.kommoAccessToken) return { ...base, erro: 'unidade sem credencial do Kommo' };

  const regraQualif = await campoDaRegra(unit.id, /qualifica[çc][ãa]o \(/i);
  const regraSexo = await campoDaRegra(unit.id, /sexo/i);
  if (!regraQualif && !regraSexo) return { ...base, erro: 'unidade sem regra de Qualificação nem de Sexo' };

  const kommo = opts.kommo ?? createKommoClient(unit);
  const lista = (await alvos(unit)).slice(0, opts.limite ?? 300);

  for (const alvo of lista) {
    base.olhados++;
    try {
      const lead = await kommo.getLead(alvo.leadId);
      if (!cartaoExiste(lead)) {
        base.apagados++;
        continue;
      }
      const valorDe = (fieldId: number) => {
        const c = (lead.custom_fields_values ?? []).find((x) => x.field_id === fieldId);
        const v = c?.values?.[0]?.value;
        return v === undefined || v === null || String(v).trim() === '' ? null : String(v);
      };

      const escrever = async (
        regra: { kommoFieldId: number; kommoFieldName: string; kommoFieldType: string; kommoFieldEnums: unknown },
        valor: string,
        porque: string,
        conta: 'qualificacao' | 'sexo',
        /** o que vai pro log: sem dado pessoal (o `porque` do sexo cita o primeiro nome do paciente) */
        porqueNoLog: string = porque,
      ) => {
        if (valorDe(regra.kommoFieldId) !== null) {
          base.jaTinha++;
          return;
        }
        if (base.amostra.length < 12) {
          base.amostra.push({ leadId: alvo.leadId, campo: regra.kommoFieldName, valor, porque });
        }
        if (!simular) {
          const enums = Array.isArray(regra.kommoFieldEnums)
            ? (regra.kommoFieldEnums as Array<{ id: number; value: string }>)
            : [];
          await kommo.setLeadCustomFieldValue(
            alvo.leadId,
            regra.kommoFieldId,
            regra.kommoFieldType as KommoFieldType,
            valor,
            enums,
          );
        }
        base[conta]++;
        // Uma linha por escrita: a rodada só resume (contagens), e sem isto não dá para conferir DEPOIS por que um cartão
        // virou Quente. Só leadId — nada de nome, telefone ou texto do paciente.
        logger.info(
          { unit: unit.slug, leadId: alvo.leadId, campo: regra.kommoFieldName, valor, porque: porqueNoLog, simulado: simular },
          'preenche-campos: preencheu',
        );
      };

      if (regraQualif) {
        const c = classificar(sinaisDoAlvo(alvo));
        await escrever(regraQualif, c.temperatura, c.porque, 'qualificacao');
      }

      if (regraSexo) {
        const d = sexoPeloNome(lead.name);
        if (d) await escrever(regraSexo, d.sexo, `nome "${d.nome}" (${d.como})`, 'sexo', `deduzido pelo primeiro nome (${d.como})`);
      }
    } catch (err) {
      base.falhas++;
      logger.warn({ err: String(err), unit: unit.slug, leadId: alvo.leadId }, 'preenche-campos: lead falhou');
    }
  }
  return base;
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    // SEM filtrar por `isActive`: quem decide é a automação, e só ela. Ao migrar este worker para a
    // tela de automações eu pus um `isActive: true` aqui, achando que era melhoria — mas Divinópolis
    // está `isActive: false` no banco do agente e mesmo assim é sincronizada com a franquia todo dia
    // (medido em 29/09/2026). O filtro faria essa unidade ser pulada em silêncio no dia em que
    // alguém a ligasse nesta automação, e "está ligado na tela mas não roda" é o pior tipo de bug.
    const todas = await prisma.unit.findMany();
    const unidades = todas.filter((u) => automacaoLigada(u.slug, 'preenche-campos', process.env.PREENCHE_CAMPOS_SLUGS));
    if (!unidades.length) return;
    for (const u of unidades) {
      const r = await preencherDaUnidade(u, { simular: false });
      if (r.qualificacao || r.sexo || r.erro) {
        logger.info({ ...r, amostra: undefined }, 'preenche-campos: rodada');
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'preenche-campos: varredura falhou');
  } finally {
    rodando = false;
  }
}

export function startPreencheCamposWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), PASSO_MS);
  logger.info({ unidades: unidadesLigadas() }, 'preenche-campos: worker iniciado');
}

export function stopPreencheCamposWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
