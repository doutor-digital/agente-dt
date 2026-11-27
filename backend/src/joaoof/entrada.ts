/**
 * A fila de entrada do Joaoof: grupos e eventos do vigia viram linhas de `joaoof_entrada` (texto já mascarado) e a triagem lê o que
 * ainda não foi processado. A fila é o PONTO DE ENTRADA único: quem quiser alimentar o Joaoof escreve aqui (ver `vigia.ts`).
 */
import { prisma } from '../lib/prisma.js';

export interface Entrada {
  id: string;
  fonte: 'grupo' | 'vigia';
  ref: string;
  unidadeSlug: string | null;
  autorNome: string;
  autorChave: string | null;
  severidade: string;
  texto: string;
  escritaEm: Date;
  processadaEm: Date | null;
}

export type NovaEntrada = Omit<Entrada, 'id' | 'processadaEm'>;

export interface EntradaRepo {
  /** quantas eram NOVAS (o par fonte+ref é único: ler duas vezes não duplica) */
  inserir(itens: NovaEntrada[]): Promise<number>;
  pendentes(limite: number): Promise<Entrada[]>;
  marcarProcessadas(ids: string[], quando: Date): Promise<void>;
  /** as entradas com estas referências (para a revisão de urgente ver as mensagens de origem) */
  porRefs(refs: string[]): Promise<Entrada[]>;
  /** apaga o que foi processado antes de `antes` */
  purgarProcessadas(antes: Date): Promise<number>;
}

export function entradaEmMemoria(agora: () => Date = () => new Date()): EntradaRepo & { _itens: Entrada[] } {
  const itens: Entrada[] = [];
  let seq = 1;
  return {
    _itens: itens,
    async inserir(novas) {
      let n = 0;
      for (const e of novas) {
        if (itens.some((x) => x.fonte === e.fonte && x.ref === e.ref)) continue;
        itens.push({ ...e, id: `e${seq++}`, processadaEm: null });
        n++;
      }
      return n;
    },
    async pendentes(limite) {
      return itens
        .filter((x) => !x.processadaEm)
        .sort((a, b) => a.escritaEm.getTime() - b.escritaEm.getTime())
        .slice(0, limite)
        .map((x) => ({ ...x }));
    },
    async porRefs(refs) {
      return itens.filter((x) => refs.includes(x.ref)).map((x) => ({ ...x }));
    },
    async marcarProcessadas(ids, quando) {
      for (const x of itens) if (ids.includes(x.id)) x.processadaEm = quando ?? agora();
    },
    async purgarProcessadas(antes) {
      const antesN = itens.length;
      for (let i = itens.length - 1; i >= 0; i--) if (itens[i]!.processadaEm && itens[i]!.processadaEm! < antes) itens.splice(i, 1);
      return antesN - itens.length;
    },
  };
}

export const entradaPrisma: EntradaRepo = {
  async inserir(novas) {
    if (novas.length === 0) return 0;
    const r = await prisma.joaoofEntrada.createMany({
      data: novas.map((e) => ({ fonte: e.fonte, ref: e.ref, unidadeSlug: e.unidadeSlug, autorNome: e.autorNome, autorChave: e.autorChave, severidade: e.severidade, texto: e.texto, escritaEm: e.escritaEm })),
      skipDuplicates: true,
    });
    return r.count;
  },
  async pendentes(limite) {
    const l = await prisma.joaoofEntrada.findMany({ where: { processadaEm: null }, orderBy: { escritaEm: 'asc' }, take: limite });
    return l.map((x) => ({ id: x.id, fonte: x.fonte === 'vigia' ? 'vigia' : 'grupo', ref: x.ref, unidadeSlug: x.unidadeSlug, autorNome: x.autorNome, autorChave: x.autorChave, severidade: x.severidade, texto: x.texto, escritaEm: x.escritaEm, processadaEm: x.processadaEm }));
  },
  async porRefs(refs) {
    if (refs.length === 0) return [];
    const l = await prisma.joaoofEntrada.findMany({ where: { ref: { in: refs } }, orderBy: { escritaEm: 'asc' } });
    return l.map((x) => ({ id: x.id, fonte: x.fonte === 'vigia' ? 'vigia' : 'grupo', ref: x.ref, unidadeSlug: x.unidadeSlug, autorNome: x.autorNome, autorChave: x.autorChave, severidade: x.severidade, texto: x.texto, escritaEm: x.escritaEm, processadaEm: x.processadaEm }));
  },

  async marcarProcessadas(ids, quando) {
    if (ids.length) await prisma.joaoofEntrada.updateMany({ where: { id: { in: ids } }, data: { processadaEm: quando } });
  },
  async purgarProcessadas(antes) {
    const r = await prisma.joaoofEntrada.deleteMany({ where: { processadaEm: { lt: antes } } });
    return r.count;
  },
};

