/**
 * O CICLO do worker `crm-tarefas` (a cada ~1 min): o que fazer com cada tarefa que chegou na hora. Aqui só há decisão e a ordem das coisas; quem fala com o
 * banco, com o Chatwoot e com o WhatsApp da menina entra pelas `Portas` (o teste troca todas, o worker de verdade as liga em `crm-tarefas-worker.ts`).
 *
 * As travas que importam:
 *  - SECO: decide tudo (lê a conversa, confere SAIR e a janela) mas NÃO escreve em lugar nenhum: nem no paciente, nem no CRM, nem no WhatsApp da menina.
 *    Só anota «mandaria…» na própria tarefa (`simuladoEm`, uma vez) e no log — sem anotar, o robô repetiria a mesma decisão a cada minuto.
 *  - Uma vez só: a tarefa é PEGA no banco antes de agir (`pendente → enviando`, `updateMany` com a condição): duas réplicas ou um reinício nunca mandam duas
 *    vezes. `enviando` que ficou preso vira «não sei se saiu» — nunca é reenviada sozinha.
 *  - O paciente que pediu SAIR, a etiqueta `sem-follow-up`, o contato interno, o horário (janela 8h–20h do fuso da unidade) e o atraso grande barram a
 *    mensagem. Atraso grande (servidor fora do ar) não sai sozinho: espera a menina confirmar na tela.
 *  - Janela de 24 h do WhatsApp: texto livre se aberta; senão o MODELO aprovado; sem modelo, não sai e a menina é avisada.
 */
import type { CrmTarefa } from '@prisma/client';
import { logger } from '../logger.js';
import type { Estado } from '../automacoes-estado.js';
import type { ContextoChatwoot } from '../../mcp-remoto/chatwoot.js';
import { CAIXAS_HISTORICO, CAIXAS_REGUA, conversaDoChatwoot } from '../chatwoot-regua.js';
import { primeiroNomeSeguro, textoFinal, valoresDasVariaveis } from '../disparo/regras.js';
import { conversaDoPublico } from '../disparo/chatwoot/publico.js';
import { ETIQUETA_SEM_FOLLOW_UP } from '../disparo/chatwoot/filtro.js';
import type { CaixaOficial, ConferenciaDoModelo } from '../disparo/chatwoot/canal.js';
import {
  ATRASO_MAXIMO_DO_LEMBRETE_MS,
  MAX_TENTATIVAS_DE_LEITURA,
  atrasoMaximoDaMensagemMs,
  dentroDaJanela,
  escolherVia,
  horaCurta,
  janelaDeEnvio,
  notaComMencao,
  referenciaDoAtraso,
  textoDoLembrete,
  type JanelaDeEnvio,
  type Tipo,
} from './regras.js';

export const ID_CICLO = 'crm-tarefas';
/** Se um defeito soltar tudo de uma vez, vaza só isto por ciclo. */
export const MAX_ENVIOS_POR_CICLO = 20;
export const MAX_POR_UNIDADE = 100;

export interface DaUnidade {
  slug: string;
  nome: string;
  fuso: string;
  modo: Estado;
  /** o Chatwoot da CONTA da unidade (null = sem conta/token válidos: não chama o Chatwoot) */
  ctx: ContextoChatwoot | null;
  /** o endereço da conta no CRM (para o link do lembrete) */
  linkDaConta: string | null;
}

export interface Armazem {
  /** `enviando` há mais de `PRESA_ENVIANDO_MS` → `falhou` («não sei se saiu»). Devolve quantas. */
  soltarPresas(agora: Date): Promise<number>;
  unidadesComVencidas(agora: Date): Promise<string[]>;
  /** pendentes que já passaram da hora; ligação/lembrete só os que ainda não foram lembrados; `soNaoSimuladas` (modo seco) pula as já anotadas */
  vencidas(unitId: string, agora: Date, soNaoSimuladas: boolean, limite: number): Promise<CrmTarefa[]>;
  /** `pendente → enviando`; false = outra réplica (ou outra aba da tela) já mexeu */
  pegar(id: string, agora: Date): Promise<boolean>;
  /** `pendente → pendente` com `lembreteEm` ainda nulo → agora; false = já lembrada */
  pegarLembrete(id: string, agora: Date): Promise<boolean>;
  desfazerLembrete(id: string): Promise<void>;
  /** grava o que o seco decidiu, uma vez; false = já estava anotado */
  anotarSimulado(id: string, texto: string, agora: Date): Promise<boolean>;
  /** só mexe se a tarefa ainda está no estado esperado (a menina pode ter cancelado no meio) */
  atualizar(id: string, daqui: string[], dados: Partial<Pick<CrmTarefa, 'estado' | 'motivo' | 'enviadaEm' | 'mensagemId' | 'lembreteEm' | 'lembreteResumo' | 'tentativas' | 'tentativaEm'>>): Promise<boolean>;
  numeroDaMenina(conta: number, agenteId: number): Promise<string | null>;
}

export interface MundoDoCiclo {
  unidade(unitId: string): Promise<DaUnidade | null>;
  conversa(ctx: ContextoChatwoot, id: number): Promise<unknown>;
  ultimaDoPaciente(ctx: ContextoChatwoot, conversaId: number): Promise<Date | null>;
  pediuSair(ctx: ContextoChatwoot, conversaId: number, contatoId: number | null): Promise<Date | null>;
  caixaOficial(ctx: ContextoChatwoot, caixa: number): Promise<CaixaOficial>;
  conferirModelo(ctx: ContextoChatwoot, caixa: number, def: { template: string; idioma: string; textoModelo: string; variaveis: string[] }): Promise<ConferenciaDoModelo>;
  /** a mensagem PÚBLICA ao paciente. `modelo` presente = vai pelo modelo aprovado. Lança com `status` se o CRM recusar. */
  mandar(ctx: ContextoChatwoot, conversaId: number, a: { content: string; modelo?: { nome: string; idioma: string; variaveis: string[] } }): Promise<{ id: number | null }>;
  /** nota PRIVADA (com menção) na conversa */
  nota(ctx: ContextoChatwoot, conversaId: number, texto: string): Promise<void>;
  /** WhatsApp pessoal da menina; false = não saiu (sem Evolution configurada, ou falhou) */
  zap(numero: string, texto: string): Promise<boolean>;
  agora(): Date;
  pausa(ms: number): Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export interface ResumoDoCiclo {
  presas: number;
  vistas: number;
  desligadas: number;
  mandadas: number;
  lembretes: number;
  simuladas: number;
  barradas: number;
  aguardando: number;
  adiadas: number;
  falhas: number;
}
const resumoVazio = (): ResumoDoCiclo => ({ presas: 0, vistas: 0, desligadas: 0, mandadas: 0, lembretes: 0, simuladas: 0, barradas: 0, aguardando: 0, adiadas: 0, falhas: 0 });

const statusDoErro = (e: unknown): number | undefined => {
  const s = (e as { status?: number } | null)?.status;
  return typeof s === 'number' ? s : undefined;
};
const msgDoErro = (e: unknown): string => String(e instanceof Error ? e.message : e).slice(0, 200);

interface Ctx {
  deps: { armazem: Armazem; mundo: MundoDoCiclo };
  u: DaUnidade;
  ctx: ContextoChatwoot;
  resumo: ResumoDoCiclo;
  janela: JanelaDeEnvio;
  atrasoMax: number;
  /** o Chatwoot respondeu 429: a rodada acaba */
  ocupado: boolean;
}

const link = (u: DaUnidade, t: CrmTarefa): string => (u.linkDaConta ? `${u.linkDaConta}/conversations/${t.conversaId}` : '');

/** Aviso à menina: nota privada com menção (o sininho do CRM) e/ou WhatsApp. Nunca lança. Devolve um resumo curto para o log. */
async function avisarMenina(c: Ctx, t: CrmTarefa, texto: string, canais: { nota: boolean; zap: boolean }): Promise<string> {
  const { mundo, armazem } = c.deps;
  const partes: string[] = [];
  if (canais.nota) {
    try {
      await mundo.nota(c.ctx, t.conversaId, notaComMencao({ id: t.responsavelId, nome: t.responsavelNome }, texto));
      partes.push('CRM: ok');
    } catch (e) {
      partes.push(`CRM: falhou (${msgDoErro(e).slice(0, 60)})`);
    }
  }
  if (canais.zap) {
    try {
      const numero = await armazem.numeroDaMenina(t.conta, t.responsavelId);
      if (!numero) partes.push('WhatsApp: sem número cadastrado');
      else {
        const l = link(c.u, t);
        partes.push((await mundo.zap(numero, `Doutor Digital · ${c.u.nome}\n${texto}${l ? `\n${l}` : ''}`)) ? 'WhatsApp: ok' : 'WhatsApp: falhou');
      }
    } catch (e) {
      partes.push(`WhatsApp: falhou (${msgDoErro(e).slice(0, 60)})`);
    }
  }
  return partes.join(' · ');
}

// ── ligação e lembrete ───────────────────────────────────────────────────────────────────────────────────────

async function tratarLembrete(c: Ctx, t: CrmTarefa): Promise<void> {
  const { armazem, mundo } = c.deps;
  const agora = mundo.agora();
  const texto = textoDoLembrete({ tipo: t.tipo as Tipo, contatoNome: t.contatoNome, quando: t.quando, texto: t.texto }, c.u.fuso);
  if (c.u.modo === 'seco') {
    const numero = await armazem.numeroDaMenina(t.conta, t.responsavelId);
    const novo = await armazem.anotarSimulado(t.id, `mandaria o lembrete: nota com menção a ${t.responsavelNome} no CRM${numero ? ' e WhatsApp para ela' : ' (sem WhatsApp cadastrado: só o CRM)'}`, agora);
    if (novo) {
      c.resumo.simuladas++;
      logger.info({ unit: c.u.slug, tarefa: t.id, tipo: t.tipo, responsavel: t.responsavelNome }, `${ID_CICLO}: SECO — mandaria o lembrete (nada foi enviado)`);
    }
    return;
  }
  // atrasada demais (o servidor ficou fora do ar): não acorda ninguém por um lembrete velho; a tarefa continua na tela como atrasada
  if (agora.getTime() - t.quando.getTime() > ATRASO_MAXIMO_DO_LEMBRETE_MS) {
    if (await armazem.pegarLembrete(t.id, agora)) await armazem.atualizar(t.id, ['pendente'], { lembreteResumo: 'não avisei: passou de 3 h do horário (a tarefa segue na tela, em Atrasadas)' });
    c.resumo.adiadas++;
    return;
  }
  if (!(await armazem.pegarLembrete(t.id, agora))) return; // outra réplica já avisou
  const resumo = await avisarMenina(c, t, texto, { nota: true, zap: true });
  const nada = resumo.includes('CRM: falhou') && !resumo.includes('WhatsApp: ok');
  if (nada && t.tentativas + 1 < MAX_TENTATIVAS_DE_LEITURA) {
    await armazem.desfazerLembrete(t.id);
    await armazem.atualizar(t.id, ['pendente'], { tentativas: t.tentativas + 1 });
    c.resumo.falhas++;
    return;
  }
  await armazem.atualizar(t.id, ['pendente'], { lembreteResumo: resumo.slice(0, 200) });
  c.resumo.lembretes++;
  logger.info({ unit: c.u.slug, tarefa: t.id, tipo: t.tipo, resumo }, `${ID_CICLO}: lembrete enviado`);
}

// ── mensagem ao paciente ─────────────────────────────────────────────────────────────────────────────────────

type Barrado = { estado: 'barrada' | 'falhou'; motivo: string };

/** Anota (seco) ou grava (ligado) que a mensagem NÃO vai sair, e avisa a menina. */
async function barrar(c: Ctx, t: CrmTarefa, b: Barrado): Promise<void> {
  const { armazem, mundo } = c.deps;
  if (c.u.modo === 'seco') {
    if (await armazem.anotarSimulado(t.id, `NÃO mandaria: ${b.motivo}`, mundo.agora())) {
      c.resumo.simuladas++;
      logger.info({ unit: c.u.slug, tarefa: t.id, motivo: b.motivo }, `${ID_CICLO}: SECO — não mandaria (${b.motivo})`);
    }
    return;
  }
  if (!(await armazem.atualizar(t.id, ['pendente', 'enviando'], { estado: b.estado, motivo: b.motivo }))) return;
  c.resumo.barradas++;
  const resumo = await avisarMenina(c, t, `A mensagem agendada para ${t.contatoNome.trim().split(/\s+/).slice(0, 3).join(' ')} NÃO saiu: ${b.motivo}.`, { nota: true, zap: true });
  logger.warn({ unit: c.u.slug, tarefa: t.id, motivo: b.motivo, resumo }, `${ID_CICLO}: mensagem barrada`);
}

/** Lê o CRM e devolve o que impede a mensagem, ou `null`. Lança se não deu para ler (quem chama adia). */
async function conferirConversa(c: Ctx, t: CrmTarefa): Promise<{ barrado: Barrado | null; nome: string }> {
  const { mundo } = c.deps;
  let raw: any;
  try {
    raw = await mundo.conversa(c.ctx, t.conversaId);
  } catch (e) {
    if (statusDoErro(e) === 404) return { barrado: { estado: 'falhou', motivo: 'a conversa não existe mais no CRM (apagada ou mesclada)' }, nome: t.contatoNome };
    throw e;
  }
  const conv = conversaDoPublico(raw);
  const nome = conversaDoChatwoot(raw)?.nome || t.contatoNome;
  if (!conv || Number(raw?.inbox_id) !== t.caixa || CAIXAS_REGUA[t.caixa] !== c.u.slug || CAIXAS_HISTORICO.has(t.caixa)) return { barrado: { estado: 'barrada', motivo: 'a conversa saiu da caixa da unidade (ou virou grupo)' }, nome };
  if (conv.etiquetas.some((e) => e.trim().toLowerCase() === ETIQUETA_SEM_FOLLOW_UP)) return { barrado: { estado: 'barrada', motivo: 'a conversa tem a etiqueta sem-follow-up' }, nome };
  if (conv.interno) return { barrado: { estado: 'barrada', motivo: 'contato interno' }, nome };
  if (t.contatoId != null && conv.contatoId != null && conv.contatoId !== t.contatoId) return { barrado: { estado: 'barrada', motivo: 'o contato da conversa mudou desde o agendamento' }, nome };
  return { barrado: null, nome };
}

async function tratarMensagem(c: Ctx, t: CrmTarefa): Promise<void> {
  const { armazem, mundo } = c.deps;
  const agora = mundo.agora();
  const seco = c.u.modo === 'seco';

  // 1. horário e atraso — sem ler nada do CRM
  const ref = referenciaDoAtraso({ quando: t.quando, confirmadaEm: t.confirmadaEm }, c.u.fuso, c.janela);
  if (ref.getTime() > agora.getTime() || !dentroDaJanela(agora, c.u.fuso, c.janela)) {
    c.resumo.adiadas++; // fora do horário de falar com o paciente: espera abrir (a tela mostra «sai às 8h»)
    return;
  }
  if (agora.getTime() - ref.getTime() > c.atrasoMax) {
    const horas = Math.round((c.atrasoMax / 3_600_000) * 10) / 10;
    const motivo = `passou de ${horas} h do horário combinado (${horaCurta(t.quando, c.u.fuso)}): confirme na tela se ainda quer mandar`;
    if (seco) {
      if (await armazem.anotarSimulado(t.id, `pediria a confirmação da menina: ${motivo}`, agora)) {
        c.resumo.simuladas++;
        logger.info({ unit: c.u.slug, tarefa: t.id }, `${ID_CICLO}: SECO — ${motivo}`);
      }
      return;
    }
    if (!(await armazem.atualizar(t.id, ['pendente'], { estado: 'aguardando', motivo }))) return;
    c.resumo.aguardando++;
    await avisarMenina(c, t, `A mensagem para ${t.contatoNome.trim().split(/\s+/).slice(0, 3).join(' ')} NÃO saiu sozinha: ${motivo}.`, { nota: true, zap: true });
    return;
  }

  // 2. o CRM: conversa, SAIR, janela de 24 h, modelo. Qualquer leitura que falhar ADIA (nunca vira «não pediu SAIR»).
  let via: ReturnType<typeof escolherVia>;
  let nomeAtual = t.contatoNome;
  try {
    const conf = await conferirConversa(c, t);
    nomeAtual = conf.nome;
    if (conf.barrado) return barrar(c, t, conf.barrado);
    const sair = await mundo.pediuSair(c.ctx, t.conversaId, t.contatoId);
    if (sair) return barrar(c, t, { estado: 'barrada', motivo: 'o paciente pediu para sair (SAIR)' });
    const oficial = await mundo.caixaOficial(c.ctx, t.caixa);
    const ultima = oficial.ok ? await mundo.ultimaDoPaciente(c.ctx, t.conversaId) : null;
    via = escolherVia({ caixaOficial: oficial.ok, ultimaDoPaciente: ultima, agora, temTexto: !!t.texto.trim(), temModelo: !!t.modeloNome });
    if (via.tipo === 'nenhuma') return barrar(c, t, { estado: 'barrada', motivo: via.motivo });
    if (via.tipo === 'modelo') {
      if (!oficial.ok) return barrar(c, t, { estado: 'barrada', motivo: oficial.motivo });
      const conferido = await mundo.conferirModelo(c.ctx, t.caixa, { template: t.modeloNome!, idioma: t.modeloIdioma ?? 'pt_BR', textoModelo: t.modeloTexto ?? '', variaveis: t.modeloVariaveis });
      if (!conferido.ok && conferido.transitorio) throw new Error(conferido.motivo);
      if (!conferido.ok) return barrar(c, t, { estado: 'barrada', motivo: `o modelo não vale mais: ${conferido.motivo}`.slice(0, 200) });
    }
  } catch (e) {
    // não deu para ler o CRM: tenta no próximo ciclo; depois de algumas vezes desiste com o motivo
    c.resumo.adiadas++;
    if (statusDoErro(e) === 429) {
      c.ocupado = true;
      return;
    }
    if (seco) return;
    if (t.tentativas + 1 >= MAX_TENTATIVAS_DE_LEITURA) return barrar(c, t, { estado: 'falhou', motivo: `não consegui ler o CRM depois de ${MAX_TENTATIVAS_DE_LEITURA} tentativas (${msgDoErro(e).slice(0, 80)})` });
    await armazem.atualizar(t.id, ['pendente'], { tentativas: t.tentativas + 1 });
    logger.warn({ unit: c.u.slug, tarefa: t.id, err: msgDoErro(e) }, `${ID_CICLO}: não consegui conferir a conversa — adio`);
    return;
  }

  // 3. o conteúdo
  let content: string;
  let modelo: { nome: string; idioma: string; variaveis: string[] } | undefined;
  if (via.tipo === 'texto') content = t.texto.trim();
  else {
    const fontes = t.modeloVariaveis;
    if (fontes.includes('primeiroNome') && !primeiroNomeSeguro(nomeAtual)) return barrar(c, t, { estado: 'barrada', motivo: 'o nome do contato não serve para a saudação do modelo' });
    const valores = valoresDasVariaveis(fontes, { primeiroNome: primeiroNomeSeguro(nomeAtual) ?? '', unidade: c.u.nome });
    content = textoFinal(t.modeloTexto ?? '', valores);
    modelo = { nome: t.modeloNome!, idioma: t.modeloIdioma ?? 'pt_BR', variaveis: valores };
  }

  const descricao = via.tipo === 'texto' ? 'texto livre (janela de 24 h aberta)' : `modelo ${t.modeloNome} (janela de 24 h fechada)`;
  if (seco) {
    if (await armazem.anotarSimulado(t.id, `mandaria agora como ${descricao}`, agora)) {
      c.resumo.simuladas++;
      logger.info({ unit: c.u.slug, tarefa: t.id, via: via.tipo }, `${ID_CICLO}: SECO — mandaria a mensagem como ${descricao} (nada foi enviado)`);
    }
    return;
  }

  // 4. LIGADO: pega a tarefa ANTES de mandar
  if (!(await armazem.pegar(t.id, agora))) return;
  try {
    const r = await mundo.mandar(c.ctx, t.conversaId, { content, modelo });
    // sem o id da mensagem não há prova de que entrou: INCERTO (nunca reenvia sozinha)
    if (r.id == null) {
      await armazem.atualizar(t.id, ['enviando'], { estado: 'falhou', motivo: 'o CRM não devolveu o id da mensagem: não sei se saiu — confira a conversa' });
      c.resumo.falhas++;
      await avisarMenina(c, t, `Não sei se a mensagem para ${t.contatoNome.trim().split(/\s+/).slice(0, 3).join(' ')} saiu (o CRM não confirmou). Confira a conversa antes de mandar de novo.`, { nota: true, zap: true });
      return;
    }
    await armazem.atualizar(t.id, ['enviando'], { estado: 'feita', enviadaEm: mundo.agora(), mensagemId: r.id, motivo: `saiu como ${descricao}` });
    c.resumo.mandadas++;
    logger.info({ unit: c.u.slug, tarefa: t.id, via: via.tipo, mensagem: r.id }, `${ID_CICLO}: mensagem enviada`);
    await avisarMenina(c, t, `Saiu a mensagem para ${t.contatoNome.trim().split(/\s+/).slice(0, 3).join(' ')} (${horaCurta(mundo.agora(), c.u.fuso)}).`, { nota: false, zap: true });
  } catch (e) {
    const status = statusDoErro(e);
    if (status === 429) {
      // o Chatwoot está ocupado: volta para a fila, sem culpa, e a rodada acaba
      await armazem.atualizar(t.id, ['enviando'], { estado: 'pendente', tentativaEm: null });
      c.ocupado = true;
      c.resumo.adiadas++;
      return;
    }
    const recusou = status !== undefined && status >= 400 && status < 500;
    const motivo = recusou ? `o CRM recusou a mensagem: ${msgDoErro(e)}` : `não sei se saiu (o CRM não respondeu direito): confira a conversa antes de mandar de novo`;
    await armazem.atualizar(t.id, ['enviando'], { estado: 'falhou', motivo });
    c.resumo.falhas++;
    logger.warn({ unit: c.u.slug, tarefa: t.id, status, err: msgDoErro(e) }, `${ID_CICLO}: a mensagem falhou`);
    await avisarMenina(c, t, `A mensagem para ${t.contatoNome.trim().split(/\s+/).slice(0, 3).join(' ')} FALHOU: ${motivo}.`, { nota: true, zap: true });
  }
}

// ── o ciclo ──────────────────────────────────────────────────────────────────────────────────────────────────

export async function rodarCiclo(deps: { armazem: Armazem; mundo: MundoDoCiclo }): Promise<ResumoDoCiclo> {
  const { armazem, mundo } = deps;
  const resumo = resumoVazio();
  const agora = mundo.agora();
  resumo.presas = await armazem.soltarPresas(agora);
  if (resumo.presas) logger.warn({ presas: resumo.presas }, `${ID_CICLO}: tarefa que ficou «enviando» virou «não sei se saiu» (nunca é reenviada sozinha)`);
  const env = mundo.env ?? process.env;
  const janela = janelaDeEnvio(env);
  const atrasoMax = atrasoMaximoDaMensagemMs(env);
  let envios = 0;

  for (const unitId of await armazem.unidadesComVencidas(agora)) {
    const u = await mundo.unidade(unitId);
    if (!u) continue;
    if (u.modo === 'desligado') {
      resumo.desligadas++;
      continue;
    }
    if (!u.ctx?.conta) {
      logger.warn({ unit: u.slug }, `${ID_CICLO}: a unidade não tem conta válida no CRM — pulo, sem chamar o Chatwoot`);
      continue;
    }
    const c: Ctx = { deps, u, ctx: u.ctx, resumo, janela, atrasoMax, ocupado: false };
    const lista = await armazem.vencidas(unitId, agora, u.modo === 'seco', MAX_POR_UNIDADE);
    for (const t of lista) {
      if (c.ocupado || envios >= MAX_ENVIOS_POR_CICLO) break;
      // a conta da tarefa é a da unidade: tarefa de uma conta nunca age em outra
      if (t.conta !== u.ctx.conta.conta) {
        logger.warn({ unit: u.slug, tarefa: t.id }, `${ID_CICLO}: a conta da tarefa não é a da unidade — pulo`);
        continue;
      }
      resumo.vistas++;
      try {
        const antes = resumo.mandadas + resumo.lembretes;
        if (t.tipo === 'mensagem') await tratarMensagem(c, t);
        else await tratarLembrete(c, t);
        if (resumo.mandadas + resumo.lembretes > antes) {
          envios++;
          await mundo.pausa(150);
        }
      } catch (e) {
        resumo.falhas++;
        logger.warn({ unit: u.slug, tarefa: t.id, err: msgDoErro(e) }, `${ID_CICLO}: falhou numa tarefa — sigo com as outras`);
      }
    }
  }
  // só fala quando algo aconteceu (tarefa esperando a janela de horário abrir seria uma linha por minuto a noite inteira)
  if (resumo.presas || resumo.mandadas || resumo.lembretes || resumo.simuladas || resumo.barradas || resumo.aguardando || resumo.falhas) logger.info(resumo, `${ID_CICLO}: ciclo`);
  return resumo;
}
