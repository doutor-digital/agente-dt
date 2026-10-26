/**
 * O que o João lê no Telegram quando o disparo PARA por conta própria. Puro (sem rede), para o teste ler cada texto.
 * Três eventos, uma mensagem por evento por unidade: número restrito pela Meta (131048), limite de taxa por rodadas demais e
 * unidade sem andar. Cada texto traz a unidade, a(s) onda(s), o motivo e o que fazer.
 */

export interface DadosDoAlerta {
  unidade: string;
  /** ids das ondas da unidade que estavam aprovadas */
  ondas: readonly string[];
}

const ondas = (d: DadosDoAlerta) => (d.ondas.length ? d.ondas.join(', ') : '(nenhuma aprovada)');

export function alertaNumeroRestrito(d: DadosDoAlerta): string {
  return [
    `🚨 Disparo PAUSADO — ${d.unidade}`,
    `Onda(s): ${ondas(d)}`,
    'Motivo: a Meta RESTRINGIU o número por spam/qualidade (erro 131048). Continuar mandando agrava a restrição.',
    'O que fazer: ver a qualidade do número no Gerenciador do WhatsApp (Meta Business). Quando a Meta liberar, montar a onda de novo e aprovar. Esta pausa não tem botão Retomar.',
  ].join('\n');
}

export function alertaLimiteDeTaxa(d: DadosDoAlerta & { rodadas: number }): string {
  return [
    `⚠️ Disparo PAUSADO — ${d.unidade}`,
    `Onda(s): ${ondas(d)}`,
    `Motivo: a Meta pediu para esperar (limite de taxa) em ${d.rodadas} rodadas seguidas.`,
    'O que fazer: conferir o limite de mensagens e a qualidade do número na Meta; esperar o limite voltar. Depois, montar a onda de novo e aprovar (esta pausa não tem botão Retomar).',
  ].join('\n');
}

export function alertaSemAndar(d: { unidade: string; rodadas: number; adiados: number }): string {
  return [
    `⏳ Disparo SEM ANDAR — ${d.unidade}`,
    `Motivo: ${d.rodadas} rodadas seguidas só com pessoas adiadas (${d.adiados} na última): não deu para conferir ninguém na franquia ou no banco, então nada sai.`,
    'O que fazer: ver se a franquia (API Spine) e o banco estão no ar. Quando voltarem, o disparo anda sozinho; se uma pessoa específica nunca confere, cancelar a onda e montar de novo.',
  ].join('\n');
}
