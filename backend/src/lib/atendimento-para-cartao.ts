/**
 * Dados do atendimento da franquia (tela de edição) espelhados no cartão do Kommo.
 *
 * Decisão do João (02/10/2026): a SDR digita UMA vez, na franquia; o Kommo reflete. Três campos:
 *  - Forma de Pagamento (franquia) → `⬢ Forma de pagamento`  (a lista do Kommo tem as 20 opções da franquia, na mesma grafia);
 *  - Data do retorno               → `◷ Retomar em` (a franquia vence; decisão do João em 02/10/2026: "franquia é o ponto central". A SDR digita a data só na franquia — digitar no Kommo é desfeito na varredura seguinte);
 *  - Motivo para não realizar      → `⊘ Motivo para não realizar o tratamento` (texto livre nos dois lados).
 * "Tratamento a ser realizado" NÃO é espelhado: a franquia só tem 3 protocolos (1, 2 ou 3 meses) e o
 * `⚕ Tratamento indicado` do Kommo tem 18 tipos — mapear perderia a região e o tipo. "Perfil" não tem par no Kommo.
 *
 * Regras: a franquia vence quando tem valor; franquia VAZIA nunca apaga o que está no cartão; só escreve o que mudou.
 *
 * Duplicata de nome: algumas contas têm dois `⬢ Forma de pagamento` (um em COMERCIAL, antigo, com 5 opções, e um na aba
 * PACIENTE). Escreve-se no que ACEITA a opção da franquia — o antigo não aceita, então nunca é tocado.
 */
import { localParaUtcIso } from '../services/spine.service.js';
import { normalizar } from './franquia-sync.js';
import type { AtendimentoTela } from './franquia-tela.js';

export const CAMPOS_ATENDIMENTO = {
  FORMA_PAGAMENTO: '⬢ Forma de pagamento',
  RETOMAR_EM: '◷ Retomar em',
  MOTIVO: '⊘ Motivo para não realizar o tratamento',
} as const;

/** Um campo da conta com este nome, e o que o cartão tem nele. */
export interface CampoCandidato {
  id: number;
  /** tipo como o Kommo diz: date, date_time, select, text, textarea… */
  tipo: string;
  valor: string | null;
  /** opções (campo de lista); vazio nos demais */
  opcoes: string[];
}

const TOLERANCIA_DIA = 86_399;

export interface EntradaAtendimento {
  atendimento: AtendimentoTela;
  /** Todos os campos da conta com esse nome (pode haver duplicata); vazio se a conta não tem. */
  campos: (nome: string) => CampoCandidato[];
  /** Fuso da clínica — a data do retorno vem em hora local. */
  fuso: string;
}

export interface EscritaDeAtendimento {
  id: number;
  campo: string;
  tipo: 'select' | 'text' | 'textarea' | 'date';
  valor: string | number;
  motivo: string;
}

export interface PlanoDeAtendimento {
  escritas: EscritaDeAtendimento[];
  /** o que ficou de fora e merece uma linha no log (opção que o Kommo não tem, tipo errado) */
  avisos: string[];
}

export function planejarAtendimento(e: EntradaAtendimento): PlanoDeAtendimento {
  const escritas: EscritaDeAtendimento[] = [];
  const avisos: string[] = [];
  const a = e.atendimento;

  // Forma de pagamento — campo de lista: só vale opção que EXISTE; grafia do Kommo, não a da franquia.
  if (a.formaPagamento) {
    const alvo = normalizar(a.formaPagamento);
    const candidatos = e.campos(CAMPOS_ATENDIMENTO.FORMA_PAGAMENTO).filter((c) => c.tipo === 'select' || c.tipo === 'radiobutton');
    let achado: { c: CampoCandidato; opcao: string } | null = null;
    for (const c of candidatos) {
      const opcao = c.opcoes.find((o) => normalizar(o) === alvo);
      if (opcao) { achado = { c, opcao }; break; }
    }
    if (!achado) {
      if (candidatos.length > 0) avisos.push(`forma de pagamento "${a.formaPagamento}" não existe como opção em nenhum campo "${CAMPOS_ATENDIMENTO.FORMA_PAGAMENTO}" da conta`);
    } else if (normalizar(achado.c.valor) !== alvo) {
      escritas.push({ id: achado.c.id, campo: CAMPOS_ATENDIMENTO.FORMA_PAGAMENTO, tipo: 'select', valor: achado.opcao, motivo: 'forma de pagamento na franquia' });
    }
  }

  // Data do retorno → Retomar em (a franquia guarda hora; o campo do Kommo é dia).
  if (a.retornoLocal) {
    const utc = localParaUtcIso(a.retornoLocal, e.fuso);
    const epoch = utc ? Math.floor(Date.parse(utc) / 1000) : null;
    const c = e.campos(CAMPOS_ATENDIMENTO.RETOMAR_EM).find((x) => x.tipo === 'date' || x.tipo === 'date_time');
    if (epoch !== null && c) {
      const atual = c.valor === null || c.valor.trim() === '' ? null : Number(c.valor);
      // `date` guarda só o dia (meia-noite do fuso da conta), então a mesma data volta do Kommo até ~24 h diferente
      // do epoch exato — comparar em 60 s regravaria o cartão a cada varredura.
      const tolerancia = c.tipo === 'date' ? TOLERANCIA_DIA : 60;
      const igual = atual !== null && Number.isFinite(atual) && Math.abs(atual - epoch) <= tolerancia;
      if (!igual) escritas.push({ id: c.id, campo: CAMPOS_ATENDIMENTO.RETOMAR_EM, tipo: 'date', valor: epoch, motivo: 'data do retorno na franquia' });
    }
  }

  // Motivo para não realizar → texto livre.
  const motivo = a.motivoNaoRealizar?.trim();
  if (motivo) {
    const c = e.campos(CAMPOS_ATENDIMENTO.MOTIVO).find((x) => x.tipo === 'text' || x.tipo === 'textarea');
    if (c && normalizar(c.valor) !== normalizar(motivo)) {
      escritas.push({ id: c.id, campo: CAMPOS_ATENDIMENTO.MOTIVO, tipo: c.tipo as 'text' | 'textarea', valor: motivo.slice(0, c.tipo === 'text' ? 250 : 1000), motivo: 'motivo para não realizar o tratamento na franquia' });
    }
  }

  return { escritas, avisos };
}
