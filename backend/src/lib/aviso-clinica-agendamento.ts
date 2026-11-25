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
 * respondeu erro ou nem conectou) libera a marca para tentar de novo; «incerto» (conectou e não respondeu) não repete.
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

export const ID_DA_AUTOMACAO = 'aviso-clinica-agendamento';

/** O «não fechou» sai no máximo uma vez por lead nesta janela. */
export const JANELA_NAO_FECHOU_MS = 24 * 60 * 60_000;

/** Tamanho máximo do trecho da fala do paciente. */
const TRECHO_MAX = 80;

type UnidadeDoAviso = Pick<Unit, 'id' | 'slug' | 'kommoSubdomain'>;

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

/**
 * «MARIA CONCEIÇÃO DA SILVA» → «Maria». Nome que não é de gente («Lead 123», telefone, só símbolos) → null.
 */
export function primeiroNome(nome: string | null | undefined): string | null {
  const t = (nome ?? '').trim();
  if (!t || /\d/.test(t) || /^lead\b/i.test(t)) return null;
  const primeiro = t.split(/\s+/)[0].replace(/[^\p{L}'-]/gu, '');
  if (primeiro.length < 2) return null;
  return primeiro[0].toLocaleUpperCase('pt-BR') + primeiro.slice(1).toLocaleLowerCase('pt-BR');
}

/**
 * Um trecho curto da fala do paciente, sem o que não pode sair no grupo: link, e-mail e qualquer número com 4 dígitos ou
 * mais (CPF, telefone, data de nascimento, protocolo). Vazio quando sobra quase nada (figurinha, áudio sem texto).
 */
export function trechoSeguro(fala: string | null | undefined, max = TRECHO_MAX): string {
  let t = (fala ?? '')
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, ' ')
    // número com separadores (CPF 123.456.789-10, fone (11) 98765-4321, +55 11 …): se somar 4 dígitos ou mais, sai inteiro
    .replace(/[+(]?\d[\d\s().\-/]{2,}\d/g, (m) => (m.replace(/\D/g, '').length >= 4 ? ' ' : m))
    // marcas de formatação do WhatsApp (*negrito*, _itálico_, ~riscado~, `código`) quebrariam o texto do aviso
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/"/g, "'");
  if ((t.match(/\p{L}/gu) ?? []).length < 3) return '';
  if (t.length > max) t = `${t.slice(0, max - 1).replace(/\s+\S*$/, '').trimEnd()}…`;
  return t;
}

function linkDoCartao(unit: Pick<Unit, 'kommoSubdomain'>, leadId: number | undefined): string | null {
  const sub = unit.kommoSubdomain?.trim();
  return sub && leadId ? `https://${sub}.kommo.com/leads/detail/${leadId}` : null;
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

/** «✅ A Sofia marcou *Maria* para sexta-feira, 28/11 às 12:30 (avaliação). Cartão: <link>» */
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

export interface Marcador {
  /** 'novo' = esta chamada ganhou o direito de avisar; 'repetido' = já avisaram; 'erro' = o banco falhou (quem chama decide). */
  reivindicar(id: string, a: { unitId: string; leadId: string; titulo: string; payload: Record<string, unknown> }): Promise<'novo' | 'repetido' | 'erro'>;
  /** Houve aviso com este prefixo de id para o lead nas últimas 24 h? */
  houveRecente(unitId: string, leadId: string, prefixoDoId: string, desde: Date): Promise<boolean>;
  /** O envio foi recusado: a marca deixa de valer e o aviso pode ser tentado de novo. */
  soltar(id: string): Promise<void>;
}

const codigoDoErro = (err: unknown): string | undefined => (err as { code?: string } | null)?.code;

/**
 * A marca é um rastro `manual` (como as do vigia de agendamento perdido) com id FIXO por evento: o banco recusa o segundo
 * (P2002), então dois processos ou dois reinícios nunca avisam o mesmo evento duas vezes. Nasce SUCCESS (RUNNING
 * apareceria como «turno preso»). Os títulos não citam a tool de agendar nem a de horários: as consultas do vigia
 * procuram esses nomes nos rastros.
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
          steps: { create: { sequence: 0, kind: 'KOMMO_ACTION', title: a.titulo, payload: a.payload as object } },
        },
      });
      return 'novo';
    } catch (err) {
      if (codigoDoErro(err) !== 'P2002') {
        logger.warn({ err: String(err), id }, 'aviso-clinica-agendamento: não consegui gravar a marca do aviso');
        return 'erro';
      }
      // Já existe. Se foi um envio recusado, o primeiro a reabrir ganha a nova tentativa.
      try {
        const r = await prisma.executionTrace.updateMany({ where: { id, status: 'FAILED' }, data: { status: 'SUCCESS', errorMessage: null } });
        return r.count > 0 ? 'novo' : 'repetido';
      } catch (err2) {
        logger.warn({ err: String(err2), id }, 'aviso-clinica-agendamento: não consegui reabrir a marca');
        return 'erro';
      }
    }
  },
  async houveRecente(unitId, leadId, prefixoDoId, desde) {
    const n = await prisma.executionTrace.count({
      where: { unitId, leadId, id: { startsWith: prefixoDoId }, status: 'SUCCESS', createdAt: { gt: desde } },
    });
    return n > 0;
  },
  async soltar(id) {
    await prisma.executionTrace
      .updateMany({ where: { id }, data: { status: 'FAILED', errorMessage: 'envio recusado pela Evolution — pode tentar de novo' } })
      .catch((err) => logger.warn({ err: String(err), id }, 'aviso-clinica-agendamento: não consegui soltar a marca'));
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
}

export type Desfecho = 'enviado' | 'incerto' | 'recusado' | 'simulado' | 'desligado' | 'sem_destino' | 'sem_config' | 'repetido' | 'recente' | 'falhou';

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
  if (a.prefixoDoLead) {
    const desde = new Date((deps.agora?.() ?? new Date()).getTime() - JANELA_NAO_FECHOU_MS);
    if (await marcador.houveRecente(unit.id, a.leadDaMarca, a.prefixoDoLead, desde).catch(() => false)) return 'recente';
  }
  // Falha do banco: avisar mesmo assim (repetir é pouco; deixar a recepção no escuro é o que o pedido quer evitar).
  const marca = await marcador.reivindicar(a.idDaMarca, { unitId: unit.id, leadId: a.leadDaMarca, titulo: a.titulo, payload: a.payload });
  if (marca === 'repetido') return 'repetido';

  const resultado = await (deps.enviar ?? enviarPelaEvolutionComResultado)({ ...cfg, numero: destino, texto: a.texto });
  if (resultado === 'ok') {
    logger.info({ unit: unit.slug, evento: a.evento, leadId: a.leadId }, 'aviso-clinica-agendamento: aviso enviado');
    return 'enviado';
  }
  if (resultado === 'recusado') {
    if (marca === 'novo') await marcador.soltar(a.idDaMarca);
    logger.warn({ unit: unit.slug, evento: a.evento, leadId: a.leadId }, 'aviso-clinica-agendamento: a Evolution recusou o aviso');
    return 'recusado';
  }
  logger.warn({ unit: unit.slug, evento: a.evento, leadId: a.leadId }, 'aviso-clinica-agendamento: envio sem resposta — pode ter saído, não repito');
  return 'incerto';
}

/** Id da marca: o evento inteiro (unidade, cartão ou cadastro, dia e hora). Remarcar para OUTRO horário é evento novo. */
export const idDaMarcaMarcou = (unitId: string, quem: string, data: string, hora: string, idSchedule?: number | null): string =>
  // O idSchedule (o número da consulta na franquia) separa «marcou, desmarcou e marcou o mesmo horário de novo»: são duas consultas, dois avisos.
  `aviso-clinica:marcou:${unitId}:${quem}:${data}T${hora}${idSchedule ? `:${idSchedule}` : ''}`;

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
  if (d === 'enviado' || d === 'incerto' || d === 'repetido' || d === 'recente') return janelaMs;
  if (d === 'desligado') return null;
  return 60 * 60_000;
}
/** Id da marca do «não fechou»: uma por oferta (a hora da oferta entra no id). */
export const prefixoNaoFechou = (unitId: string, leadId: string | number): string => `aviso-clinica:nao-fechou:${unitId}:${leadId}:`;

/**
 * A Sofia acabou de gravar a consulta na franquia. Nunca lança.
 * `tipo`: «avaliação» (categoria 1, a consulta inicial) ou «consulta».
 */
export async function avisarClinicaMarcou(
  a: {
    unit: UnidadeDoAviso;
    leadId?: number;
    idClient: number;
    nome: string | null | undefined;
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
    const texto = textoMarcou({
      nome: a.nome,
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
  a: { unit: UnidadeDoAviso; leadId: number; nome: string | null | undefined; ultimaFala: string | null | undefined; ofereceuEm: Date },
  deps: DepsDoAviso = {},
): Promise<Desfecho> {
  try {
    const prefixo = prefixoNaoFechou(a.unit.id, a.leadId);
    return await entregar(
      a.unit,
      {
        evento: 'nao-fechou',
        leadId: a.leadId,
        texto: textoNaoFechou({ nome: a.nome, ultimaFala: avisoSemTrecho(deps.env ?? process.env) ? null : a.ultimaFala, link: linkDoCartao(a.unit, a.leadId) }),
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
