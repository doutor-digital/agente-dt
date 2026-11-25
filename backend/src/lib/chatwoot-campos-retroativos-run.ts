/**
 * O miolo do preenchimento retroativo de campos do CRM (`scripts/preencher-campos-crm.ts`): lê as conversas da caixa, pergunta ao Kommo e à
 * Sofia o que cada uma é, decide (`decidirCampos`, pura) e grava. Separado do script para ser testado com portas de mentira.
 *
 * Ordem de gravação POR CONVERSA (cada passo existe por um motivo, ver `chatwoot-campos-retroativos.ts`):
 *   1. relê a conversa (e a última mensagem PÚBLICA, como o worker da régua) e decide de novo — só campo vazio;
 *   2. MARCAS: a etapa entra na memória da régua como `inicial` e o evento de conversão da Meta como `inicial` — ANTES do campo existir;
 *   3. relê de novo, JUNTO antes de gravar (o Chatwoot SUBSTITUI o objeto inteiro: quem gravou no meio não pode ser apagado), e grava campos e etiqueta;
 *   4. GUARDA das marcas: um ciclo da régua que tenha LISTADO a conversa antes do passo 3 (a listagem leva minutos) apaga a marca quando salva a
 *      memória, bem depois. A guarda reafirma as marcas de 30 em 30 s DURANTE a gravação (o lote leva um ciclo inteiro) e por mais 12 min no fim.
 * Cada conversa gravada deixa uma linha `REG {…}`: é o registro para desfazer (`--desfazer`). A saída não tem nome, telefone nem texto de paciente.
 *
 * DESFAZER: tira só o campo que ainda é o que a gente gravou. NÃO apaga a marca da régua (a própria régua a tira quando o campo some; apagá-la antes
 * faria um ciclo com a listagem velha enxergar «etapa nova» e mandar a mensagem). As marcas do CAPI só saem depois de uma guarda e com o campo
 * conferido vazio de novo.
 */
import { conversaDoChatwoot, ehArquivo, historicoSilencia, type AjustesDaRegua, type ConversaRegua, type MensagemResumo, type Vistos } from './chatwoot-regua.js';
import type { EventoCapi } from './chatwoot-capi.js';
import { BuscaDeContatosIncompleta } from './chatwoot-campos-retroativos-kommo.js';
import {
  chaveDoFone,
  decidirCampos,
  ETIQUETA_CONFERIR_ETAPA,
  type EntradaDaConversa,
  type FatoDeQualificacao,
  type LeadDoKommo,
  type Plano,
  type RegraDoCampo,
} from './chatwoot-campos-retroativos.js';

/** A linha da memória da régua como estava antes de a marca passar por cima dela. */
export interface VistoAnterior {
  valor: string;
  inicial: boolean;
  /** ISO */
  desde: string;
}
export type ComoMarcou = 'criou' | 'atualizou' | 'igual';

export interface PortasDosCampos {
  /** a listagem inteira da caixa (todas as páginas); `truncado` = bateu no teto de páginas */
  conversas(): Promise<{ lista: any[]; truncado: boolean }>;
  fresca(id: number): Promise<any | null>;
  /** a última mensagem PÚBLICA da conversa (null = nenhuma): é o que o worker da régua olha nas etapas de qualificação */
  ultimaPublica(id: number): Promise<MensagemResumo | null>;
  /** os cartões do Kommo deste telefone (lança se o Kommo falhou: nunca «sem cartão» por engano; `BuscaDeContatosIncompleta` = não deu para fechar a busca: vira «ambíguo», nada é gravado) */
  leadsDoKommo(telefone: string): Promise<LeadDoKommo[]>;
  qualificacoes(leadIds: number[]): Promise<FatoDeQualificacao[]>;
  vistosDaCaixa(): Promise<Map<number, Vistos>>;
  vistosDe(id: number): Promise<Vistos>;
  motivosValidos(): Promise<string[]>;
  /** os tempos e modelos que a Gestora pôs na tela «Robôs» (a régua de verdade usa estes) */
  ajustesDaRegua(): Promise<AjustesDaRegua | undefined>;
  /** upsert da marca `inicial` da régua; só escreve se for diferente */
  marcarVisto(id: number, campo: string, valor: string, agora: Date): Promise<{ como: ComoMarcou; antes?: VistoAnterior }>;
  /** `atualizou` = a linha existia como «novo» (o worker mandaria o evento): passa a `inicial` */
  marcarCapi(id: number, evento: EventoCapi, agora: Date): Promise<ComoMarcou>;
  /**
   * A reafirmação (durante e depois de gravar): só CRIA a linha que sumiu (ou volta `inicial` se o valor é o mesmo). Linha com OUTRO valor é
   * mudança legítima de etapa (a equipe moveu, a régua registrou): `divergente`, não se mexe.
   */
  reafirmarVisto(id: number, campo: string, valor: string, agora: Date): Promise<'igual' | 'recriou' | 'divergente'>;
  apagarVisto(id: number, campo: string): Promise<void>;
  restaurarVisto(id: number, campo: string, antes: VistoAnterior): Promise<void>;
  apagarCapi(id: number, evento: EventoCapi): Promise<void>;
  restaurarCapi(id: number, evento: EventoCapi): Promise<void>;
  gravarAtributos(id: number, attrs: Record<string, unknown>): Promise<void>;
  gravarEtiquetas(id: number, etiquetas: string[]): Promise<void>;
  pausa(ms: number): Promise<void>;
}

export interface OpcoesDosCampos {
  soConferir: boolean;
  caixa: number;
  /** teto de conversas gravadas por execução */
  max: number;
  /** só estas conversas (vazio = a caixa toda) */
  so: number[] | null;
  /** minutos de guarda depois de gravar (tem de passar de um ciclo da régua, que é de 10 min) */
  guardaMin: number;
}

export function lerArgumentos(argv: string[]): OpcoesDosCampos & { desfazer: boolean } {
  const o: OpcoesDosCampos & { desfazer: boolean } = { soConferir: false, caixa: 3, max: 150, so: null, guardaMin: 12, desfazer: false };
  for (const a of argv) {
    if (a === '--so-conferir') o.soConferir = true;
    else if (a === '--desfazer') o.desfazer = true;
    else if (/^--caixa=\d+$/.test(a)) o.caixa = Number(a.slice('--caixa='.length));
    else if (/^--max=\d+$/.test(a)) o.max = Number(a.slice('--max='.length));
    else if (/^--guarda=\d+$/.test(a)) o.guardaMin = Number(a.slice('--guarda='.length));
    else if (/^--conversas=\d+(,\d+)*$/.test(a)) o.so = a.slice('--conversas='.length).split(',').map(Number);
    else throw new Error(`opção inválida: ${a} (use --so-conferir, --desfazer, --caixa=N, --max=N, --guarda=MIN, --conversas=1,2,3)`);
  }
  if (!Number.isInteger(o.caixa) || o.caixa <= 0) throw new Error(`caixa inválida: ${o.caixa}`);
  if (!Number.isInteger(o.max) || o.max <= 0) throw new Error(`--max inválido: ${o.max}`);
  if (o.guardaMin > 60) throw new Error(`--guarda inválido: ${o.guardaMin} (máximo 60 minutos)`);
  // um ciclo da régua leva até 10 min: guarda menor deixa a janela da marca apagada aberta (e a do CAPI no desfazer). Só o seco dispensa.
  if (!o.soConferir && o.guardaMin < 11) throw new Error(`--guarda inválido: ${o.guardaMin} (para gravar ou desfazer precisa ser de 11 a 60 minutos: um ciclo da régua leva até 10)`);
  return o;
}

export interface ResumoDosCampos {
  conversas: number;
  /** com algum campo vazio dos que as regras preenchem */
  comCampoVazio: number;
  jaMarcadasParaConferir: number;
  irmas: number;
  semCartao: number;
  /** gravações previstas (seco) ou feitas, por regra */
  porRegra: Partial<Record<RegraDoCampo, number>>;
  conversasComAlteracao: number;
  /** das que recebem algo: quantas são arquivo (`historico`, parado) e acordam ao serem tocadas */
  arquivoQueAcorda: number;
  /** das que recebem algo: resolvidas, fora do histórico e SEM etapa depois de gravar → o resolver do webhook põe a etiqueta `falta-etapa` (e mexe na última atividade) */
  ganhamFaltaEtapa: number;
  bloqueios: Record<string, number>;
  semRegra: Record<string, number>;
  erros: number;
  gravadas: number;
  falhas: number;
  /** vezes que a guarda achou uma marca da régua apagada e a recriou */
  marcasReafirmadas: number;
  /** conversas em que a última atividade andou depois da gravação (acordam se eram arquivo; pode ser também o paciente escrevendo) */
  atividadeMexeu: number;
  truncado: boolean;
  parouPor: string | null;
}

const vazio = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const somar = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);
const atividadeDe = (raw: any): number => Number(raw?.last_activity_at) || 0;
/** O erro do Kommo traz o telefone na mensagem: no log vai só o status. */
const motivoDoErro = (err: unknown): string => {
  const s = Number((err as { status?: unknown })?.status);
  return Number.isInteger(s) && s > 0 ? `HTTP ${s}` : 'falha na consulta';
};

/** Os campos que as regras preenchem: conversa com todos eles já preenchidos não precisa nem de consulta ao Kommo. */
function algumCampoVazio(attrs: Record<string, unknown>): boolean {
  return vazio(attrs.etapa) || vazio(attrs.qualificacao) || (vazio(attrs.funil) && vazio(attrs.etapa_tratamento));
}

const MAX_ERROS_SEGUIDOS_DO_KOMMO = 5;
/** ≤ 4 requisições por segundo no Kommo (a busca e a leitura dos cartões de um telefone são 2: 300 ms depois de cada uma + a pausa do cliente) */
const PAUSA_ENTRE_CONSULTAS_MS = 300;
const PAUSA_ENTRE_ESCRITAS_MS = 400;
const PAUSA_ANTES_DE_REAFIRMAR_MS = 2500;
const PAUSA_DA_GUARDA_MS = 30_000;
/** durante a gravação, a guarda passa a cada tantas conversas gravadas (≈ 30 s: cada uma leva ~4 s) ou a cada 30 s de relógio, o que vier primeiro */
const CONVERSAS_ENTRE_GUARDAS = 6;

export interface Registro {
  conversa: number;
  /** campo → valor gravado (os campos estavam vazios: o desfazer só tira o campo, e só se ainda for este valor) */
  depois: Record<string, string>;
  etiqueta: string | null;
  visto: Array<{ campo: string; como: ComoMarcou; antes?: VistoAnterior }>;
  capi: Array<{ evento: EventoCapi; como: ComoMarcou }>;
  em: string;
}

/** A conversa cujo número tem contatos demais no Kommo para eu ter certeza do cartão: nada é decidido nem gravado (nem «sem cartão»); a equipe decide. */
function planoAmbiguo(c: ConversaRegua, raw: any, motivosValidos: string[], ajustes: AjustesDaRegua | undefined, detalhe: string): { plano: Plano; ent: Omit<EntradaDaConversa, 'vistos'>; raw: any } {
  return {
    plano: { conversa: c.id, alteracoes: [], etiquetaNova: null, bloqueios: [{ codigo: 'kommo-ambiguo', detalhe }], semRegra: null, marcasVisto: [], marcasCapi: [] },
    ent: { conv: c, status: String(raw?.status ?? ''), leads: [], qualificacoes: [], motivosValidos, ajustes },
    raw,
  };
}

export async function rodarCampos(o: OpcoesDosCampos, p: PortasDosCampos, log: (linha: string) => void, agora: () => Date = () => new Date()): Promise<ResumoDosCampos> {
  const r: ResumoDosCampos = { conversas: 0, comCampoVazio: 0, jaMarcadasParaConferir: 0, irmas: 0, semCartao: 0, porRegra: {}, conversasComAlteracao: 0, arquivoQueAcorda: 0, ganhamFaltaEtapa: 0, bloqueios: {}, semRegra: {}, erros: 0, gravadas: 0, falhas: 0, marcasReafirmadas: 0, atividadeMexeu: 0, truncado: false, parouPor: null };
  const { lista, truncado } = await p.conversas();
  r.truncado = truncado;
  if (truncado) log('AVISO  bati no teto de páginas da listagem: pode haver conversa que não foi vista (e irmãs do mesmo telefone sem ver)');
  const todas = lista.flatMap((raw) => {
    const c = conversaDoChatwoot(raw);
    return c ? [{ raw, c }] : [];
  });
  r.conversas = todas.length;
  const [motivosValidos, vistosDaCaixa, ajustes] = [await p.motivosValidos(), await p.vistosDaCaixa(), await p.ajustesDaRegua()];

  const porTelefone = new Map<string, typeof todas>();
  for (const x of todas) {
    const k = chaveDoFone(x.c.telefone);
    if (k) porTelefone.set(k, [...(porTelefone.get(k) ?? []), x]);
  }
  const jaTemEtapa = (a: Record<string, unknown>) => !vazio(a.etapa) || !vazio(a.funil) || !vazio(a.etapa_tratamento);

  const alvos = todas.filter((x) => !o.so || o.so.includes(x.c.id));
  const planos: Array<{ plano: Plano; ent: Omit<EntradaDaConversa, 'vistos'>; raw: any }> = [];
  const cacheDoKommo = new Map<string, LeadDoKommo[]>();
  const cortadosDoKommo = new Set<string>();
  let errosSeguidos = 0;
  for (const { raw, c } of alvos) {
    if (!algumCampoVazio(c.attrs)) continue;
    r.comCampoVazio++;
    if (c.etiquetas.includes(ETIQUETA_CONFERIR_ETAPA)) {
      r.jaMarcadasParaConferir++;
      continue;
    }
    const chave = chaveDoFone(c.telefone);
    // a irmã (mesmo telefone) que já tem etapa/funil: a pessoa já está no funil; esta não a duplica
    if ((chave ? porTelefone.get(chave) ?? [] : []).some((x) => x.c.id !== c.id && jaTemEtapa(x.c.attrs))) {
      r.irmas++; // (só conta: a maioria nem tem cartão no Kommo, listar uma a uma seria ruído)
      continue;
    }
    let leads: LeadDoKommo[] = [];
    if (c.telefone && chave) {
      const guardado = cacheDoKommo.get(chave);
      if (cortadosDoKommo.has(chave)) {
        // outra conversa do mesmo número já mostrou que a busca não fecha: mesma resposta, sem bater de novo no Kommo
        planos.push(planoAmbiguo(c, raw, motivosValidos, ajustes, 'a busca deste número no Kommo voltou cheia demais para eu ter certeza do cartão: a equipe decide'));
        continue;
      }
      if (guardado) leads = guardado;
      else {
        try {
          leads = await p.leadsDoKommo(c.telefone);
          cacheDoKommo.set(chave, leads);
          errosSeguidos = 0;
        } catch (err) {
          if (err instanceof BuscaDeContatosIncompleta) {
            // não é falha do Kommo: o número tem contatos demais para eu ter certeza de qual é o cartão. Nada é decidido (nem «sem cartão»): vai para a equipe
            cortadosDoKommo.add(chave);
            errosSeguidos = 0;
            planos.push(planoAmbiguo(c, raw, motivosValidos, ajustes, `${err.message}: a equipe decide`));
            await p.pausa(PAUSA_ENTRE_CONSULTAS_MS);
            continue;
          }
          r.erros++;
          errosSeguidos++;
          log(`ERRO   conversa ${c.id}: não consegui ler o Kommo (${motivoDoErro(err)}) — não decido esta`);
          if (errosSeguidos >= MAX_ERROS_SEGUIDOS_DO_KOMMO) {
            r.parouPor = `o Kommo falhou ${MAX_ERROS_SEGUIDOS_DO_KOMMO} vezes seguidas`;
            log(`PAROU  ${r.parouPor}: nada mais é decidido nesta execução`);
            break;
          }
          await p.pausa(PAUSA_ENTRE_CONSULTAS_MS);
          continue;
        }
        await p.pausa(PAUSA_ENTRE_CONSULTAS_MS);
      }
    }
    let qualificacoes: FatoDeQualificacao[] = [];
    if (leads.length && vazio(c.attrs.qualificacao)) {
      try {
        qualificacoes = await p.qualificacoes(leads.map((l) => l.id));
      } catch {
        r.erros++;
        log(`ERRO   conversa ${c.id}: não consegui ler a classificação da Sofia — a qualificação desta fica de fora`);
      }
    }
    if (!leads.length) r.semCartao++;
    let ent: Omit<EntradaDaConversa, 'vistos'> = { conv: c, status: String(raw?.status ?? ''), leads, qualificacoes, motivosValidos, ajustes };
    const vistos = vistosDaCaixa.get(c.id) ?? new Map();
    let plano = decidirCampos({ ...ent, vistos }, agora());
    // a última mensagem da listagem é muitas vezes uma NOTA privada; o worker da régua, em etapa de qualificação, troca por a última PÚBLICA: a trava olha a mesma
    if ((plano.alteracoes.length || plano.etiquetaNova) && c.ultima?.privada) {
      try {
        ent = { ...ent, ultimaPublica: await p.ultimaPublica(c.id) };
        plano = decidirCampos({ ...ent, vistos }, agora());
      } catch {
        r.erros++;
        log(`ERRO   conversa ${c.id}: não consegui ler a última mensagem pública — não decido esta`);
        continue;
      }
    }
    planos.push({ plano, ent, raw });
  }

  // uma conversa por telefone: duas conversas da mesma pessoa duplicariam o funil. Entre as que de fato receberiam algo, vale a de atividade mais recente
  // (empate: id maior); as outras ficam como estão. Decidido DEPOIS dos planos: a irmã que a trava segurou não pode tirar a vez da que pode gravar.
  const grupos = new Map<string, typeof planos>();
  for (const x of planos) {
    const k = chaveDoFone(x.ent.conv.telefone);
    if (k && (x.plano.alteracoes.length || x.plano.etiquetaNova)) grupos.set(k, [...(grupos.get(k) ?? []), x]);
  }
  for (const g of grupos.values()) {
    if (g.length < 2) continue;
    const vencedora = [...g].sort((a, b) => atividadeDe(b.raw) - atividadeDe(a.raw) || b.plano.conversa - a.plano.conversa)[0]!;
    for (const x of g) {
      if (x === vencedora) continue;
      r.irmas++;
      log(`PULA   conversa ${x.plano.conversa}  irma: a conversa ${vencedora.plano.conversa}, do mesmo telefone, é a mais recente e recebe o preenchimento`);
      x.plano = { ...x.plano, alteracoes: [], etiquetaNova: null, marcasVisto: [], marcasCapi: [] };
    }
  }

  // o relatório do que cada conversa teria
  for (const { plano, raw, ent } of planos) {
    for (const b of plano.bloqueios) {
      somar(r.bloqueios, b.codigo);
      log(`PULA   conversa ${plano.conversa}  ${b.codigo}: ${b.detalhe}`);
    }
    if (plano.semRegra) somar(r.semRegra, plano.semRegra);
    if (plano.alteracoes.length || plano.etiquetaNova) {
      r.conversasComAlteracao++;
      if (ehArquivo(raw, agora())) {
        r.arquivoQueAcorda++;
        log(`aviso  conversa ${plano.conversa}: é arquivo (histórico parado) e entra nos fluxos normais depois de gravada`);
      }
      const etapaDepois = plano.alteracoes.find((x) => x.campo === 'etapa')?.depois ?? ent.conv.attrs.etapa;
      if (ent.status === 'resolved' && !historicoSilencia(raw) && !ent.conv.etiquetas.includes('falta-etapa') && vazio(etapaDepois)) {
        r.ganhamFaltaEtapa++;
        log(`aviso  conversa ${plano.conversa}: resolvida e sem etapa depois de gravar — o resolver do webhook põe a etiqueta falta-etapa (e mexe na última atividade)`);
      }
    }
    for (const x of plano.alteracoes) {
      r.porRegra[x.regra] = (r.porRegra[x.regra] ?? 0) + 1;
      log(`${o.soConferir ? 'poria ' : 'põe   '} conversa ${plano.conversa}  ${x.campo}: (vazio) → ${x.depois}  [${x.regra}: ${x.porque}]`);
    }
    if (plano.etiquetaNova) {
      r.porRegra['espera-kommo'] = (r.porRegra['espera-kommo'] ?? 0) + 1;
      log(`${o.soConferir ? 'poria ' : 'põe   '} conversa ${plano.conversa}  etiqueta: + ${plano.etiquetaNova}  [espera-kommo: Kommo EM ESPERA]`);
    }
  }
  if (o.soConferir || r.parouPor) return r;
  if (truncado) {
    // sem a listagem inteira não dá para saber quem são as irmãs do mesmo telefone: gravar duplicaria o funil
    r.parouPor = 'a listagem da caixa foi cortada pelo teto de páginas: não gravo (aumente MAX_PAGINAS no script ou limpe/arquive conversas)';
    log(`PAROU  ${r.parouPor}`);
    return r;
  }

  // gravar
  let feitas = 0;
  const regs: Registro[] = [];
  /**
   * ÓRFÃ POR CAMPO: o campo gravado que «não ficou» (outro processo regravou o objeto) sai da guarda; os que ficaram CONTINUAM nela (a Sofia troca a
   * qualificação 2 s depois e a marca do Perdido que ficou tem de seguir guardada). Só a marca do campo que não ficou é solta; as do CAPI dele saem
   * depois da guarda, com a etapa conferida vazia.
   */
  const orfas = new Map<number, { reg: Registro; campos: Set<string> }>();
  const semGuarda = new Map<number, Set<string>>();
  let ultimaGuarda = Date.now();
  for (const { plano, ent } of planos) {
    if (!plano.alteracoes.length && !plano.etiquetaNova) continue;
    if (feitas >= o.max) {
      r.parouPor = `teto de ${o.max} conversas por execução (--max)`;
      log(`PAROU  ${r.parouPor}: rode de novo para as restantes`);
      break;
    }
    // a guarda DURANTE a gravação: o lote inteiro leva um ciclo da régua; as já gravadas não podem esperar o fim para serem protegidas
    if (regs.length && (feitas % CONVERSAS_ENTRE_GUARDAS === 0 || Date.now() - ultimaGuarda >= PAUSA_DA_GUARDA_MS)) {
      r.marcasReafirmadas += await passeDaGuarda(regs, semGuarda, p, log, agora);
      ultimaGuarda = Date.now();
    }
    feitas++;
    const out = await gravarUma(plano, ent, p, agora, log);
    if (out.reg) {
      regs.push(out.reg);
      log(`REG ${JSON.stringify(out.reg)}`);
    }
    if (out.orfos?.length && out.reg) {
      orfas.set(out.reg.conversa, { reg: out.reg, campos: new Set(out.orfos) });
      semGuarda.set(out.reg.conversa, new Set(out.orfos)); // não reafirma marca de campo que não ficou — só dele
    }
    if (out.erro) {
      r.falhas++;
      log(`FALHOU conversa ${plano.conversa}: ${out.erro}`);
    } else if (out.reg) r.gravadas++;
    if (out.mexeu) r.atividadeMexeu++;
    await p.pausa(PAUSA_ENTRE_ESCRITAS_MS);
  }
  if (regs.length && o.guardaMin > 0) r.marcasReafirmadas += await guardarMarcas(regs, semGuarda, p, o.guardaMin, log, agora);
  // a guarda final já esperou mais que um ciclo da régua depois de cada gravação; só espera de novo se não houve guarda
  if (orfas.size) await limparOrfas([...orfas.values()], p, regs.length ? 0 : o.guardaMin, log);
  return r;
}

/** Desfaz as marcas que ESTA execução pôs (e só elas): a linha nova some; a que já existia volta como era. `visto: false` deixa a da régua (ela mesma a tira). */
async function desfazerMarcas(reg: Pick<Registro, 'conversa' | 'visto' | 'capi'>, p: PortasDosCampos, o: { soCampos?: ReadonlySet<string>; visto?: boolean } = {}): Promise<void> {
  if (o.visto !== false) {
    for (const v of reg.visto) {
      if (o.soCampos && !o.soCampos.has(v.campo)) continue;
      if (v.como === 'criou') await p.apagarVisto(reg.conversa, v.campo);
      else if (v.como === 'atualizou' && v.antes) await p.restaurarVisto(reg.conversa, v.campo, v.antes);
    }
  }
  for (const x of reg.capi) {
    if (o.soCampos && !o.soCampos.has('etapa')) continue; // o evento de conversão nasce da etapa
    if (x.como === 'criou') await p.apagarCapi(reg.conversa, x.evento);
    else if (x.como === 'atualizou') await p.restaurarCapi(reg.conversa, x.evento);
  }
}

/** Relê a conversa e junta o que existe AGORA com o que vamos gravar (padrão `portaDoChatwoot.gravarAtributos`): quem gravou no meio não é apagado. */
async function lerParaGravar(p: PortasDosCampos, id: number): Promise<{ attrs: Record<string, unknown>; etiquetas: string[] }> {
  const f = await p.fresca(id);
  const c = f ? conversaDoChatwoot(f) : null;
  if (!f || !c) throw new Error('não consegui reler a conversa');
  return { attrs: { ...c.attrs }, etiquetas: [...c.etiquetas] };
}

async function gravarUma(planoPrevisto: Plano, ent: Omit<EntradaDaConversa, 'vistos'>, p: PortasDosCampos, agora: () => Date, log: (l: string) => void): Promise<{ reg: Registro | null; erro?: string; mexeu?: boolean; orfos?: string[] }> {
  const id = planoPrevisto.conversa;
  const reg: Registro = { conversa: id, depois: {}, etiqueta: null, visto: [], capi: [], em: agora().toISOString() };
  let escreveu = false;
  let tentouCampos = false;
  try {
    const fresca = await p.fresca(id);
    const lida = fresca ? conversaDoChatwoot(fresca) : null;
    if (!fresca || !lida) throw new Error('não consegui reler a conversa');
    // a leitura de UMA conversa não traz `last_non_activity_message` (só a listagem traz): as regras internas da qualificação olhariam uma conversa
    // «sem mensagens» e liberariam o que a listagem tinha segurado. E, como o worker, em etapa de qualificação vale a última PÚBLICA, lida agora.
    const c = { ...lida, ultima: lida.ultima ?? ent.conv.ultima };
    const ultimaPublica = c.ultima?.privada ? await p.ultimaPublica(id) : undefined;
    // 1. decide de novo com a conversa e a memória de AGORA
    const plano = decidirCampos({ ...ent, conv: c, status: String(fresca.status ?? ''), vistos: await p.vistosDe(id), ultimaPublica }, agora());
    if (!plano.alteracoes.length && !plano.etiquetaNova) {
      log(`nada   conversa ${id}: mudou desde a leitura (${plano.bloqueios.map((b) => b.codigo).join(', ') || 'já preenchida'}) — não gravo`);
      return { reg: null };
    }
    // 2. as marcas, ANTES do campo
    for (const m of plano.marcasVisto) reg.visto.push({ campo: m.campo, ...(await p.marcarVisto(id, m.campo, m.valor, agora())) });
    for (const ev of plano.marcasCapi) reg.capi.push({ evento: ev, como: await p.marcarCapi(id, ev, agora()) });
    // 3. relê JUNTO antes de gravar: se alguém preencheu um destes campos desde a decisão, não grava (e as marcas, que ainda não têm campo, saem)
    const agoraNoChatwoot = await lerParaGravar(p, id);
    if (plano.alteracoes.some((x) => !vazio(agoraNoChatwoot.attrs[x.campo])) || agoraNoChatwoot.etiquetas.includes(ETIQUETA_CONFERIR_ETAPA)) {
      await desfazerMarcas(reg, p);
      log(`nada   conversa ${id}: alguém preencheu um destes campos agora há pouco — não gravo`);
      return { reg: null };
    }
    if (plano.alteracoes.length) {
      const attrs = { ...agoraNoChatwoot.attrs };
      for (const x of plano.alteracoes) {
        attrs[x.campo] = x.depois;
        reg.depois[x.campo] = x.depois;
      }
      tentouCampos = true;
      await p.gravarAtributos(id, attrs);
      escreveu = true;
    }
    if (plano.etiquetaNova && !agoraNoChatwoot.etiquetas.includes(plano.etiquetaNova)) {
      await p.gravarEtiquetas(id, [...agoraNoChatwoot.etiquetas, plano.etiquetaNova]);
      escreveu = true;
      reg.etiqueta = plano.etiquetaNova;
    }
    // 4. reafirma já e confere (a guarda de minutos vem durante e no fim do lote)
    await p.pausa(PAUSA_ANTES_DE_REAFIRMAR_MS);
    for (const m of plano.marcasVisto) await p.reafirmarVisto(id, m.campo, m.valor, agora());
    const depois = await p.fresca(id);
    const attrsDepois = (depois?.custom_attributes ?? {}) as Record<string, unknown>;
    const orfos: string[] = [];
    for (const [campo, valor] of Object.entries(reg.depois)) {
      if (attrsDepois[campo] !== valor) {
        orfos.push(campo);
        log(`AVISO  conversa ${id}: ${campo} não ficou (outro processo gravou junto) — só a marca dele sai da guarda; rode de novo`);
      }
    }
    const mexeu = Number(depois?.last_activity_at) > Number(fresca.last_activity_at);
    if (mexeu) log(`AVISO  conversa ${id}: a última atividade andou depois de gravar (se era arquivo, entra nos fluxos normais)`);
    return { reg, mexeu, orfos };
  } catch (err) {
    const erro = err instanceof Error ? err.message.slice(0, 120) : 'erro';
    if (!escreveu && tentouCampos) {
      // o Chatwoot pode ter aplicado e a resposta se perdido (tempo esgotado, 5xx): antes de tirar as marcas, olha se o campo entrou
      const entrou = await p.fresca(id).then(
        (f) => Object.entries(reg.depois).every(([campo, valor]) => (f?.custom_attributes ?? {})[campo] === valor),
        () => null,
      );
      if (entrou !== false) {
        log(`AVISO  conversa ${id}: o Chatwoot respondeu erro, mas ${entrou ? 'o campo entrou' : 'não deu para conferir se o campo entrou'} — mantenho as marcas e o registro`);
        escreveu = true;
      }
    }
    // o campo não chegou a ser gravado: as marcas que esta execução pôs não podem ficar (calariam a Meta e a régua de uma etapa que nunca foi gravada)
    if (!escreveu) {
      await desfazerMarcas(reg, p).catch(() => log(`AVISO  conversa ${id}: não consegui desfazer as marcas — confira com --desfazer`));
      return { reg: null, erro };
    }
    // o campo foi gravado e algo depois falhou (etiqueta, conferência): o registro sai assim mesmo, para o --desfazer enxergar
    return { reg, erro };
  }
}

/** Uma volta da guarda: recria a marca da régua que algum ciclo (listagem velha) apagou. Só recria; nunca passa por cima de etapa que mudou de verdade. */
async function passeDaGuarda(regs: Registro[], semGuarda: ReadonlyMap<number, ReadonlySet<string>>, p: PortasDosCampos, log: (l: string) => void, agora: () => Date): Promise<number> {
  let reafirmadas = 0;
  for (const reg of regs) {
    for (const v of reg.visto) {
      const valor = reg.depois[v.campo];
      if (valor === undefined || semGuarda.get(reg.conversa)?.has(v.campo)) continue;
      try {
        if ((await p.reafirmarVisto(reg.conversa, v.campo, valor, agora())) === 'recriou') {
          reafirmadas++;
          log(`AVISO  conversa ${reg.conversa}: a marca da régua de ${v.campo} tinha sumido — reafirmei`);
        }
      } catch {
        log(`AVISO  conversa ${reg.conversa}: não consegui conferir a marca de ${v.campo} nesta volta`);
      }
    }
  }
  return reafirmadas;
}

/**
 * A GUARDA FINAL: o ciclo da régua lista as conversas (minutos) e só depois lê a memória; quem foi listado ANTES da gravação e teve a memória lida
 * DEPOIS da marca enxerga «etapa ausente» e apaga a marca ao salvar, bem depois da gravação. Reafirmar de 30 em 30 s por mais que um ciclo inteiro
 * fecha a janela: quando o ciclo seguinte lê a memória, a marca está lá.
 */
async function guardarMarcas(regs: Registro[], semGuarda: ReadonlyMap<number, ReadonlySet<string>>, p: PortasDosCampos, minutos: number, log: (l: string) => void, agora: () => Date): Promise<number> {
  const voltas = Math.ceil((minutos * 60_000) / PAUSA_DA_GUARDA_MS);
  log(`guarda das marcas da régua: ${regs.length} conversas, ${minutos} min (de 30 em 30 s) — o processo roda na VPS, pode fechar o terminal`);
  let reafirmadas = 0;
  for (let i = 0; i < voltas; i++) {
    await p.pausa(PAUSA_DA_GUARDA_MS);
    reafirmadas += await passeDaGuarda(regs, semGuarda, p, log, agora);
  }
  log(`guarda terminada: ${reafirmadas} reafirmação(ões)`);
  return reafirmadas;
}

/** Marcas do CAPI de conversa em que o campo não ficou: só saem se, depois da guarda, a etapa continua vazia (a listagem velha de um ciclo já não existe). */
async function limparOrfas(orfas: Array<{ reg: Registro; campos: Set<string> }>, p: PortasDosCampos, guardaMin: number, log: (l: string) => void): Promise<void> {
  await esperar(p, guardaMin);
  for (const { reg, campos } of orfas) {
    if (!campos.has('etapa')) continue; // o evento de conversão nasce da etapa: se ela ficou, as marcas do CAPI ficam
    try {
      const { attrs } = await lerParaGravar(p, reg.conversa);
      if (vazio(attrs.etapa)) await desfazerMarcas(reg, p, { soCampos: new Set(['etapa']), visto: false });
      else log(`AVISO  conversa ${reg.conversa}: a etapa não está vazia — as marcas do CAPI ficam`);
    } catch {
      log(`AVISO  conversa ${reg.conversa}: não consegui conferir a etapa — as marcas do CAPI ficam`);
    }
  }
}

async function esperar(p: PortasDosCampos, minutos: number): Promise<void> {
  for (let i = 0; i < Math.ceil((minutos * 60_000) / PAUSA_DA_GUARDA_MS); i++) await p.pausa(PAUSA_DA_GUARDA_MS);
}

/**
 * `--desfazer`: lê as linhas `REG` de uma execução e devolve cada conversa ao que era (só o que ainda é o que a gente gravou).
 * A marca da régua NÃO é apagada (a régua a tira quando o campo some; apagá-la antes faria um ciclo com listagem velha mandar a mensagem de «etapa nova»).
 * A marca do CAPI só sai depois da guarda e com a etapa conferida vazia.
 */
export async function desfazerCampos(linhas: string[], p: PortasDosCampos, log: (l: string) => void, guardaMin = 12): Promise<{ desfeitas: number; puladas: number; capiLimpas: number }> {
  let desfeitas = 0;
  let puladas = 0;
  const paraLimpar: Registro[] = [];
  for (const linha of linhas) {
    const m = /^REG (\{.*\})\s*$/.exec(linha.trim());
    if (!m) continue;
    let reg: Registro;
    try {
      reg = JSON.parse(m[1]!) as Registro;
      if (!Number.isInteger(reg.conversa) || typeof reg.depois !== 'object' || reg.depois === null || !Array.isArray(reg.visto) || !Array.isArray(reg.capi)) throw new Error('formato');
    } catch {
      puladas++;
      log('PULA   uma linha REG estragada (JSON incompleto): as outras seguem');
      continue;
    }
    try {
      // relê JUNTO imediatamente antes de gravar: quem mexeu no meio não é apagado
      const atual = await lerParaGravar(p, reg.conversa);
      const attrs = atual.attrs;
      const revertidos = new Set<string>();
      let mudou = false;
      for (const [campo, valor] of Object.entries(reg.depois)) {
        // só desfaz o que ainda é o que a gente gravou: se alguém mudou depois, é decisão dela
        if (attrs[campo] === valor) {
          delete attrs[campo];
          mudou = true;
          revertidos.add(campo);
        } else if (vazio(attrs[campo])) revertidos.add(campo);
      }
      if (mudou) await p.gravarAtributos(reg.conversa, attrs);
      let tirouEtiqueta = false;
      if (reg.etiqueta && atual.etiquetas.includes(reg.etiqueta)) {
        await p.gravarEtiquetas(reg.conversa, atual.etiquetas.filter((e) => e !== reg.etiqueta));
        tirouEtiqueta = true;
      }
      if (revertidos.has('etapa') && reg.capi.length) paraLimpar.push(reg);
      if (!revertidos.size && !tirouEtiqueta) {
        puladas++;
        log(`PULA   conversa ${reg.conversa}: nada a desfazer (a equipe já mudou o que a gente gravou)`);
        continue;
      }
      desfeitas++;
      log(`desfez conversa ${reg.conversa}: ${[...revertidos].join(', ') || '-'}${tirouEtiqueta ? ` + etiqueta ${reg.etiqueta}` : ''} (a marca da régua fica: ela mesma a tira)`);
    } catch (err) {
      puladas++;
      log(`PULA   conversa ${reg.conversa}: ${err instanceof Error ? err.message.slice(0, 100) : 'erro'}`);
    }
    await p.pausa(PAUSA_ENTRE_ESCRITAS_MS);
  }
  let capiLimpas = 0;
  if (paraLimpar.length) {
    log(`guarda do CAPI: ${paraLimpar.length} conversas, ${guardaMin} min — depois confiro que a etapa continua vazia e só então tiro as marcas de conversão`);
    await esperar(p, guardaMin);
    for (const reg of paraLimpar) {
      try {
        const { attrs } = await lerParaGravar(p, reg.conversa);
        if (!vazio(attrs.etapa)) {
          log(`AVISO  conversa ${reg.conversa}: a etapa voltou a ter valor — as marcas do CAPI ficam`);
          continue;
        }
        await desfazerMarcas(reg, p, { soCampos: new Set(['etapa']), visto: false });
        capiLimpas++;
      } catch {
        log(`AVISO  conversa ${reg.conversa}: não consegui conferir a etapa — as marcas do CAPI ficam`);
      }
    }
  }
  return { desfeitas, puladas, capiLimpas };
}
