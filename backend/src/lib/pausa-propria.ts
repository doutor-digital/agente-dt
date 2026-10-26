/**
 * "Fui EU que pausei": a marca que a trava de antes de enviar consulta.
 *
 * Antes de mandar a resposta, a Sofia confere de novo se o cartão foi pausado enquanto o modelo pensava
 * (`travaAntesDeEnviar`, em pausa-equipe.ts). Só que há pausas que nascem DENTRO do próprio turno e cuja
 * resposta TEM de sair: o `pausar_ia` ("Responda em UMA frase avisando o paciente") e o teto de gasto
 * (FALLBACK_TETO avisa que uma pessoa continua). Sem esta marca, a trava jogaria fora justamente o aviso
 * do handoff.
 *
 * Em memória, por conta do Kommo + número do cartão: o turno inteiro (modelo, ferramentas e envio) roda no
 * mesmo processo, e a marca só precisa viver o tempo de um turno. A conta entra na chave porque o mesmo
 * número de cartão pode existir em duas contas (review do Codex, 21/10).
 */

const VALIDADE_MS = 30 * 60_000;
const marcas = new Map<string, number>();

/** A conta do Kommo da unidade (comercial e resgate da mesma clínica dividem o cartão). */
type Conta = { kommoSubdomain?: string | null; id?: string } | null | undefined;
const chave = (conta: Conta, leadId: number | string) => `${conta?.kommoSubdomain || conta?.id || '?'}:${leadId}`;

/** Chamar ANTES de a ferramenta/rotina marcar a pausa (assim nenhuma checagem vê a pausa sem a marca). */
export function registrarPausaPropria(conta: Conta, leadId: number | string | null | undefined, agora: number = Date.now()): void {
  if (leadId === null || leadId === undefined || leadId === '') return;
  marcas.set(chave(conta, leadId), agora);
  if (marcas.size > 5_000) {
    for (const [k, t] of marcas) if (agora - t > VALIDADE_MS) marcas.delete(k);
  }
}

/** A pausa não chegou ao Kommo: a marca sai, senão a resposta "atropelada" sai e o próximo turno responde de novo. */
export function esquecerPausaPropria(conta: Conta, leadId: number | string | null | undefined): void {
  if (leadId === null || leadId === undefined || leadId === '') return;
  marcas.delete(chave(conta, leadId));
}

/** A própria Sofia pausou este cartão desde `desde` (início do turno)? */
export function pausouSozinhaDesde(conta: Conta, leadId: number | string, desde: number): boolean {
  const t = marcas.get(chave(conta, leadId));
  return t !== undefined && t >= desde;
}

/** Só para teste. */
export function _limparPausasProprias(): void {
  marcas.clear();
}

/**
 * Segura a resposta "atropelada" (o paciente mandou outra mensagem enquanto ela nascia) só se o próximo turno
 * vai mesmo responder. Quando a própria Sofia pausou neste turno — sinal de alerta, handoff, teto —, o próximo
 * turno é pulado ("agente pulado (IA Pausada)") e segurar é jogar fora o último aviso ao paciente.
 * Marabá, lead 29029780 (26/10): "minha perna está perdendo força" + "(é teste)" e o paciente ficou sem nada.
 */
export function segurarRespostaAtropelada(conta: Conta, leadId: number | string, inicioDoTurno: number, chegouOutra: boolean): boolean {
  return chegouOutra && !pausouSozinhaDesde(conta, leadId, inicioDoTurno);
}
