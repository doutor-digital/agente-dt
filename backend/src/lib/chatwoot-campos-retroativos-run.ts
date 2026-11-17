/**
 * O miolo do preenchimento retroativo de campos do CRM (`scripts/preencher-campos-crm.ts`): lê as conversas da caixa, pergunta ao Kommo e à
 * Sofia o que cada uma é, decide (`decidirCampos`, pura) e grava. Separado do script para ser testado com portas de mentira.
 *
 * Ordem de gravação POR CONVERSA (cada passo existe por um motivo, ver `chatwoot-campos-retroativos.ts`):
 *   1. relê a conversa e decide de novo (alguém pode ter preenchido no meio; só campo vazio);
 *   2. MARCAS: a etapa entra na memória da régua como `inicial` e o evento de conversão da Meta como `inicial` — ANTES do campo existir;
 *   3. os campos (o Chatwoot SUBSTITUI o objeto inteiro: relê e manda todos) e a etiqueta (a lista inteira);
 *   4. GUARDA das marcas: um ciclo da régua que tenha LISTADO a conversa antes do passo 3 (a listagem leva minutos) apaga a marca quando salva a
 *      memória, bem depois. Por isso, no fim, o script reafirma as marcas de todas as conversas gravadas de 30 em 30 s por mais que um ciclo inteiro.
 * Cada conversa gravada deixa uma linha `REG {…}` com o que estava antes: é o registro para desfazer (`--desfazer`). A saída não tem nome,
 * telefone nem texto de paciente: só número da conversa, campo, valor e regra.
 */
import { conversaDoChatwoot, ehArquivo, type AjustesDaRegua, type Vistos } from './chatwoot-regua.js';
import { chaveDoTelefone } from './chatwoot-lida.js';
import type { EventoCapi } from './chatwoot-capi.js';
import {
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
  /** os cartões do Kommo deste telefone (lança se o Kommo falhou: nunca «sem cartão» por engano) */
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
  /** minutos de guarda das marcas depois de gravar (tem de passar de um ciclo da régua, que é de 10 min) */
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
  if (o.guardaMin > 60) throw new Error(`--guarda inválido: ${o.guardaMin} (0 a 60 minutos)`);
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
  bloqueios: Record<string, number>;
  semRegra: Record<string, number>;
  erros: number;
  gravadas: number;
  falhas: number;
  /** vezes que a guarda achou uma marca da régua apagada ou mudada e a reafirmou */
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
const PAUSA_ENTRE_CONSULTAS_MS = 250;
const PAUSA_ENTRE_ESCRITAS_MS = 400;
const PAUSA_ANTES_DE_REAFIRMAR_MS = 2500;
const PAUSA_DA_GUARDA_MS = 30_000;

export interface Registro {
  conversa: number;
  antes: Record<string, null>;
  depois: Record<string, string>;
  etiqueta: string | null;
  visto: Array<{ campo: string; como: ComoMarcou; antes?: VistoAnterior }>;
  capi: Array<{ evento: EventoCapi; como: ComoMarcou }>;
  em: string;
}

export async function rodarCampos(o: OpcoesDosCampos, p: PortasDosCampos, log: (linha: string) => void, agora: () => Date = () => new Date()): Promise<ResumoDosCampos> {
  const r: ResumoDosCampos = { conversas: 0, comCampoVazio: 0, jaMarcadasParaConferir: 0, irmas: 0, semCartao: 0, porRegra: {}, conversasComAlteracao: 0, arquivoQueAcorda: 0, bloqueios: {}, semRegra: {}, erros: 0, gravadas: 0, falhas: 0, marcasReafirmadas: 0, atividadeMexeu: 0, truncado: false, parouPor: null };
  const { lista, truncado } = await p.conversas();
  r.truncado = truncado;
  if (truncado) log('AVISO  bati no teto de páginas da listagem: pode haver conversa que não foi vista (e irmãs do mesmo telefone sem ver)');
  const todas = lista.flatMap((raw) => {
    const c = conversaDoChatwoot(raw);
    return c ? [{ raw, c }] : [];
  });
  r.conversas = todas.length;
  const [motivosValidos, vistosDaCaixa, ajustes] = [await p.motivosValidos(), await p.vistosDaCaixa(), await p.ajustesDaRegua()];

  // uma conversa por telefone: o cartão do Kommo é de uma pessoa, e duas conversas dela duplicariam o funil
  const porTelefone = new Map<string, typeof todas>();
  for (const x of todas) {
    const k = chaveDoTelefone(x.c.telefone);
    if (k) porTelefone.set(k, [...(porTelefone.get(k) ?? []), x]);
  }
  const jaTemEtapa = (a: Record<string, unknown>) => !vazio(a.etapa) || !vazio(a.funil) || !vazio(a.etapa_tratamento);

  const alvos = todas.filter((x) => !o.so || o.so.includes(x.c.id));
  const planos: Array<{ plano: Plano; ent: Omit<EntradaDaConversa, 'vistos'>; raw: any }> = [];
  const cacheDoKommo = new Map<string, LeadDoKommo[]>();
  let errosSeguidos = 0;
  for (const { raw, c } of alvos) {
    if (!algumCampoVazio(c.attrs)) continue;
    r.comCampoVazio++;
    if (c.etiquetas.includes(ETIQUETA_CONFERIR_ETAPA)) {
      r.jaMarcadasParaConferir++;
      continue;
    }
    const chave = chaveDoTelefone(c.telefone);
    const irmas = (chave ? porTelefone.get(chave) ?? [] : []).filter((x) => x.c.id !== c.id);
    if (irmas.some((x) => jaTemEtapa(x.c.attrs)) || irmas.some((x) => algumCampoVazio(x.c.attrs) && !x.c.etiquetas.includes(ETIQUETA_CONFERIR_ETAPA) && (atividadeDe(x.raw) > atividadeDe(raw) || (atividadeDe(x.raw) === atividadeDe(raw) && x.c.id > c.id)))) {
      r.irmas++;
      continue;
    }
    let leads: LeadDoKommo[] = [];
    if (c.telefone && chave) {
      const guardado = cacheDoKommo.get(chave);
      if (guardado) leads = guardado;
      else {
        try {
          leads = await p.leadsDoKommo(c.telefone);
          cacheDoKommo.set(chave, leads);
          errosSeguidos = 0;
        } catch (err) {
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
    if (leads.length && vazio(c.attrs.qualificacao)) qualificacoes = await p.qualificacoes(leads.map((l) => l.id)).catch(() => []);
    if (!leads.length) r.semCartao++;
    const ent = { conv: c, status: String(raw?.status ?? ''), leads, qualificacoes, motivosValidos, ajustes };
    const plano = decidirCampos({ ...ent, vistos: vistosDaCaixa.get(c.id) ?? new Map() }, agora());
    planos.push({ plano, ent, raw });
  }

  // o relatório do que cada conversa teria
  for (const { plano, raw } of planos) {
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
    r.parouPor = 'a listagem da caixa foi cortada: não gravo (rode com --conversas=… para as que você quer)';
    log(`PAROU  ${r.parouPor}`);
    return r;
  }

  // gravar
  let feitas = 0;
  const regs: Registro[] = [];
  for (const { plano, ent } of planos) {
    if (!plano.alteracoes.length && !plano.etiquetaNova) continue;
    if (feitas >= o.max) {
      r.parouPor = `teto de ${o.max} conversas por execução (--max)`;
      log(`PAROU  ${r.parouPor}: rode de novo para as restantes`);
      break;
    }
    feitas++;
    const out = await gravarUma(plano, ent, p, agora, log);
    if (out.reg) {
      regs.push(out.reg);
      log(`REG ${JSON.stringify(out.reg)}`);
    }
    if (out.erro) {
      r.falhas++;
      log(`FALHOU conversa ${plano.conversa}: ${out.erro}`);
    } else if (out.reg) r.gravadas++;
    if (out.mexeu) r.atividadeMexeu++;
    await p.pausa(PAUSA_ENTRE_ESCRITAS_MS);
  }
  if (regs.length && o.guardaMin > 0) r.marcasReafirmadas = await guardarMarcas(regs, p, o.guardaMin, log, agora);
  return r;
}

/** Desfaz as marcas que ESTA execução pôs (e só elas): a linha nova some; a que já existia volta como era. */
async function desfazerMarcas(reg: Pick<Registro, 'conversa' | 'visto' | 'capi'>, p: PortasDosCampos): Promise<void> {
  for (const v of reg.visto) {
    if (v.como === 'criou') await p.apagarVisto(reg.conversa, v.campo);
    else if (v.como === 'atualizou' && v.antes) await p.restaurarVisto(reg.conversa, v.campo, v.antes);
  }
  for (const x of reg.capi) {
    if (x.como === 'criou') await p.apagarCapi(reg.conversa, x.evento);
    else if (x.como === 'atualizou') await p.restaurarCapi(reg.conversa, x.evento);
  }
}

async function gravarUma(planoPrevisto: Plano, ent: Omit<EntradaDaConversa, 'vistos'>, p: PortasDosCampos, agora: () => Date, log: (l: string) => void): Promise<{ reg: Registro | null; erro?: string; mexeu?: boolean }> {
  const id = planoPrevisto.conversa;
  const reg: Registro = { conversa: id, antes: {}, depois: {}, etiqueta: null, visto: [], capi: [], em: agora().toISOString() };
  let escreveu = false;
  try {
    const fresca = await p.fresca(id);
    const c = fresca ? conversaDoChatwoot(fresca) : null;
    if (!fresca || !c) throw new Error('não consegui reler a conversa');
    // 1. decide de novo com a conversa e a memória de AGORA
    const plano = decidirCampos({ ...ent, conv: c, status: String(fresca.status ?? ''), vistos: await p.vistosDe(id) }, agora());
    if (!plano.alteracoes.length && !plano.etiquetaNova) {
      log(`nada   conversa ${id}: mudou desde a leitura (${plano.bloqueios.map((b) => b.codigo).join(', ') || 'já preenchida'}) — não gravo`);
      return { reg: null };
    }
    // 2. as marcas, ANTES do campo
    for (const m of plano.marcasVisto) reg.visto.push({ campo: m.campo, ...(await p.marcarVisto(id, m.campo, m.valor, agora())) });
    for (const ev of plano.marcasCapi) reg.capi.push({ evento: ev, como: await p.marcarCapi(id, ev, agora()) });
    // 3. os campos e a etiqueta
    if (plano.alteracoes.length) {
      const attrs: Record<string, unknown> = { ...c.attrs };
      for (const x of plano.alteracoes) attrs[x.campo] = x.depois;
      await p.gravarAtributos(id, attrs);
      escreveu = true;
      for (const x of plano.alteracoes) {
        reg.antes[x.campo] = null;
        reg.depois[x.campo] = x.depois;
      }
    }
    if (plano.etiquetaNova && !c.etiquetas.includes(plano.etiquetaNova)) {
      await p.gravarEtiquetas(id, [...c.etiquetas, plano.etiquetaNova]);
      escreveu = true;
      reg.etiqueta = plano.etiquetaNova;
    }
    // 4. reafirma já e confere (a guarda de minutos vem no fim de tudo)
    await p.pausa(PAUSA_ANTES_DE_REAFIRMAR_MS);
    for (const m of plano.marcasVisto) await p.marcarVisto(id, m.campo, m.valor, agora());
    const depois = await p.fresca(id);
    const attrsDepois = (depois?.custom_attributes ?? {}) as Record<string, unknown>;
    for (const [campo, valor] of Object.entries(reg.depois)) if (attrsDepois[campo] !== valor) log(`AVISO  conversa ${id}: ${campo} não ficou (outro processo gravou junto) — rode de novo`);
    const mexeu = Number(depois?.last_activity_at) > Number(fresca.last_activity_at);
    if (mexeu) log(`AVISO  conversa ${id}: a última atividade andou depois de gravar (se era arquivo, entra nos fluxos normais)`);
    return { reg, mexeu };
  } catch (err) {
    const erro = err instanceof Error ? err.message.slice(0, 120) : 'erro';
    // o campo não chegou a ser gravado: as marcas que esta execução pôs não podem ficar (calariam a Meta e a régua de uma etapa que nunca foi gravada)
    if (!escreveu) {
      await desfazerMarcas(reg, p).catch(() => log(`AVISO  conversa ${id}: não consegui desfazer as marcas — confira com --desfazer`));
      return { reg: null, erro };
    }
    // o campo foi gravado e algo depois falhou (etiqueta, conferência): o registro sai assim mesmo, para o --desfazer enxergar
    return { reg, erro };
  }
}

/**
 * A GUARDA: o ciclo da régua lista as conversas (minutos) e só depois lê a memória; quem foi listado ANTES da gravação e teve a memória lida DEPOIS
 * da marca enxerga «etapa ausente» e apaga a marca ao salvar. Isso acontece no fim da listagem, bem depois da gravação. Reafirmar de 30 em 30 s
 * por mais que um ciclo inteiro fecha a janela: quando o ciclo seguinte lê a memória, a marca está lá.
 */
async function guardarMarcas(regs: Registro[], p: PortasDosCampos, minutos: number, log: (l: string) => void, agora: () => Date): Promise<number> {
  const voltas = Math.ceil((minutos * 60_000) / PAUSA_DA_GUARDA_MS);
  log(`guarda das marcas da régua: ${regs.length} conversas, ${minutos} min (de 30 em 30 s) — não feche o terminal`);
  let reafirmadas = 0;
  for (let i = 0; i < voltas; i++) {
    await p.pausa(PAUSA_DA_GUARDA_MS);
    for (const reg of regs) {
      for (const v of reg.visto) {
        const valor = reg.depois[v.campo];
        if (valor === undefined) continue;
        try {
          const m = await p.marcarVisto(reg.conversa, v.campo, valor, agora());
          if (m.como !== 'igual') {
            reafirmadas++;
            log(`AVISO  conversa ${reg.conversa}: a marca da régua de ${v.campo} tinha sumido ou mudado — reafirmei`);
          }
        } catch {
          log(`AVISO  conversa ${reg.conversa}: não consegui conferir a marca de ${v.campo} nesta volta`);
        }
      }
    }
  }
  log(`guarda terminada: ${reafirmadas} reafirmação(ões)`);
  return reafirmadas;
}

/** `--desfazer`: lê as linhas `REG` de uma execução e devolve cada conversa ao que era (só o que ainda é o que a gente gravou). */
export async function desfazerCampos(linhas: string[], p: PortasDosCampos, log: (l: string) => void): Promise<{ desfeitas: number; puladas: number }> {
  let desfeitas = 0;
  let puladas = 0;
  for (const linha of linhas) {
    const m = /^REG (\{.*\})\s*$/.exec(linha.trim());
    if (!m) continue;
    let reg: Registro;
    try {
      reg = JSON.parse(m[1]!) as Registro;
      if (!Number.isInteger(reg.conversa) || typeof reg.depois !== 'object' || !Array.isArray(reg.visto) || !Array.isArray(reg.capi)) throw new Error('formato');
    } catch {
      puladas++;
      log('PULA   uma linha REG estragada (JSON incompleto): as outras seguem');
      continue;
    }
    try {
      const fresca = await p.fresca(reg.conversa);
      const c = fresca ? conversaDoChatwoot(fresca) : null;
      if (!fresca || !c) throw new Error('não consegui reler');
      const attrs: Record<string, unknown> = { ...c.attrs };
      let mudou = false;
      for (const [campo, valor] of Object.entries(reg.depois)) {
        // só desfaz o que ainda é o que a gente gravou: se alguém mudou depois, é decisão dela
        if (attrs[campo] === valor) {
          delete attrs[campo];
          mudou = true;
        }
      }
      if (mudou) await p.gravarAtributos(reg.conversa, attrs);
      if (reg.etiqueta && c.etiquetas.includes(reg.etiqueta)) await p.gravarEtiquetas(reg.conversa, c.etiquetas.filter((e) => e !== reg.etiqueta));
      await desfazerMarcas(reg, p);
      desfeitas++;
      log(`desfez conversa ${reg.conversa}: ${Object.keys(reg.depois).join(', ') || '-'}${reg.etiqueta ? ` + etiqueta ${reg.etiqueta}` : ''}`);
    } catch (err) {
      puladas++;
      log(`PULA   conversa ${reg.conversa}: ${err instanceof Error ? err.message.slice(0, 100) : 'erro'}`);
    }
    await p.pausa(PAUSA_ENTRE_ESCRITAS_MS);
  }
  return { desfeitas, puladas };
}
