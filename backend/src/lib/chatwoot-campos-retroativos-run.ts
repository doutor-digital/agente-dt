/**
 * O miolo do preenchimento retroativo de campos do CRM (`scripts/preencher-campos-crm.ts`): lê as conversas da caixa, pergunta ao Kommo e à
 * Sofia o que cada uma é, decide (`decidirCampos`, pura) e grava. Separado do script para ser testado com portas de mentira.
 *
 * Ordem de gravação POR CONVERSA (cada passo existe por um motivo, ver `chatwoot-campos-retroativos.ts`):
 *   1. relê a conversa e decide de novo (alguém pode ter preenchido no meio; só campo vazio);
 *   2. MARCAS: a etapa entra na memória da régua como `inicial` e o evento de conversão da Meta como `inicial` — ANTES do campo existir;
 *   3. os campos (o Chatwoot SUBSTITUI o objeto inteiro: relê e manda todos) e a etiqueta (a lista inteira);
 *   4. REAFIRMA as marcas (um ciclo da régua que tenha lido a conversa antes do passo 3 apaga a marca que ainda não tinha o campo) e confere.
 * Cada conversa gravada deixa uma linha `REG {…}` com o que estava antes: é o registro para desfazer (`--desfazer`). A saída não tem nome,
 * telefone nem texto de paciente: só número da conversa, campo, valor e regra.
 */
import { conversaDoChatwoot, type Vistos } from './chatwoot-regua.js';
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
  /** upsert da marca `inicial` da régua; 'igual' = já estava assim */
  marcarVisto(id: number, campo: string, valor: string, agora: Date): Promise<'criou' | 'atualizou' | 'igual'>;
  marcarCapi(id: number, evento: EventoCapi, agora: Date): Promise<'criou' | 'ja-existia'>;
  apagarVisto(id: number, campo: string): Promise<void>;
  apagarCapi(id: number, evento: EventoCapi): Promise<void>;
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
}

export function lerArgumentos(argv: string[]): OpcoesDosCampos & { desfazer: boolean } {
  const o: OpcoesDosCampos & { desfazer: boolean } = { soConferir: false, caixa: 3, max: 150, so: null, desfazer: false };
  for (const a of argv) {
    if (a === '--so-conferir') o.soConferir = true;
    else if (a === '--desfazer') o.desfazer = true;
    else if (/^--caixa=\d+$/.test(a)) o.caixa = Number(a.slice('--caixa='.length));
    else if (/^--max=\d+$/.test(a)) o.max = Number(a.slice('--max='.length));
    else if (/^--conversas=\d+(,\d+)*$/.test(a)) o.so = a.slice('--conversas='.length).split(',').map(Number);
    else throw new Error(`opção inválida: ${a} (use --so-conferir, --desfazer, --caixa=N, --max=N, --conversas=1,2,3)`);
  }
  if (!Number.isInteger(o.caixa) || o.caixa <= 0) throw new Error(`caixa inválida: ${o.caixa}`);
  if (!Number.isInteger(o.max) || o.max <= 0) throw new Error(`--max inválido: ${o.max}`);
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
  bloqueios: Record<string, number>;
  semRegra: Record<string, number>;
  erros: number;
  gravadas: number;
  falhas: number;
  truncado: boolean;
  parouPor: string | null;
}

const vazio = (v: unknown): boolean => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const somar = (o: Record<string, number>, k: string) => (o[k] = (o[k] ?? 0) + 1);
const atividadeDe = (raw: any): number => Number(raw?.last_activity_at) || 0;

/** Os campos que as regras preenchem: conversa com todos eles já preenchidos não precisa nem de consulta ao Kommo. */
function algumCampoVazio(attrs: Record<string, unknown>): boolean {
  return vazio(attrs.etapa) || vazio(attrs.qualificacao) || (vazio(attrs.funil) && vazio(attrs.etapa_tratamento));
}

const MAX_ERROS_SEGUIDOS_DO_KOMMO = 5;
const PAUSA_ENTRE_CONSULTAS_MS = 250;
const PAUSA_ENTRE_ESCRITAS_MS = 400;
const PAUSA_ANTES_DE_REAFIRMAR_MS = 2500;

export async function rodarCampos(o: OpcoesDosCampos, p: PortasDosCampos, log: (linha: string) => void, agora: () => Date = () => new Date()): Promise<ResumoDosCampos> {
  const r: ResumoDosCampos = { conversas: 0, comCampoVazio: 0, jaMarcadasParaConferir: 0, irmas: 0, semCartao: 0, porRegra: {}, conversasComAlteracao: 0, bloqueios: {}, semRegra: {}, erros: 0, gravadas: 0, falhas: 0, truncado: false, parouPor: null };
  const { lista, truncado } = await p.conversas();
  r.truncado = truncado;
  if (truncado) log('AVISO  bati no teto de páginas da listagem: pode haver conversa que não foi vista');
  const todas = lista.flatMap((raw) => {
    const c = conversaDoChatwoot(raw);
    return c ? [{ raw, c }] : [];
  });
  r.conversas = todas.length;
  const motivosValidos = await p.motivosValidos();
  const vistosDaCaixa = await p.vistosDaCaixa();

  // uma conversa por telefone: o cartão do Kommo é de uma pessoa, e duas conversas dela duplicariam o funil
  const porTelefone = new Map<string, typeof todas>();
  for (const x of todas) {
    const k = chaveDoTelefone(x.c.telefone);
    if (k) porTelefone.set(k, [...(porTelefone.get(k) ?? []), x]);
  }
  const jaTemEtapa = (a: Record<string, unknown>) => !vazio(a.etapa) || !vazio(a.funil) || !vazio(a.etapa_tratamento);

  const alvos = todas.filter((x) => !o.so || o.so.includes(x.c.id));
  const planos: Array<{ plano: Plano; ent: Omit<EntradaDaConversa, 'vistos'> }> = [];
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
          log(`ERRO   conversa ${c.id}: não consegui ler o Kommo (${err instanceof Error ? err.message.slice(0, 100) : 'erro'}) — não decido esta`);
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
    const ent = { conv: c, status: String(raw?.status ?? ''), leads, qualificacoes, motivosValidos };
    const plano = decidirCampos({ ...ent, vistos: vistosDaCaixa.get(c.id) ?? new Map() }, agora());
    planos.push({ plano, ent });
  }

  // o relatório do que cada conversa teria
  for (const { plano } of planos) {
    for (const b of plano.bloqueios) {
      somar(r.bloqueios, b.codigo);
      log(`PULA   conversa ${plano.conversa}  ${b.codigo}: ${b.detalhe}`);
    }
    if (plano.semRegra) somar(r.semRegra, plano.semRegra);
    if (plano.alteracoes.length || plano.etiquetaNova) r.conversasComAlteracao++;
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

  // gravar
  let feitas = 0;
  for (const { plano, ent } of planos) {
    if (!plano.alteracoes.length && !plano.etiquetaNova) continue;
    if (feitas >= o.max) {
      r.parouPor = `teto de ${o.max} conversas por execução (--max)`;
      log(`PAROU  ${r.parouPor}: rode de novo para as restantes`);
      break;
    }
    feitas++;
    try {
      const reg = await gravarUma(plano, ent, p, agora, log);
      if (reg) {
        r.gravadas++;
        log(`REG ${JSON.stringify(reg)}`);
      }
    } catch (err) {
      r.falhas++;
      log(`FALHOU conversa ${plano.conversa}: ${err instanceof Error ? err.message.slice(0, 120) : 'erro'}`);
    }
    await p.pausa(PAUSA_ENTRE_ESCRITAS_MS);
  }
  return r;
}

export interface Registro {
  conversa: number;
  antes: Record<string, null>;
  depois: Record<string, string>;
  etiqueta: string | null;
  visto: Array<{ campo: string; como: 'criou' | 'atualizou' | 'igual' }>;
  capi: Array<{ evento: EventoCapi; como: 'criou' | 'ja-existia' }>;
  em: string;
}

async function gravarUma(planoPrevisto: Plano, ent: Omit<EntradaDaConversa, 'vistos'>, p: PortasDosCampos, agora: () => Date, log: (l: string) => void): Promise<Registro | null> {
  const id = planoPrevisto.conversa;
  const fresca = await p.fresca(id);
  const c = fresca ? conversaDoChatwoot(fresca) : null;
  if (!fresca || !c) throw new Error('não consegui reler a conversa');
  // 1. decide de novo com a conversa e a memória de AGORA
  const plano = decidirCampos({ ...ent, conv: c, status: String(fresca.status ?? ''), vistos: await p.vistosDe(id) }, agora());
  if (!plano.alteracoes.length && !plano.etiquetaNova) {
    log(`nada   conversa ${id}: mudou desde a leitura (${plano.bloqueios.map((b) => b.codigo).join(', ') || 'já preenchida'}) — não gravo`);
    return null;
  }
  const reg: Registro = { conversa: id, antes: {}, depois: {}, etiqueta: null, visto: [], capi: [], em: agora().toISOString() };
  // 2. as marcas, ANTES do campo
  for (const m of plano.marcasVisto) reg.visto.push({ campo: m.campo, como: await p.marcarVisto(id, m.campo, m.valor, agora()) });
  for (const ev of plano.marcasCapi) reg.capi.push({ evento: ev, como: await p.marcarCapi(id, ev, agora()) });
  // 3. os campos e a etiqueta
  if (plano.alteracoes.length) {
    const attrs: Record<string, unknown> = { ...c.attrs };
    for (const x of plano.alteracoes) {
      attrs[x.campo] = x.depois;
      reg.antes[x.campo] = null;
      reg.depois[x.campo] = x.depois;
    }
    await p.gravarAtributos(id, attrs);
  }
  if (plano.etiquetaNova && !c.etiquetas.includes(plano.etiquetaNova)) {
    await p.gravarEtiquetas(id, [...c.etiquetas, plano.etiquetaNova]);
    reg.etiqueta = plano.etiquetaNova;
  }
  // 4. reafirma as marcas e confere
  await p.pausa(PAUSA_ANTES_DE_REAFIRMAR_MS);
  for (const m of plano.marcasVisto) await p.marcarVisto(id, m.campo, m.valor, agora());
  const depois = await p.fresca(id);
  const attrsDepois = (depois?.custom_attributes ?? {}) as Record<string, unknown>;
  for (const [campo, valor] of Object.entries(reg.depois)) if (attrsDepois[campo] !== valor) log(`AVISO  conversa ${id}: ${campo} não ficou (outro processo gravou junto) — rode de novo`);
  return reg;
}

/** `--desfazer`: lê as linhas `REG` de uma execução e devolve cada conversa ao que era (só o que ainda é o que a gente gravou). */
export async function desfazerCampos(linhas: string[], p: PortasDosCampos, log: (l: string) => void): Promise<{ desfeitas: number; puladas: number }> {
  let desfeitas = 0;
  let puladas = 0;
  for (const linha of linhas) {
    const m = /^REG (\{.*\})\s*$/.exec(linha.trim());
    if (!m) continue;
    const reg = JSON.parse(m[1]!) as Registro;
    const fresca = await p.fresca(reg.conversa);
    const c = fresca ? conversaDoChatwoot(fresca) : null;
    if (!fresca || !c) {
      puladas++;
      log(`PULA   conversa ${reg.conversa}: não consegui reler`);
      continue;
    }
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
    for (const v of reg.visto) if (v.como !== 'igual') await p.apagarVisto(reg.conversa, v.campo);
    for (const x of reg.capi) if (x.como === 'criou') await p.apagarCapi(reg.conversa, x.evento);
    desfeitas++;
    log(`desfez conversa ${reg.conversa}: ${Object.keys(reg.depois).join(', ') || '-'}${reg.etiqueta ? ` + etiqueta ${reg.etiqueta}` : ''}`);
    await p.pausa(PAUSA_ENTRE_ESCRITAS_MS);
  }
  return { desfeitas, puladas };
}
