/**
 * O CICLO do worker `crm-demora` (a cada ~1 min): quem está esperando a equipe responder e o que fazer por isso.
 * Aqui só há decisão e a ordem das coisas; banco, Chatwoot e WhatsApp entram pelas portas (o teste troca todas, o worker de verdade as liga em
 * `crm-demora-worker.ts`). As regras puras estão em `regras.ts` (e o porquê de não usar o `waiting_since` do Chatwoot).
 *
 * Três passos, cada um no máximo UMA vez por episódio de espera (até a equipe responder):
 *  - 5 min  → mensagem de espera ao PACIENTE (1× por conversa por dia; nunca com a Sofia atendendo ou prestes a responder);
 *  - 10 min → WhatsApp para quem está com a conversa (sem dono ou sem número: a gerente) + nota com @menção no CRM;
 *  - 30 min → WhatsApp para a gerente.
 *
 * As travas que importam:
 *  - SECO (de fábrica em toda conta): decide tudo (lê a conversa, confere SAIR e a janela) mas NÃO escreve em lugar nenhum — nem no paciente, nem no
 *    CRM, nem no WhatsApp de ninguém. Só grava a linha «mandaria…» no banco (regra com sufixo `~seco`, para o ligado nascer limpo).
 *  - Uma vez só: a linha de `chatwoot_regua_disparo` (UNIQUE caixa+conversa+regra+chave) é GRAVADA ANTES de agir. Duas cópias do servidor, um
 *    reinício ou o ciclo seguinte nunca repetem. Erro sem resposta do CRM (pode ter ido) NÃO desfaz; recusa (4xx) desfaz.
 *  - Antes de agir, a conversa e as mensagens são RELIDAS (a equipe pode ter respondido no meio-tempo).
 *  - Teto de saídas por ciclo; só 8h–20h da unidade; passo atrasado demais (servidor parado) não sai.
 */
import { logger } from '../logger.js';
import type { Estado } from '../automacoes-estado.js';
import type { ContextoChatwoot } from '../../mcp-remoto/chatwoot.js';
import { conversaLidaDoChatwoot } from '../chatwoot-porta.js';
import { USUARIO_ROBO } from '../chatwoot-pausa.js';
import { ETIQUETA_HUMANO } from '../chatwoot-sofia.js';
import { janelaDeEnvio, nomeCurto, notaComMencao } from '../crm-tarefas/regras.js';
import { primeiroNomeSeguro } from '../disparo/regras.js';
import { ehMensagemDeEspera, textoDaEspera } from './marca.js';
import { chaveDoEpisodio, decidirDemora, diaNoFuso, duracaoCurta, esperaDaEquipe, mensagensDaConversa, type EsperaDaEquipe, type Passo } from './regras.js';

export const ID_CICLO = 'crm-demora';
/** Tudo o que SAI do servidor (mensagem ao paciente, nota no CRM, WhatsApp) conta 1; se um defeito soltar tudo, vaza só isto por ciclo. */
export const MAX_SAIDAS_POR_CICLO = 12;
/** Conversas com atividade até este tempo atrás entram na leitura (o maior prazo de um passo + folga). */
export const JANELA_DE_LEITURA_MS = 200 * 60_000;
export const SUFIXO_SECO = '~seco';


export interface UnidadeDaDemora {
  slug: string;
  nome: string;
  fuso: string;
  modo: Estado;
  /** a Sofia está LIGADA nesta unidade (`chatwoot-ia`) */
  iaLigada: boolean;
  /** o Chatwoot da CONTA da unidade (null = sem conta/token válidos) */
  ctx: ContextoChatwoot | null;
  caixas: Array<{ id: number; oficial: boolean; gerente: number | null }>;
}

export interface Armazem {
  /** false = já existia (outra cópia do servidor ou ciclo anterior) */
  registrar(l: { caixa: number; conversationId: number; regra: string; chave: string; modo: string; texto: string }): Promise<boolean>;
  desfazer(l: { caixa: number; conversationId: number; regra: string; chave: string }): Promise<void>;
  /** o WhatsApp de uma atendente (`crm_tarefa_zap`); null = não cadastrado */
  numeroDoAgente(conta: number, agenteId: number): Promise<{ telefone: string; nome: string } | null>;
}

export interface MundoDaDemora {
  unidades(): Promise<UnidadeDaDemora[]>;
  /** conversas ABERTAS/PENDENTES da caixa com atividade a partir de `desdeSeg` (segundos), cruas, da mais nova para a mais velha */
  listar(ctx: ContextoChatwoot, caixa: number, desdeSeg: number): Promise<any[]>;
  conversa(ctx: ContextoChatwoot, id: number): Promise<any>;
  /** as mensagens mais novas, em ordem crescente */
  mensagens(ctx: ContextoChatwoot, id: number): Promise<any[]>;
  /** o id do usuário «conector» DESTA conta (por onde saem a régua, as tarefas e a mensagem de espera): sua fala é do robô, não da equipe. null = não deu para saber. */
  conector?(ctx: ContextoChatwoot): Promise<number | null>;
  /** o paciente pediu SAIR? (data do pedido; null = não). Lança se não deu para conferir. */
  pediuSair(ctx: ContextoChatwoot, conversaId: number, contatoId: number | null): Promise<Date | null>;
  /** a mensagem PÚBLICA de espera ao paciente (pelo robô da Sofia quando ele existe nesta conta; senão pelo conector) */
  mandarEspera(u: UnidadeDaDemora, ctx: ContextoChatwoot, conversaId: number, texto: string): Promise<{ id: number | null }>;
  nota(ctx: ContextoChatwoot, conversaId: number, texto: string): Promise<void>;
  zap(numero: string, texto: string): Promise<boolean>;
  agora(): Date;
  pausa(ms: number): Promise<void>;
  env?: NodeJS.ProcessEnv;
}

/** O que o servidor lembra entre ciclos (só otimização: a verdade é a linha do banco). */
export interface MemoriaDaDemora {
  /** conversa → a espera calculada para a «assinatura» das mensagens (não relê as mensagens a cada minuto) */
  esperas: Map<string, { assinatura: string; espera: EsperaDaEquipe | null }>;
  /** `caixa|conversa|regra|chave` que este processo já tratou (registrou, barrou ou viu registrado): não relê a conversa por isso */
  tratados: Set<string>;
  /** `caixa|conversa|regra|chave` → só tenta de novo depois deste instante (WhatsApp que falhou, ninguém a avisar): não gasta o teto do ciclo nem relê a conversa a cada minuto */
  adiados: Map<string, number>;
  /** conta → id do conector (só guarda o que deu certo) */
  conectores: Map<number, number>;
}
export const novaMemoriaDaDemora = (): MemoriaDaDemora => ({ esperas: new Map(), tratados: new Set(), adiados: new Map(), conectores: new Map() });
/** Depois de uma falha (ou de «sem ninguém a avisar»), espera isto para tentar de novo. */
export const ESPERA_ENTRE_TENTATIVAS_MS = 5 * 60_000;
const LIMITE_DA_MEMORIA = 20_000;

export interface ResumoDaDemora {
  unidades: number;
  lidas: number;
  esperando: number;
  /** passos devidos que sairiam/saíram (por passo) */
  devidos: Record<Passo, number>;
  /** passos que o SECO só anotou */
  simulados: Record<Passo, number>;
  /** passos que SAÍRAM (ligado) */
  feitos: Record<Passo, number>;
  barrados: Record<string, number>;
  saidas: number;
  falhas: number;
  noTeto: number;
}
const zeros = (): Record<Passo, number> => ({ espera: 0, 'aviso-10': 0, 'aviso-30': 0 });
const resumoVazio = (): ResumoDaDemora => ({ unidades: 0, lidas: 0, esperando: 0, devidos: zeros(), simulados: zeros(), feitos: zeros(), barrados: {}, saidas: 0, falhas: 0, noTeto: 0 });

const statusDoErro = (e: unknown): number | undefined => {
  const s = (e as { status?: number } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};
const msgDoErro = (e: unknown): string => String(e instanceof Error ? e.message : e).slice(0, 200);
const contar = (r: Record<string, number>, k: string) => void (r[k] = (r[k] ?? 0) + 1);

interface Alvo {
  u: UnidadeDaDemora;
  ctx: ContextoChatwoot;
  conta: number;
  caixa: UnidadeDaDemora['caixas'][number];
  /** ids de usuário do Chatwoot que são o robô nesta conta (o conector) */
  robos: ReadonlySet<number>;
}

interface Estado1 {
  raw: any;
  lida: NonNullable<ReturnType<typeof conversaLidaDoChatwoot>>;
  status: string;
  espera: EsperaDaEquipe | null;
  mensagens: any[];
}

function lerConversa(raw: any, mensagens: any[], robos: ReadonlySet<number>): Estado1 | null {
  const lida = conversaLidaDoChatwoot(raw);
  if (!lida) return null;
  const esperandoHumano = lida.etiquetas.includes(ETIQUETA_HUMANO) || String(lida.attrs.etapa ?? '').trim() === 'Esperando humano';
  return { raw, lida, status: String(raw?.status ?? ''), mensagens, espera: esperaDaEquipe(mensagensDaConversa(mensagens, robos), { esperandoHumano }) };
}

const assinatura = (raw: any): string =>
  [raw?.last_non_activity_message?.id ?? '', raw?.status ?? '', [...(Array.isArray(raw?.labels) ? raw.labels : [])].map(String).sort().join(','), raw?.custom_attributes?.etapa ?? ''].join('|');

const linkDaConversa = (a: Alvo, id: number): string => (a.ctx.conta ? `${a.ctx.conta.url}/app/accounts/${a.conta}/conversations/${id}` : '');

/** O responsável pela conversa (o conector e o robô nunca são «quem atende»). */
function responsavelDe(raw: any, robos: ReadonlySet<number>): { id: number; nome: string } | null {
  const id = Number(raw?.meta?.assignee?.id);
  if (!Number.isInteger(id) || id <= 0 || id === USUARIO_ROBO || robos.has(id)) return null;
  return { id, nome: String(raw?.meta?.assignee?.name ?? '').trim() || 'atendente' };
}

interface Ctx {
  deps: { armazem: Armazem; mundo: MundoDaDemora; memoria: MemoriaDaDemora };
  resumo: ResumoDaDemora;
  agora: Date;
}

const cabe = (c: Ctx, custo: number) => c.resumo.saidas + custo <= MAX_SAIDAS_POR_CICLO;

/** As linhas do banco: uma por passo e, no aviso de 10 min, uma a mais para a nota (WhatsApp que falha repete sozinho; a nota que já saiu não). */
export type RegraBase = 'demora-espera' | 'demora-aviso-10' | 'demora-aviso-10-nota' | 'demora-aviso-30';
const nomeDaRegra = (a: Alvo, base: RegraBase): string => `${base}${a.u.modo === 'seco' ? SUFIXO_SECO : ''}`;
const chaveDaMemoria = (a: Alvo, id: number, base: RegraBase, chave: string): string => `${a.caixa.id}|${id}|${nomeDaRegra(a, base)}|${chave}`;

/** Registra ANTES de agir. true = esta cópia é quem age. */
async function registrar(c: Ctx, a: Alvo, conversationId: number, base: RegraBase, chave: string, texto: string): Promise<boolean> {
  const novo = await c.deps.armazem.registrar({ caixa: a.caixa.id, conversationId, regra: nomeDaRegra(a, base), chave, modo: a.u.modo, texto: texto.slice(0, 1000) });
  if (c.deps.memoria.tratados.size > LIMITE_DA_MEMORIA) c.deps.memoria.tratados.clear();
  c.deps.memoria.tratados.add(chaveDaMemoria(a, conversationId, base, chave));
  return novo;
}

const jaTratado = (c: Ctx, a: Alvo, conversationId: number, base: RegraBase, chave: string): boolean => c.deps.memoria.tratados.has(chaveDaMemoria(a, conversationId, base, chave));
const marcarTratado = (c: Ctx, a: Alvo, conversationId: number, base: RegraBase, chave: string): void => void c.deps.memoria.tratados.add(chaveDaMemoria(a, conversationId, base, chave));

async function desfazer(c: Ctx, a: Alvo, conversationId: number, base: RegraBase, chave: string): Promise<void> {
  await c.deps.armazem.desfazer({ caixa: a.caixa.id, conversationId, regra: nomeDaRegra(a, base), chave }).catch(() => undefined);
  c.deps.memoria.tratados.delete(chaveDaMemoria(a, conversationId, base, chave));
}

const agoraMs = (c: Ctx): number => c.deps.mundo.agora().getTime();
const adiado = (c: Ctx, a: Alvo, id: number, base: RegraBase, chave: string): boolean => (c.deps.memoria.adiados.get(chaveDaMemoria(a, id, base, chave)) ?? 0) > agoraMs(c);
function adiar(c: Ctx, a: Alvo, id: number, base: RegraBase, chave: string): void {
  const m = c.deps.memoria;
  if (m.adiados.size > LIMITE_DA_MEMORIA) m.adiados.clear();
  m.adiados.set(chaveDaMemoria(a, id, base, chave), agoraMs(c) + ESPERA_ENTRE_TENTATIVAS_MS);
}
/** Quem já foi tratado ou está esperando a hora de tentar de novo. */
const resolvido = (c: Ctx, a: Alvo, id: number, base: RegraBase, chave: string): boolean => jaTratado(c, a, id, base, chave) || adiado(c, a, id, base, chave);

/** O passo já foi tratado por este processo (registrado, barrado ou visto registrado)? O aviso de 10 min só está tratado com o WhatsApp E a nota (no seco, a linha única). */
function passoTratado(c: Ctx, a: Alvo, id: number, passo: Passo, chaveEp: string, dia: string): boolean {
  if (passo === 'espera') return resolvido(c, a, id, 'demora-espera', dia);
  if (passo === 'aviso-30') return resolvido(c, a, id, 'demora-aviso-30', chaveEp);
  return resolvido(c, a, id, 'demora-aviso-10', chaveEp) && (a.u.modo === 'seco' || resolvido(c, a, id, 'demora-aviso-10-nota', chaveEp));
}

/** Os usuários que são o robô nesta conta: o 2 de sempre e o conector que o Chatwoot disser (uma clínica de conta própria tem outro id). */
async function robosDaConta(deps: { mundo: MundoDaDemora; memoria: MemoriaDaDemora }, ctx: ContextoChatwoot): Promise<ReadonlySet<number>> {
  const conta = ctx.conta?.conta;
  const robos = new Set<number>([USUARIO_ROBO]);
  if (!conta || !deps.mundo.conector) return robos;
  let id = deps.memoria.conectores.get(conta);
  if (id === undefined) {
    id = (await deps.mundo.conector(ctx).catch(() => null)) ?? undefined;
    if (id !== undefined) deps.memoria.conectores.set(conta, id);
  }
  if (id !== undefined) robos.add(id);
  return robos;
}

// ── os três passos ───────────────────────────────────────────────────────────────────────────────

async function passoEspera(c: Ctx, a: Alvo, e: Estado1, minutos: number): Promise<void> {
  const { mundo } = c.deps;
  const { u } = a;
  const id = e.lida.id;
  const dia = diaNoFuso(c.agora, u.fuso);
  if (jaTratado(c, a, id, 'demora-espera', dia)) return;
  // já há uma mensagem de espera NOSSA hoje na conversa (o banco pode ter perdido a linha): 1× por dia
  if (e.mensagens.some((m) => ehMensagemDeEspera(m) && diaNoFuso(new Date(Number(m.created_at) * 1000), u.fuso) === dia)) {
    marcarTratado(c, a, id, 'demora-espera', dia);
    contar(c.resumo.barrados, 'espera: já mandou hoje');
    return;
  }
  const contatoId = Number(e.raw?.meta?.sender?.id);
  try {
    const sair = await mundo.pediuSair(a.ctx, id, Number.isInteger(contatoId) && contatoId > 0 ? contatoId : null);
    if (sair) {
      marcarTratado(c, a, id, 'demora-espera', dia);
      contar(c.resumo.barrados, 'espera: o paciente pediu SAIR');
      return;
    }
  } catch (err) {
    contar(c.resumo.barrados, 'espera: não deu para conferir SAIR');
    logger.warn({ unit: u.slug, conversa: id, err: msgDoErro(err) }, `${ID_CICLO}: não consegui conferir SAIR — não mando agora`);
    adiar(c, a, id, 'demora-espera', dia);
    return;
  }
  const texto = textoDaEspera(primeiroNomeSeguro(e.lida.nome));
  if (u.modo === 'ligado' && !cabe(c, 1)) {
    c.resumo.noTeto++;
    return;
  }
  if (!(await registrar(c, a, id, 'demora-espera', dia, u.modo === 'seco' ? `mandaria ao paciente (espera há ${duracaoCurta(minutos)}): ${texto}` : texto))) return;
  c.resumo.devidos.espera++;
  if (u.modo === 'seco') {
    c.resumo.simulados.espera++;
    logger.info({ unit: u.slug, conversa: id, minutos }, `${ID_CICLO}: SECO — mandaria a mensagem de espera ao paciente (nada foi enviado)`);
    return;
  }
  try {
    c.resumo.saidas++; // conta ao tentar: sem resposta do CRM, pode ter saído
    await mundo.mandarEspera(u, a.ctx, id, texto);
    c.resumo.feitos.espera++;
    logger.info({ unit: u.slug, conversa: id, minutos }, `${ID_CICLO}: mensagem de espera enviada ao paciente`);
  } catch (err) {
    c.resumo.falhas++;
    const status = statusDoErro(err);
    if (status !== undefined && status >= 400 && status < 500) {
      await desfazer(c, a, id, 'demora-espera', dia);
      adiar(c, a, id, 'demora-espera', dia); // recusa do CRM: não insiste a cada minuto
    }
    logger.warn({ unit: u.slug, conversa: id, status, err: msgDoErro(err) }, `${ID_CICLO}: não consegui mandar a mensagem de espera`);
  }
}

interface Destino {
  numero: string | null;
  agente: { id: number; nome: string } | null;
}

async function destinoDaGerente(c: Ctx, a: Alvo): Promise<Destino> {
  const id = a.caixa.gerente;
  if (!id) return { numero: null, agente: null };
  const z = await c.deps.armazem.numeroDoAgente(a.conta, id);
  return { numero: z?.telefone ?? null, agente: { id, nome: z?.nome ?? 'gerente' } };
}

const textoDoAviso = (a: Alvo, nome: string, minutos: number, id: number, extra = ''): string => {
  const link = linkDaConversa(a, id);
  return `Doutor Digital · ${a.u.nome}\n⏰ ${nome} está esperando resposta há ${duracaoCurta(minutos)}${extra}${link ? `\n${link}` : ''}`;
};

/**
 * `numeroDo30`: o número que o aviso de 30 min vai usar NESTE ciclo (os dois passos vencidos juntos, p.ex. depois de uma janela de horário). Se for o
 * mesmo do 10 min, o WhatsApp sai uma vez só (o de 30 min); a nota com menção sai do mesmo jeito.
 * Ligado, a nota e o WhatsApp têm cada um a sua linha no banco: o WhatsApp que falha tenta de novo no ciclo seguinte sem repetir a nota que já saiu,
 * e sem ninguém a avisar (nem responsável, nem número) nada é registrado — se o cadastro sair ainda dentro do prazo, o aviso sai.
 */
async function passoAviso10(c: Ctx, a: Alvo, e: Estado1, minutos: number, numeroDo30: string | null): Promise<void> {
  const { mundo, armazem } = c.deps;
  const { u } = a;
  const id = e.lida.id;
  const chave = chaveDoEpisodio(e.espera!.desde);
  const dono = responsavelDe(e.raw, a.robos);
  const donoZap = dono ? await armazem.numeroDoAgente(a.conta, dono.id) : null;
  const gerente = !dono || !donoZap ? await destinoDaGerente(c, a) : null;
  const numero = donoZap?.telefone ?? gerente?.numero ?? null;
  // a nota com @menção (o sininho): quem está com a conversa; sem dono, a gerente
  const mencionado = dono ?? gerente?.agente ?? null;
  const nome = nomeCurto(e.lida.nome || e.lida.telefone || '');
  const pularZap = numero !== null && numero === numeroDo30;
  if (u.modo === 'seco') {
    const descricao = `${mencionado ? `nota com @${mencionado.nome.split(/\s+/)[0]}` : 'sem a quem mencionar'} · WhatsApp ${numero ? `para ${donoZap ? 'o responsável' : 'a gerente'}${pularZap ? ' (junto com o de 30 min)' : ''}` : 'NÃO (sem número cadastrado)'}`;
    if (!(await registrar(c, a, id, 'demora-aviso-10', chave, `mandaria (há ${duracaoCurta(minutos)}): ${descricao}`))) return;
    c.resumo.devidos['aviso-10']++;
    c.resumo.simulados['aviso-10']++;
    logger.info({ unit: u.slug, conversa: id, minutos, descricao }, `${ID_CICLO}: SECO — mandaria o aviso de 10 min (nada foi enviado)`);
    return;
  }
  if (!mencionado && !numero) {
    contar(c.resumo.barrados, 'aviso-10: sem ninguém a avisar (sem responsável e sem número da gerente)');
    adiar(c, a, id, 'demora-aviso-10', chave);
    adiar(c, a, id, 'demora-aviso-10-nota', chave);
    return;
  }
  let saiu = false;
  if (mencionado && !jaTratado(c, a, id, 'demora-aviso-10-nota', chave)) {
    if (!cabe(c, 1)) c.resumo.noTeto++;
    else if (await registrar(c, a, id, 'demora-aviso-10-nota', chave, `nota com @${mencionado.nome.split(/\s+/)[0]}`)) {
      c.resumo.saidas++;
      try {
        await mundo.nota(a.ctx, id, notaComMencao(mencionado, `⏰ ${nome} está esperando resposta há ${duracaoCurta(minutos)}. Responda agora.`));
        saiu = true;
      } catch (err) {
        c.resumo.falhas++;
        if (statusDoErro(err) !== undefined && statusDoErro(err)! >= 400 && statusDoErro(err)! < 500) {
          await desfazer(c, a, id, 'demora-aviso-10-nota', chave);
          adiar(c, a, id, 'demora-aviso-10-nota', chave);
        }
        logger.warn({ unit: u.slug, conversa: id, err: msgDoErro(err) }, `${ID_CICLO}: não consegui deixar a nota com menção`);
      }
    }
  }
  if (numero && !jaTratado(c, a, id, 'demora-aviso-10', chave)) {
    if (!cabe(c, 1)) c.resumo.noTeto++;
    else if (await registrar(c, a, id, 'demora-aviso-10', chave, pularZap ? 'WhatsApp junto com o aviso de 30 min' : `WhatsApp para ${donoZap ? 'o responsável' : 'a gerente'}`)) {
      if (pularZap) {
        // o WhatsApp deste número sai no aviso de 30 min (mesmo destino): aqui só fica a linha dizendo isso, sem contar como enviado
      } else {
        c.resumo.saidas++;
        if (await mundo.zap(numero, textoDoAviso(a, nome, minutos, id))) saiu = true;
        else {
          c.resumo.falhas++;
          await desfazer(c, a, id, 'demora-aviso-10', chave); // não saiu: tenta de novo daqui a pouco
          adiar(c, a, id, 'demora-aviso-10', chave);
        }
      }
    }
  }
  if (saiu) {
    c.resumo.devidos['aviso-10']++;
    c.resumo.feitos['aviso-10']++;
  }
}

async function passoAviso30(c: Ctx, a: Alvo, e: Estado1, minutos: number): Promise<void> {
  const { mundo } = c.deps;
  const { u } = a;
  const id = e.lida.id;
  const chave = chaveDoEpisodio(e.espera!.desde);
  if (jaTratado(c, a, id, 'demora-aviso-30', chave)) return;
  const gerente = await destinoDaGerente(c, a);
  const dono = responsavelDe(e.raw, a.robos);
  const nome = nomeCurto(e.lida.nome || e.lida.telefone || '');
  const texto = textoDoAviso(a, nome, minutos, id, ` — ${dono ? `com ${dono.nome.split(/\s+/)[0]}` : 'sem responsável'}`);
  if (!gerente.numero && u.modo !== 'seco') {
    // sem o número da gerente não há o que mandar: NÃO registra (quando o número for cadastrado, ainda dentro do prazo, sai)
    contar(c.resumo.barrados, 'aviso-30: a gerente não tem WhatsApp cadastrado');
    adiar(c, a, id, 'demora-aviso-30', chave);
    return;
  }
  if (u.modo === 'ligado' && !cabe(c, 1)) {
    c.resumo.noTeto++;
    return;
  }
  if (!(await registrar(c, a, id, 'demora-aviso-30', chave, u.modo === 'seco' ? `mandaria à gerente (há ${duracaoCurta(minutos)})${gerente.numero ? '' : ' — SEM número cadastrado'}` : texto))) return;
  c.resumo.devidos['aviso-30']++;
  if (u.modo === 'seco') {
    c.resumo.simulados['aviso-30']++;
    logger.info({ unit: u.slug, conversa: id, minutos, semNumero: !gerente.numero }, `${ID_CICLO}: SECO — mandaria o aviso de 30 min à gerente (nada foi enviado)`);
    return;
  }
  c.resumo.saidas++;
  if (await mundo.zap(gerente.numero!, texto)) c.resumo.feitos['aviso-30']++;
  else {
    c.resumo.falhas++;
    await desfazer(c, a, id, 'demora-aviso-30', chave);
    adiar(c, a, id, 'demora-aviso-30', chave);
  }
}

// ── uma conversa ─────────────────────────────────────────────────────────────────────────────────

async function tratarConversa(c: Ctx, a: Alvo, atual: Estado1, devidos: Passo[], janela: ReturnType<typeof janelaDeEnvio>): Promise<void> {
  const { mundo } = c.deps;
  const id = atual.lida.id;
  const chaveEp = atual.espera ? chaveDoEpisodio(atual.espera.desde) : '';
  const dia = diaNoFuso(c.agora, a.u.fuso);
  // o que ainda falta fazer (este processo já tratou o resto): sem isto, o seco releria a conversa a cada minuto por um passo já anotado
  const faltam = devidos.filter((p) => !passoTratado(c, a, id, p, chaveEp, dia));
  if (!faltam.length) return;
  // RELÊ a conversa e as mensagens: a equipe pode ter respondido (ou a Sofia assumido) entre a listagem e agora
  const [raw, msgs] = await Promise.all([mundo.conversa(a.ctx, id), mundo.mensagens(a.ctx, id)]);
  const fresco = lerConversa(raw, msgs, a.robos);
  if (!fresco) return;
  const agora = mundo.agora();
  const d = decidirDemora({ espera: fresco.espera, agora, fuso: a.u.fuso, janela, status: fresco.status, lida: fresco.lida, iaLigada: a.u.iaLigada, caixaOficial: a.caixa.oficial });
  for (const b of d.barrados) contar(c.resumo.barrados, `${b.passo}: ${b.motivo}`);
  const agir = d.devidos.filter((p) => faltam.includes(p));
  if (!agir.length || !fresco.espera) return;
  c.agora = agora;
  const minutos = d.minutosReais;
  if (agir.includes('espera')) await passoEspera(c, a, fresco, minutos);
  const numeroDo30 = agir.includes('aviso-30') ? (await destinoDaGerente(c, a)).numero : null;
  if (agir.includes('aviso-10')) await passoAviso10(c, a, fresco, minutos, numeroDo30);
  if (agir.includes('aviso-30')) await passoAviso30(c, a, fresco, minutos);
}

export async function rodarCicloDaDemora(deps: { armazem: Armazem; mundo: MundoDaDemora; memoria: MemoriaDaDemora }): Promise<ResumoDaDemora> {
  const { mundo, memoria } = deps;
  const resumo = resumoVazio();
  const c: Ctx = { deps, resumo, agora: mundo.agora() };
  const janela = janelaDeEnvio(mundo.env ?? process.env);
  for (const u of await mundo.unidades()) {
    if (u.modo === 'desligado') continue;
    if (!u.ctx?.conta) {
      logger.warn({ unit: u.slug }, `${ID_CICLO}: a unidade não tem conta válida no CRM — pulo, sem chamar o Chatwoot`);
      continue;
    }
    resumo.unidades++;
    for (const caixa of u.caixas) {
      const a: Alvo = { u, ctx: u.ctx, conta: u.ctx.conta.conta, caixa, robos: await robosDaConta(deps, u.ctx) };
      let lista: any[];
      try {
        lista = await mundo.listar(a.ctx, caixa.id, Math.floor((mundo.agora().getTime() - JANELA_DE_LEITURA_MS) / 1000));
      } catch (err) {
        logger.warn({ unit: u.slug, caixa: caixa.id, err: msgDoErro(err) }, `${ID_CICLO}: não consegui listar as conversas — tento no próximo ciclo`);
        resumo.falhas++;
        continue;
      }
      for (const raw of lista) {
        if (resumo.saidas >= MAX_SAIDAS_POR_CICLO) {
          resumo.noTeto++;
          break;
        }
        resumo.lidas++;
        try {
          const lida = conversaLidaDoChatwoot(raw);
          if (!lida) continue;
          const chave = `${a.conta}:${caixa.id}:${lida.id}`;
          const sig = assinatura(raw);
          let guardada = memoria.esperas.get(chave);
          let estado: Estado1 | null = null;
          if (!guardada || guardada.assinatura !== sig) {
            estado = lerConversa(raw, await mundo.mensagens(a.ctx, lida.id), a.robos);
            if (!estado) continue;
            guardada = { assinatura: sig, espera: estado.espera };
            if (memoria.esperas.size > 4000) memoria.esperas.clear();
            memoria.esperas.set(chave, guardada);
          }
          if (!guardada.espera) continue;
          resumo.esperando++;
          c.agora = mundo.agora();
          const d = decidirDemora({ espera: guardada.espera, agora: c.agora, fuso: u.fuso, janela, status: String(raw?.status ?? ''), lida, iaLigada: u.iaLigada, caixaOficial: caixa.oficial });
          for (const b of d.barrados) contar(resumo.barrados, `${b.passo}: ${b.motivo}`);
          if (!d.devidos.length) continue;
          const base: Estado1 = estado ?? { raw, lida, status: String(raw?.status ?? ''), espera: guardada.espera, mensagens: [] };
          const antes = resumo.saidas;
          await tratarConversa(c, a, base, d.devidos, janela);
          if (resumo.saidas > antes) await mundo.pausa(150);
        } catch (err) {
          resumo.falhas++;
          logger.warn({ unit: u.slug, caixa: caixa.id, err: msgDoErro(err) }, `${ID_CICLO}: falhou numa conversa — sigo com as outras`);
        }
      }
    }
  }
  if (resumo.noTeto) logger.warn({ saidas: resumo.saidas, teto: MAX_SAIDAS_POR_CICLO }, `${ID_CICLO}: teto de saídas do ciclo atingido — o resto fica para o próximo`);
  const mexeu = PASSOS_DO_RESUMO.some((p) => resumo.devidos[p] || resumo.simulados[p] || resumo.feitos[p]);
  if (mexeu || resumo.falhas) logger.info(resumo, `${ID_CICLO}: ciclo`);
  return resumo;
}

const PASSOS_DO_RESUMO: readonly Passo[] = ['espera', 'aviso-10', 'aviso-30'];
