/**
 * Leitura e estado EM MEMÓRIA do vigia da rede, com a mesma semântica das consultas de `vigia-rede-banco.ts`
 * (janela `[agora - N min, agora]`, sucesso/erro por modelo). Serve aos testes e à simulação contra um dump do banco real
 * (o que o vigia TERIA avisado numa noite passada). Não é usado em produção.
 */
import {
  familiaDoModelo,
  ehModeloDoGoogle,
  FAMILIAS,
  type EstadoAlerta,
  type EstadoStore,
  type Familia,
  type Frases,
  type GrupoDeErro,
  type Leitura,
  type TotaisDaFamilia,
} from './vigia-rede.js';

export interface ChamadaLlm {
  /** epoch em ms */
  t: number;
  status: 'success' | 'error';
  model: string;
  unidade?: string;
  mensagem?: string;
}
export interface FraseEnviada {
  t: number;
  conversa: string;
  unidade?: string;
}

const MIN = 60_000;
const DIA = 24 * 60 * MIN;

export function leituraEmMemoria(
  chamadas: ChamadaLlm[],
  frases: FraseEnviada[] = [],
  nomeDaUnidade: (id: string) => string = (i) => i,
  /** atalho dos testes: o "normal" do horário, sem gerar 4 semanas de tráfego */
  baselineFixo?: number[],
): Leitura {
  const na = (t: number, agora: Date, janelaMin: number) => t >= agora.getTime() - janelaMin * MIN && t <= agora.getTime();
  return {
    async errosAgrupados(agora: Date, janelaMin: number): Promise<GrupoDeErro[]> {
      const mapa = new Map<string, GrupoDeErro & { _u: Set<string> }>();
      for (const c of chamadas) {
        if (c.status !== 'error' || !na(c.t, agora, janelaMin) || ehModeloDoGoogle(c.model)) continue;
        const familia = familiaDoModelo(c.model);
        const mensagem = (c.mensagem ?? '').slice(0, 200);
        const k = `${familia}|${mensagem}`;
        const g = mapa.get(k) ?? { familia, mensagem, chamadas: 0, unidades: [], primeiro: new Date(c.t), ultimo: new Date(c.t), _u: new Set<string>() };
        g.chamadas += 1;
        if (c.unidade) g._u.add(nomeDaUnidade(c.unidade));
        if (c.t < g.primeiro.getTime()) g.primeiro = new Date(c.t);
        if (c.t > g.ultimo.getTime()) g.ultimo = new Date(c.t);
        mapa.set(k, g);
      }
      return [...mapa.values()].map(({ _u, ...g }) => ({ ...g, unidades: [..._u].sort() }));
    },
    async totaisPorFamilia(agora: Date, janelaMin: number): Promise<Record<Familia, TotaisDaFamilia>> {
      const out: Record<Familia, TotaisDaFamilia> = { anthropic: { ok: 0, erro: 0 }, openai: { ok: 0, erro: 0 } };
      for (const c of chamadas) {
        if (!na(c.t, agora, janelaMin) || ehModeloDoGoogle(c.model)) continue;
        out[familiaDoModelo(c.model)][c.status === 'success' ? 'ok' : 'erro'] += 1;
      }
      return out;
    },
    async ultimoSucesso(agora: Date): Promise<Record<Familia, Date | null>> {
      const out: Record<Familia, Date | null> = { anthropic: null, openai: null };
      for (const c of chamadas) {
        if (c.status !== 'success' || !na(c.t, agora, 24 * 60) || ehModeloDoGoogle(c.model)) continue;
        const f = familiaDoModelo(c.model);
        if (!out[f] || c.t > (out[f] as Date).getTime()) out[f] = new Date(c.t);
      }
      return out;
    },
    async baselineSucessos(agora: Date, janelaMin: number, semanas: number): Promise<number[]> {
      if (baselineFixo) return baselineFixo;
      const out: number[] = [];
      for (let d = 1; d <= semanas; d++) {
        const fim = agora.getTime() - d * 7 * DIA;
        const ini = fim - janelaMin * MIN;
        out.push(chamadas.filter((c) => c.status === 'success' && c.t >= ini && c.t < fim).length);
      }
      return out;
    },
    async frases(agora: Date, janelaMin: number): Promise<Frases> {
      const dentro = frases.filter((f) => na(f.t, agora, janelaMin));
      return {
        mensagens: dentro.length,
        conversas: new Set(dentro.map((f) => f.conversa)).size,
        unidades: [...new Set(dentro.flatMap((f) => (f.unidade ? [nomeDaUnidade(f.unidade)] : [])))].sort(),
      };
    },
  };
}

export function storeEmMemoria(): EstadoStore & { linhas: Map<string, EstadoAlerta> } {
  const linhas = new Map<string, EstadoAlerta>();
  return {
    linhas,
    async listar() {
      return [...linhas.values()].map((l) => ({ ...l }));
    },
    async abrir(chave, abertoEm, vistoEm) {
      linhas.set(chave, { chave, abertoEm, ultimoVistoEm: vistoEm, ultimoAvisoEm: null, lembretes: 0, resolvidoEm: null });
    },
    async visto(chave, vistoEm) {
      const l = linhas.get(chave);
      if (l && !l.resolvidoEm) l.ultimoVistoEm = vistoEm;
    },
    async avisou(chave, quando, lembrete) {
      const l = linhas.get(chave);
      if (!l) throw new Error(`avisou(${chave}): sem estado`);
      l.ultimoAvisoEm = quando;
      if (lembrete) l.lembretes += 1;
    },
    async fechar(chave, quando) {
      const l = linhas.get(chave);
      if (l && !l.resolvidoEm) l.resolvidoEm = quando;
    },
  };
}

export { FAMILIAS };
