/**
 * Retentativa do disparo do Salesbot, sem duplicar mensagem.
 *
 * Em 19/09/2026, na primeira conversa que a IA de Mossoró atendeu, o
 * `POST /bots/8612/run` morreu com `socket hang up` — erro de rede, não de
 * configuração; o mesmo endpoint respondeu 202 quando repetido na mão minutos
 * depois. O código tentava uma vez e caía pra nota interna: o paciente ficava
 * sem resposta por causa de um soluço de rede.
 *
 * Só que repetir disparo de Salesbot é exatamente o que já produziu mensagem
 * duplicada nesta rede. E `socket hang up` é o pior caso possível pra decidir:
 * a requisição foi enviada e nenhuma resposta voltou, então o bot PODE ter
 * rodado. Retentar no escuro troca "paciente sem resposta" por "paciente com a
 * mesma mensagem duas vezes".
 *
 * Por isso a retentativa olha antes: lê a conversa oficial e procura a própria
 * fala entre as mensagens de saída recentes. Se já saiu, para. É uma chamada a
 * mais, mas só no caminho que já falhou.
 */

/** Erros que valem retentar: rede e 5xx. 4xx é configuração errada — repetir não conserta. */
export function valeRetentar(erro: { status?: number; code?: string; message?: string }): boolean {
  if (typeof erro.status === 'number') return erro.status >= 500;
  const sinal = `${erro.code ?? ''} ${erro.message ?? ''}`.toLowerCase();
  return /socket hang up|econnreset|etimedout|econnaborted|epipe|enotfound|eai_again|network error|timeout/.test(
    sinal,
  );
}

/** Espera entre tentativas, em ms. Duas retentativas bastam pro soluço; mais que isso é a conta fora do ar. */
export const ESPERAS_MS = [600, 1800];

export interface MensagemDaConversa {
  type?: string;
  text?: string | null;
  created_at?: number | null;
}

/**
 * Normaliza pra comparar: o texto que sai pode ter emoji removido no downgrade
 * e espaço sobrando no lugar dele, então comparo só letras e dígitos.
 */
function chave(t: string): string {
  return t.toLowerCase().replace(/[^a-z0-9à-ú]+/gi, '').slice(0, 60);
}

/**
 * A resposta já chegou ao paciente?
 *
 * Compara pelo começo do texto: o Salesbot pode quebrar a fala em pedaços, e o
 * primeiro pedaço basta pra saber que o disparo pegou.
 */
export function jaSaiu(
  mensagens: MensagemDaConversa[],
  texto: string,
  agoraEpoch: number,
  janelaSeg = 180,
): boolean {
  const alvo = chave(texto);
  if (alvo.length < 8) return false; // curto demais pra afirmar qualquer coisa
  return mensagens.some((m) => {
    if (m.type !== 'outgoing') return false;
    const quando = Number(m.created_at ?? 0);
    if (!Number.isFinite(quando) || agoraEpoch - quando > janelaSeg) return false;
    const dela = chave(String(m.text ?? ''));
    return dela.length >= 8 && (alvo.startsWith(dela) || dela.startsWith(alvo));
  });
}
