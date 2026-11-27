/**
 * O que o Joaoof guarda, atrás de uma interface: o cérebro e as ferramentas não sabem se é Postgres ou memória.
 * `repoEmMemoria` serve ao teste e à prova em seco (nada toca o banco); `repo-prisma.ts` é o de produção.
 */
import { cortar, mascarar, trechoCurto } from './privacidade.js';

export const CATEGORIAS = ['pedido', 'queixa', 'problema_ia', 'duvida', 'dinheiro', 'paciente', 'outro'] as const;
export const PRIORIDADES = ['urgente', 'alta', 'normal', 'baixa'] as const;
export const STATUS = ['aberta', 'em_andamento', 'feita', 'descartada'] as const;
export const TIPOS_MEMORIA = ['decisao', 'preferencia', 'resposta', 'fato'] as const;

export type Categoria = (typeof CATEGORIAS)[number];
export type Prioridade = (typeof PRIORIDADES)[number];
export type StatusDemanda = (typeof STATUS)[number];
export type TipoMemoria = (typeof TIPOS_MEMORIA)[number];

export interface Demanda {
  id: string;
  numero: number;
  unidadeSlug: string | null;
  solicitante: string;
  titulo: string;
  descricao: string;
  trecho: string;
  categoria: Categoria;
  prioridade: Prioridade;
  status: StatusDemanda;
  responsavel: string;
  /** AAAA-MM-DD */
  prazo: string | null;
  prazoTexto: string;
  fonte: string;
  fonteRefs: string[];
  /** campos que o João já definiu: ficam travados para a triagem automática */
  camposDoJoao: string[];
  repeticoes: number;
  motivo: string;
  notaJoao: string;
  vistaEm: Date;
  avisadaEm: Date | null;
  resolvidaEm: Date | null;
  criadoEm: Date;
  atualizadoEm: Date;
}

export interface NovaDemanda {
  unidadeSlug?: string | null;
  solicitante?: string;
  titulo: string;
  descricao?: string;
  trecho?: string;
  categoria?: Categoria;
  prioridade?: Prioridade;
  responsavel?: string;
  prazo?: string | null;
  prazoTexto?: string;
  fonte?: string;
  fonteRefs?: string[];
  motivo?: string;
}

export interface AtualizaDemanda {
  titulo?: string;
  descricao?: string;
  categoria?: Categoria;
  prioridade?: Prioridade;
  status?: StatusDemanda;
  responsavel?: string;
  prazo?: string | null;
  prazoTexto?: string;
  motivo?: string;
  notaJoao?: string;
  /** a mesma pergunta apareceu de novo: soma 1 e anexa as referências das mensagens (sem repetir) */
  repeticao?: { fonteRefs: string[]; trecho?: string };
  avisadaEm?: Date;
}

export interface FiltroDemandas {
  status?: StatusDemanda[];
  /** só as resolvidas a partir deste instante (o «resolvidas hoje» do resumo não pode depender do limite da lista) */
  resolvidaDesde?: Date;
  unidadeSlug?: string;
  /** palavra ou trecho do título/descrição/solicitante */
  texto?: string;
  limite?: number;
}

export interface Memoria {
  id: string;
  tipo: TipoMemoria;
  assunto: string;
  texto: string;
  unidadeSlug: string | null;
  origem: string;
  usos: number;
  ativa: boolean;
  criadoEm: Date;
  atualizadoEm: Date;
}

export interface NovaMemoria {
  tipo: TipoMemoria;
  assunto: string;
  texto: string;
  unidadeSlug?: string | null;
  origem?: string;
}

export interface UnidadeJoaoof {
  slug: string;
  nome: string;
  grupoJid: string | null;
  notas: string;
  ativa: boolean;
}

export interface AvisoJoaoof {
  tipo: 'resumo' | 'urgente' | 'resposta' | 'sistema';
  chave: string;
  demandaId?: string | null;
  texto: string;
  enviado: boolean;
  seco: boolean;
}

export interface FalaDaConversa {
  quem: 'joao' | 'joaoof';
  texto: string;
  criadoEm: Date;
}

export interface JoaoofRepo {
  criarDemanda(d: NovaDemanda): Promise<Demanda>;
  /** `porJoao`: a mudança veio do João (Telegram): os campos mexidos ficam travados para a triagem automática. */
  atualizarDemanda(numero: number, patch: AtualizaDemanda, porJoao?: boolean): Promise<Demanda | null>;
  buscarDemanda(numero: number): Promise<Demanda | null>;
  listarDemandas(f?: FiltroDemandas): Promise<Demanda[]>;
  /** Grava a memória; mesma (tipo, assunto, unidade) ATUALIZA o texto em vez de duplicar. */
  guardarMemoria(m: NovaMemoria): Promise<Memoria>;
  buscarMemoria(consulta: string, opcoes?: { unidadeSlug?: string; limite?: number }): Promise<Memoria[]>;
  lerMemoria(id: string): Promise<Memoria | null>;
  esquecerMemoria(id: string): Promise<boolean>;
  unidades(): Promise<UnidadeJoaoof[]>;
  /** false = já existia um aviso desse (tipo, chave): quem chama NÃO manda de novo. */
  registrarAviso(a: AvisoJoaoof): Promise<boolean>;
  marcarAvisoEnviado(tipo: AvisoJoaoof['tipo'], chave: string, enviado: boolean): Promise<void>;
  /**
   * Retoma um aviso que NÃO foi enviado (falhou antes). Só uma instância ganha: a reserva anterior precisa ter mais de `minSegundos`.
   * Quem chama `registrarAviso` e ganha já está com a reserva; quem encontra uma linha não enviada tem de passar por aqui antes de enviar.
   */
  reivindicarReenvio(tipo: AvisoJoaoof['tipo'], chave: string, minSegundos: number): Promise<boolean>;
  buscarAviso(tipo: AvisoJoaoof['tipo'], chave: string): Promise<{ enviado: boolean; seco: boolean } | null>;
  anexarConversa(quem: 'joao' | 'joaoof', texto: string): Promise<void>;
  ultimasDaConversa(n: number): Promise<FalaDaConversa[]>;
  lerEstado<T = unknown>(chave: string): Promise<T | null>;
  gravarEstado(chave: string, valor: unknown): Promise<void>;
}

/** Os campos de uma demanda que, depois que o João mexe, a triagem não sobrescreve. */
export const CAMPOS_TRAVAVEIS = ['titulo', 'prioridade', 'categoria', 'responsavel', 'prazo', 'prazoTexto', 'status'] as const;

export function camposMexidos(patch: AtualizaDemanda): string[] {
  return CAMPOS_TRAVAVEIS.filter((c) => (patch as Record<string, unknown>)[c] !== undefined);
}

const sem = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/** Palavras da consulta com 3+ letras, sem acento: a busca textual em memória (teste e seco). */
export function palavrasDaBusca(consulta: string): string[] {
  return [...new Set(sem(consulta).split(/[^a-z0-9]+/).filter((p) => p.length >= 3))];
}

export function repoEmMemoria(agora: () => Date = () => new Date(), unidadesIniciais: UnidadeJoaoof[] = []): JoaoofRepo & { _demandas: Demanda[]; _avisos: Array<AvisoJoaoof & { reservadoEmMs?: number }>; _memorias: Memoria[] } {
  const demandas: Demanda[] = [];
  const memorias: Memoria[] = [];
  const avisos: Array<AvisoJoaoof & { reservadoEmMs?: number }> = [];
  const conversa: FalaDaConversa[] = [];
  const estado = new Map<string, unknown>();
  let proxNumero = 1;
  let proxMem = 1;
  const copia = <T,>(x: T): T => structuredClone(x);

  return {
    _demandas: demandas,
    _avisos: avisos,
    _memorias: memorias,
    async criarDemanda(d) {
      const t = agora();
      const nova: Demanda = {
        id: `d${proxNumero}`,
        numero: proxNumero++,
        unidadeSlug: d.unidadeSlug ?? null,
        solicitante: trechoCurto(d.solicitante ?? '', 120),
        titulo: trechoCurto(d.titulo, 200),
        descricao: trechoCurto(d.descricao ?? '', 1000),
        trecho: trechoCurto(d.trecho ?? ''),
        categoria: d.categoria ?? 'outro',
        prioridade: d.prioridade ?? 'normal',
        status: 'aberta',
        responsavel: d.responsavel ?? 'joao',
        prazo: d.prazo ?? null,
        prazoTexto: trechoCurto(d.prazoTexto ?? '', 120),
        fonte: d.fonte ?? 'grupo',
        fonteRefs: [...(d.fonteRefs ?? [])],
        camposDoJoao: [],
        repeticoes: 1,
        motivo: trechoCurto(d.motivo ?? '', 300),
        notaJoao: '',
        vistaEm: t,
        avisadaEm: null,
        resolvidaEm: null,
        criadoEm: t,
        atualizadoEm: t,
      };
      demandas.push(nova);
      return copia(nova);
    },
    async atualizarDemanda(numero, patch, porJoao = false) {
      const d = demandas.find((x) => x.numero === numero);
      if (!d) return null;
      if (porJoao) d.camposDoJoao = [...new Set([...d.camposDoJoao, ...camposMexidos(patch)])];
      const t = agora();
      const { repeticao, titulo, descricao, prazoTexto, motivo, notaJoao, ...resto } = patch;
      Object.assign(d, Object.fromEntries(Object.entries(resto).filter(([, v]) => v !== undefined)));
      // todo texto livre passa pela máscara AQUI (vale para qualquer chamador): nada de telefone/CPF no banco
      if (titulo !== undefined) d.titulo = trechoCurto(titulo, 200);
      if (descricao !== undefined) d.descricao = trechoCurto(descricao, 1000);
      if (prazoTexto !== undefined) d.prazoTexto = trechoCurto(prazoTexto, 120);
      if (motivo !== undefined) d.motivo = trechoCurto(motivo, 300);
      if (notaJoao !== undefined) d.notaJoao = trechoCurto(notaJoao, 500);
      if (repeticao) {
        const novas = repeticao.fonteRefs.filter((r) => !d.fonteRefs.includes(r));
        d.fonteRefs.push(...novas);
        // só soma com PROVA: ao menos uma mensagem nova (o mesmo lote lido duas vezes, ou referência que não existe, não soma)
        if (novas.length > 0) d.repeticoes += 1;
        if (repeticao.trecho && !d.trecho) d.trecho = trechoCurto(repeticao.trecho);
        d.vistaEm = t;
      }
      if (patch.status === 'feita' || patch.status === 'descartada') d.resolvidaEm = t;
      if (patch.status === 'aberta' || patch.status === 'em_andamento') d.resolvidaEm = null;
      d.atualizadoEm = t;
      return copia(d);
    },
    async buscarDemanda(numero) {
      const d = demandas.find((x) => x.numero === numero);
      return d ? copia(d) : null;
    },
    async listarDemandas(f = {}) {
      const palavras = f.texto ? palavrasDaBusca(f.texto) : [];
      const achadas = demandas.filter((d) => {
        if (f.status && !f.status.includes(d.status)) return false;
        if (f.unidadeSlug && d.unidadeSlug !== f.unidadeSlug) return false;
        if (f.resolvidaDesde && !(d.resolvidaEm && d.resolvidaEm >= f.resolvidaDesde)) return false;
        if (palavras.length) {
          const alvo = sem(`${d.titulo} ${d.descricao} ${d.solicitante} ${d.trecho}`);
          if (!palavras.some((p) => alvo.includes(p))) return false;
        }
        return true;
      });
      const peso = (p: Prioridade) => PRIORIDADES.indexOf(p);
      achadas.sort((a, b) => peso(a.prioridade) - peso(b.prioridade) || a.criadoEm.getTime() - b.criadoEm.getTime());
      return achadas.slice(0, f.limite ?? 50).map(copia);
    },
    async guardarMemoria(m) {
      const t = agora();
      const existente = memorias.find((x) => x.ativa && x.tipo === m.tipo && sem(x.assunto) === sem(m.assunto) && (x.unidadeSlug ?? null) === (m.unidadeSlug ?? null));
      if (existente) {
        existente.texto = trechoCurto(m.texto, 1200);
        existente.atualizadoEm = t;
        return copia(existente);
      }
      const nova: Memoria = { id: `m${proxMem++}`, tipo: m.tipo, assunto: trechoCurto(m.assunto, 160), texto: trechoCurto(m.texto, 1200), unidadeSlug: m.unidadeSlug ?? null, origem: m.origem ?? 'telegram', usos: 0, ativa: true, criadoEm: t, atualizadoEm: t };
      memorias.push(nova);
      return copia(nova);
    },
    async buscarMemoria(consulta, opcoes = {}) {
      const palavras = palavrasDaBusca(consulta);
      const pontos = memorias
        .filter((m) => m.ativa && (!opcoes.unidadeSlug || m.unidadeSlug === null || m.unidadeSlug === opcoes.unidadeSlug))
        .map((m) => {
          const alvo = sem(`${m.assunto} ${m.texto}`);
          return { m, p: palavras.filter((w) => alvo.includes(w)).length };
        })
        .filter((x) => x.p > 0)
        .sort((a, b) => b.p - a.p);
      const saida = pontos.slice(0, opcoes.limite ?? 5).map((x) => x.m);
      for (const m of saida) m.usos += 1;
      return saida.map(copia);
    },
    async lerMemoria(id) {
      const m = memorias.find((x) => x.id === id && x.ativa);
      return m ? copia(m) : null;
    },
    async esquecerMemoria(id) {
      const m = memorias.find((x) => x.id === id);
      if (!m) return false;
      m.ativa = false;
      return true;
    },
    async unidades() {
      return unidadesIniciais.map(copia);
    },
    async registrarAviso(a) {
      if (avisos.some((x) => x.tipo === a.tipo && x.chave === a.chave)) return false;
      avisos.push({ ...a, texto: cortar(mascarar(a.texto), 4000), reservadoEmMs: agora().getTime() });
      return true;
    },
    async marcarAvisoEnviado(tipo, chave, enviado) {
      const a = avisos.find((x) => x.tipo === tipo && x.chave === chave);
      if (a) a.enviado = enviado;
    },
    async reivindicarReenvio(tipo, chave, minSegundos) {
      const a = avisos.find((x) => x.tipo === tipo && x.chave === chave);
      if (!a || a.enviado) return false;
      const agoraMs = agora().getTime();
      if (a.reservadoEmMs !== undefined && agoraMs - a.reservadoEmMs < minSegundos * 1000) return false;
      a.reservadoEmMs = agoraMs;
      return true;
    },
    async buscarAviso(tipo, chave) {
      const a = avisos.find((x) => x.tipo === tipo && x.chave === chave);
      return a ? { enviado: a.enviado, seco: a.seco } : null;
    },
    async anexarConversa(quem, texto) {
      conversa.push({ quem, texto: trechoCurto(texto, 2000), criadoEm: agora() });
      if (conversa.length > 40) conversa.splice(0, conversa.length - 40);
    },
    async ultimasDaConversa(n) {
      return conversa.slice(-n).map(copia);
    },
    async lerEstado<T>(chave: string) {
      return (estado.has(chave) ? copia(estado.get(chave)) : null) as T | null;
    },
    async gravarEstado(chave, valor) {
      estado.set(chave, copia(valor));
    },
  };
}
