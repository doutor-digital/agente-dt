/**
 * Alerta «Sofia parou» (26/11/2026): a Sofia do CRM deveria estar atendendo, o paciente escreveu, a rodada acabou em falha, teto ou erro e
 * ninguém respondeu há mais de N minutos — a equipe é avisada no mesmo grupo de WhatsApp da recepção do `aviso-clinica-agendamento`.
 *
 * Por que existe: quando a rodada falha o paciente fica sem resposta e a única pista é uma nota privada (e, no teto do dia, nem isso). A
 * reclamação das unidades é «a Sofia passa para a equipe e ninguém pega» / «ficou sem resposta». O alerta pega o silêncio, não só o erro:
 * N minutos DEPOIS da falha ele relê a conversa e só avisa se a última mensagem pública continua sendo do paciente.
 *
 * Quando avisa (todas): chave `chatwoot-sofia-parou` ligada (em «só no papel» só anota «alertaria»); a Sofia desta unidade está LIGADA; a unidade
 * não está pausada; a Sofia IA ia mesmo atender agora (`foraDoHorarioDaIa`: fora da janela da IA — expediente, feriado — quem atende é a equipe e a falha
 * do «teto» não deixou ninguém sem resposta); a conversa não foi passada à equipe, nem a IA pausada (alguém já está nela); a última mensagem pública é do
 * paciente e tem mais de N minutos (`CHATWOOT_SOFIA_PAROU_MIN`, padrão 15); e este paciente/conversa não foi avisado nas últimas 2 h.
 *
 * QUANDO o aviso sai (o padrão): na hora SÓ durante o horário da EQUIPE (`dentroDoHorario`: dias da agenda, 8h–20h, sem feriado — o mesmo da unidade no
 * alerta do Telegram) e SÓ se a unidade não avisou outro paciente PELO MESMO MOTIVO nos últimos 30 min (teto por unidade e motivo, `teto`, `falhou`,
 * `kommo-indisponivel` e `sem-texto`: 30 conversas paradas pela mesma causa não viram 30 WhatsApps). O que não sai na hora NÃO se perde: fica numa lista em
 * memória e, quando a clínica ABRE (ou a janela de 30 min acaba), sai UM resumo com quem AINDA está sem resposta (relido na hora: quem a equipe já
 * atendeu sai da lista).
 *
 * Limite honesto: o relógio da espera e a lista de pendentes são em memória (como o resto da IA do CRM): se o servidor reinicia, o que estava na espera não é
 * avisado. Se a Evolution recusa o aviso que reservou a janela, a unidade libera a janela mas as conversas já seguradas esperam o próximo resumo. O destino é
 * `AVISO_CLINICA_AGENDAMENTO_DESTINOS` (JSON por unidade) e a instância é a do mesmo aviso; sem destino não manda e diz no log.
 */
import type { Unit } from '@prisma/client';
import { logger } from './logger.js';
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { enviarPelaEvolutionComResultado } from './alerta-whatsapp.js';
import { registrarSimulacao } from './so-no-papel.js';
import { configDaEvolution, destinoDoAvisoClinica, nomeDeGente, primeiroNome } from './aviso-clinica-agendamento.js';
import { leadDaConversaChatwoot } from './chatwoot-lead.js';
import { emPausa } from './pausa-unidade.js';
import { motivoDeNaoResponder } from './chatwoot-sofia.js';
import { foraDoHorarioDaIa } from './chatwoot-horario-da-ia.js';
import { dentroDoHorario } from './sla-alert-worker.js';
import { ehMensagemDeEspera } from './crm-demora/marca.js';
import type { ConversaLida } from './chatwoot-porta.js';

export const ID_SOFIA_PAROU = 'chatwoot-sofia-parou';
export const MINUTOS_PADRAO = 15;
export const ENTRE_AVISOS_MS = 2 * 60 * 60_000;
/**
 * No máximo 1 aviso por unidade e por motivo nesta janela. 30 min: mais que os 15 min da espera (a «onda» de falhas de um mesmo incidente cai toda dentro
 * dela e vira UM aviso), e curta o bastante para que um segundo incidente, depois de a recepção ter tido tempo de agir no primeiro, avise de novo.
 */
export const ENTRE_AVISOS_DA_UNIDADE_MS = 30 * 60_000;
/** quantos pacientes o resumo lista pelo nome (o resto vai em «e mais N»): o WhatsApp não é relatório */
export const MAX_NO_RESUMO = 8;

/** Desfechos da rodada em que o paciente ficou sem resposta POR FALHA (não por decisão: calada, pausa, equipe respondeu…). */
export const DESFECHOS_QUE_PARAM: ReadonlySet<string> = new Set(['falhou', 'teto', 'kommo-indisponivel', 'sem-texto']);

/** motivos que atingem a unidade toda: o aviso diz que o resto vem num resumo */
const DESFECHOS_DA_UNIDADE: ReadonlySet<string> = new Set(['teto', 'kommo-indisponivel']);

const PORQUE: Readonly<Record<string, string>> = {
  falhou: 'falha da Sofia ou do Chatwoot',
  teto: 'limite de respostas do dia',
  'kommo-indisponivel': 'não deu para conferir o Kommo',
  'sem-texto': 'o modelo não escreveu a resposta',
};

export const minutosDoAlerta = (e: NodeJS.ProcessEnv = process.env): number => {
  const n = Number(e.CHATWOOT_SOFIA_PAROU_MIN);
  return Number.isFinite(n) && n >= 1 && n <= 24 * 60 ? Math.round(n) : MINUTOS_PADRAO;
};

const tempoPorExtenso = (minutos: number): string => (minutos >= 120 ? `${Math.floor(minutos / 60)} h` : `${minutos} min`);

export function textoDoAviso(a: { nome: string | null | undefined; minutos: number; desfecho: string; conversa: number; link: string | null }): string {
  const quem = primeiroNome(a.nome) ?? 'um paciente';
  return `⚠️ A Sofia parou de responder no CRM: *${quem}* escreveu há ${tempoPorExtenso(a.minutos)} e ninguém respondeu (${PORQUE[a.desfecho] ?? a.desfecho}). Abra a conversa ${a.conversa} e responda por lá.${a.link ? ` ${a.link}` : ''}${DESFECHOS_DA_UNIDADE.has(a.desfecho) ? ' Se outros pacientes ficaram parados pelo mesmo motivo, eles vêm num resumo em seguida.' : ''}`;
}

export interface ItemDoResumo {
  nome: string | null | undefined;
  minutos: number;
  conversa: number;
  link: string | null;
}

/** O resumo único dos que ficaram para depois (clínica fechada, ou aviso da unidade recente demais): quem ainda espera, com tempo e link. */
export function textoDoResumo(itens: readonly ItemDoResumo[]): string {
  const n = itens.length;
  const lista = itens
    .slice(0, MAX_NO_RESUMO)
    .map((i) => `*${primeiroNome(i.nome) ?? 'um paciente'}* (há ${tempoPorExtenso(i.minutos)}, conversa ${i.conversa}${i.link ? ` ${i.link}` : ''})`)
    .join('; ');
  const resto = n > MAX_NO_RESUMO ? `; e mais ${n - MAX_NO_RESUMO}` : '';
  return `⚠️ A Sofia parou de responder no CRM e ${n === 1 ? '1 paciente segue' : `${n} pacientes seguem`} sem resposta: ${lista}${resto}. Abra ${n === 1 ? 'a conversa' : 'as conversas'} e responda por lá.`;
}

/** Instante (ms) da última mensagem pública do paciente, ou null se a última pública não é dele / não dá para saber. */
export function ultimaDoPacienteEm(mensagens: any[]): number | null {
  // a mensagem de espera do robô de demora («já já alguém te responde») não é resposta de ninguém: não encerra o alerta
  const publicas = mensagens.filter((m) => m?.private !== true && (Number(m?.message_type) === 0 || Number(m?.message_type) === 1) && !ehMensagemDeEspera(m));
  const ultima = publicas.at(-1);
  if (!ultima || Number(ultima.message_type) !== 0) return null;
  const t = Number(ultima.created_at);
  return Number.isFinite(t) && t > 0 ? (t < 1e12 ? t * 1000 : t) : 0;
}

export interface DepsDoVigia {
  /** estado da chave `chatwoot-sofia-parou` */
  estado(slug: string): Estado;
  /** estado da Sofia (chatwoot-ia): só avisa se está LIGADA */
  estadoDaSofia(slug: string): Estado;
  unidade(slug: string): Promise<Unit | null>;
  mensagens(conversa: number): Promise<any[]>;
  conversa(conversa: number): Promise<ConversaLida | null>;
  agora(): number;
  /** o link da conversa no Chatwoot (null = não sabe) */
  link(conversa: number): string | null;
  env?: Partial<NodeJS.ProcessEnv>;
  enviar?: typeof enviarPelaEvolutionComResultado;
  simular?: typeof registrarSimulacao;
}

export type ResultadoDoVigia =
  | 'avisou'
  | 'simulado'
  | 'acumulada'
  | 'desligado'
  | 'sofia-desligada'
  | 'pausada'
  | 'fora-do-horario-da-ia'
  | 'ja-tem-gente'
  | 'respondida'
  | 'recente'
  | 'ja-avisada'
  | 'sem-destino'
  | 'sem-config'
  | 'recusado'
  | 'falhou';

/** Conversa → quando foi avisada (memória do processo). */
const avisadas = new Map<string, number>();
/** `unidade|motivo` → quando a unidade foi avisada por esse motivo (o teto por unidade e motivo; `resumo` é o motivo do resumo). */
const avisadasPorUnidade = new Map<string, number>();
const semDestinoAvisado = new Set<string>();

/** O que ficou para o resumo: a conversa, por que parou, e as portas da conta dela (a varredura relê a conversa por elas). */
interface Pendente {
  slug: string;
  conversa: number;
  desfecho: string;
  deps: DepsDoVigia;
  /** quando entrou na lista */
  desde: number;
  /** só pode entrar num resumo a partir daqui (a janela de 30 min da unidade, quando foi ela que o segurou); 0 = só espera a clínica abrir */
  ate: number;
}
/** quanto tempo um pendente espera antes de ser largado (unidade apagada, destino que nunca veio…): o paciente de ontem já foi atendido ou desistiu */
const VALIDADE_DO_PENDENTE_MS = 24 * 60 * 60_000;
const MAX_PENDENTES = 5000;
let varrendo = false;
const pendentes = new Map<string, Pendente>();
let relogio: NodeJS.Timeout | null = null;
/** de quanto em quanto tempo a varredura vê se alguma unidade com pendentes já abriu */
const VARREDURA_MS = 60_000;

export const esquecerAvisosDoVigia = (): void => {
  avisadas.clear();
  avisadasPorUnidade.clear();
  semDestinoAvisado.clear();
  pendentes.clear();
  if (relogio) clearInterval(relogio);
  relogio = null;
};
/** só para o teste: quantas conversas esperam o resumo (de uma unidade, ou de todas) */
export const pendentesDoVigia = (slug?: string): number => [...pendentes.values()].filter((p) => !slug || p.slug === slug).length;

type Avaliacao = { resultado: ResultadoDoVigia } | { unit: Unit; lida: ConversaLida | null; passou: number };

/**
 * A conversa continua sem resposta e a Sofia ia atendê-la? Só olha (nada de reserva nem envio): é o que o alerta na hora e a varredura do resumo
 * repetem. `resultado` = por que NÃO há o que avisar.
 */
async function avaliar(m: { slug: string; conversa: number }, deps: DepsDoVigia, env: Partial<NodeJS.ProcessEnv>): Promise<Avaliacao> {
  const estado = deps.estado(m.slug);
  if (estado === 'desligado') return { resultado: 'desligado' };
  if (deps.estadoDaSofia(m.slug) !== 'ligado') return { resultado: 'sofia-desligada' };
  const unit = await deps.unidade(m.slug);
  if (!unit) return { resultado: 'falhou' };
  const agora = new Date(deps.agora());
  if (emPausa(unit, agora)) return { resultado: 'pausada' };

  const lida = await deps.conversa(m.conversa);
  // leitura que falhou NÃO é «já tem gente»: o alerta existe justamente para a falha do Chatwoot — segue e avisa sem o nome
  if (!lida) logger.warn({ conversa: m.conversa, unit: m.slug }, `${ID_SOFIA_PAROU}: não consegui ler a conversa — confiro só as mensagens`);
  else if (motivoDeNaoResponder(lida)) return { resultado: 'ja-tem-gente' }; // passada à equipe, IA pausada, interno, tratamento: alguém (ou nada a fazer) já cuida
  const mensagens = await deps.mensagens(m.conversa);
  const desde = ultimaDoPacienteEm(mensagens);
  if (desde === null) return { resultado: 'respondida' }; // a última pública não é do paciente: a Sofia (outra rodada) ou a equipe já respondeu
  const minutos = minutosDoAlerta(env as NodeJS.ProcessEnv);
  const passou = desde ? Math.floor((deps.agora() - desde) / 60_000) : minutos;
  // a Sofia do CRM respeita a janela da IA (#476): fora dela quem atende é a equipe e a rodada do «teto» não deixou ninguém sem resposta que a Sofia fosse responder.
  // A janela vale NO INSTANTE em que o paciente escreveu (a rodada rodou ali), não agora: a falha da noite de Caxias, relida quando a clínica abre, continua sendo da Sofia
  if (foraDoHorarioDaIa(unit, new Date(desde || deps.agora()))) return { resultado: 'fora-do-horario-da-ia' };
  if (passou < minutos) return { resultado: 'recente' }; // o paciente escreveu de novo há pouco: a rodada nova cuida, e o próximo alerta nasce dela
  return { unit, lida, passou };
}

/**
 * Confere AGORA se o paciente segue sem resposta e, se sim, avisa — na hora (horário da equipe e janela da unidade livre) ou deixa para o resumo.
 * Roda `minutos` depois da falha (quem agenda é a porta do chatwoot-ia). Nunca lança.
 */
export async function conferirSofiaParou(m: { slug: string; conversa: number }, desfecho: string, deps: DepsDoVigia): Promise<ResultadoDoVigia> {
  try {
    const env = deps.env ?? process.env;
    const estado = deps.estado(m.slug);
    const a = await avaliar(m, deps, env);
    if ('resultado' in a) return a.resultado;
    const { unit, lida, passou } = a;

    // o «só no papel» tem a sua janela de 2 h: não gasta a do aviso de verdade quando a chave virar «ligado»
    const prefixo = estado === 'seco' ? 'seco|' : '';
    const chave = `${prefixo}${m.slug}|${m.conversa}`;
    const antes = avisadas.get(chave);
    if (antes !== undefined && deps.agora() - antes < ENTRE_AVISOS_MS) return 'ja-avisada';

    const destino = destinoDoAvisoClinica(m.slug, env.AVISO_CLINICA_AGENDAMENTO_DESTINOS);
    if (estado !== 'seco') {
      if (!destino) {
        if (!semDestinoAvisado.has(m.slug)) {
          semDestinoAvisado.add(m.slug);
          logger.warn({ unit: m.slug }, `${ID_SOFIA_PAROU}: ligado, mas a unidade não tem destino em AVISO_CLINICA_AGENDAMENTO_DESTINOS — não mando`);
        }
        return 'sem-destino';
      }
      if (!configDaEvolution(env)) {
        logger.warn({ unit: m.slug }, `${ID_SOFIA_PAROU}: sem AVISO_CLINICA_AGENDAMENTO_EVOLUTION_URL/HEADER/VALUE — não mando`);
        return 'sem-config';
      }
    }

    // NA HORA só dentro do horário da equipe e com a janela da unidade livre; senão fica para o resumo (não se perde, nem vira N WhatsApps)
    const chaveDaUnidade = `${prefixo}${m.slug}|${desfecho}`;
    const daUnidade = avisadasPorUnidade.get(chaveDaUnidade);
    const unidadeRecente = daUnidade !== undefined && deps.agora() - daUnidade < ENTRE_AVISOS_DA_UNIDADE_MS;
    if (!dentroDoHorario(unit, new Date(deps.agora())) || unidadeRecente) {
      if (pendentes.size >= MAX_PENDENTES) for (const k of [...pendentes.keys()].slice(0, MAX_PENDENTES / 5)) pendentes.delete(k);
      pendentes.set(`${prefixo}${m.slug}|${m.conversa}`, { slug: m.slug, conversa: m.conversa, desfecho, deps, desde: deps.agora(), ate: unidadeRecente ? daUnidade! + ENTRE_AVISOS_DA_UNIDADE_MS : 0 });
      agendarVarredura();
      logger.info({ unit: m.slug, conversa: m.conversa, desfecho, motivo: unidadeRecente ? 'a unidade já foi avisada por este motivo há menos de 30 min' : 'fora do horário da equipe' }, `${ID_SOFIA_PAROU}: aviso fica para o resumo`);
      return 'acumulada';
    }

    const texto = textoDoAviso({ nome: nomeDeGente(lida?.nome), minutos: passou, desfecho, conversa: m.conversa, link: deps.link(m.conversa) });
    const r = await enviarOuSimular({ unit, slug: m.slug, conversas: [m.conversa], texto, estado, destino, deps, env, chaves: [chave, chaveDaUnidade] });
    if (r === 'avisou' || r === 'simulado') pendentes.delete(`${prefixo}${m.slug}|${m.conversa}`);
    if (r === 'avisou') logger.info({ unit: m.slug, conversa: m.conversa, desfecho }, `${ID_SOFIA_PAROU}: aviso enviado`);
    return r;
  } catch (err) {
    logger.warn({ err: String(err), conversa: m.conversa }, `${ID_SOFIA_PAROU}: não consegui conferir`);
    return 'falhou';
  }
}

/**
 * Reserva as janelas (conversa e unidade) ANTES de mandar — duas conferências da mesma coisa não avisam duas vezes — e manda; se a Evolution recusar, libera.
 * Em «só no papel» só anota «alertaria» para cada conversa. Síncrono até o `await` do envio: quem checa a janela e reserva não deixa brecha.
 */
async function enviarOuSimular(a: {
  unit: Unit;
  slug: string;
  conversas: number[];
  texto: string;
  estado: Estado;
  destino: string | null;
  deps: DepsDoVigia;
  env: Partial<NodeJS.ProcessEnv>;
  /** a primeira é a da conversa (ou de cada conversa do resumo, em `chavesPorConversa`); as demais, da unidade */
  chaves: string[];
}): Promise<'avisou' | 'simulado' | 'recusado'> {
  const agora = a.deps.agora();
  if (a.estado === 'seco') {
    for (const c of a.conversas) {
      (a.deps.simular ?? registrarSimulacao)(a.unit, ID_SOFIA_PAROU, {
        leadId: leadDaConversaChatwoot(c),
        acao: 'alertaria',
        alvo: 'sofia-parou',
        valor: a.texto,
        motivo: a.destino ? `para ${a.destino}` : 'SEM destino configurado (AVISO_CLINICA_AGENDAMENTO_DESTINOS): ligado, não sairia',
      });
    }
    marcar(a.chaves, a.conversas, a.estado, a.slug, agora);
    return 'simulado';
  }
  const cfg = configDaEvolution(a.env)!;
  if (avisadas.size > 5000) avisadas.clear(); // antes de reservar: não apaga a reserva desta própria conversa
  marcar(a.chaves, a.conversas, a.estado, a.slug, agora);
  const r = await (a.deps.enviar ?? enviarPelaEvolutionComResultado)({ ...cfg, numero: a.destino!, texto: a.texto });
  if (r === 'recusado') {
    desmarcar(a.chaves, a.conversas, a.estado, a.slug);
    logger.warn({ unit: a.slug, conversas: a.conversas }, `${ID_SOFIA_PAROU}: a Evolution recusou o aviso`);
    return 'recusado';
  }
  return 'avisou';
}

/** `chaves`: [chave da conversa, chave da unidade]; no resumo a chave da conversa vem de cada `conversas`. */
function marcar(chaves: string[], conversas: number[], estado: Estado, slug: string, agora: number): void {
  const prefixo = estado === 'seco' ? 'seco|' : '';
  for (const c of conversas) avisadas.set(`${prefixo}${slug}|${c}`, agora);
  for (const k of chaves.slice(1)) avisadasPorUnidade.set(k, agora);
}
function desmarcar(chaves: string[], conversas: number[], estado: Estado, slug: string): void {
  const prefixo = estado === 'seco' ? 'seco|' : '';
  for (const c of conversas) avisadas.delete(`${prefixo}${slug}|${c}`);
  for (const k of chaves.slice(1)) avisadasPorUnidade.delete(k);
}

/**
 * Manda o RESUMO de cada unidade que tem pendentes e já pode avisar (clínica aberta e janela da unidade livre): UM WhatsApp com quem AINDA está sem resposta
 * (relido agora; quem a equipe atendeu sai). Um pendente só sai da lista quando entrou no resumo enviado, quando foi atendido, ou quando passou de 24 h:
 * erro ao reler uma conversa, falta de destino ou Evolution recusando NÃO o perdem. Devolve quantos resumos saíram (ou foram anotados no «só no papel»).
 * Nunca lança, e duas varreduras não andam ao mesmo tempo.
 */
export async function descarregarPendentes(): Promise<number> {
  if (varrendo) return 0;
  varrendo = true;
  try {
    let resumos = 0;
    const porUnidade = new Map<string, Array<[string, Pendente]>>();
    for (const [k, p] of pendentes) {
      const g = p.slug + (k.startsWith('seco|') ? '|seco' : '');
      porUnidade.set(g, [...(porUnidade.get(g) ?? []), [k, p]]);
    }
    for (const itens of porUnidade.values()) {
      try {
        const { slug, deps } = itens[0]![1];
        const env = deps.env ?? process.env;
        const estado = deps.estado(slug);
        const agora = deps.agora();
        for (const [k, p] of itens) if (estado === 'desligado' || agora - p.desde > VALIDADE_DO_PENDENTE_MS) pendentes.delete(k);
        if (estado === 'desligado') continue;
        const unit = await deps.unidade(slug);
        if (!unit) continue;
        // ainda fechada: espera abrir
        if (!dentroDoHorario(unit, new Date(agora))) continue;
        const prefixo = estado === 'seco' ? 'seco|' : '';
        const chaveDoResumo = `${prefixo}${slug}|resumo`;
        const ultimo = avisadasPorUnidade.get(chaveDoResumo);
        if (ultimo !== undefined && agora - ultimo < ENTRE_AVISOS_DA_UNIDADE_MS) continue; // o resumo anterior é recente: o próximo espera a janela
        const aindaEsperam: ItemDoResumo[] = [];
        const chavesDoResumo: string[] = [];
        for (const [k, p] of itens) {
          if (!pendentes.has(k) || agora < p.ate) continue; // já saiu da lista, ou a janela da unidade que o segurou ainda não acabou
          try {
            const av = await avaliar({ slug, conversa: p.conversa }, p.deps, env);
            if ('resultado' in av) {
              // atendido, respondido, pausado… (o que não é «tente de novo»): sai; leitura que falhou ou unidade que sumiu fica para a próxima
              if (av.resultado !== 'falhou') pendentes.delete(k);
              continue;
            }
            const aviso = avisadas.get(`${prefixo}${slug}|${p.conversa}`);
            if (aviso !== undefined && agora - aviso < ENTRE_AVISOS_MS) {
              pendentes.delete(k);
              continue;
            }
            aindaEsperam.push({ nome: nomeDeGente(av.lida?.nome), minutos: av.passou, conversa: p.conversa, link: p.deps.link(p.conversa) });
            chavesDoResumo.push(k);
          } catch (err) {
            logger.warn({ err: String(err), conversa: p.conversa }, `${ID_SOFIA_PAROU}: não consegui reler a conversa para o resumo — fica para a próxima varredura`);
          }
        }
        if (!aindaEsperam.length) continue;
        const destino = destinoDoAvisoClinica(slug, env.AVISO_CLINICA_AGENDAMENTO_DESTINOS);
        if (estado !== 'seco' && (!destino || !configDaEvolution(env))) {
          if (!semDestinoAvisado.has(slug)) {
            semDestinoAvisado.add(slug);
            logger.warn({ unit: slug }, `${ID_SOFIA_PAROU}: o resumo não tem destino/instância — não mando (os pendentes ficam por até 24 h)`);
          }
          continue;
        }
        aindaEsperam.sort((x, y) => y.minutos - x.minutos);
        const r = await enviarOuSimular({ unit, slug, conversas: aindaEsperam.map((i) => i.conversa), texto: textoDoResumo(aindaEsperam), estado, destino, deps, env, chaves: ['resumo', chaveDoResumo] });
        if (r !== 'recusado') {
          resumos++;
          for (const k of chavesDoResumo) pendentes.delete(k);
        }
      } catch (err) {
        logger.warn({ err: String(err) }, `${ID_SOFIA_PAROU}: não consegui montar o resumo`);
      }
    }
    return resumos;
  } finally {
    varrendo = false;
  }
}

/** liga (uma vez) o relógio que vê, de minuto em minuto, se alguma unidade com pendentes já abriu; ele mesmo se desliga quando não há mais nada */
function agendarVarredura(): void {
  if (relogio) return;
  relogio = setInterval(() => {
    void descarregarPendentes().finally(() => {
      if (pendentes.size === 0 && relogio) {
        clearInterval(relogio);
        relogio = null;
      }
    });
  }, VARREDURA_MS);
  relogio.unref();
}

// ── retomada no boot: a lista de pendentes reconstruída do Registro ──────────────────────────────────

/** o que a retomada precisa de uma linha do Registro (`sofia_evento`) */
export interface EventoDoRegistro {
  unitSlug: string;
  conversa: number;
  tipo: string;
  nome: string | null;
  criadoEm: Date;
}
/** quanto para trás a retomada olha: o aviso é de hoje; o paciente de anteontem já foi atendido ou desistiu (e o pendente vale 24 h) */
export const JANELA_DA_RETOMADA_MS = VALIDADE_DO_PENDENTE_MS;
/** quantas conversas são rearmadas de uma vez, e quanto tempo separa um lote do outro (o servidor acabou de subir: sem rajada de leituras no Chatwoot) */
export const LOTE_DA_RETOMADA = 20;
export const ENTRE_LOTES_DA_RETOMADA_MS = 3_000;

/**
 * Quem a Sofia deixou parado, segundo o Registro: o ÚLTIMO evento de cada (unidade, conversa) — de qualquer tipo, para que uma rodada que marcou, passou para a equipe ou
 * mandou o Pix depois da falha a tire da lista — e só se esse último evento é uma decisão de falha/teto/sem-texto/Kommo-indisponível.
 */
export function paradosDoRegistro(eventos: readonly EventoDoRegistro[]): Array<{ slug: string; conversa: number; desfecho: string; em: number }> {
  const ultimo = new Map<string, EventoDoRegistro>();
  for (const e of [...eventos].sort((a, b) => a.criadoEm.getTime() - b.criadoEm.getTime())) ultimo.set(`${e.unitSlug}|${e.conversa}`, e);
  return [...ultimo.values()]
    .filter((e) => e.tipo === 'decisao' && !!e.nome && DESFECHOS_QUE_PARAM.has(e.nome))
    .map((e) => ({ slug: e.unitSlug, conversa: e.conversa, desfecho: e.nome!, em: e.criadoEm.getTime() }));
}

/**
 * Ao subir o servidor (um deploy a cada ~55 min perde a lista em memória): relê o Registro das últimas 24 h e REARMA a vigia de cada conversa que ficou parada, esperando só o
 * que faltava dos N minutos — quem já passou do prazo é conferido já, em lotes escalonados. Sem tabela nova. Devolve quantas conversas foram rearmadas. Nunca lança.
 */
export async function retomarDoRegistro(d: {
  eventos(desde: Date): Promise<EventoDoRegistro[]>;
  armar(p: { slug: string; conversa: number; desfecho: string }, esperaMs: number): void | Promise<void>;
  agora(): number;
  env?: Partial<NodeJS.ProcessEnv>;
}): Promise<number> {
  try {
    const agora = d.agora();
    const minutosMs = minutosDoAlerta((d.env ?? process.env) as NodeJS.ProcessEnv) * 60_000;
    const parados = paradosDoRegistro(await d.eventos(new Date(agora - JANELA_DA_RETOMADA_MS))).filter((p) => agora - p.em <= JANELA_DA_RETOMADA_MS);
    parados.sort((a, b) => a.em - b.em);
    let n = 0;
    let vencidas = 0;
    for (const p of parados) {
      try {
        // quem ainda tem prazo espera só o que falta; quem JÁ venceu entra em lotes (a mais antiga primeiro), para o boot não virar uma rajada de leituras no Chatwoot
        const falta = Math.max(0, minutosMs - (agora - p.em));
        await d.armar(p, falta > 0 ? falta : Math.floor(vencidas++ / LOTE_DA_RETOMADA) * ENTRE_LOTES_DA_RETOMADA_MS);
        n++;
      } catch (err) {
        logger.warn({ err: String(err), conversa: p.conversa }, `${ID_SOFIA_PAROU}: não consegui rearmar a vigia no boot`);
      }
    }
    if (n) logger.info({ rearmadas: n }, `${ID_SOFIA_PAROU}: vigia rearmada a partir do Registro`);
    return n;
  } catch (err) {
    logger.warn({ err: String(err) }, `${ID_SOFIA_PAROU}: não consegui reconstruir a lista a partir do Registro`);
    return 0;
  }
}

/** A chave desta unidade (catálogo). */
export const estadoDoAlerta = (slug: string, env: NodeJS.ProcessEnv = process.env): Estado => estadoDaAutomacao(slug, ID_SOFIA_PAROU, env.CHATWOOT_SOFIA_PAROU_SLUGS);
