/**
 * "Fui EU que pausei": a marca que a trava de antes de enviar consulta.
 *
 * Antes de mandar a resposta, a Sofia confere de novo se o cartão foi pausado enquanto o modelo pensava
 * (`travaAntesDeEnviar`, em pausa-equipe.ts). Só que há pausas que nascem DENTRO do próprio turno e cuja
 * resposta TEM de sair: o `pausar_ia` ("Responda em UMA frase avisando o paciente") e o teto de gasto
 * (FALLBACK_TETO avisa que uma pessoa continua). Sem esta marca, a trava jogaria fora justamente o aviso
 * do handoff.
 *
 * Em memória e por número do cartão: o turno inteiro (modelo, ferramentas e envio) roda no mesmo processo,
 * e a marca só precisa viver o tempo de um turno. Número de cartão de outra conta do Kommo com o mesmo
 * valor, no mesmo minuto, faria a trava deixar passar uma resposta — que é exatamente o que acontecia
 * antes dela existir.
 */

const VALIDADE_MS = 30 * 60_000;
const marcas = new Map<string, number>();

/** Chamar ANTES de a ferramenta/rotina marcar a pausa (assim nenhuma checagem vê a pausa sem a marca). */
export function registrarPausaPropria(leadId: number | string | null | undefined, agora: number = Date.now()): void {
  if (leadId === null || leadId === undefined || leadId === '') return;
  marcas.set(String(leadId), agora);
  if (marcas.size > 5_000) {
    for (const [k, t] of marcas) if (agora - t > VALIDADE_MS) marcas.delete(k);
  }
}

/** A própria Sofia pausou este cartão desde `desde` (início do turno)? */
export function pausouSozinhaDesde(leadId: number | string, desde: number): boolean {
  const t = marcas.get(String(leadId));
  return t !== undefined && t >= desde;
}

/** Só para teste. */
export function _limparPausasProprias(): void {
  marcas.clear();
}
