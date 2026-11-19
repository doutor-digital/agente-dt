/**
 * Retroativo do «Sofia atendendo»: as conversas que JÁ estão em «Pendentes» na caixa vão para «Abertas» e, se a Sofia ainda pode estar
 * atendendo (viva há pouco e sem nada que a cale), levam a etiqueta `sofia-atendendo`. Não manda mensagem a ninguém: só status e etiqueta.
 * O que decide é o mesmo `sofiaPodeAtender` do fluxo ao vivo. Repetir é seguro (já aberta/etiquetada não é regravada).
 */
import { ETIQUETA_SOFIA_ATENDENDO, sofiaPodeAtender, type PortaDoAtendimento } from './chatwoot-sofia-atendendo.js';

export interface ArgumentosDoAcerto {
  soConferir: boolean;
  caixa: number;
  /** só conversas com atividade nas últimas N horas levam a etiqueta (a de semana passada não está «sendo atendida») */
  etiquetarHoras: number;
}

export function lerArgumentosDoAcerto(argv: string[]): ArgumentosDoAcerto {
  const r: ArgumentosDoAcerto = { soConferir: false, caixa: 3, etiquetarHoras: 24 };
  for (const a of argv) {
    let m: RegExpMatchArray | null;
    if (a === '--so-conferir') r.soConferir = true;
    else if ((m = a.match(/^--caixa=(\d{1,6})$/))) r.caixa = Number(m[1]);
    else if ((m = a.match(/^--etiquetar-horas=(\d{1,4})$/))) r.etiquetarHoras = Number(m[1]);
    else throw new Error(`opção inválida: ${a} (use --so-conferir, --caixa=N, --etiquetar-horas=N)`);
  }
  if (r.caixa <= 0) throw new Error('--caixa precisa ser maior que zero');
  return r;
}

export interface PendenteDaCaixa {
  id: number;
  /** segundos desde 1970 da última atividade; null = o Chatwoot não disse */
  ultimaAtividade: number | null;
}

export interface PortasDoAcerto {
  pendentes(): Promise<{ lista: PendenteDaCaixa[]; truncado: boolean }>;
  atendimento: PortaDoAtendimento;
  /** a automação `chatwoot-ia` da unidade: a etiqueta só vale se a Sofia está LIGADA */
  sofiaLigada: boolean;
}

export interface ResumoDoAcerto {
  pendentes: number;
  abertas: number;
  etiquetadas: number;
  semEtiqueta: number;
  falhou: number;
  truncado: boolean;
}

export async function acertarPendentes(a: ArgumentosDoAcerto, p: PortasDoAcerto, agora: Date, log: (l: string) => void = () => undefined): Promise<ResumoDoAcerto> {
  const { lista, truncado } = await p.pendentes();
  const r: ResumoDoAcerto = { pendentes: lista.length, abertas: 0, etiquetadas: 0, semEtiqueta: 0, falhou: 0, truncado };
  const limite = agora.getTime() / 1000 - a.etiquetarHoras * 3600;
  for (const c of lista) {
    try {
      const viva = await p.atendimento.conversa(c.id);
      if (!viva) {
        log(`conversa ${c.id}: sumiu do Chatwoot — ignorada`);
        continue;
      }
      const recente = c.ultimaAtividade !== null && c.ultimaAtividade >= limite;
      // a decisão da etiqueta é a do fluxo ao vivo (pendente conta como viva; resolvida/adiada nesse meio-tempo, não)
      const etiquetar = p.sofiaLigada && recente && sofiaPodeAtender(viva) && !viva.lida.etiquetas.includes(ETIQUETA_SOFIA_ATENDENDO);
      if (viva.status === 'pending') r.abertas++;
      if (etiquetar) r.etiquetadas++;
      else r.semEtiqueta++;
      log(`conversa ${c.id}: ${viva.status === 'pending' ? 'abrir' : `já ${viva.status}`}${etiquetar ? ' + etiqueta' : ''}${etiquetar ? '' : ` (sem etiqueta: ${!p.sofiaLigada ? 'Sofia não está ligada nesta unidade' : !recente ? `parada há mais de ${a.etiquetarHoras} h` : viva.lida.etiquetas.includes(ETIQUETA_SOFIA_ATENDENDO) ? 'já tem' : 'a Sofia está calada aqui'})`}`);
      if (a.soConferir) continue;
      if (viva.status === 'pending') await p.atendimento.abrir(c.id);
      if (etiquetar) {
        await p.atendimento.garantirEtiqueta();
        // relê logo antes de regravar a lista (o Chatwoot a substitui inteira)
        const fresca = await p.atendimento.conversa(c.id);
        if (fresca && sofiaPodeAtender(fresca) && !fresca.lida.etiquetas.includes(ETIQUETA_SOFIA_ATENDENDO)) await p.atendimento.etiquetas(c.id, [...fresca.lida.etiquetas, ETIQUETA_SOFIA_ATENDENDO]);
      }
    } catch (err) {
      r.falhou++;
      log(`conversa ${c.id}: FALHOU — ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`);
    }
  }
  return r;
}
