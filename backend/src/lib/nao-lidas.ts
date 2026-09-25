/**
 * "Quantos pacientes escreveram e ninguém leu?"
 *
 * Medido em 25/09/2026, nas 19 contas: 363 conversas não lidas. Bebedouro 92,
 * Divinópolis 90, Serra 63, Mossoró 54. Ninguém é avisado disso hoje — o alerta de SLA
 * existe, mas está ligado em 10 das 30 unidades e cobra resposta em MINUTOS; ele não
 * enxerga pilha acumulada. Uma conversa de três dias atrás não dispara nada.
 *
 * A diferença entre este aviso e a faxina do inbox: a faxina fecha o que já foi lido, e
 * este cobra o que não foi. São os dois lados do mesmo problema — a faxina deixa a pilha
 * visível, este diz que ela existe.
 */
import type { Unit } from '@prisma/client';
import { createKommoClient } from '../services/kommo.service.js';

export interface NaoLidasDaConta {
  unidade: string;
  naoLidas: number;
  /** Há quantas horas está esperando a mais antiga sem ler. */
  maisAntigaHoras: number | null;
  erro?: string;
}

export function horasDesde(epoch: number | undefined, agora = Date.now()): number | null {
  if (!epoch) return null;
  return Math.max(0, Math.floor((agora - epoch * 1000) / 3_600_000));
}

export async function contarNaoLidas(unit: Unit): Promise<NaoLidasDaConta> {
  const base: NaoLidasDaConta = { unidade: unit.slug, naoLidas: 0, maisAntigaHoras: null };
  if (!unit.kommoAccessToken) return { ...base, erro: 'sem credencial do Kommo' };
  try {
    const abertas = await createKommoClient(unit).listarConversasAbertas();
    let maisAntiga: number | null = null;
    for (const t of abertas) {
      if (t.is_read) continue;
      base.naoLidas++;
      const q = t.updated_at ?? 0;
      if (q && (maisAntiga === null || q < maisAntiga)) maisAntiga = q;
    }
    base.maisAntigaHoras = horasDesde(maisAntiga ?? undefined);
    return base;
  } catch (err) {
    return { ...base, erro: String(err).slice(0, 140) };
  }
}

/** "3 dias", "5h", "agora" — o suficiente pra decidir se corre ou não. */
export function espera(horas: number | null): string {
  if (horas === null) return '?';
  if (horas < 1) return 'menos de 1h';
  if (horas < 48) return `${horas}h`;
  return `${Math.floor(horas / 24)} dias`;
}

/**
 * O texto do aviso. Só entra unidade que TEM não lida — mandar "0 pendências" todo dia
 * é o jeito mais rápido de a pessoa parar de abrir a mensagem.
 *
 * Devolve `null` quando não há nada a dizer: quem chama não manda nada, em vez de mandar
 * um aviso vazio.
 */
export function montarAviso(contas: NaoLidasDaConta[], hoje = new Date()): string | null {
  const comPendencia = contas
    .filter((c) => c.naoLidas > 0)
    .sort((a, b) => (b.maisAntigaHoras ?? 0) - (a.maisAntigaHoras ?? 0));
  const falharam = contas.filter((c) => c.erro);
  if (!comPendencia.length && !falharam.length) return null;

  const dia = hoje.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  const total = comPendencia.reduce((s, c) => s + c.naoLidas, 0);
  const linhas = [`*Pacientes esperando* · ${dia}`, ''];

  if (comPendencia.length) {
    linhas.push(`${total} pessoas escreveram e ninguém leu ainda.`, '');
    for (const c of comPendencia) {
      // O sinal à esquerda vale mais que o número: o que decide a ordem do dia é há
      // quanto tempo a mais antiga está parada, não quantas são.
      const h = c.maisAntigaHoras ?? 0;
      const sinal = h >= 24 ? '🔴' : h >= 4 ? '🟡' : '⚪';
      linhas.push(`${sinal} ${c.unidade} — ${c.naoLidas}, a mais antiga há ${espera(c.maisAntigaHoras)}`);
    }
  }

  if (falharam.length) {
    linhas.push('', `_Não consegui conferir: ${falharam.map((c) => c.unidade).join(', ')}_`);
  }

  return linhas.join('\n');
}
