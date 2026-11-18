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
/**
 * De onde veio a pausa da própria Sofia. Só `handoff` (o `pausar_ia` comum) pode ser calado pela chave
 * `handoff-calado`: o teto de gasto e o candidato a vaga TÊM de avisar, e o sinal de alerta vale mais que o
 * cadastro da unidade (decisão do João, 26/10). Quem não diz é `outra` — nunca calado.
 */
export type OrigemPausaPropria = 'handoff' | 'alerta' | 'outra';
const PESO: Record<OrigemPausaPropria, number> = { handoff: 0, outra: 1, alerta: 2 };
const marcas = new Map<string, { t: number; origem: OrigemPausaPropria }>();

/** A conta do Kommo da unidade (comercial e resgate da mesma clínica dividem o cartão). */
type Conta = { kommoSubdomain?: string | null; id?: string } | null | undefined;
const chave = (conta: Conta, leadId: number | string) => `${conta?.kommoSubdomain || conta?.id || '?'}:${leadId}`;

/** Chamar ANTES de a ferramenta/rotina marcar a pausa (assim nenhuma checagem vê a pausa sem a marca). */
export function registrarPausaPropria(
  conta: Conta,
  leadId: number | string | null | undefined,
  agora: number = Date.now(),
  origem: OrigemPausaPropria = 'outra',
): void {
  if (leadId === null || leadId === undefined || leadId === '') return;
  // Nunca rebaixa dentro da validade (alerta > outra > handoff): um 2º pausar_ia comum no mesmo turno não pode calar
  // o aviso do alerta, do teto ou da resposta ao candidato a vaga.
  const k = chave(conta, leadId);
  const antes = marcas.get(k);
  const manter = antes && agora - antes.t < VALIDADE_MS && PESO[antes.origem] > PESO[origem];
  marcas.set(k, { t: agora, origem: manter ? antes.origem : origem });
  if (marcas.size > 5_000) {
    for (const [k, m] of marcas) if (agora - m.t > VALIDADE_MS) marcas.delete(k);
  }
}

/** A pausa não chegou ao Kommo: a marca sai, senão a resposta "atropelada" sai e o próximo turno responde de novo. */
export function esquecerPausaPropria(conta: Conta, leadId: number | string | null | undefined): void {
  if (leadId === null || leadId === undefined || leadId === '') return;
  marcas.delete(chave(conta, leadId));
}

/** A própria Sofia pausou este cartão desde `desde` (início do turno)? */
export function pausouSozinhaDesde(conta: Conta, leadId: number | string, desde: number): boolean {
  const m = marcas.get(chave(conta, leadId));
  return m !== undefined && m.t >= desde;
}

/** A pausa da própria Sofia neste turno foi um handoff comum (`pausar_ia` sem sinal de alerta)? */
export function handoffDaSofiaDesde(conta: Conta, leadId: number | string, desde: number): boolean {
  const m = marcas.get(chave(conta, leadId));
  return m !== undefined && m.t >= desde && m.origem === 'handoff';
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
