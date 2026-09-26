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
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoFieldType } from '../services/kommo.service.js';
import { classificar, type SinaisDaConversa } from './qualificacao-por-sinal.js';
import { sexoPeloNome } from './sexo-pelo-nome.js';

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

interface Alvo {
  leadId: number;
  mensagensDoPaciente: number;
  ferramentas: string[];
}

/** Conversas que esfriaram na janela, com os sinais já contados pelo banco. */
async function alvos(unit: Unit): Promise<Alvo[]> {
  const linhas = await prisma.$queryRawUnsafe<
    Array<{ lead_id: string; msgs: bigint; ferramentas: string[] | null }>
  >(
    `SELECT c.lead_id,
            count(*) FILTER (WHERE m.role = 'user')            AS msgs,
            array_remove(array_agg(DISTINCT s.ferramenta), NULL) AS ferramentas
     FROM conversations c
     JOIN messages m ON m.conversation_id = c.id
     LEFT JOIN LATERAL (
       SELECT substring(es.title from 'Decisão: ([a-z_]+)\\(') AS ferramenta
       FROM execution_steps es
       JOIN execution_traces et ON et.id = es.trace_id
       WHERE et.unit_id = c.unit_id AND et.lead_id = c.lead_id AND es.kind = 'TOOL_CALL'
     ) s ON true
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
  return linhas.map((l) => ({
    leadId: Number(l.lead_id),
    mensagensDoPaciente: Number(l.msgs ?? 0),
    ferramentas: l.ferramentas ?? [],
  }));
}

export interface ResultadoPreenchimento {
  unidade: string;
  simulado: boolean;
  olhados: number;
  qualificacao: number;
  sexo: number;
  jaTinha: number;
  falhas: number;
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

export async function preencherDaUnidade(
  unit: Unit,
  opts: { simular?: boolean; limite?: number } = {},
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
    amostra: [],
  };
  if (!unit.kommoAccessToken) return { ...base, erro: 'unidade sem credencial do Kommo' };

  const regraQualif = await campoDaRegra(unit.id, /qualifica[çc][ãa]o \(/i);
  const regraSexo = await campoDaRegra(unit.id, /sexo/i);
  if (!regraQualif && !regraSexo) return { ...base, erro: 'unidade sem regra de Qualificação nem de Sexo' };

  const kommo = createKommoClient(unit);
  const lista = (await alvos(unit)).slice(0, opts.limite ?? 300);

  for (const alvo of lista) {
    base.olhados++;
    try {
      const lead = await kommo.getLead(alvo.leadId);
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
      };

      if (regraQualif) {
        const sinais: SinaisDaConversa = {
          mensagensDoPaciente: alvo.mensagensDoPaciente,
          ferramentasChamadas: alvo.ferramentas,
        };
        const c = classificar(sinais);
        await escrever(regraQualif, c.temperatura, c.porque, 'qualificacao');
      }

      if (regraSexo) {
        const d = sexoPeloNome(lead.name);
        if (d) await escrever(regraSexo, d.sexo, `nome "${d.nome}" (${d.como})`, 'sexo');
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
  const slugs = unidadesLigadas();
  if (!slugs.length) return;
  rodando = true;
  try {
    const unidades = await prisma.unit.findMany({ where: { slug: { in: slugs } } });
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
