/**
 * O que o Copiloto SABE e PODE sobre os campos do cartão — e só isso.
 *
 * Regra do João (28/10/2026): "não inventa coisa: campo que não deve ser preenchido, campo que é automático".
 * Então o Copiloto nunca decide sozinho o que propor: tudo vem do dicionário da rede (`dicionario-campos.ts`),
 * e este módulo é o portão. Se o campo não existe no dicionário, chega sozinho, é técnico, é de outra pessoa,
 * é de outra etapa, já tem valor ou o valor não é uma opção da lista, a proposta é recusada com o motivo
 * (que o Copiloto repete para a pessoa em português simples).
 */
import { DICIONARIO } from './dicionario-campos.js';

export type Ator = 'sdr' | 'sofia' | 'recepcao' | 'fisio' | 'financeiro' | 'automatico';
export type PapelDeQuemUsa = 'sdr' | 'recepcao' | 'fisio';
export type Acao = 'propor' | 'avisar' | 'recusar';

export interface InfoCampo {
  nome: string;
  oQueE: string;
  quemPreencheTexto: string;
  quando: string;
  exemplo: string;
  /** Como o valor chega sem ninguém digitar (agenda da franquia, regra do comprovante…); null = alguém digita. */
  chegaSozinho: string | null;
  atores: Ator[];
  /** "Asaas", "3C", "rastreio de anúncios"… quando o texto de "quem preenche" diz de onde vem. */
  origemAutomatica: string | null;
}

export interface Decisao {
  acao: Acao;
  /** Frase pronta, em português simples, para o Copiloto falar. */
  motivo: string;
}

const norm = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();

const POR_NOME = new Map<string, string>(Object.keys(DICIONARIO.campos).map((n) => [norm(n), n]));
const POR_ETAPA = new Map<string, string>(Object.keys(DICIONARIO.etapas).map((n) => [norm(n), n]));

const NOME_DO_ATOR: Record<Ator, string> = {
  sdr: 'da SDR',
  sofia: 'da Sofia (a IA)',
  recepcao: 'da recepção',
  fisio: 'da fisioterapeuta',
  financeiro: 'do financeiro',
  automatico: 'automático',
};

/** "SDR", "Sofia ou SDR", "Automático (Asaas)", "Fisio ou Recepção"… → quem mexe nesse campo. */
export function atoresDe(quemPreenche: string): Ator[] {
  const t = norm(quemPreenche);
  const s = new Set<Ator>();
  if (t.includes('automático') || t.includes('automatico')) s.add('automatico');
  if (/\bsdr\b/.test(t)) s.add('sdr');
  if (/\bsofia\b/.test(t)) s.add('sofia');
  if (/recepção|recepcao/.test(t)) s.add('recepcao');
  if (/\bfisio/.test(t)) s.add('fisio');
  if (/financeiro/.test(t)) s.add('financeiro');
  // "Sofia (ajuste se discordar)" / "Sofia (complete se o paciente contou mais…)": a Sofia preenche, a pessoa corrige
  if (/ajuste se discordar|complete se/.test(t)) s.add('sdr');
  return [...s];
}

export function nomeCanonico(nome: string): string | null {
  return POR_NOME.get(norm(nome)) ?? null;
}

export function etapaCanonica(etapa: string): string | null {
  return POR_ETAPA.get(norm(etapa)) ?? null;
}

/** utm_*, Statistics…: rastreio técnico que ninguém preenche nem precisa ver. */
export function ehCampoTecnico(nome: string): boolean {
  const n = norm(nome);
  return Object.keys(DICIONARIO.generico).some((g) => n.startsWith(norm(g)));
}

export function infoDoCampo(nome: string): InfoCampo | null {
  const canon = nomeCanonico(nome);
  if (!canon) return null;
  const e = DICIONARIO.campos[canon]!;
  const origem = /^automático\s*\(([^)]+)\)/i.exec(e.q.trim());
  return {
    nome: canon,
    oQueE: e.o,
    quemPreencheTexto: e.q,
    quando: e.w,
    exemplo: e.ex,
    chegaSozinho: e.chega_sozinho ?? null,
    atores: atoresDe(e.q),
    origemAutomatica: origem ? origem[1]!.trim() : null,
  };
}

/** Campos que a pessoa deve preencher na etapa, como o dicionário manda (nada além disso). */
export function camposDaEtapa(etapa: string): InfoCampo[] {
  const canon = etapaCanonica(etapa);
  if (!canon) return [];
  return (DICIONARIO.etapas[canon] ?? []).map((n) => infoDoCampo(n)).filter((x): x is InfoCampo => x !== null);
}

export function etapasQueListamOCampo(nome: string): string[] {
  const canon = nomeCanonico(nome);
  if (!canon) return [];
  return Object.entries(DICIONARIO.etapas).filter(([, l]) => l.includes(canon)).map(([e]) => e);
}

export function proximasEtapas(etapa: string): string[] {
  const canon = etapaCanonica(etapa);
  return canon ? (DICIONARIO.proxima[canon] ?? []) : [];
}

export function missaoDaEtapa(etapa: string): string | null {
  const canon = etapaCanonica(etapa);
  return canon ? (DICIONARIO.missao[canon] ?? null) : null;
}

/**
 * Pode o Copiloto sugerir que ESTA pessoa preencha o campo? (só a regra de "de quem é", sem olhar etapa nem valor).
 * - propor: o campo é da pessoa (ou da Sofia com ajuste humano) e não chega sozinho.
 * - avisar: tem parte automática (ex.: "Sofia ou automático"): o Copiloto só avisa que está vazio, não manda preencher.
 * - recusar: chega sozinho, é técnico, não existe, ou é de outra pessoa.
 */
export function podeSugerir(nome: string, papel: PapelDeQuemUsa = 'sdr'): Decisao {
  if (ehCampoTecnico(nome)) return { acao: 'recusar', motivo: 'Esse é um campo técnico de rastreio. Ninguém preenche, e não precisa mexer.' };
  const info = infoDoCampo(nome);
  if (!info) return { acao: 'recusar', motivo: 'Esse campo não existe no padrão da rede, então eu não sugiro nada nele.' };
  if (info.chegaSozinho) {
    return { acao: 'recusar', motivo: `Esse campo chega sozinho: ${info.chegaSozinho}. Não precisa preencher.` };
  }
  if (info.atores.includes('automatico')) {
    const de = info.origemAutomatica ? ` (${info.origemAutomatica})` : '';
    return info.atores.some((a) => a !== 'automatico')
      ? { acao: 'avisar', motivo: `Esse campo costuma chegar sozinho${de} ou pela Sofia. Se estiver vazio, é bom conferir, mas eu não mando preencher.` }
      : { acao: 'recusar', motivo: `Esse campo é automático${de}. Não precisa preencher.` };
  }
  if (info.atores.includes(papel)) return { acao: 'propor', motivo: 'É um campo seu.' };
  const donos = info.atores.map((a) => NOME_DO_ATOR[a]);
  return { acao: 'recusar', motivo: `Esse campo é ${donos.join(' ou ')}, não seu.` };
}

export interface PropostaDeCampo {
  campo: string;
  valor: string;
}

export interface ContextoDeValidacao {
  etapa: string;
  papel?: PapelDeQuemUsa;
  /** Valor que o campo já tem no cartão (null/vazio = vazio). */
  valorAtual?: (campo: string) => string | null | undefined;
  /** Opções válidas quando o campo é uma lista. */
  opcoes?: (campo: string) => string[] | null | undefined;
  /** O campo é uma lista? Sem opções conhecidas de uma lista, o valor é recusado (não dá para conferir). */
  ehLista?: (campo: string) => boolean;
  /** Aceita também campos das etapas para onde o lead pode ir (padrão: NÃO — só a etapa atual). */
  incluirProximas?: boolean;
}

/** O portão: devolve se a proposta pode seguir ao revisor, com o motivo em português simples. */
export function validarProposta(p: PropostaDeCampo, ctx: ContextoDeValidacao): Decisao {
  if (!p.valor || !p.valor.trim()) return { acao: 'recusar', motivo: 'Faltou o valor a preencher.' };
  const quem = podeSugerir(p.campo, ctx.papel ?? 'sdr');
  if (quem.acao !== 'propor') return quem;
  const nome = nomeCanonico(p.campo)!;

  const daEtapa = (camposDaEtapa(ctx.etapa)).some((c) => c.nome === nome);
  const dasProximas = !!ctx.incluirProximas && proximasEtapas(ctx.etapa).some((e) => camposDaEtapa(e).some((c) => c.nome === nome));
  if (!daEtapa && !dasProximas) {
    const onde = etapasQueListamOCampo(nome);
    return { acao: 'recusar', motivo: onde.length ? `Esse campo é da etapa ${onde[0]}, não desta.` : 'Esse campo não é de nenhuma etapa em que a SDR trabalha.' };
  }

  const atual = ctx.valorAtual?.(nome);
  if (atual && atual.trim()) {
    return { acao: 'recusar', motivo: norm(atual) === norm(p.valor) ? 'Esse campo já está assim.' : 'Esse campo já tem valor. Eu não sobrescrevo o que já foi preenchido.' };
  }

  const lista = ctx.opcoes?.(nome);
  if (lista && lista.length) {
    if (!lista.some((o) => norm(o) === norm(p.valor))) return { acao: 'recusar', motivo: `"${p.valor}" não é uma opção da lista deste campo.` };
  } else if (ctx.ehLista?.(nome)) {
    return { acao: 'recusar', motivo: 'Esse campo é uma lista e eu não consegui ler as opções dele, então não sugiro valor.' };
  }
  return { acao: 'propor', motivo: 'Pode seguir para a conferência do revisor.' };
}

/** Explicação curta e fiel do dicionário, para a pergunta "o que é esse campo / quem preenche?". */
export function explicarCampo(nome: string): string | null {
  const i = infoDoCampo(nome);
  if (!i) return null;
  const quem = i.chegaSozinho ? `Chega sozinho: ${i.chegaSozinho}.` : `Quem preenche: ${i.quemPreencheTexto}.`;
  return `${i.nome}: ${i.oQueE} ${quem} Quando: ${i.quando}`;
}
