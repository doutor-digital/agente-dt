/**
 * A caixa "Leads de entrada" (unsorted) do Kommo, sem ninguém para abrir (pedido do João, 06/11/2026).
 *
 * O problema, medido em 06/11 nas contas com a chave: Timbó chegou a ter 302 leads de entrada parados (299 com o MESMO telefone
 * de um cartão de verdade: a importação de 29/10 criou contato novo e a SDR via "duplicado"); a Advocacia Magalhães tem 655 e só
 * 2 cartões em 14 dias; Salto 94, nenhum aceito. Conversa sem cartão não é atendida por ninguém.
 *
 * Duas automações, as duas por unidade, padrão DESLIGADO, as duas com "só no papel":
 *
 *  - `entrada-automatica` (lead de entrada RECENTE: com mais de `ENTRADA_ESPERA_MIN` e menos de `ENTRADA_JANELA_MIN` minutos):
 *      · o telefone (últimos 8 dígitos) bate com UM cartão aberto → VINCULA (a conversa cai no cartão; nada muda de etapa);
 *      · bate com 2 ou mais cartões abertos → NÃO faz nada (ver abaixo); só loga e mostra na tela;
 *      · não bate com cartão aberto → ACEITA, na primeira etapa de trabalho do funil onde o lead entrou.
 *  - `entrada-estoque` (lead de entrada VELHO, mais antigo que a janela): só VINCULA quando há UM cartão aberto. Quem não tem par
 *      NÃO é aceito — só aparece na tela "só no papel" para uma pessoa decidir.
 *
 * POR QUE A JANELA. Aceitar é uma mudança de etapa, e os robôs de "entra na etapa" do destino (boas-vindas, primeiro contato)
 * podem disparar: aceitar uma conversa de setembro mandaria "olá, tudo bem?" a um paciente que escreveu há dois meses. Vincular não
 * mexe na etapa do cartão — provado em Timbó em 05/11 (274 vinculados, 0 erro, nenhum robô). Por isso o estoque só vincula.
 * O lead recente que ninguém tratou na janela (API fora, par ambíguo) passa a ser estoque: a janela NUNCA se estende sozinha.
 *
 * POR QUE O AMBÍGUO NÃO VINCULA (nem "o mais recente"). Com 2+ cartões abertos no mesmo telefone o duplicado já existe, e escolher
 * um pelo relógio pode pôr a conversa num cartão em outra etapa (AGENDADO ou EM TRATAMENTO) enquanto a Sofia atende o outro.
 * Vincular consome o lead de entrada: não tem volta. E ACEITAR um terceiro cartão seria piorar o duplicado. Fica na caixa, à vista.
 *
 * "CARTÃO ABERTO" = fora de 142/143 e fora da etapa de entrada (type 1) de qualquer funil. Cartão só FECHADO (ALTA, PERDIDO, GANHO)
 * não segura o aceite: paciente que volta depois da alta é cartão novo, e a Sofia vê o cadastro antigo pelo telefone.
 *
 * Falha NUNCA perde nada: o lead continua na caixa e a próxima rodada tenta de novo. Falha na BUSCA nunca vira "sem par" (aceitaria
 * em duplicidade): o lead fica. Só a categoria `chats` é tratada; formulário, ligação e e-mail ficam como estão (a API de vincular
 * é só para chats, e formulário não tem conversa esperando).
 *
 * Teto por rodada (o limitador do Kommo é da rede toda): `ENTRADA_MAX_AVALIACOES` leads olhados e `ENTRADA_MAX_ESCRITAS` escritas.
 * O recente vem primeiro, então o estoque nunca atrasa quem acabou de chegar. O que passa do teto entra na rodada seguinte.
 */
import type { EntradaDoKommo, KommoClient, KommoLead, KommoPipeline } from '../services/kommo.service.js';
import type { Estado } from './automacoes-estado.js';
import type { Simulacao } from './so-no-papel.js';
import { logger } from './logger.js';

export const ID_ENTRADA = 'entrada-automatica';
export const ID_ESTOQUE = 'entrada-estoque';

const MIN = 60;

export interface ConfigEntrada {
  /** abaixo disto o lead ainda é "de agora": dá tempo de a Sofia ou a recepção pegarem sozinhas (segundos) */
  esperaS: number;
  /** até isto o lead é recente (segundos); acima é estoque */
  janelaS: number;
  maxAvaliacoes: number;
  maxEscritas: number;
  maxPaginas: number;
}

const inteiro = (v: string | undefined, padrao: number, min: number): number => {
  if (v === undefined || v.trim() === '') return padrao; // `Number('')` é 0: variável declarada e vazia não pode zerar a espera
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : padrao;
};

export function configDoAmbiente(env: NodeJS.ProcessEnv = process.env): ConfigEntrada {
  return {
    esperaS: inteiro(env.ENTRADA_ESPERA_MIN, 3, 0) * MIN,
    janelaS: inteiro(env.ENTRADA_JANELA_MIN, 120, 1) * MIN,
    maxAvaliacoes: inteiro(env.ENTRADA_MAX_AVALIACOES, 30, 1),
    maxEscritas: inteiro(env.ENTRADA_MAX_ESCRITAS, 15, 1),
    maxPaginas: inteiro(env.ENTRADA_MAX_PAGINAS, 4, 1),
  };
}

// ─── regras puras ─────────────────────────────────────────────────────────────────────────────────

const soDigitos = (t: string) => t.replace(/\D+/g, '');

/** Sem o +55 e sem o zero de tronco ("011 98765-4321"): fica DDD + número (10 ou 11 dígitos) ou, se não der, o que sobrar. */
function nacional(t: string): string {
  let d = soDigitos(t);
  if (d.length >= 12 && d.startsWith('55')) d = d.slice(2);
  return d.replace(/^0+/, '');
}

/** Os últimos 8 dígitos (imunes ao nono dígito e ao +55), ou `null` se não há 8 para comparar. */
export function chaveFone(t: string): string | null {
  const d = soDigitos(t);
  return d.length >= 8 ? d.slice(-8) : null;
}

/**
 * Mesma linha? Últimos 8 dígitos iguais; e, quando os DOIS números trazem o DDD, o DDD também (8 dígitos iguais em cidades
 * diferentes existem). Sem DDD de um dos lados, vale só o final — é o que atravessa as duas formas de gravar o mesmo número.
 */
export function mesmoTelefone(a: string, b: string): boolean {
  const ka = chaveFone(a);
  if (!ka || ka !== chaveFone(b)) return false;
  const na = nacional(a);
  const nb = nacional(b);
  // só compara o DDD quando os DOIS lados têm a forma de DDD + número (10 ou 11 dígitos). Na dúvida são o mesmo número:
  // o erro caro é achar que são pessoas diferentes e ACEITAR um cartão duplicado.
  const comDdd = (n: string) => n.length === 10 || n.length === 11;
  if (comDdd(na) && comDdd(nb)) return na.slice(0, 2) === nb.slice(0, 2);
  return true;
}

/** A primeira etapa de TRABALHO do funil: a de menor `sort` que não é a de entrada (type 1) nem GANHO/PERDIDO (142/143). */
export function primeiraEtapaDoFunil(pipelines: readonly KommoPipeline[], pipelineId: number): { id: number; nome: string } | null {
  const funil = pipelines.find((p) => p.id === pipelineId && !p.is_archive);
  if (!funil) return null;
  const etapas = funil.statuses
    .filter((s) => s.type !== 1 && s.id !== 142 && s.id !== 143)
    .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));
  return etapas[0] ? { id: etapas[0].id, nome: etapas[0].name } : null;
}

/** Ids das etapas de entrada (type 1) de todos os funis: um cartão ali é lead de entrada, não "cartão de verdade". */
export function etapasDeEntrada(pipelines: readonly KommoPipeline[]): Set<string> {
  const out = new Set<string>();
  for (const p of pipelines) for (const s of p.statuses) if (s.type === 1) out.add(`${p.id}:${s.id}`);
  return out;
}

/** Aberto = não fechado (142/143, ou `closed_at`) e fora da etapa de entrada. */
export function cartaoAberto(l: Pick<KommoLead, 'pipeline_id' | 'status_id' | 'closed_at'>, entrada: ReadonlySet<string>): boolean {
  if (l.closed_at) return false;
  if (l.status_id === 142 || l.status_id === 143) return false;
  return !entrada.has(`${l.pipeline_id}:${l.status_id}`);
}

export type Modo = 'recente' | 'estoque';

/** O que fazer com o lead de entrada, dado o que existe no Kommo para o telefone dele. */
export type Decisao =
  | { tipo: 'vincular'; cartaoId: number }
  | { tipo: 'aceitar' }
  | { tipo: 'nada'; motivo: 'ambiguo' | 'sem-par-velho' | 'sem-telefone' | 'sem-contato' | 'busca-cheia' };

export function decidir(modo: Modo, entrada: { temTelefone: boolean; buscaCheia: boolean }, abertos: readonly number[]): Decisao {
  if (!entrada.temTelefone) return { tipo: 'nada', motivo: 'sem-telefone' };
  // a busca devolveu o teto: pode haver mais cartões do que vimos — não é prova de "um só" nem de "nenhum"
  if (entrada.buscaCheia) return { tipo: 'nada', motivo: 'busca-cheia' };
  if (abertos.length === 1) return { tipo: 'vincular', cartaoId: abertos[0] };
  if (abertos.length > 1) return { tipo: 'nada', motivo: 'ambiguo' };
  return modo === 'recente' ? { tipo: 'aceitar' } : { tipo: 'nada', motivo: 'sem-par-velho' };
}

export type ClasseDoErro = 'ja-resolvido' | 'permanente' | 'transitorio';

/** 404 = o lead de entrada já saiu da caixa (alguém aceitou/vinculou antes); 400/401/403/422 não passam sozinhos; o resto (429, 5xx, rede) passa. */
export function classeDoErro(err: unknown): ClasseDoErro {
  const status = (err as { status?: number; response?: { status?: number } })?.status ?? (err as { response?: { status?: number } })?.response?.status;
  if (status === 404) return 'ja-resolvido';
  if (status === 400 || status === 401 || status === 403 || status === 422) return 'permanente';
  return 'transitorio';
}

// ─── a rodada de uma conta ────────────────────────────────────────────────────────────────────────

export type PortaKommo = Pick<
  KommoClient,
  'listarEntrada' | 'telefonesDoContato' | 'buscarContatos' | 'listLeadsPorIds' | 'listPipelines' | 'vincularEntrada' | 'aceitarEntrada' | 'addLeadNote'
>;

/** O que dura entre rodadas, POR CONTA: o que já foi olhado (para não repetir a busca) e o bloqueio por erro que não passa. */
export interface MemoriaDaConta {
  vistoAte: Map<string, number>;
  bloqueadaAte: number;
}
export const memoriaNova = (): MemoriaDaConta => ({ vistoAte: new Map(), bloqueadaAte: 0 });

/** Lead olhado e deixado como está (ambíguo, sem par, seco) não é buscado de novo por este tempo. */
export const VISTO_MS = 3 * 60 * 60_000;
/** O estoque sem par ou ambíguo muda devagar (e são centenas): olhar de novo a cada 12 h, não a cada 3 h. */
export const VISTO_ESTOQUE_MS = 12 * 60 * 60_000;
/** Lead que deu erro que passa (Kommo fora, busca que falha): sai da frente por 15 min, para um lead com defeito não travar a fila atrás dele. */
export const VISTO_FALHA_MS = 15 * 60_000;
/** Erro que não passa sozinho (token sem direito de admin): a conta descansa. */
export const BLOQUEIO_MS = 60 * 60_000;
/** Falha que pode passar (429, 5xx, rede, busca): a conta descansa um pouco em vez de bater de novo na rodada seguinte. */
export const DESCANSO_CURTO_MS = 5 * 60_000;
const ERROS_PERMANENTES_QUE_ENCERRAM = 3;
const PAUSA_ENTRE_ESCRITAS_MS = 300;

export interface ContextoDaRodada {
  unit: { id: string; slug: string };
  recente: Estado;
  estoque: Estado;
  /** epoch em segundos */
  agora: number;
  cfg: ConfigEntrada;
  memoria: MemoriaDaConta;
  registrar: (s: Simulacao & { automacao: string }) => void;
  /** só o teste troca (a pausa entre escritas) */
  pausa?: () => Promise<void>;
  /** o worker foi parado (perdeu a liderança, SIGTERM): a rodada para antes da próxima escrita */
  cancelado?: () => boolean;
}

export interface ResumoDaRodada {
  unit: string;
  lidos: number;
  /** categorias que não são chats (formulário, ligação, e-mail): ficam como estão */
  foraDeEscopo: number;
  aguardando: number;
  jaVistos: number;
  avaliados: number;
  vinculados: number;
  aceitos: number;
  /** seco */
  vincularia: number;
  aceitaria: number;
  ambiguos: number;
  semParVelho: number;
  semTelefone: number;
  jaResolvidos: number;
  adiados: number;
  erros: number;
  /** a lista tinha mais páginas do que o teto */
  listaTruncada: boolean;
  /** parou antes do fim (erro que repete, ou conta em descanso) */
  encerrouCedo: string | null;
}

const resumoNovo = (unit: string): ResumoDaRodada => ({
  unit, lidos: 0, foraDeEscopo: 0, aguardando: 0, jaVistos: 0, avaliados: 0, vinculados: 0, aceitos: 0, vincularia: 0, aceitaria: 0,
  ambiguos: 0, semParVelho: 0, semTelefone: 0, jaResolvidos: 0, adiados: 0, erros: 0, listaTruncada: false, encerrouCedo: null,
});

const pausaPadrao = () => new Promise<void>((r) => setTimeout(r, PAUSA_ENTRE_ESCRITAS_MS));

/** Fim da rodada por causa de um erro de rede/Kommo: o que não foi feito continua na caixa. */
class RodadaEncerrada extends Error {}

const MOTIVO_DO_NADA: Record<Extract<Decisao, { tipo: 'nada' }>['motivo'], string> = {
  ambiguo: 'o telefone tem mais de um cartão aberto: decidir qual é da conversa é da recepção',
  'sem-par-velho': 'sem cartão do mesmo telefone, mas a conversa é antiga: aceitar mandaria mensagem de boas-vindas fora de hora',
  'sem-telefone': 'o contato não tem telefone: não dá para saber se já existe cartão',
  'sem-contato': 'o lead de entrada não tem contato',
  'busca-cheia': 'a busca por telefone voltou cheia: pode haver mais cartões do que foram vistos',
};

/**
 * Uma rodada numa conta Kommo. Nunca lança por causa do Kommo: o que falhou fica na caixa e conta em `erros`/`encerrouCedo`.
 * `seco` por modo: decide, loga e registra para a tela, sem escrever nada (nem nota).
 */
export async function rodarConta(kommo: PortaKommo, ctx: ContextoDaRodada): Promise<ResumoDaRodada> {
  const { unit, cfg, memoria } = ctx;
  const resumo = resumoNovo(unit.slug);
  if (ctx.recente === 'desligado' && ctx.estoque === 'desligado') return resumo;
  if (memoria.bloqueadaAte > Date.now()) {
    resumo.encerrouCedo = 'conta em descanso depois de um erro (Kommo fora, ou token sem direito de administrador)';
    return resumo;
  }
  const pausa = ctx.pausa ?? pausaPadrao;

  try {
    const { itens, completa } = await kommo.listarEntrada({ categoria: 'chats', maxPaginas: cfg.maxPaginas });
    resumo.lidos = itens.length;
    resumo.listaTruncada = !completa;
    const chats = itens.filter((i) => i.categoria === 'chats');
    resumo.foraDeEscopo = itens.length - chats.length;

    // quem vai ser olhado: recente (do mais velho ao mais novo: quem espera há mais tempo), depois estoque (do mais novo)
    const recentes: EntradaDoKommo[] = [];
    const velhos: EntradaDoKommo[] = [];
    for (const i of chats) {
      const idade = ctx.agora - i.criadoEm;
      if (idade < cfg.esperaS) resumo.aguardando++;
      else if (idade < cfg.janelaS) {
        if (ctx.recente !== 'desligado') recentes.push(i);
      } else if (ctx.estoque !== 'desligado') velhos.push(i);
    }
    recentes.sort((a, b) => a.criadoEm - b.criadoEm);
    velhos.sort((a, b) => b.criadoEm - a.criadoEm);
    const fila = [...recentes.map((i) => ({ i, modo: 'recente' as const })), ...velhos.map((i) => ({ i, modo: 'estoque' as const }))];
    if (fila.length === 0) return resumo;

    const idsDaCaixa = new Set(itens.map((i) => i.leadId).filter((x): x is number => typeof x === 'number'));
    let pipelines: KommoPipeline[] | null = null;
    const funis = async () => (pipelines ??= await kommo.listPipelines());

    let escritas = 0;
    let permanentesSeguidos = 0;
    const telefonesDaRodada = new Set<string>();

    for (const { i, modo } of fila) {
      if (resumo.avaliados >= cfg.maxAvaliacoes || escritas >= cfg.maxEscritas) break;
      if (ctx.cancelado?.()) {
        resumo.encerrouCedo = 'o worker foi parado no meio da rodada';
        return resumo;
      }
      const estado = modo === 'recente' ? ctx.recente : ctx.estoque;
      const automacao = modo === 'recente' ? ID_ENTRADA : ID_ESTOQUE;
      const chaveVisto = `${estado}:${i.uid}`;
      const ate = memoria.vistoAte.get(chaveVisto);
      if (ate && ate > Date.now()) {
        resumo.jaVistos++;
        continue;
      }
      if (ate) memoria.vistoAte.delete(chaveVisto);
      const visto = (ms = modo === 'estoque' ? VISTO_ESTOQUE_MS : VISTO_MS) => {
        if (memoria.vistoAte.size > 20_000) for (const [k, t] of memoria.vistoAte) if (t <= Date.now()) memoria.vistoAte.delete(k);
        memoria.vistoAte.set(chaveVisto, Date.now() + ms);
      };
      const simular = (acao: Simulacao['acao'], alvo: string, valor: unknown, motivo: string) => {
        if (i.leadId) ctx.registrar({ automacao, leadId: i.leadId, acao, alvo, valor, motivo });
      };

      // onde estamos: 404 numa LEITURA é contato apagado; 404 numa ESCRITA é "o lead já saiu da caixa"
      let fase: 'ler' | 'escrever' = 'ler';
      try {
        // 1. quem é: os telefones do contato do lead de entrada
        if (!i.contatoId) {
          resumo.avaliados++;
          resumo.semTelefone++;
          visto();
          simular('pularia', 'lead de entrada', null, MOTIVO_DO_NADA['sem-contato']);
          logger.info({ unit: unit.slug, uid: i.uid, modo }, `${automacao}: sem contato — não faço nada`);
          continue;
        }
        const telefones = await kommo.telefonesDoContato(i.contatoId);
        const chaves = [...new Set(telefones.map(chaveFone).filter((k): k is string => !!k))];
        if (chaves.some((k) => telefonesDaRodada.has(k))) {
          // outro lead do MESMO telefone acabou de ser tratado nesta rodada: a busca do Kommo pode não ter visto o cartão novo ainda
          resumo.adiados++;
          continue;
        }
        resumo.avaliados++;

        // 2. quem mais tem este telefone: a busca do Kommo é difusa, então cada contato devolvido é CONFERIDO pelo telefone
        const cartaoIds = new Set<number>();
        let buscaCheia = false;
        for (const k of chaves) {
          const achados = await kommo.buscarContatos(k, 50);
          if (achados === null) throw new RodadaEncerrada('a busca por telefone falhou: o lead fica na caixa (não dá para dizer "sem cartão")');
          if (achados.length >= 50) buscaCheia = true;
          for (const c of achados) {
            if (!c.telefones.some((t) => telefones.some((meu) => mesmoTelefone(t, meu)))) continue;
            for (const id of c.leadIds) cartaoIds.add(id);
          }
        }
        for (const id of idsDaCaixa) cartaoIds.delete(id);

        // 3. destes, os abertos
        const entradaDosFunis = etapasDeEntrada(await funis());
        const cartoes = cartaoIds.size ? await kommo.listLeadsPorIds([...cartaoIds]) : [];
        const abertos = cartoes.filter((l) => cartaoAberto(l, entradaDosFunis)).map((l) => l.id);

        const d = decidir(modo, { temTelefone: chaves.length > 0, buscaCheia }, abertos);

        // 4. o que fazer
        if (ctx.cancelado?.()) {
          resumo.encerrouCedo = 'o worker foi parado no meio da rodada';
          return resumo;
        }
        fase = 'escrever';
        if (d.tipo === 'nada') {
          if (d.motivo === 'ambiguo') resumo.ambiguos++;
          else if (d.motivo === 'sem-par-velho') resumo.semParVelho++;
          else if (d.motivo === 'sem-telefone') resumo.semTelefone++;
          visto();
          simular('pularia', 'lead de entrada', d.motivo === 'ambiguo' ? abertos.join(', ') : null, MOTIVO_DO_NADA[d.motivo]);
          logger.info({ unit: unit.slug, uid: i.uid, leadId: i.leadId, modo, motivo: d.motivo, cartoes: abertos }, `${automacao}: deixei na caixa — ${MOTIVO_DO_NADA[d.motivo]}`);
          continue;
        }

        if (d.tipo === 'vincular') {
          escritas++;
          if (estado === 'seco') {
            resumo.vincularia++;
            visto();
            simular('gravaria', `vincular ao cartão ${d.cartaoId}`, d.cartaoId, 'o telefone bate com um cartão aberto: a conversa cairia nele');
            logger.info({ unit: unit.slug, uid: i.uid, leadId: i.leadId, cartaoId: d.cartaoId, modo }, `${automacao} [seco]: vincularia`);
            chaves.forEach((k) => telefonesDaRodada.add(k));
            continue;
          }
          await kommo.vincularEntrada(i.uid, d.cartaoId);
          resumo.vinculados++;
          chaves.forEach((k) => telefonesDaRodada.add(k));
          logger.info({ unit: unit.slug, uid: i.uid, leadId: i.leadId, cartaoId: d.cartaoId, modo }, `${automacao}: vinculei ao cartão aberto do mesmo telefone`);
          await kommo
            .addLeadNote(d.cartaoId, 'A conversa do WhatsApp que estava em "Leads de entrada" foi vinculada a este cartão automaticamente (o telefone é o mesmo).')
            .catch(() => null);
          permanentesSeguidos = 0;
          await pausa();
          continue;
        }

        // aceitar (só no modo recente: `decidir` nunca devolve isso para o estoque)
        const etapa = primeiraEtapaDoFunil(await funis(), i.pipelineId);
        if (!etapa) {
          resumo.erros++;
          visto();
          logger.warn({ unit: unit.slug, uid: i.uid, pipelineId: i.pipelineId }, `${automacao}: não achei a primeira etapa do funil do lead — não aceitei`);
          continue;
        }
        escritas++;
        if (estado === 'seco') {
          resumo.aceitaria++;
          visto();
          simular('moveria', `aceitar na etapa «${etapa.nome}»`, etapa.id, 'lead de entrada recente, sem cartão aberto do mesmo telefone');
          logger.info({ unit: unit.slug, uid: i.uid, leadId: i.leadId, etapa: etapa.nome }, `${automacao} [seco]: aceitaria`);
          chaves.forEach((k) => telefonesDaRodada.add(k));
          continue;
        }
        const r = await kommo.aceitarEntrada(i.uid, etapa.id);
        resumo.aceitos++;
        chaves.forEach((k) => telefonesDaRodada.add(k));
        logger.info({ unit: unit.slug, uid: i.uid, leadId: r.leadId ?? i.leadId, etapa: etapa.nome }, `${automacao}: aceitei na primeira etapa do funil`);
        const cartao = r.leadId ?? i.leadId;
        if (cartao) {
          await kommo
            .addLeadNote(cartao, `Lead de entrada aceito automaticamente (conversa recente, sem cartão aberto com este telefone). Etapa: ${etapa.nome}.`)
            .catch(() => null);
        }
        permanentesSeguidos = 0;
        await pausa();
      } catch (err) {
        if (err instanceof RodadaEncerrada) {
          resumo.erros++;
          visto(VISTO_FALHA_MS);
          memoria.bloqueadaAte = Date.now() + DESCANSO_CURTO_MS;
          resumo.encerrouCedo = err.message;
          return resumo;
        }
        const classe = classeDoErro(err);
        if (classe === 'ja-resolvido' && fase === 'ler') {
          // 404 ao ler o contato: contato apagado ou unido. Não é "alguém tratou": o lead continua na caixa, sem como ser avaliado
          resumo.erros++;
          visto(VISTO_ESTOQUE_MS);
          logger.warn({ err: String(err), unit: unit.slug, uid: i.uid, leadId: i.leadId, modo }, `${automacao}: o contato do lead de entrada não existe mais — deixei na caixa`);
          continue;
        }
        if (classe === 'ja-resolvido') {
          resumo.jaResolvidos++; // alguém (a recepção, a Sofia) foi mais rápido: a caixa já está certa
          logger.info({ unit: unit.slug, uid: i.uid, leadId: i.leadId, modo }, `${automacao}: o lead de entrada já saiu da caixa (404) — nada a fazer`);
          continue;
        }
        resumo.erros++;
        logger.warn({ err: String(err), unit: unit.slug, uid: i.uid, leadId: i.leadId, modo }, `${automacao}: erro num lead de entrada — ele fica na caixa`);
        if (classe === 'transitorio') {
          visto(VISTO_FALHA_MS);
          memoria.bloqueadaAte = Date.now() + DESCANSO_CURTO_MS;
          resumo.encerrouCedo = 'o Kommo falhou (429, 5xx ou rede): a conta descansa 5 minutos e tento de novo';
          return resumo;
        }
        visto(6 * 60 * 60_000); // não bate no mesmo lead de 3 em 3 minutos por um erro que não passa
        if (++permanentesSeguidos >= ERROS_PERMANENTES_QUE_ENCERRAM) {
          memoria.bloqueadaAte = Date.now() + BLOQUEIO_MS;
          resumo.encerrouCedo = 'três erros seguidos que não passam sozinhos (token sem direito?): a conta descansa por 1 hora';
          return resumo;
        }
      }
    }
    return resumo;
  } catch (err) {
    // a leitura da caixa (ou dos funis) falhou: nada foi feito
    resumo.erros++;
    resumo.encerrouCedo = `não consegui ler o Kommo: ${String(err).slice(0, 200)}`;
    memoria.bloqueadaAte = Date.now() + (classeDoErro(err) === 'permanente' ? BLOQUEIO_MS : DESCANSO_CURTO_MS);
    logger.warn({ err: String(err), unit: unit.slug }, 'entrada-automatica: não consegui ler a caixa de entrada');
    return resumo;
  }
}
