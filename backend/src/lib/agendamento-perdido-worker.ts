import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { createKommoClient, type KommoLead } from '../services/kommo.service.js';
import { normalizarNome } from './kommo-schema.js';
import { CAMPOS_SYNC } from './franquia-sync.js';
import { fusoDaUnidade } from './fuso.js';
import { enviarTelegramSofia } from './telegram.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { registrarSimulacao } from './so-no-papel.js';
import { avisoClinicaAtivo, avisarClinicaNaoFechou, avisoSemTrecho, reenviarMarcouPendentes, silencioDepoisDe } from './aviso-clinica-agendamento.js';
import { AGORA_UTC } from './sql-tempo.js';

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
 * 28/11/2026 (dois alarmes falsos no Telegram do João, medidos em 7 dias: 180 avisos):
 *  - só OFERTA de verdade conta: `consultar_horarios` com a resposta da IA trazendo um horário (`respostaOfereceHorario`). Consultar a
 *    agenda e perguntar da dor (Porto, lead 30288526) não é oferecer;
 *  - handoff certo não é venda perdida: depois da oferta a IA transferiu por SINAL DE ALERTA (Canaã, lead 31395380, fraqueza na perna)
 *    ou a equipe assumiu (IA pausada por humano / pausa-equipe). Sem chave: é erro do aviso, não preferência de unidade.
 *
 * Até 20/10/2026 isso estava só neste comentário: o SQL não separava nada. Com a
 * chave "agendamento-perdido-filtro" (`motivoParaNaoAvisar`) o vigia deixa de
 * avisar quem adiou com retomada marcada, quem nunca respondeu à oferta, e não
 * avisa de madrugada.
 *
 * O alerta vai como tarefa no Kommo, igual ao de SLA: é onde a equipe já olha,
 * e o n8n leva pro grupo do GAC. Um por lead, nunca repetido — alarme que repete
 * vira ruído, e ruído faz ninguém olhar mais.
 *
 * E vai também pro Telegram do João (19/10/2026): desde 21/09 o aviso é só uma NOTA no cartão, e nota
 * ninguém vê chegar — o Anderson de Olímpia (lead 5646431) escolheu "terça às 11:30", a IA não marcou, o
 * vigia avisou às 13:27 e ninguém soube. Sem `TELEGRAM_BOT_TOKEN` no servidor, só a nota (como antes).
 */

const SWEEP_MS = Number(process.env.AGENDAMENTO_PERDIDO_SWEEP_MS) || 15 * 60_000;

/** Quanto tempo depois de oferecer horário a gente considera perdido. */
const CARENCIA_MIN = Number(process.env.AGENDAMENTO_PERDIDO_CARENCIA_MIN) || 90;

/** Não olha conversa velha demais: o que passou disso é história, não ação. */
const JANELA_PEDIDA_H = Number(process.env.AGENDAMENTO_PERDIDO_JANELA_H) || 24;

/**
 * A janela nunca é menor que a carência mais a madrugada inteira (21h–8h) e uma folga: com o filtro
 * ligado, a oferta das 20h só pode ser avisada às 8h do dia seguinte — se já tivesse saído da janela,
 * o aviso sumiria em vez de esperar a manhã. Com o padrão de 24 h nada muda.
 */
export function janelaEfetivaH(pedidaH: number, carenciaMin: number): number {
  return Math.max(pedidaH, Math.ceil(carenciaMin / 60 + 11 + 1));
}

const JANELA_HORAS = janelaEfetivaH(JANELA_PEDIDA_H, CARENCIA_MIN);

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

/**
 * A resposta da IA TRAZ um horário? ("às 08:30", "9h", "10 horas"). É o que separa OFERECER horário de só CONSULTAR a agenda.
 *
 * 28/11/2026, Porto, lead 30288526: o paciente disse "Quero agendar uma consulta!", a IA chamou `consultar_horarios` (o passo gravado) e
 * respondeu "onde é a dor e há quanto tempo?" — não ofereceu nada. O aviso do Telegram disse "a IA ofereceu horário (01:35)". Em 7 dias,
 * 180 avisos; só o texto da resposta diz se houve oferta.
 *
 * A MESMA fonte vai para o SQL (`~*` com este texto) e para o teste (`RegExp`, flag `i`): só usa o que o POSIX ARE do Postgres e o JS
 * entendem igual — sem `\b` (no Postgres é backspace) nem `\m`/`\M` (só no Postgres).
 */
export const HORARIO_NA_RESPOSTA_FONTE = '(^|[^0-9:])(([01]?[0-9]|2[0-3]):[0-5][0-9]|([01]?[0-9]|2[0-3]) ?h([^a-zà-ú]|$)|[0-9]{1,2} horas)';

export function respostaOfereceHorario(texto: string | null | undefined): boolean {
  return !!texto && new RegExp(HORARIO_NA_RESPOSTA_FONTE, 'i').test(texto);
}

/** A mensagem do Telegram: quem, de qual unidade, quando a IA ofereceu, e o link pra abrir o cartão. */
export function textoTelegramPerdido(args: {
  unidade: string;
  subdominio: string | null | undefined;
  leadId: number;
  nomeDoCartao: string | null | undefined;
  ofereceuEm: Date;
  fuso: string;
}): string {
  const hora = new Intl.DateTimeFormat('pt-BR', { timeZone: args.fuso, hour: '2-digit', minute: '2-digit' }).format(args.ofereceuEm);
  const quem = (args.nomeDoCartao ?? '').trim() || `lead ${args.leadId}`;
  const link = args.subdominio ? `https://${args.subdominio}.kommo.com/leads/detail/${args.leadId}` : `lead ${args.leadId}`;
  return [
    `⚠️ Agendamento perdido · ${args.unidade}`,
    `${quem} — a IA ofereceu horário (${hora}) e a consulta não foi marcada. Vale retomar antes que esfrie.`,
    link,
  ].join('\n');
}

/**
 * Chave "Alerta de agendamento perdido sem alarme falso" (nasce desligada; tem "só no papel").
 *
 * Dos 20 alertas que chegaram ao Telegram do João em 19–20/10/2026, 14 não eram venda que a IA perdeu:
 *  - 10 o paciente ADIOU e a IA já tinha gravado ⊘ Motivo da espera com ◷ Retomar em ("deixa para
 *    próximo", "só volto em dezembro", "vou pelo plano de saúde", "quando eu receber") — a retomada
 *    automática já cuida, e "vale retomar antes que esfrie" contradiz o que o paciente pediu;
 *  -  4 o paciente NUNCA respondeu depois da oferta — é a régua de follow-up que cuida de quem sumiu;
 *  - e 6 chegaram de madrugada (00:00, 00:30, 02:15, 03:00 e dois às 07:30), quando ninguém pode agir.
 * Quem respondeu à oferta e ficou sem consulta continua avisando — inclusive o "vou ver com meu marido".
 */
const ID_FILTRO = 'agendamento-perdido-filtro';

export function estadoDoFiltro(slug: string, raw: string | undefined = process.env.AGENDAMENTO_PERDIDO_FILTRO_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID_FILTRO, raw);
}

/** Silêncio da madrugada, na hora da unidade: o mesmo das mensagens automáticas (21:00–08:00). */
const SILENCIO_INICIO_MIN = 21 * 60;
const SILENCIO_FIM_MIN = 8 * 60;

/** Minutos desde a meia-noite no fuso da unidade. */
export function minutosNoFuso(fuso: string, agora: Date = new Date()): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: fuso || 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(agora);
  const h = Number(p.find((x) => x.type === 'hour')?.value) % 24;
  const m = Number(p.find((x) => x.type === 'minute')?.value);
  return h * 60 + m;
}

/**
 * Por que este alerta NÃO deve sair agora — ou `null` se deve.
 * A ordem importa só para o que a tela de "só no papel" mostra: o motivo que dura vem antes da madrugada,
 * que passa sozinha (o vigia volta a olhar às 08:00 e só avisa se ainda valer).
 */
export function motivoParaNaoAvisar(
  c: { pacienteRespondeu: boolean; adiou: boolean },
  minutosLocais: number,
): string | null {
  if (c.adiou) return 'o paciente adiou: a IA gravou ⊘ Motivo da espera depois da oferta (a retomada cuida)';
  if (!c.pacienteRespondeu) return 'o paciente não respondeu depois da oferta (a régua de follow-up cuida)';
  if (minutosLocais >= SILENCIO_INICIO_MIN || minutosLocais < SILENCIO_FIM_MIN) {
    return 'madrugada (21h–8h na hora da unidade): espera a manhã e confere de novo';
  }
  return null;
}

/**
 * Para quem cada candidato vira aviso nesta varredura.
 *  - `paraVigia`: o alerta de sempre (nota no cartão + Telegram do João), uma vez por lead, com o filtro da chave
 *    «agendamento-perdido-filtro» exatamente como era: ligado pula quem tem motivo (sem marcar como avisado), seco só anota
 *    o «pularia», desligado avisa tudo.
 *  - `paraClinica`: o aviso à recepção (chave «aviso-clinica-agendamento»). Segue o seu próprio caminho: o «já avisado» do
 *    vigia não o cala (o vigia avisa 1 vez por lead para sempre; a recepção, 1 por lead a cada 24 h), e a MESMA decisão do
 *    filtro (adiou / não respondeu / madrugada) vale SEMPRE, até na unidade em que o filtro do vigia está desligado.
 *  - `pularia`: o motivo a anotar na tela «só no papel» (filtro em seco).
 */
export function quemAvisar(a: {
  jaAvisado: boolean;
  filtro: Estado;
  /** a chave do aviso à recepção está ligada ou em seco nesta unidade E esta oferta ainda não foi avisada */
  avisaClinica: boolean;
  c: { pacienteRespondeu: boolean; adiou: boolean };
  minutosLocais: number;
}): { paraVigia: boolean; paraClinica: boolean; pularia: string | null } {
  const motivo = motivoParaNaoAvisar(a.c, a.minutosLocais);
  let paraVigia = !a.jaAvisado;
  let pularia: string | null = null;
  if (paraVigia && a.filtro !== 'desligado' && motivo) {
    if (a.filtro === 'ligado') paraVigia = false; // não marca como avisado: se o paciente voltar a falar, vale de novo
    else pularia = motivo;
  }
  return { paraVigia, paraClinica: a.avisaClinica && motivo === null, pularia };
}

let timer: NodeJS.Timeout | null = null;
let rodando = false;

/** Leads cujo cartão já mostrou consulta → até quando não precisa reler (ms). */
const comConsulta = new Map<string, number>();

/** Ofertas cujo aviso à recepção já saiu (ou já tinha saído) → até quando não precisa reler o cartão (ms). */
const comAvisoDaClinica = new Map<string, number>();

interface Candidato {
  unitId: string;
  slug: string;
  leadId: string;
  ofereceuEm: Date;
  /** O paciente escreveu (em qualquer unidade da mesma conta Kommo) depois da oferta. */
  pacienteRespondeu: boolean;
  /** A IA gravou ⊘ Motivo da espera depois da oferta: o paciente adiou e a retomada já está marcada. */
  adiou: boolean;
}

/**
 * Leads que chegaram a consultar horário e não têm agendamento, dentro da
 * janela. Feito em SQL porque a leitura é sobre milhares de passos de execução
 * e trazer isso pra memória seria caro à toa.
 */
async function candidatos(): Promise<Candidato[]> {
  const linhas = await prisma.$queryRawUnsafe<Candidato[]>(
    `
    with ofertas as (
      select distinct on (t.lead_id)
             t.unit_id  as "unitId",
             u.slug     as "slug",
             u.kommo_subdomain as "sub",
             t.lead_id  as "leadId",
             max(s.created_at) as "ofereceuEm"
        from execution_steps s
        join execution_traces t on t.id = s.trace_id
        join units u            on u.id = t.unit_id
       where s.created_at > ${AGORA_UTC} - ($1 || ' hours')::interval
         and s.title ilike '%consultar_horarios%'
         -- "consultar_horarios bloqueado — IA pausada pela recepção" não é oferta: quem conversa é humano.
         and s.title not ilike '%bloqueado%'
         -- Oferta de VERDADE: consultar a agenda não é oferecer. Só conta se a resposta da IA, no mesmo turno e depois da consulta,
         -- traz um horário ("às 08:30", "9h"). Porto 28/11: consultou, perguntou da dor e o aviso disse "ofereceu horário".
         and exists (
               select 1
                 from execution_steps r
                where r.trace_id = s.trace_id
                  and r.kind = 'THINKING'
                  and r.title like 'IA respondeu%'
                  and r.sequence > s.sequence
                  and (r.payload->>'text') ~* $3
             )
         and not exists (
               select 1
                 from execution_steps s2
                 join execution_traces t2 on t2.id = s2.trace_id
                where t2.lead_id = t.lead_id
                  -- O sucesso é gravado como "Consulta marcada: …", sem o nome da tool:
                  -- sem esta linha, marcar de primeira virava alerta de perdido.
                  and (s2.title ilike '%agendar_consulta%' or s2.title like 'Consulta marcada:%')
                  and s2.created_at > ${AGORA_UTC} - ($1 || ' hours')::interval
             )
       group by t.unit_id, u.slug, u.kommo_subdomain, t.lead_id
      having max(s.created_at) < ${AGORA_UTC} - ($2 || ' minutes')::interval
       limit 200
    )
    select o."unitId", o."slug", o."leadId", o."ofereceuEm",
           -- Mesma conta Kommo: o resgate e a comercial dividem o cartão (a oferta numa, a resposta na outra).
           -- Comparado no próprio SQL, coluna com coluna: o horário do rastro não passa pelo fuso do processo.
           exists (
             select 1
               from messages m
               join conversations c on c.id = m.conversation_id
               join units cu        on cu.id = c.unit_id
              where c.lead_id = o."leadId"
                and (cu.kommo_subdomain = o."sub" or cu.id = o."unitId")
                and m.role = 'user'
                and m.created_at > o."ofereceuEm"
           ) as "pacienteRespondeu",
           exists (
             select 1
               from execution_steps s3
               join execution_traces t3 on t3.id = s3.trace_id
               join units u3            on u3.id = t3.unit_id
              where t3.lead_id = o."leadId"
                and (u3.kommo_subdomain = o."sub" or u3.id = o."unitId")
                and s3.title ilike '%motivo da espera" gravado no lead%'
                and s3.created_at > o."ofereceuEm"
           ) as "adiou"
      from ofertas o
     -- O handoff certo não é venda perdida (Canaã 28/11, lead 31395380: fraqueza na perna → a IA passou para a equipe com o aviso urgente,
     -- e o vigia avisou "agendamento perdido"). Depois da oferta: transferiu por SINAL DE ALERTA, ou a equipe/um atendente assumiu
     -- (IA pausada por humano, resposta descartada pela pausa-equipe). Vale com ou sem a chave do filtro: é erro do aviso, não preferência.
     where not exists (
             select 1
               from execution_steps s4
               join execution_traces t4 on t4.id = s4.trace_id
               join units u4            on u4.id = t4.unit_id
              where t4.lead_id = o."leadId"
                and (u4.kommo_subdomain = o."sub" or u4.id = o."unitId")
                and s4.created_at > o."ofereceuEm"
                and (   (s4.title like 'Decisão: pausar IA%' and s4.title like '%SINAL DE ALERTA')
                     or s4.title like 'Sinal de alerta avisado%'
                     or s4.title like 'IA pausada por humano%'
                     or s4.title like '⏸ Resposta descartada antes de enviar%')
           )
    `,
    String(JANELA_HORAS),
    String(CARENCIA_MIN),
    HORARIO_NA_RESPOSTA_FONTE,
  );
  // O driver devolve timestamp; normaliza aqui pra quem consome não ter de adivinhar.
  return linhas.map((l) => ({ ...l, ofereceuEm: new Date(l.ofereceuEm), pacienteRespondeu: Boolean(l.pacienteRespondeu), adiou: Boolean(l.adiou) }));
}

/**
 * A última fala do paciente neste cartão (em qualquer unidade da mesma conta Kommo, como `pacienteRespondeu`). Só o aviso à
 * recepção usa. Sem ela o aviso sai sem o trecho; nunca lança.
 */
async function ultimaFalaDoPaciente(unitId: string, sub: string | null | undefined, leadId: string): Promise<string | null> {
  try {
    const linhas = await prisma.$queryRawUnsafe<Array<{ content: string | null }>>(
      `select m.content as content
         from messages m
         join conversations c on c.id = m.conversation_id
         join units cu        on cu.id = c.unit_id
        where c.lead_id = $1
          and (cu.id = $2 or ($3::text is not null and cu.kommo_subdomain = $3))
          and m.role = 'user'
        order by m.created_at desc
        limit 1`,
      leadId,
      unitId,
      sub ?? null,
    );
    return linhas[0]?.content ?? null;
  } catch (err) {
    logger.warn({ err: String(err), unitId, leadId }, 'agendamento perdido: não li a última fala do paciente (o aviso à recepção sai sem ela)');
    return null;
  }
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
    for (const [chave, ate] of comAvisoDaClinica) if (ate <= agora) comAvisoDaClinica.delete(chave);

    // «A Sofia marcou» que ficou guardado da madrugada ou que a Evolution recusou (chave aviso-clinica-agendamento). Nunca lança.
    await reenviarMarcouPendentes();

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

      const filtro = estadoDoFiltro(unit.slug);
      const minutosLocais = minutosNoFuso(fusoDaUnidade(unit));
      // Aviso à recepção no WhatsApp (chave aviso-clinica-agendamento): segue o seu próprio caminho — o «já avisado» do vigia
      // (nota + Telegram, uma vez por lead) não o cala, e o estado do filtro acima não o liga nem o desliga.
      const avisaClinica = avisoClinicaAtivo(unit.slug);

      // Um lote por unidade (50 cartões por chamada) em vez de um GET por candidato.
      const aChecar: Array<{ c: Candidato; leadId: number; chave: string; paraVigia: boolean; paraClinica: boolean }> = [];
      for (const c of itens) {
        const leadId = Number(c.leadId);
        if (!Number.isFinite(leadId) || leadId <= 0) continue;
        // A chave leva a hora da oferta: oferta nova no mesmo lead é relida.
        const chave = `${unitId}:${c.leadId}:${c.ofereceuEm.getTime()}`;
        if (comConsulta.has(chave)) continue;
        const d = quemAvisar({
          jaAvisado: await jaAvisado(unitId, c.leadId),
          filtro,
          avisaClinica: avisaClinica && !comAvisoDaClinica.has(chave),
          c,
          minutosLocais,
        });
        if (d.pularia) registrarSimulacao(unit, ID_FILTRO, { leadId, acao: 'pularia', alvo: 'alerta de agendamento perdido', motivo: d.pularia });
        const { paraVigia, paraClinica } = d;
        if (!paraVigia && !paraClinica) continue;
        aChecar.push({ c, leadId, chave, paraVigia, paraClinica });
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

      for (const { c, leadId, chave, paraVigia, paraClinica } of aChecar) {
        const lead = porId.get(leadId);
        if (!lead) continue; // cartão apagado ou de outra conta: não há a quem avisar
        if (cartaoTemConsulta(lead, c.ofereceuEm)) {
          // Some da janela em JANELA_HORAS; até lá não relê o cartão a cada varredura.
          comConsulta.set(chave, Date.now() + JANELA_HORAS * 60 * 60_000);
          continue;
        }

        if (paraClinica) {
          // Sem esperar: WhatsApp lento não segura a varredura. Nunca lança (falha vira log).
          void (async () => {
            const ultimaFala = avisoSemTrecho() ? null : await ultimaFalaDoPaciente(unitId, unit.kommoSubdomain, c.leadId);
            const desfecho = await avisarClinicaNaoFechou({ unit, leadId, nome: lead.name, ultimaFala, ofereceuEm: c.ofereceuEm });
            // Saiu (ou já tinha saído): esta oferta não volta a ser lida. Seco, recusado, sem destino: espera 1 h para tentar de novo.
            const silencio = silencioDepoisDe(desfecho, JANELA_HORAS * 60 * 60_000);
            if (silencio !== null) comAvisoDaClinica.set(chave, Date.now() + silencio);
          })().catch(() => undefined);
        }
        if (!paraVigia) continue;

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
                      // O rastro é só a marca de "já avisei", não um turno da IA. Sem status explícito o
                      // banco grava RUNNING (o padrão) e ele nunca fecha: em 17/11/2026 eram 69 dos 71
                      // "turnos presos há mais de 15 min" da rede em 72 h, e o painel lia isso como
                      // paciente sem resposta. As outras marcas (etiqueta, rotina, cutucada) já nascem SUCCESS.
                      status: 'SUCCESS',
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

          // Sem esperar: Telegram lento não pode segurar a varredura (até 10 s por alerta). Nunca lança;
          // sem token, só registra no log.
          void enviarTelegramSofia(
            textoTelegramPerdido({
              unidade: unit.name,
              subdominio: unit.kommoSubdomain,
              leadId,
              nomeDoCartao: lead.name,
              ofereceuEm: c.ofereceuEm,
              fuso: fusoDaUnidade(unit),
            }),
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
