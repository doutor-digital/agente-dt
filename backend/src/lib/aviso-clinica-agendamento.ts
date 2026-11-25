/**
 * Aviso à RECEPÇÃO da clínica, no WhatsApp, quando a Sofia mexe com agendamento (pedido de Salto, 25/11/2026).
 *
 * O áudio da clínica: "ela tá conversando, tem o horário das 12h30, ela entrega o 12h30 e a gente fica sem saber se esse
 * paciente tá vindo ou não. Se ela não conseguir agendar no CRM, pelo menos mande um alarme pra gente."
 *
 * Dois avisos, num grupo de WhatsApp por unidade (texto simples, para ler no celular):
 *  1. «A Sofia marcou»: no instante em que a consulta é gravada na franquia (agendar_consulta; remarcar_consulta passa
 *     pelo mesmo caminho e diz «remarcou»).
 *  2. «A Sofia ofereceu e não fechou»: o MESMO vigia do «agendamento perdido» (agendamento-perdido-worker.ts), com a
 *     MESMA decisão (`motivoParaNaoAvisar`, chave agendamento-perdido-filtro): quem adiou, quem nunca respondeu e a
 *     madrugada não geram aviso. Não há critério novo aqui.
 *
 * POR QUE UMA CHAVE NOVA, E NÃO ESTENDER `aviso-agendamento`: aquela fala com o João (texto com nome inteiro, forma de
 * pagamento, nome da unidade), não tem modo seco e está LIGADA em 5 unidades — dar-lhe um destino por unidade mudaria o
 * que essas 5 fazem e misturaria dois públicos (o dono, que acompanha unidade nova, e a recepção, que precisa agir no
 * horário). Esta tem texto próprio, seco, destino por unidade e cobre os dois avisos.
 *
 * Chave `aviso-clinica-agendamento` (AVISO_CLINICA_AGENDAMENTO_SLUGS), nasce DESLIGADA. Estados: ligado / seco / desligado.
 * Seco registra o que mandaria na tela «só no papel» (automacao_simulacoes) e não manda.
 *
 * Configuração (no .env do stack; mesmo padrão do exame de imagem):
 *  - AVISO_CLINICA_AGENDAMENTO_DESTINOS: JSON {"<slug>": "<id do grupo>@g.us"} (também aceita um número com DDI).
 *  - AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL: …/message/sendText/<instância que envia> (a mesma dos relatórios dos grupos).
 *  - AVISO_CLINICA_AGENDAMENTO_EVOLUTION_HEADER / _VALUE: o cabeçalho da chave da Evolution (padrão: os do EVOLUTION_ALERT_*).
 *  Sem destino da unidade, sem URL ou sem chave: não manda (e diz no log).
 *
 * Um aviso por evento: cada aviso reivindica uma linha-marca no banco ANTES de sair (id fixo = primeira escrita vence,
 * vale entre processos e reinícios). O «não fechou» ainda respeita 1 por lead a cada 24 h. Envio recusado (a Evolution
 * respondeu erro ou nem conectou) deixa a marca `pendente`: o vigia tenta de novo (o «não fechou» na própria varredura, o
 * «marcou» em `reenviarMarcouPendentes`, até 12 h); «incerto» (conectou e não respondeu) não repete. O «marcou» de madrugada
 * (21h–7h na unidade) também fica `pendente` e sai depois das 7h.
 *
 * Nada aqui lança nem espera o agendamento: falha no WhatsApp vira log e o turno segue.
 *
 * Conteúdo: primeiro nome, dia, hora, tipo e o link do cartão. Sem CPF, telefone, e-mail nem dado clínico: o trecho da
 * última fala do paciente passa por `trechoSeguro` (tira número comprido, e-mail e link) antes de sair.
 */
import type { Unit } from '@prisma/client';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { enviarPelaEvolutionComResultado, type ResultadoDoEnvio } from './alerta-whatsapp.js';
import { registrarSimulacao } from './so-no-papel.js';
import { diaDaSemana } from './feriados.js';
import { fusoDaUnidade, partesNoFuso } from './fuso.js';
import { ehLeadDoChatwoot } from './chatwoot-lead.js';
import { avaliarNome } from '../services/spine-sync.service.js';

export const ID_DA_AUTOMACAO = 'aviso-clinica-agendamento';

/**
 * O «marcou» não toca o celular da recepção de madrugada: entre 21h e 7h (hora da unidade) fica guardado e sai na varredura do
 * vigia depois das 7h. (O «não fechou» já espera as 8h pela decisão do filtro do vigia.)
 */
const SILENCIO_INICIO_MIN = 21 * 60;
const SILENCIO_FIM_MIN = 7 * 60;
/** Um «marcou» que não saiu (recusado, ou guardado da madrugada) deixa de ser reenviado depois disto: aviso velho não ajuda. */
const IDADE_MAXIMA_PENDENTE_H = 12;
const PREFIXO_MARCOU = 'aviso-clinica:marcou:';

/** O «não fechou» sai no máximo uma vez por lead nesta janela. */
export const JANELA_NAO_FECHOU_MS = 24 * 60 * 60_000;

/** Tamanho máximo do trecho da fala do paciente. */
const TRECHO_MAX = 80;

type UnidadeDoAviso = Pick<Unit, 'id' | 'slug' | 'kommoSubdomain' | 'businessHoursTimezone' | 'spineTimezone'>;

/** Entre 21h e 7h na hora da unidade? */
export function emMadrugadaDoAviso(unit: Pick<Unit, 'businessHoursTimezone' | 'spineTimezone'>, agora: Date = new Date()): boolean {
  const p = partesNoFuso(agora, fusoDaUnidade(unit));
  const min = p.hora * 60 + p.min;
  return min >= SILENCIO_INICIO_MIN || min < SILENCIO_FIM_MIN;
}

export function estadoDoAvisoClinica(slug: string, raw: string | undefined = process.env.AVISO_CLINICA_AGENDAMENTO_SLUGS): Estado {
  return estadoDaAutomacao(slug, ID_DA_AUTOMACAO, raw);
}

/** A chave está ligada OU em seco nesta unidade (quem chama só precisa saber se vale montar o aviso). */
export function avisoClinicaAtivo(slug: string, raw?: string): boolean {
  return estadoDoAvisoClinica(slug, raw) !== 'desligado';
}

/** O destino (grupo ou número) da unidade, ou null. */
export function destinoDoAvisoClinica(slug: string, raw: string | undefined = process.env.AVISO_CLINICA_AGENDAMENTO_DESTINOS): string | null {
  if (!raw?.trim()) return null;
  try {
    const mapa = JSON.parse(raw.trim().replace(/^'|'$/g, '')) as Record<string, unknown>;
    const d = mapa?.[slug];
    return typeof d === 'string' && d.trim() ? d.trim() : null;
  } catch {
    logger.warn('aviso-clinica-agendamento: AVISO_CLINICA_AGENDAMENTO_DESTINOS não é JSON válido — sem destino');
    return null;
  }
}

// ── Texto ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const SEM_NOME = 'paciente (sem nome)';

/** Título que vem antes do nome («Dr. Fulano», «Sra Maria»): o primeiro nome é o que vem depois. */
const TITULOS = new Set(['dr', 'dra', 'sr', 'sra', 'srta', 'doutor', 'doutora', 'prof', 'profa', 'professor', 'professora']);

/**
 * «MARIA CONCEIÇÃO DA SILVA» → «Maria»; «Dr. Fulano» → «Fulano». Nome que não é de gente («Lead 123», telefone, só símbolos) → null.
 */
export function primeiroNome(nome: string | null | undefined): string | null {
  const t = (nome ?? '').trim();
  // «Lead #123», «Lead 23 16/11/2026», «Novo lead», «Contato», «Sem nome»…: título que o sistema ou o Kommo põe quando não sabe o nome
  if (!t || /\d/.test(t) || /^(novo\s+)?(lead|contato|cliente|paciente|visitante|whatsapp|sem\s+nome|desconhecid[oa]|unknown)\b/i.test(t)) return null;
  const palavras = t.split(/\s+/).map((p) => p.replace(/[^\p{L}'-]/gu, ''));
  // a primeira palavra que não é título nem inicial solta («J. Silva» → Silva)
  const primeiro = palavras.find((p) => (p.match(/\p{L}/gu) ?? []).length >= 2 && !TITULOS.has(p.toLocaleLowerCase('pt-BR')));
  if (!primeiro) return null;
  return primeiro
    .toLocaleLowerCase('pt-BR')
    .split('-')
    .map((x) => (x ? x[0].toLocaleUpperCase('pt-BR') + x.slice(1) : x))
    .join('-');
}

/** De onde vem um nome: o valor já pronto, ou uma busca que só roda se as fontes de antes não deram um nome de gente. */
export type FonteDeNome = string | null | undefined | (() => Promise<string | null | undefined>);

/** Emoji e enfeite colados no nome do perfil («Rosa❤️»). */
const ENFEITE = /[\p{Extended_Pictographic}☀-➿️‍]/gu;

/**
 * O nome só se for de PESSOA: passa por `primeiroNome` e pelo mesmo filtro de nome-lixo do cadastro na franquia (`avaliarNome`:
 * «Ocupado», «Fly link», «Oi», saudação, pedaço de mensagem, número, nome da clínica). Devolve o nome sem enfeite, ou null.
 */
export function nomeDeGente(nome: string | null | undefined): string | null {
  const limpo = String(nome ?? '').replace(ENFEITE, ' ').replace(/\s+/g, ' ').trim();
  return limpo && primeiroNome(limpo) && avaliarNome(limpo).ok ? limpo : null;
}

/** A fonte passada pelo filtro de `nomeDeGente` (o nome do perfil do WhatsApp e o título do cartão são texto livre de gente e de robô). */
export function soDeGente(f: FonteDeNome): FonteDeNome {
  return async () => nomeDeGente(typeof f === 'function' ? await f() : f);
}

/**
 * A primeira fonte que dá um nome de gente (`primeiroNome` não nulo), na ordem em que vieram; null se nenhuma. Fonte que lança
 * é pulada. Ordem dos avisos: nome da franquia → nome do contato da conversa (`conversations.contact_name`) → nome do cartão do
 * Kommo → «paciente (sem nome)».
 */
export async function primeiraFonteComNome(fontes: FonteDeNome[]): Promise<string | null> {
  for (const f of fontes) {
    try {
      const n = typeof f === 'function' ? await f() : f;
      if (primeiroNome(n)) return n ?? null;
    } catch {
      /* próxima fonte */
    }
  }
  return null;
}

/**
 * `conversations.contact_name` das conversas deste lead NESTA unidade (as 5 mais recentes: o lead pode ter WhatsApp e Instagram),
 * o primeiro que for nome de gente. Nunca lança.
 */
export async function nomeDoContatoDaConversa(unitId: string, leadId: number): Promise<string | null> {
  try {
    const cs = await prisma.conversation.findMany({
      where: { unitId, leadId: String(leadId), contactName: { not: null } },
      orderBy: { lastMessageAt: 'desc' },
      take: 5,
      select: { contactName: true },
    });
    for (const c of cs) {
      const n = nomeDeGente(c.contactName);
      if (n) return n;
    }
    return null;
  } catch (err) {
    logger.warn({ err: String(err), unitId, leadId }, 'aviso-clinica-agendamento: não li o nome do contato da conversa');
    return null;
  }
}

/**
 * Número com separadores (CPF 123.456.789-10, conta 351,855,134,29, fone (11) 98765-4321, +55 11 …): vírgula, ponto, hífen, barra,
 * parêntese e espaço ENTRE dígitos fazem parte do mesmo número. Se ele somar 4 dígitos ou mais, sai inteiro.
 */
function tirarNumeros(t: string): string {
  return t.replace(/[+(]?\d(?:[\d\s().,\-/]*\d)?/g, (m) => (m.replace(/\D/g, '').length >= 4 ? ' ' : m));
}

/**
 * Um trecho curto da fala do paciente, sem o que não pode sair no grupo: link, e-mail e qualquer número com 4 dígitos ou
 * mais (CPF, conta, telefone, data de nascimento, protocolo). Vazio quando sobra quase nada (figurinha, áudio sem texto).
 *
 * A ORDEM importa: a formatação do WhatsApp (*negrito*, _itálico_, ~riscado~, `código`) sai ANTES de procurar números, senão
 * «012*.*602*.*411» ou «123_456_789_10» escapam em pedaços e se juntam depois. O filtro roda de novo no fim, depois do corte.
 */
export function trechoSeguro(fala: string | null | undefined, max = TRECHO_MAX): string {
  let t = tirarNumeros(
    (fala ?? '')
      .replace(/[*_~`]/g, '')
      .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
      .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/"/g, "'");
  if ((t.match(/\p{L}/gu) ?? []).length < 3) return '';
  if (t.length > max) t = `${t.slice(0, max - 1).replace(/\s+\S*$/, '').trimEnd()}…`;
  return tirarNumeros(t).replace(/\s+/g, ' ').trim();
}

/**
 * O link do cartão do Kommo. Conversa do Chatwoot usa um id sintético (2 bilhões + o número da conversa): não existe cartão
 * no Kommo para ele, então não há link.
 */
export function linkDoCartao(unit: Pick<Unit, 'kommoSubdomain'>, leadId: number | undefined): string | null {
  const sub = unit.kommoSubdomain?.trim();
  if (!sub || !leadId || ehLeadDoChatwoot(leadId)) return null;
  return `https://${sub}.kommo.com/leads/detail/${leadId}`;
}

export interface DadosDoMarcou {
  nome: string | null | undefined;
  /** AAAA-MM-DD */
  data: string;
  /** HH:mm */
  hora: string;
  /** «avaliação», «consulta»… */
  tipo: string;
  remarcando?: boolean;
  link: string | null;
}

/**
 * «✅ A Sofia marcou *Maria* para sábado, 28/11 às 12:30 (avaliação). Cartão: <link>»
 * O dia da semana sai da DATA CIVIL da agenda (a data que a franquia e a Sofia usam, já na hora da unidade), calculada em UTC
 * puro: não depende do fuso nem do relógio do servidor.
 */
export function textoMarcou(d: DadosDoMarcou): string {
  const [, m, dia] = d.data.split('-');
  const semana = diaDaSemana(d.data);
  const quando = `${semana ? `${semana}, ` : ''}${dia}/${m} às ${d.hora}`;
  const verbo = d.remarcando ? 'remarcou' : 'marcou';
  const quem = primeiroNome(d.nome) ?? SEM_NOME;
  return `${d.remarcando ? '🔄' : '✅'} A Sofia ${verbo} *${quem}* para ${quando} (${d.tipo}).${d.link ? ` Cartão: ${d.link}` : ''}`;
}

export interface DadosDoNaoFechou {
  nome: string | null | undefined;
  ultimaFala: string | null | undefined;
  link: string | null;
}

/** «⚠️ A Sofia ofereceu horário a *Maria* e não fechou. Última fala do paciente: "…". Vale retomar. Cartão: <link>» */
export function textoNaoFechou(d: DadosDoNaoFechou): string {
  const quem = primeiroNome(d.nome) ?? SEM_NOME;
  const trecho = trechoSeguro(d.ultimaFala);
  return (
    `⚠️ A Sofia ofereceu horário a *${quem}* e não fechou.` +
    `${trecho ? ` Última fala do paciente: "${trecho}".` : ''} Vale retomar.` +
    `${d.link ? ` Cartão: ${d.link}` : ''}`
  );
}

// ── Marca de «já avisei» (uma por evento) ─────────────────────────────────────────────────────────────────────────

/**
 * Onde o aviso está:
 *  - `enviando`: alguém ganhou o direito de mandar e está mandando;
 *  - `pendente`: precisa sair e ainda não saiu (guardado da madrugada, ou a Evolution recusou) — o vigia reenvia;
 *  - `enviado` / `incerto`: saiu / pode ter saído (nunca repete).
 */
export type EstadoDaMarca = 'enviando' | 'pendente' | 'enviado' | 'incerto';

export interface MarcaPendente {
  id: string;
  unitId: string;
  leadId: string;
  payload: Record<string, unknown>;
}

export interface Marcador {
  /** 'novo' = esta chamada ganhou o direito de avisar; 'repetido' = já avisaram; 'erro' = o banco falhou (quem chama decide). */
  reivindicar(
    id: string,
    a: { unitId: string; leadId: string; titulo: string; payload: Record<string, unknown>; estado: 'enviando' | 'pendente' },
  ): Promise<'novo' | 'repetido' | 'erro'>;
  /** Uma marca `pendente` passa a `enviando` — só UM chamador ganha (true). */
  pegar(id: string): Promise<boolean>;
  /** Houve aviso (que saiu ou está saindo, não os pendentes) com este prefixo de id para o lead dentro da janela? */
  houveRecente(unitId: string, leadId: string, prefixoDoId: string, janelaMs: number): Promise<boolean>;
  concluir(id: string, estado: 'enviado' | 'incerto' | 'pendente'): Promise<void>;
  /** Marcas `pendente` com este prefixo de id, nascidas há menos de `idadeMaxMs`. */
  pendentes(prefixoDoId: string, idadeMaxMs: number): Promise<MarcaPendente[]>;
}

const codigoDoErro = (err: unknown): string | undefined => (err as { code?: string } | null)?.code;

/**
 * A marca é um rastro `manual` (como as do vigia de agendamento perdido) com id FIXO por evento: o banco recusa o segundo
 * (P2002), então dois processos ou dois reinícios nunca avisam o mesmo evento duas vezes. O ESTADO do aviso mora no payload
 * do passo, e o rastro é SEMPRE `SUCCESS`: RUNNING apareceria como «turno preso» e FAILED seria contado como falha da IA nos
 * painéis. Os títulos não citam a tool de agendar nem a de horários: as consultas do vigia procuram esses nomes nos rastros.
 */
export const marcadorNoBanco: Marcador = {
  async reivindicar(id, a) {
    try {
      await prisma.executionTrace.create({
        data: {
          id,
          unitId: a.unitId,
          leadId: a.leadId,
          threadId: id,
          input: { origem: ID_DA_AUTOMACAO },
          channel: 'manual',
          status: 'SUCCESS',
          steps: { create: { sequence: 0, kind: 'KOMMO_ACTION', title: a.titulo, payload: { ...a.payload, estado: a.estado } as object } },
        },
      });
      return 'novo';
    } catch (err) {
      if (codigoDoErro(err) !== 'P2002') {
        logger.warn({ err: String(err), id }, 'aviso-clinica-agendamento: não consegui gravar a marca do aviso');
        return 'erro';
      }
      // Já existe. Se estava pendente (recusado antes), o primeiro a pegar ganha a nova tentativa; guardar de novo é repetido.
      if (a.estado === 'pendente') return 'repetido';
      try {
        return (await marcadorNoBanco.pegar(id)) ? 'novo' : 'repetido';
      } catch (err2) {
        logger.warn({ err: String(err2), id }, 'aviso-clinica-agendamento: não consegui reabrir a marca');
        return 'erro';
      }
    }
  },
  async pegar(id) {
    const n = await prisma.$executeRaw`
      UPDATE execution_steps SET payload = jsonb_set(payload, '{estado}', '"enviando"')
       WHERE trace_id = ${id} AND payload->>'estado' = 'pendente'`;
    return n > 0;
  },
  async houveRecente(unitId, leadId, prefixoDoId, janelaMs) {
    const linhas = await prisma.$queryRaw<Array<{ n: bigint | number }>>`
      SELECT count(*) AS n
        FROM execution_steps s
        JOIN execution_traces t ON t.id = s.trace_id
       WHERE t.unit_id = ${unitId} AND t.lead_id = ${leadId}
         AND starts_with(t.id, ${prefixoDoId})
         AND s.payload->>'estado' <> 'pendente'
         AND t.created_at > now() - (${String(Math.round(janelaMs / 1000))} || ' seconds')::interval`;
    return Number(linhas[0]?.n ?? 0) > 0;
  },
  async concluir(id, estado) {
    await prisma
      .$executeRaw`UPDATE execution_steps SET payload = jsonb_set(payload, '{estado}', to_jsonb(${estado}::text)) WHERE trace_id = ${id}`
      .catch((err: unknown) => logger.warn({ err: String(err), id, estado }, 'aviso-clinica-agendamento: não consegui anotar o desfecho na marca'));
  },
  async pendentes(prefixoDoId, idadeMaxMs) {
    const linhas = await prisma.$queryRaw<Array<{ id: string; unitId: string; leadId: string; payload: Record<string, unknown> | null }>>`
      SELECT t.id AS "id", t.unit_id AS "unitId", t.lead_id AS "leadId", s.payload AS "payload"
        FROM execution_steps s
        JOIN execution_traces t ON t.id = s.trace_id
       WHERE starts_with(t.id, ${prefixoDoId})
         AND s.payload->>'estado' = 'pendente'
         AND t.created_at > now() - (${String(Math.round(idadeMaxMs / 1000))} || ' seconds')::interval
       ORDER BY t.created_at
       LIMIT 50`;
    return linhas.filter((l) => l.unitId).map((l) => ({ id: l.id, unitId: l.unitId, leadId: l.leadId, payload: l.payload ?? {} }));
  },
};

// ── Envio ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DepsDoAviso {
  enviar?: (a: { url: string; header: string; valor: string; numero: string; texto: string }) => Promise<ResultadoDoEnvio>;
  marcador?: Marcador;
  simular?: typeof registrarSimulacao;
  env?: Partial<NodeJS.ProcessEnv>;
  estado?: Estado;
  agora?: () => Date;
  /** só teste: o `conversations.contact_name` do lead nesta unidade */
  nomeDoContato?: (unitId: string, leadId: number) => Promise<string | null>;
}

export type Desfecho =
  | 'enviado'
  | 'incerto'
  | 'recusado'
  | 'simulado'
  | 'desligado'
  | 'sem_destino'
  | 'sem_config'
  | 'repetido'
  | 'recente'
  | 'segurado'
  | 'falhou';

/** Avisa no log UMA vez por unidade e motivo: o vigia volta ao mesmo lead a cada 15 min e o log vai para o painel de erros. */
const jaDisseNoLog = new Set<string>();
function avisarUmaVez(unit: string, motivo: string, msg: string): void {
  const k = `${unit}|${motivo}`;
  if (jaDisseNoLog.has(k)) return;
  jaDisseNoLog.add(k);
  logger.warn({ unit }, msg);
}

function configDaEvolution(env: Partial<NodeJS.ProcessEnv>): { url: string; header: string; valor: string } | null {
  const url = env.AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL;
  const header = env.AVISO_CLINICA_AGENDAMENTO_EVOLUTION_HEADER || env.EVOLUTION_ALERT_HEADER;
  const valor = env.AVISO_CLINICA_AGENDAMENTO_EVOLUTION_VALUE || env.EVOLUTION_ALERT_VALUE;
  return url && header && valor ? { url, header, valor } : null;
}

type Cfg = { url: string; header: string; valor: string };

/**
 * Manda e anota o desfecho na marca: saiu → `enviado`; a Evolution recusou (não saiu) → `pendente` (o vigia tenta de novo);
 * sem resposta (pode ter saído) → `incerto`, que nunca repete.
 */
async function enviarEAnotar(
  a: { unit: Pick<Unit, 'slug'>; evento: string; leadId: number | undefined; idDaMarca: string; texto: string; destino: string; cfg: Cfg; anotar: boolean },
  deps: DepsDoAviso,
  marcador: Marcador,
): Promise<'enviado' | 'recusado' | 'incerto'> {
  const resultado = await (deps.enviar ?? enviarPelaEvolutionComResultado)({ ...a.cfg, numero: a.destino, texto: a.texto });
  if (resultado === 'ok') {
    logger.info({ unit: a.unit.slug, evento: a.evento, leadId: a.leadId }, 'aviso-clinica-agendamento: aviso enviado');
    if (a.anotar) await marcador.concluir(a.idDaMarca, 'enviado');
    return 'enviado';
  }
  if (resultado === 'recusado') {
    if (a.anotar) await marcador.concluir(a.idDaMarca, 'pendente');
    logger.warn({ unit: a.unit.slug, evento: a.evento, leadId: a.leadId }, 'aviso-clinica-agendamento: a Evolution recusou o aviso — fica pendente para a próxima varredura');
    return 'recusado';
  }
  if (a.anotar) await marcador.concluir(a.idDaMarca, 'incerto');
  logger.warn({ unit: a.unit.slug, evento: a.evento, leadId: a.leadId }, 'aviso-clinica-agendamento: envio sem resposta — pode ter saído, não repito');
  return 'incerto';
}

async function entregar(
  unit: UnidadeDoAviso,
  a: {
    evento: 'marcou' | 'nao-fechou';
    leadId: number | undefined;
    texto: string;
    idDaMarca: string;
    leadDaMarca: string;
    titulo: string;
    payload: Record<string, unknown>;
    /** só o «não fechou»: prefixo dos ids de aviso deste lead, para a regra de 1 a cada 24 h */
    prefixoDoLead?: string;
    /** só o «marcou»: de madrugada (21h–7h na unidade) o aviso fica guardado e sai pela varredura do vigia depois das 7h */
    segurarNaMadrugada?: boolean;
  },
  deps: DepsDoAviso,
): Promise<Desfecho> {
  const env = deps.env ?? process.env;
  const estado = deps.estado ?? estadoDoAvisoClinica(unit.slug, env.AVISO_CLINICA_AGENDAMENTO_SLUGS);
  if (estado === 'desligado') return 'desligado';
  const destino = destinoDoAvisoClinica(unit.slug, env.AVISO_CLINICA_AGENDAMENTO_DESTINOS);

  if (estado === 'seco') {
    (deps.simular ?? registrarSimulacao)(unit, ID_DA_AUTOMACAO, {
      leadId: a.leadId ?? 0,
      acao: 'mandaria',
      alvo: a.evento,
      valor: a.texto,
      motivo: destino ? `para ${destino}` : 'SEM destino configurado (AVISO_CLINICA_AGENDAMENTO_DESTINOS): ligado, não sairia',
    });
    return 'simulado';
  }

  if (!destino) {
    avisarUmaVez(unit.slug, 'destino', 'aviso-clinica-agendamento: ligado, mas a unidade não tem destino em AVISO_CLINICA_AGENDAMENTO_DESTINOS — não mando');
    return 'sem_destino';
  }
  const cfg = configDaEvolution(env);
  if (!cfg) {
    avisarUmaVez(unit.slug, 'config', 'aviso-clinica-agendamento: sem AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL/HEADER/VALUE — não mando');
    return 'sem_config';
  }

  const marcador = deps.marcador ?? marcadorNoBanco;
  const agora = deps.agora?.() ?? new Date();
  if (a.prefixoDoLead) {
    if (await marcador.houveRecente(unit.id, a.leadDaMarca, a.prefixoDoLead, JANELA_NAO_FECHOU_MS).catch(() => false)) return 'recente';
  }
  const segurar = Boolean(a.segurarNaMadrugada) && emMadrugadaDoAviso(unit, agora);
  const marca = await marcador.reivindicar(a.idDaMarca, {
    unitId: unit.id,
    leadId: a.leadDaMarca,
    titulo: a.titulo,
    // O texto fica na marca: é ele que o vigia reenvia se o aviso ficou guardado ou foi recusado.
    payload: { ...a.payload, texto: a.texto },
    estado: segurar ? 'pendente' : 'enviando',
  });
  if (marca === 'repetido') return 'repetido';
  if (segurar) {
    if (marca === 'erro') return 'falhou'; // sem a marca não há onde guardar: melhor calar de madrugada do que tocar o celular
    logger.info({ unit: unit.slug, evento: a.evento, leadId: a.leadId }, 'aviso-clinica-agendamento: madrugada na unidade — aviso guardado para depois das 7h');
    return 'segurado';
  }
  // Falha do banco da marca: avisar mesmo assim (repetir é pouco; deixar a recepção no escuro é o que o pedido quer evitar).
  return enviarEAnotar(
    { unit, evento: a.evento, leadId: a.leadId, idDaMarca: a.idDaMarca, texto: a.texto, destino, cfg, anotar: marca === 'novo' },
    deps,
    marcador,
  );
}

/**
 * Reenvia os «marcou» que não saíram (guardados da madrugada, ou recusados pela Evolution). Chamado a cada varredura do vigia.
 * Só reenvia com a chave LIGADA, fora da madrugada da unidade e para marcas de até 12 h; cada marca sai uma vez (quem ganha o
 * `pegar` envia). Nunca lança. Devolve quantos enviou.
 */
export async function reenviarMarcouPendentes(
  deps: DepsDoAviso & { unidade?: (unitId: string) => Promise<UnidadeDoAviso | null> } = {},
): Promise<number> {
  try {
    const env = deps.env ?? process.env;
    const marcador = deps.marcador ?? marcadorNoBanco;
    const carregar =
      deps.unidade ??
      ((id: string) =>
        prisma.unit.findUnique({
          where: { id },
          select: { id: true, slug: true, kommoSubdomain: true, businessHoursTimezone: true, spineTimezone: true, isActive: true },
        }));
    const lista = await marcador.pendentes(PREFIXO_MARCOU, IDADE_MAXIMA_PENDENTE_H * 3600_000);
    let enviados = 0;
    // No máximo 10 por varredura (cada envio pode levar até 15 s e a varredura do vigia espera por esta função).
    for (const p of lista.slice(0, 10)) {
      let pegou = false;
      try {
        const unit = await carregar(p.unitId);
        if (!unit || (unit as { isActive?: boolean }).isActive === false) continue;
        const estado = deps.estado ?? estadoDoAvisoClinica(unit.slug, env.AVISO_CLINICA_AGENDAMENTO_SLUGS);
        if (estado !== 'ligado') continue; // desligado ou seco: não manda; a marca fica
        if (emMadrugadaDoAviso(unit, deps.agora?.() ?? new Date())) continue;
        const destino = destinoDoAvisoClinica(unit.slug, env.AVISO_CLINICA_AGENDAMENTO_DESTINOS);
        const cfg = configDaEvolution(env);
        const texto = typeof p.payload.texto === 'string' ? p.payload.texto : '';
        if (!destino || !cfg || !texto) continue;
        if (!(await marcador.pegar(p.id))) continue;
        pegou = true;
        const leadId = Number(p.leadId);
        const r = await enviarEAnotar(
          { unit, evento: 'marcou', leadId: Number.isFinite(leadId) ? leadId : undefined, idDaMarca: p.id, texto, destino, cfg, anotar: true },
          deps,
          marcador,
        );
        if (r === 'enviado') enviados++;
      } catch (err) {
        // Um pendente com problema não trava os outros; a marca que já tinha sido pega volta a pendente (nada saiu).
        logger.warn({ err: String(err), id: p.id }, 'aviso-clinica-agendamento: falha ao reenviar um «marcou» pendente');
        if (pegou) await marcador.concluir(p.id, 'pendente').catch(() => undefined);
      }
    }
    return enviados;
  } catch (err) {
    logger.warn({ err: String(err) }, 'aviso-clinica-agendamento: falha ao reenviar os «marcou» pendentes');
    return 0;
  }
}

/** Id da marca: o evento inteiro (unidade, cartão ou cadastro, dia e hora). Remarcar para OUTRO horário é evento novo. */
export const idDaMarcaMarcou = (unitId: string, quem: string, data: string, hora: string, idSchedule?: number | null): string =>
  // O idSchedule (o número da consulta na franquia) separa «marcou, desmarcou e marcou o mesmo horário de novo»: são duas consultas, dois avisos.
  `${PREFIXO_MARCOU}${unitId}:${quem}:${data}T${hora}${idSchedule ? `:${idSchedule}` : ''}`;

/**
 * Chave de privacidade: `AVISO_CLINICA_AGENDAMENTO_SEM_TRECHO=1` tira do «não fechou» a última fala do paciente (o aviso fica só com
 * o primeiro nome e o link do cartão). O trecho passa por `trechoSeguro`, mas o que o paciente escreve em palavras (um sintoma,
 * um endereço) não tem como ser filtrado.
 */
export function avisoSemTrecho(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  return /^(1|true|sim)$/i.test((env.AVISO_CLINICA_AGENDAMENTO_SEM_TRECHO ?? '').trim());
}

/**
 * Por quanto tempo o vigia NÃO volta a este aviso depois de cada desfecho: o que saiu (ou já tinha saído) fica quieto até a
 * oferta sair da janela; o que não saiu (seco, recusado, sem destino/URL, falha) espera uma hora — nem martela a Evolution e
 * o Kommo a cada varredura de 15 min, nem fica esquecido se alguém acertar a configuração.
 */
export function silencioDepoisDe(d: Desfecho, janelaMs: number): number | null {
  if (d === 'enviado' || d === 'incerto' || d === 'repetido') return janelaMs;
  if (d === 'desligado') return null;
  // «recente» = outro aviso deste lead ainda dentro das 24 h: olha de novo em 1 h, porque ESTA oferta pode valer assim que as 24 h fecharem.
  // «simulado» = seco: 3 h bastam (a tela só precisa do último «mandaria»).
  if (d === 'simulado') return 3 * 60 * 60_000;
  return 60 * 60_000;
}

/** Id da marca do «não fechou»: uma por oferta (a hora da oferta entra no id). */
export const prefixoNaoFechou = (unitId: string, leadId: string | number): string => `aviso-clinica:nao-fechou:${unitId}:${leadId}:`;

/**
 * A Sofia acabou de gravar a consulta na franquia. Nunca lança.
 * `tipo`: «avaliação» (categoria 1, a consulta inicial) ou «consulta».
 * Nome, em ordem: o da franquia → `conversations.contact_name` do lead nesta unidade → o do cartão do Kommo (`nomeDoCartao`) →
 * «paciente (sem nome)». Cada fonte só é consultada se as de antes não deram um nome de gente.
 * De madrugada (21h–7h na unidade) o aviso fica guardado e sai pelo vigia depois das 7h.
 */
export async function avisarClinicaMarcou(
  a: {
    unit: UnidadeDoAviso;
    leadId?: number;
    idClient: number;
    nome: string | null | undefined;
    nomeDoCartao?: () => Promise<string | null | undefined>;
    data: string;
    hora: string;
    idCategory?: number;
    remarcando?: boolean;
    /** o número da consulta na franquia (devolvido ao gravar) */
    idSchedule?: number | null;
  },
  deps: DepsDoAviso = {},
): Promise<Desfecho> {
  try {
    const nome = await primeiraFonteComNome([
      a.nome,
      a.leadId ? soDeGente(() => (deps.nomeDoContato ?? nomeDoContatoDaConversa)(a.unit.id, a.leadId!)) : null,
      a.nomeDoCartao ? soDeGente(a.nomeDoCartao) : null,
    ]);
    const texto = textoMarcou({
      nome,
      data: a.data,
      hora: a.hora,
      tipo: (a.idCategory ?? 1) === 1 ? 'avaliação' : 'consulta',
      remarcando: a.remarcando,
      link: linkDoCartao(a.unit, a.leadId),
    });
    const quem = a.leadId ? String(a.leadId) : `cliente-${a.idClient}`;
    return await entregar(
      a.unit,
      {
        evento: 'marcou',
        leadId: a.leadId,
        texto,
        idDaMarca: idDaMarcaMarcou(a.unit.id, quem, a.data, a.hora, a.idSchedule),
        leadDaMarca: quem,
        titulo: `AVISO CLÍNICA · ${a.remarcando ? 'remarcou' : 'marcou'} — ${a.data} ${a.hora}`,
        payload: { leadId: a.leadId ?? null, data: a.data, hora: a.hora },
        segurarNaMadrugada: true,
      },
      deps,
    );
  } catch (err) {
    logger.warn({ err: String(err), unit: a.unit.slug, leadId: a.leadId }, 'aviso-clinica-agendamento: falha ao avisar que marcou — o agendamento segue valendo');
    return 'falhou';
  }
}

/** O vigia decidiu que a oferta não fechou (mesma decisão do alerta de «agendamento perdido»). Nunca lança. */
export async function avisarClinicaNaoFechou(
  /** `nome` = o do CARTÃO do Kommo: só vale se não for título genérico, e só depois do nome do contato da conversa. */
  a: { unit: UnidadeDoAviso; leadId: number; nome: string | null | undefined; ultimaFala: string | null | undefined; ofereceuEm: Date },
  deps: DepsDoAviso = {},
): Promise<Desfecho> {
  try {
    const nome = await primeiraFonteComNome([soDeGente(() => (deps.nomeDoContato ?? nomeDoContatoDaConversa)(a.unit.id, a.leadId)), soDeGente(a.nome)]);
    const prefixo = prefixoNaoFechou(a.unit.id, a.leadId);
    return await entregar(
      a.unit,
      {
        evento: 'nao-fechou',
        leadId: a.leadId,
        texto: textoNaoFechou({ nome, ultimaFala: avisoSemTrecho(deps.env ?? process.env) ? null : a.ultimaFala, link: linkDoCartao(a.unit, a.leadId) }),
        idDaMarca: `${prefixo}${a.ofereceuEm.getTime()}`,
        leadDaMarca: String(a.leadId),
        titulo: `AVISO CLÍNICA · ofereceu e não fechou — lead ${a.leadId}`,
        payload: { leadId: a.leadId, ofereceuEm: a.ofereceuEm.toISOString() },
        prefixoDoLead: prefixo,
      },
      deps,
    );
  } catch (err) {
    logger.warn({ err: String(err), unit: a.unit.slug, leadId: a.leadId }, 'aviso-clinica-agendamento: falha ao avisar o «não fechou»');
    return 'falhou';
  }
}
