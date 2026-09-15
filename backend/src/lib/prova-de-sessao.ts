/**
 * Quando o guardião da voz deve PROVAR que a sessão web ainda funciona.
 *
 * Por que isto existe (15/09/2026): o guardião só mexia na sessão quando havia
 * token para renovar — o que só acontece nas últimas 48 h de vida do token. Uma
 * varredura que não renova nada **não prova nada**: ela passa, não dá erro, e o
 * campo `ultimo_ok` fica velho. Olhando esse campo eu concluí que a sessão estava
 * morta há um dia e dei alarme falso; ela estava viva e a manutenção estava
 * agendada para dali a 15 minutos.
 *
 * Duas consequências, e esta função resolve as duas:
 *  - `ultimo_ok` passa a significar "última vez que provamos que funciona", e não
 *    "última vez que por acaso teve trabalho a fazer";
 *  - a falha aparece com DIAS de antecedência, e não nas últimas 48 h — quando já
 *    não sobra margem para alguém logar de novo.
 */

const DIA_MS = 86_400_000;

/** Dias sem prova a partir dos quais o guardião emite um token de teste. */
export const DIAS_SEM_PROVA = 7;

export interface DecisaoDeProva {
  provar: boolean;
  /** dias desde a última prova; null quando nunca houve prova */
  idadeDias: number | null;
  motivo: 'nunca-provada' | 'prova-velha' | 'prova-recente' | 'ja-provou-agora';
}

/**
 * @param ultimoOk quando a sessão foi provada pela última vez (null = nunca)
 * @param renovouAgora true quando a varredura acabou de emitir token — aí ela já
 *        provou a sessão por conta própria e não precisa de teste extra
 */
export function decidirProva(
  ultimoOk: Date | null | undefined,
  agora: Date,
  opts: { renovouAgora?: boolean; diasSemProva?: number } = {},
): DecisaoDeProva {
  const limite = opts.diasSemProva ?? DIAS_SEM_PROVA;
  const idadeDias = ultimoOk ? (agora.getTime() - ultimoOk.getTime()) / DIA_MS : null;

  // Renovar já é a prova: emitiu token, a sessão respondeu. Testar de novo seria
  // chamada à toa contra o Kommo.
  if (opts.renovouAgora) return { provar: false, idadeDias, motivo: 'ja-provou-agora' };
  if (idadeDias === null) return { provar: true, idadeDias, motivo: 'nunca-provada' };
  if (idadeDias >= limite) return { provar: true, idadeDias, motivo: 'prova-velha' };
  return { provar: false, idadeDias, motivo: 'prova-recente' };
}

/**
 * Texto do aviso quando a prova falha. Fica aqui (e não no worker) para poder ser
 * testado: um alerta que não diz o que fazer é um alerta que ninguém age.
 */
export function avisoDeSessaoCaida(erro: string, diasDeMargem: number | null): string {
  const margem =
    diasDeMargem === null
      ? 'Os tokens atuais ainda podem estar válidos, mas não consigo emitir novos.'
      : diasDeMargem <= 0
        ? 'Os tokens de chat já venceram: as respostas em áudio estão saindo em texto AGORA.'
        : `Os tokens atuais valem por mais ${Math.floor(diasDeMargem)} dia(s) — depois disso as respostas em áudio saem em texto.`;
  return (
    '🔊 Guardião da voz: a sessão web do Kommo não está emitindo token novo.\n' +
    `${margem}\n\n` +
    `Erro: ${String(erro).slice(0, 160)}\n\n` +
    'Para resolver: abrir o Kommo numa janela anônima, logar com o usuário Doutor Digital ' +
    'e me avisar — eu releio os cookies e regravo a sessão.'
  );
}
