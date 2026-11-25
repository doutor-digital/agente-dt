/**
 * ETAPAS POR CONTA DO CRM (Chatwoot): cada clínica pode ter as MESMAS etapas e os MESMOS nomes que tem na Kommo, sem o código inteiro
 * saber disso (pedido do João, 25/11/2026: Timbó, conta 3).
 *
 * O desenho é de FRONTEIRA: por dentro o código fala em PAPÉIS, e o papel tem o nome do molde da rede («Sofia qualifica», «Fechou»…, mais
 * os que o molde nunca teve: «Em espera», «Conferir na franquia», «Faltou», «Retorno pós-tratamento»). Régua, guia, Sofia, CAPI, agenda, Hoje e
 * gestor continuam comparando esses nomes. Só este módulo conhece o nome da conta:
 *   - LER:    `papelDaEtapa(mapa, nomeDaConta)` / `papeisDosAtributos(mapa, attrs)` — o que vem do Chatwoot vira papel;
 *   - GRAVAR: `nomeParaGravar(mapa, papel)` / `atributosParaGravar(mapa, attrs)` — o papel vira o nome que a conta tem (ou nada, se a conta não tem).
 *
 * Quem não tem mapa (Parauapebas e toda conta sem configuração) usa o MOLDE: mapa de identidade. Nesse caso as funções devolvem o MESMO valor
 * (e o MESMO objeto) que recebem — o teste compara byte a byte. A leitura é TOLERANTE: o nome antigo do molde continua valendo em uma conta que
 * já tem mapa (a troca da configuração, da lista do atributo e das conversas pode acontecer em qualquer ordem, e desfazer é seguro).
 *
 * Módulo PURO (sem banco nem rede). A leitura da coluna `unit_chatwoot.etapas` está em `chatwoot-unidades-banco.ts`.
 */

import { contaDaCaixa } from './chatwoot-unidades.js';

/** Papéis do funil COMERCIAL. Os 11 primeiros são o molde da rede; os 4 últimos só existem nas contas que os mapeiam. */
export const PAPEIS_COMERCIAIS = [
  'Novo lead',
  'Sofia qualifica',
  'Esperando humano',
  'Agendado',
  'Confirmado',
  'Compareceu',
  'Fechou',
  'Pós-consulta',
  'Resgate',
  'Perdido',
  'Frio',
  'Em espera',
  'Conferir na franquia',
  'Faltou',
  'Retorno pós-tratamento',
] as const;
export type PapelComercial = (typeof PAPEIS_COMERCIAIS)[number];

/** Papéis do funil de TRATAMENTO (atributo `etapa_tratamento`). */
export const PAPEIS_DO_TRATAMENTO = ['Entrada', 'Em tratamento', 'Alta', 'Tratamento cancelado'] as const;
export type PapelDoTratamento = (typeof PAPEIS_DO_TRATAMENTO)[number];

export interface EtapaDaConta<P extends string = string> {
  papel: P;
  /** o nome na conta (o valor do atributo no Chatwoot, igual ao da Kommo) */
  nome: string;
}

/** As etapas da conta, NA ORDEM do quadro. Dois papéis podem ter o mesmo nome (alias: «Confirmado» grava em «AGENDADO»); o primeiro é o que a leitura devolve. */
export interface MapaDeEtapas {
  comercial: ReadonlyArray<EtapaDaConta<PapelComercial>>;
  tratamento: ReadonlyArray<EtapaDaConta<PapelDoTratamento>>;
}

/** O molde da rede: as listas que Parauapebas tem. O nome É o papel. Não editar: o teste compara com o comportamento de antes. */
export const ETAPAS_DO_MOLDE: MapaDeEtapas = {
  comercial: PAPEIS_COMERCIAIS.slice(0, 11).map((p) => ({ papel: p, nome: p })),
  tratamento: PAPEIS_DO_TRATAMENTO.map((p) => ({ papel: p, nome: p })),
};

/**
 * Papel que a conta NÃO tem → onde ele passa a morar. Só entra o que tem equivalente de verdade (e a regra que o torna distinguível fica fora da etapa):
 *  - «Confirmado» é o «Agendado» com `situacao_consulta` = Confirmado;
 *  - «Esperando humano» é a qualificação com a etiqueta `esperando-humano` (a Sofia e a demora já leem a etiqueta).
 * «Frio», «Resgate» e os papéis novos não têm substituto: a conta que não os tem simplesmente não os usa (nada é gravado).
 */
export const SUBSTITUTO_DO_PAPEL: Readonly<Partial<Record<PapelComercial, PapelComercial>>> = {
  Confirmado: 'Agendado',
  'Esperando humano': 'Sofia qualifica',
};

/** Os papéis que o código grava sozinho: todo mapa precisa tê-los. */
const PAPEIS_QUE_O_CODIGO_GRAVA: readonly PapelComercial[] = ['Novo lead', 'Sofia qualifica', 'Agendado', 'Fechou', 'Perdido'];
const PAPEIS_DO_TRATAMENTO_QUE_O_CODIGO_GRAVA: readonly PapelDoTratamento[] = ['Em tratamento', 'Alta'];

/** Quando dois papéis têm o mesmo nome, a leitura devolve o que vem primeiro nesta lista. */
const PRIORIDADE_NA_LEITURA: readonly PapelComercial[] = ['Agendado', 'Confirmado'];

const semAcento = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

/** Mapa de identidade (sem configuração)? Aí nada é traduzido. */
export const ehMolde = (m: MapaDeEtapas | null | undefined): boolean => !m || m === ETAPAS_DO_MOLDE;

// ── validação (pura): quem grava o mapa na coluna passa por aqui ─────────────────────────────────

export function problemasDoMapa(bruto: unknown): string[] {
  const p: string[] = [];
  if (!bruto || typeof bruto !== 'object') return ['o mapa de etapas precisa ser um objeto {comercial, tratamento}'];
  const o = bruto as Record<string, unknown>;
  const conferir = (funil: 'comercial' | 'tratamento', papeis: readonly string[]): void => {
    const lista = o[funil];
    if (!Array.isArray(lista) || !lista.length) {
      p.push(`${funil}: lista vazia ou ausente`);
      return;
    }
    const vistos = new Set<string>();
    for (const e of lista) {
      const papel = (e as { papel?: unknown })?.papel;
      const nome = (e as { nome?: unknown })?.nome;
      if (typeof papel !== 'string' || !papeis.includes(papel)) p.push(`${funil}: papel desconhecido (${String(papel)})`);
      else if (vistos.has(papel)) p.push(`${funil}: papel repetido (${papel})`);
      else vistos.add(papel);
      if (typeof nome !== 'string' || !nome.trim() || nome.trim() !== nome || nome.length > 60) p.push(`${funil}: nome inválido para ${String(papel)} (1 a 60 letras, sem espaço nas pontas)`);
    }
    // dois papéis com o mesmo nome (mesmo só diferindo em caixa ou acento, que a leitura trata como igual): só o alias Agendado/Confirmado
    const porNome = new Map<string, string[]>();
    for (const e of lista as Array<{ papel?: unknown; nome?: unknown }>) {
      if (typeof e?.nome !== 'string' || typeof e?.papel !== 'string') continue;
      porNome.set(semAcento(e.nome), [...(porNome.get(semAcento(e.nome)) ?? []), e.papel]);
    }
    for (const papeisDoNome of porNome.values()) {
      const alias = funil === 'comercial' && papeisDoNome.length === 2 && papeisDoNome.includes('Agendado') && papeisDoNome.includes('Confirmado');
      if (papeisDoNome.length > 1 && !alias) p.push(`${funil}: o mesmo nome em mais de um papel (${papeisDoNome.join(', ')}); só «Confirmado» pode repetir o nome de «Agendado»`);
    }
    // um nome da conta que é o NOME DE OUTRO papel do molde tornaria a leitura ambígua (ex.: «Agendado» como nome do papel «Faltou»)
    for (const e of lista as Array<{ papel: string; nome: string }>) {
      if (typeof e?.nome === 'string' && papeis.some((x) => semAcento(x) === semAcento(e.nome)) && semAcento(e.nome) !== semAcento(e.papel) && !(lista as Array<{ papel: string; nome: string }>).some((x) => semAcento(x.papel) === semAcento(e.nome) && semAcento(x.nome) === semAcento(e.nome))) {
        p.push(`${funil}: o nome «${e.nome}» da etapa ${e.papel} é o nome de outro papel`);
      }
    }
  };
  conferir('comercial', PAPEIS_COMERCIAIS);
  conferir('tratamento', PAPEIS_DO_TRATAMENTO);
  // os papéis que o código grava SOZINHO (Sofia, agenda, régua, botão «Perdido»): mapa sem eles gravaria etapa que a conta não tem
  const tem = (funil: 'comercial' | 'tratamento'): Set<string> => new Set(((o[funil] as Array<{ papel?: unknown }>) ?? []).map((e) => String(e?.papel)));
  if (Array.isArray(o.comercial)) for (const obrigatorio of PAPEIS_QUE_O_CODIGO_GRAVA) if (!tem('comercial').has(obrigatorio)) p.push(`comercial: falta o papel «${obrigatorio}» (o código grava esta etapa sozinho)`);
  if (Array.isArray(o.tratamento)) for (const obrigatorio of PAPEIS_DO_TRATAMENTO_QUE_O_CODIGO_GRAVA) if (!tem('tratamento').has(obrigatorio)) p.push(`tratamento: falta o papel «${obrigatorio}»`);
  return p;
}

/** Do que está na coluna (Json) para o mapa, ou null (inválido/vazio → o molde vale, nunca um mapa pela metade). */
export function mapaDaColuna(bruto: unknown): MapaDeEtapas | null {
  if (bruto === null || bruto === undefined) return null;
  if (problemasDoMapa(bruto).length) return null;
  const o = bruto as { comercial: Array<{ papel: PapelComercial; nome: string }>; tratamento: Array<{ papel: PapelDoTratamento; nome: string }> };
  return { comercial: o.comercial.map((e) => ({ papel: e.papel, nome: e.nome })), tratamento: o.tratamento.map((e) => ({ papel: e.papel, nome: e.nome })) };
}

// ── o registro por conta (objeto vivo, como os mapas de `chatwoot-unidades.ts`) ──────────────────

let porConta: ReadonlyMap<number, MapaDeEtapas> = new Map();

/** Troca o registro inteiro (síncrono). Só contas PRÓPRIAS entram: a do ambiente (Parauapebas) nunca tem mapa. */
export function aplicarEtapasDasContas(linhas: ReadonlyArray<{ contaId?: number | null; etapas?: unknown }>): void {
  const m = new Map<number, MapaDeEtapas>();
  const repetidas = new Set<number>();
  for (const l of linhas) {
    const c = l.contaId;
    if (typeof c !== 'number' || !Number.isInteger(c) || c <= 0) continue;
    const mapa = mapaDaColuna(l.etapas);
    if (!mapa) continue;
    if (m.has(c)) repetidas.add(c); // duas unidades na mesma conta com mapas: ambíguo, fica o molde
    m.set(c, mapa);
  }
  for (const c of repetidas) m.delete(c);
  porConta = m;
}

/** O mapa da conta, ou o molde (conta sem mapa, conta do ambiente, `null`/`undefined`). */
export function etapasDaConta(contaId: number | null | undefined): MapaDeEtapas {
  return (typeof contaId === 'number' ? porConta.get(contaId) : undefined) ?? ETAPAS_DO_MOLDE;
}

/** O mapa de quem fala pela CAIXA (régua, CAPI, disparos…): a caixa diz a unidade, a unidade diz a conta. Caixa desconhecida: o molde. */
export const etapasDaCaixa = (caixa: number): MapaDeEtapas => etapasDaConta(contaDaCaixa(caixa));

/** O mapa de quem fala pelo contexto do Chatwoot (a conta que a chamada usa). `conta` = a conta do ambiente para Parauapebas, que nunca tem mapa. */
export const etapasDoContexto = (ctx: { conta: { conta: number } | null } | null | undefined): MapaDeEtapas => etapasDaConta(ctx?.conta?.conta ?? null);

/** As contas que têm mapa próprio (para os testes e para o log de boot). */
export const contasComEtapasProprias = (): number[] => [...porConta.keys()].sort((a, b) => a - b);

// ── ler: nome da conta → papel ───────────────────────────────────────────────────────────────────

function papelNaLista<P extends string>(lista: ReadonlyArray<EtapaDaConta<P>>, nome: string, prioridade: readonly string[] = []): P | null {
  const chave = semAcento(nome);
  const achados = lista.filter((e) => semAcento(e.nome) === chave);
  if (!achados.length) return null;
  // dois papéis com o mesmo nome (alias): vale o que vem primeiro em `prioridade`, não o da ordem do quadro
  const preferido = [...achados].filter((e) => prioridade.includes(e.papel)).sort((a, b) => prioridade.indexOf(a.papel) - prioridade.indexOf(b.papel))[0];
  return (preferido ?? achados[0]!).papel;
}

/**
 * O papel da etapa COMERCIAL com este nome. Sem mapa: o próprio valor. Com mapa: o papel da conta; senão, se o valor é o nome de um papel do molde
 * (leitura tolerante, conversa ainda não migrada), esse papel; senão o valor como veio (etapa que ninguém conhece não vira outra coisa).
 */
export function papelDaEtapa(mapa: MapaDeEtapas | null | undefined, nome: string): string {
  if (ehMolde(mapa) || !nome) return nome;
  const m = mapa as MapaDeEtapas;
  return papelNaLista(m.comercial, nome, PRIORIDADE_NA_LEITURA) ?? nome;
}

/** O mesmo para `etapa_tratamento`. */
export function papelDaEtapaDoTratamento(mapa: MapaDeEtapas | null | undefined, nome: string): string {
  if (ehMolde(mapa) || !nome) return nome;
  return papelNaLista((mapa as MapaDeEtapas).tratamento, nome) ?? nome;
}

/** Os atributos da conversa com `etapa` e `etapa_tratamento` em PAPÉIS. Sem mapa (ou sem mudança): o MESMO objeto. */
export function papeisDosAtributos<T extends Record<string, unknown>>(mapa: MapaDeEtapas | null | undefined, attrs: T): T {
  if (ehMolde(mapa) || !attrs) return attrs;
  let saida: Record<string, unknown> | null = null;
  const etapa = typeof attrs.etapa === 'string' ? attrs.etapa : null;
  if (etapa !== null) {
    const p = papelDaEtapa(mapa, etapa.trim());
    if (p !== etapa) (saida ??= { ...attrs }).etapa = p;
  }
  const trat = typeof attrs.etapa_tratamento === 'string' ? attrs.etapa_tratamento : null;
  if (trat !== null) {
    const p = papelDaEtapaDoTratamento(mapa, trat.trim());
    if (p !== trat) (saida ??= { ...attrs }).etapa_tratamento = p;
  }
  return (saida ?? attrs) as T;
}

/** A conversa crua do Chatwoot (listagem ou webhook) com os atributos em papéis, SEM tocar no original. Sem mapa: a MESMA conversa. */
export function conversaCrua<T>(mapa: MapaDeEtapas | null | undefined, raw: T): T {
  if (ehMolde(mapa)) return raw;
  const r = raw as unknown as { custom_attributes?: Record<string, unknown> } | null;
  const attrs = r?.custom_attributes;
  if (!attrs || typeof attrs !== 'object') return raw;
  const novos = papeisDosAtributos(mapa, attrs);
  return novos === attrs ? raw : ({ ...(r as object), custom_attributes: novos } as unknown as T);
}

// ── gravar: papel → nome da conta ────────────────────────────────────────────────────────────────

/**
 * O nome que a conta tem para o papel (ou para o substituto dele), ou null = a conta não tem esta etapa: NÃO grave. Sem mapa: o próprio papel.
 * Um valor que não é papel conhecido (texto livre, nome que o usuário escolheu na tela) passa como veio.
 */
export function nomeParaGravar(mapa: MapaDeEtapas | null | undefined, papel: string): string | null {
  if (ehMolde(mapa)) return papel;
  const m = mapa as MapaDeEtapas;
  if (!(PAPEIS_COMERCIAIS as readonly string[]).includes(papel)) return papel;
  const direto = m.comercial.find((e) => e.papel === papel);
  if (direto) return direto.nome;
  const sub = SUBSTITUTO_DO_PAPEL[papel as PapelComercial];
  return sub ? (m.comercial.find((e) => e.papel === sub)?.nome ?? null) : null;
}

export function nomeDoTratamentoParaGravar(mapa: MapaDeEtapas | null | undefined, papel: string): string | null {
  if (ehMolde(mapa)) return papel;
  if (!(PAPEIS_DO_TRATAMENTO as readonly string[]).includes(papel)) return papel;
  return (mapa as MapaDeEtapas).tratamento.find((e) => e.papel === papel)?.nome ?? null;
}

/**
 * O que vai ser gravado, com `etapa` / `etapa_tratamento` em nomes da conta. Papel que a conta não tem: o campo SAI da gravação (a etapa que a
 * conversa já tem não é trocada nem apagada). Sem mapa: o MESMO objeto.
 * `objetoInteiro`: quem manda TODOS os atributos de uma vez (o Chatwoot substitui o objeto): o papel que a conta não tem fica como veio, nunca some.
 */
export function atributosParaGravar<T extends Record<string, unknown>>(mapa: MapaDeEtapas | null | undefined, parcial: T, objetoInteiro = false): T {
  if (ehMolde(mapa)) return parcial;
  let saida: Record<string, unknown> | null = null;
  const trocar = (campo: 'etapa' | 'etapa_tratamento', f: (m: MapaDeEtapas | null | undefined, p: string) => string | null): void => {
    const v = parcial[campo];
    if (typeof v !== 'string' || !v) return;
    const nome = f(mapa, v);
    if (nome === v) return;
    saida ??= { ...parcial };
    // objeto INTEIRO (o Chatwoot troca todos os atributos de uma vez): omitir o campo o APAGARIA — o valor que a conta não conhece fica como veio
    if (nome === null) {
      if (!objetoInteiro) delete saida[campo];
    } else saida[campo] = nome;
  };
  trocar('etapa', nomeParaGravar);
  trocar('etapa_tratamento', nomeDoTratamentoParaGravar);
  return (saida ?? parcial) as T;
}

// ── a lista do atributo ──────────────────────────────────────────────────────────────────────────

/** Os valores do atributo `etapa` da conta (sem repetir, na ordem do quadro). Sem mapa: o molde. */
export function listaDeEtapas(mapa: MapaDeEtapas | null | undefined): string[] {
  return [...new Set((mapa ?? ETAPAS_DO_MOLDE).comercial.map((e) => e.nome))];
}

export function listaDeEtapasDoTratamento(mapa: MapaDeEtapas | null | undefined): string[] {
  return [...new Set((mapa ?? ETAPAS_DO_MOLDE).tratamento.map((e) => e.nome))];
}

/**
 * Dos valores que o atributo tem AGORA no Chatwoot, os PAPÉIS que a conta tem (é a pergunta «esta conta tem a etapa X?»: Sofia só move para etapa que existe).
 * Valor desconhecido passa como veio. Sem mapa: a própria lista. Papel com substituto não aparece (a conta não tem etapa dele).
 */
export function papeisDoTratamentoDaLista(mapa: MapaDeEtapas | null | undefined, valores: readonly string[]): string[] {
  if (ehMolde(mapa)) return [...valores];
  return [...new Set(valores.map((v) => papelDaEtapaDoTratamento(mapa, v)))];
}

/** (comercial) */
export function papeisDaLista(mapa: MapaDeEtapas | null | undefined, valores: readonly string[]): string[] {
  if (ehMolde(mapa)) return [...valores];
  return [...new Set(valores.map((v) => papelDaEtapa(mapa, v)))];
}
