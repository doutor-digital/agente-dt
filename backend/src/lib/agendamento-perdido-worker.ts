import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoLead } from '../services/kommo.service.js';
import { normalizarNome } from './kommo-schema.js';
import { CAMPOS_SYNC } from './franquia-sync.js';

/**
 * Avisa quando a IA chegou a oferecer horário e não fechou.
 *
 * É o alarme que não existia e por isso o prejuízo passou meses invisível: em
 * 30 dias, 211 conversas chegaram ao ponto de consultar a agenda e só 39
 * viraram consulta marcada — 82 foram entregues à secretária no momento exato
 * em que o paciente escolhia horário. Ninguém foi avisado nenhuma vez.
 *
 * Havia alarme pra SDR demorar 15 minutos pra responder. Não havia nenhum pra a
 * IA perder a venda com o paciente ainda na conversa.
 *
 * O QUE CONTA COMO PERDIDO
 * ------------------------
 * A IA consultou horário (ou seja, o paciente queria marcar) e, passada a
 * janela de carência, não existe `agendar_consulta` bem-sucedida naquele lead.
 * A carência existe porque conversa boa demora: o paciente some, volta, pergunta
 * o preço de novo. Avisar cedo demais transforma atendimento normal em alarme.
 *
 * O QUE NÃO CONTA
 * ---------------
 * Lead que a IA transferiu por motivo legítimo (fora de perfil, red flag,
 * paciente pediu humano) não é venda perdida — é o sistema funcionando. Como o
 * handoff tem motivo registrado, dá pra separar: só entra na conta quem foi
 * embora sem desfecho.
 *
 * O alerta vai como tarefa no Kommo, igual ao de SLA: é onde a equipe já olha,
 * e o n8n leva pro grupo do GAC. Um por lead, nunca repetido — alarme que repete
 * vira ruído, e ruído faz ninguém olhar mais.
 */

const SWEEP_MS = Number(process.env.AGENDAMENTO_PERDIDO_SWEEP_MS) || 15 * 60_000;

/** Quanto tempo depois de oferecer horário a gente considera perdido. */
const CARENCIA_MIN = Number(process.env.AGENDAMENTO_PERDIDO_CARENCIA_MIN) || 90;

/** Não olha conversa velha demais: o que passou disso é história, não ação. */
const JANELA_HORAS = Number(process.env.AGENDAMENTO_PERDIDO_JANELA_H) || 24;

const MARCA = 'ALERTA · agendamento perdido';

/**
 * Folga contra fuso: o `created_at` do rastro pode chegar 3 h adiantado ou
 * atrasado conforme o TZ do processo. Mais que isso esconde consulta antiga
 * (faltou às 8h, nova oferta às 15h) e cala o alerta verdadeiro.
 */
const FOLGA_FUSO_MS = 4 * 60 * 60_000;

/** Data de campo do Kommo: epoch em segundos — aceita ms e ISO por segurança. */
function epochSegundos(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isFinite(n) && n > 0) return n > 1e11 ? Math.floor(n / 1000) : n;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/**
 * O cartão já diz que existe consulta marcada depois da oferta?
 *
 * Cobre quem não foi a IA a marcar — recepção, SDR, franquia. Sem isto o vigia
 * só enxergava o rastro da própria IA e avisava "não foi marcada" de consulta
 * marcada (06/10/2026, Açailândia, lead 28088906, consulta #3738045).
 *
 * Data de consulta ANTERIOR à oferta é de outro ciclo (o paciente voltou) e não
 * conta: aí o alerta é verdadeiro.
 */
export function cartaoTemConsulta(
  lead: Pick<KommoLead, 'custom_fields_values'> | null | undefined,
  ofereceuEm: Date,
  /** O vigia "prometeu e não marcou" compara instantes certos (sem SQL cru) e usa uma folga menor. */
  folgaMs: number = FOLGA_FUSO_MS,
): boolean {
  const alvo = normalizarNome(CAMPOS_SYNC.DATA_CONSULTA);
  const campo = lead?.custom_fields_values?.find((c) => normalizarNome(c.field_name ?? '') === alvo);
  const segundos = epochSegundos(campo?.values?.[0]?.value);
  const oferta = ofereceuEm.getTime();
  if (segundos === null || !Number.isFinite(oferta)) return false;
  return segundos * 1000 >= oferta - folgaMs;
}

let timer: NodeJS.Timeout | null = null;
let rodando = false;

/** Leads cujo cartão já mostrou consulta → até quando não precisa reler (ms). */
const comConsulta = new Map<string, number>();

interface Candidato {
  unitId: string;
  slug: string;
  leadId: string;
  ofereceuEm: Date;
}

/**
 * Leads que chegaram a consultar horário e não têm agendamento, dentro da
 * janela. Feito em SQL porque a leitura é sobre milhares de passos de execução
 * e trazer isso pra memória seria caro à toa.
 */
async function candidatos(): Promise<Candidato[]> {
  const linhas = await prisma.$queryRawUnsafe<Candidato[]>(
    `
    select distinct on (t.lead_id)
           t.unit_id  as "unitId",
           u.slug     as "slug",
           t.lead_id  as "leadId",
           max(s.created_at) as "ofereceuEm"
      from execution_steps s
      join execution_traces t on t.id = s.trace_id
      join units u            on u.id = t.unit_id
     where s.created_at > now() - ($1 || ' hours')::interval
       and s.title ilike '%consultar_horarios%'
       -- "consultar_horarios bloqueado — IA pausada pela recepção" não é oferta: quem conversa é humano.
       and s.title not ilike '%bloqueado%'
       and not exists (
             select 1
               from execution_steps s2
               join execution_traces t2 on t2.id = s2.trace_id
              where t2.lead_id = t.lead_id
                -- O sucesso é gravado como "Consulta marcada: …", sem o nome da tool:
                -- sem esta linha, marcar de primeira virava alerta de perdido.
                and (s2.title ilike '%agendar_consulta%' or s2.title like 'Consulta marcada:%')
                and s2.created_at > now() - ($1 || ' hours')::interval
           )
     group by t.unit_id, u.slug, t.lead_id
    having max(s.created_at) < now() - ($2 || ' minutes')::interval
     limit 200
    `,
    String(JANELA_HORAS),
    String(CARENCIA_MIN),
  );
  // O driver devolve timestamp; normaliza aqui pra quem consome não ter de adivinhar.
  return linhas.map((l) => ({ ...l, ofereceuEm: new Date(l.ofereceuEm) }));
}

/** Já avisamos deste lead? Um alerta por lead, sempre. */
async function jaAvisado(unitId: string, leadId: string): Promise<boolean> {
  const n = await prisma.executionStep.count({
    where: {
      title: { startsWith: MARCA },
      trace: { unitId, leadId },
    },
  });
  return n > 0;
}

async function varrer(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const agora = Date.now();
    for (const [chave, ate] of comConsulta) if (ate <= agora) comConsulta.delete(chave);

    const lista = await candidatos();
    if (lista.length === 0) return;

    const porUnidade = new Map<string, Candidato[]>();
    for (const c of lista) {
      porUnidade.set(c.unitId, [...(porUnidade.get(c.unitId) ?? []), c]);
    }

    for (const [unitId, itens] of porUnidade) {
      const unit = await prisma.unit.findUnique({ where: { id: unitId } });
      if (!unit || !unit.isActive) continue;

      let kommo;
      try {
        kommo = createKommoClient(unit);
      } catch {
        continue;
      }

      // Um lote por unidade (50 cartões por chamada) em vez de um GET por candidato.
      const aChecar: Array<{ c: Candidato; leadId: number; chave: string }> = [];
      for (const c of itens) {
        const leadId = Number(c.leadId);
        if (!Number.isFinite(leadId) || leadId <= 0) continue;
        // A chave leva a hora da oferta: oferta nova no mesmo lead é relida.
        const chave = `${unitId}:${c.leadId}:${c.ofereceuEm.getTime()}`;
        if (comConsulta.has(chave)) continue;
        if (await jaAvisado(unitId, c.leadId)) continue;
        aChecar.push({ c, leadId, chave });
      }
      if (aChecar.length === 0) continue;

      let cartoes: KommoLead[];
      try {
        cartoes = await kommo.listLeadsPorIds(aChecar.map((x) => x.leadId));
      } catch (err) {
        // Sem ler o cartão não dá pra saber se a recepção marcou; tenta na próxima varredura.
        logger.warn({ err: String(err), unit: unit.slug, n: aChecar.length }, 'agendamento perdido: não li os cartões, fica pra próxima');
        continue;
      }
      const porId = new Map(cartoes.map((l) => [l.id, l]));

      for (const { c, leadId, chave } of aChecar) {
        const lead = porId.get(leadId);
        if (!lead) continue; // cartão apagado ou de outra conta: não há a quem avisar
        if (cartaoTemConsulta(lead, c.ofereceuEm)) {
          // Some da janela em JANELA_HORAS; até lá não relê o cartão a cada varredura.
          comConsulta.set(chave, Date.now() + JANELA_HORAS * 60 * 60_000);
          continue;
        }

        const texto =
          `${MARCA} · ${unit.slug} · lead ${leadId} — a IA ofereceu horário e ` +
          `a consulta não foi marcada. O paciente queria agendar: vale retomar antes que esfrie.`;

        try {
          // 21/09/2026: nota no cartão em vez de tarefa (decisão do João: tarefa só pra ação com prazo).
          await kommo.addLeadNote(leadId, texto);
          // Registrar no rastro é o que impede repetir o alerta amanhã.
          const idRastro = `perdido-${unitId}-${c.leadId}`;
          await prisma.executionStep
            .create({
              data: {
                trace: {
                  connectOrCreate: {
                    where: { id: idRastro },
                    create: {
                      id: idRastro,
                      unitId,
                      leadId: c.leadId,
                      threadId: idRastro,
                      input: { origem: 'vigia-agendamento-perdido' },
                      channel: 'manual',
                    },
                  },
                },
                sequence: 0,
                kind: 'ERROR',
                title: `${MARCA} — lead ${leadId}`,
                payload: { leadId, ofereceuEm: c.ofereceuEm.toISOString() },
              },
            })
            .catch(() => undefined);

          logger.warn(
            { unit: unit.slug, leadId },
            'agendamento perdido: IA ofereceu horário e não fechou',
          );
        } catch (err) {
          logger.warn({ err: String(err), unit: unit.slug, leadId }, 'falha ao avisar agendamento perdido');
        }
      }
    }
  } catch (err) {
    logger.warn({ err: String(err) }, 'varredura de agendamento perdido falhou');
  } finally {
    rodando = false;
  }
}

export function startAgendamentoPerdidoWorker(): void {
  if (timer) return;
  timer = setInterval(() => void varrer(), SWEEP_MS);
  timer.unref?.();
  logger.info(
    { sweepMs: SWEEP_MS, carenciaMin: CARENCIA_MIN },
    'vigia de agendamento perdido ligado',
  );
}

export function stopAgendamentoPerdidoWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Exposto para teste e para uma varredura manual pelo painel. */
export const _internos = { candidatos, varrer, MARCA, CARENCIA_MIN, JANELA_HORAS };
