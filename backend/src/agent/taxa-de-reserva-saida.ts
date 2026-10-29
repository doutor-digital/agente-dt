/**
 * A saída da taxa de reserva (Boa Vista) no fim do turno: o que o grafo faz com a decisão pura de `taxa-de-reserva.ts`.
 *
 * Tirado do `graph.ts` para poder ser testado sem subir o grafo. Recebe as ferramentas e o recorder; devolve o texto final.
 *
 *  - O que o prompt não trouxe e o código confere antes de trocar: a consulta gravada no vínculo (`agendar_consulta`) e o campo
 *    do cartão "✓ Consulta pg antecipado" (`pagouOAntecipado`). Quem já pagou NUNCA recebe de novo "seu horário não está
 *    garantido" + a chave, nem quando a equipe demorou mais de 24 h para criar a consulta. Sem conseguir ler o cartão (erro ou
 *    prazo), vale a regra de quem já pagou: nada é pedido por conta da Sofia, mas o pedido EXPLÍCITO da chave ("manda o pix") é
 *    atendido — pedir de novo a quem pode ter pago é pior que deixar o modelo falar, e deixar sem chave quem pediu é a falha de origem.
 *  - Insistência em pagar só na clínica: a equipe recebe a TAREFA (e o resumo, com prazo que cancela a chamada). O recado só
 *    promete "a equipe vai falar com você" se algum dos dois saiu; senão ele não promete nada.
 *  - Falha ou demora de qualquer ferramenta nunca derruba a resposta ao paciente.
 */
import type { TrocaDaTaxa, ContextoDaTaxa, DadosDaTaxa } from './taxa-de-reserva.js';
import { recadoDaInsistencia, travaDaTaxaDeReserva } from './taxa-de-reserva.js';
import type { TraceRecorder } from './trace-recorder.js';

/** O mesmo prazo do resumo do sinal de alerta (passe-por-sinal.ts). */
export const PRAZO_DO_RESUMO_DA_TAXA_MS = 8_000;

/** Leitura do vínculo e do cartão: sem isso um Kommo travado seguraria a resposta. */
export const PRAZO_DA_LEITURA_MS = 5_000;

export const FOCO_DO_RESUMO_DA_INSISTENCIA =
  'Unidade com taxa de reserva: o paciente já recebeu a chave Pix e INSISTE em pagar só na clínica. Sem o comprovante da taxa o horário NÃO está garantido. Equipe: falar com ele.';

export interface FerramentasDaTaxa {
  recorder: Pick<TraceRecorder, 'step'>;
  leadId: number | null;
  /** existe consulta futura gravada pelo `agendar_consulta` para este cartão (o prompt pode não ter trazido) */
  consultaGravada: () => Promise<boolean>;
  /** o campo do cartão "✓ Consulta pg antecipado" está marcado (`pagouOAntecipado`); rejeitar = não deu para ler */
  cartaoDizPago: () => Promise<boolean>;
  /** a ferramenta `resumir_lead_para_sdr`, se a unidade a tem; recebe o sinal que cancela a chamada no prazo */
  resumir?: {
    invoke: (input: { leadId: number; focusHint: string }, config?: { signal?: AbortSignal }) => Promise<unknown>;
  };
  /** abre a tarefa para a equipe (`abrirTarefaParaEquipe`), se há cartão e cliente do Kommo */
  abrirTarefa?: () => Promise<'criada' | 'repetida' | 'falhou'>;
  /** avisa o João (Telegram) quando o paciente insiste e NADA chegou à equipe */
  alertar?: (texto: string) => Promise<unknown>;
  slug?: string;
  prazoDoResumoMs?: number;
  /** prazo das leituras (vínculo, cartão): um Kommo ou banco lento não segura a resposta ao paciente */
  prazoDaLeituraMs?: number;
}

export interface SaidaDaTaxa {
  texto: string;
  /** a troca aplicada; null = a resposta sai como veio */
  troca: TrocaDaTaxa | null;
  /** por que a trava disparou e a resposta ficou como veio */
  liberadaPor?: 'consulta_gravada' | 'cartao_pago' | 'cartao_ilegivel';
  /** só na insistência: a equipe recebeu a tarefa ou o resumo (o recado promete que ela fala com o paciente) */
  equipeAvisada?: boolean;
}

const QUEM_FALOU: Record<TrocaDaTaxa['motivo'], string> = {
  horario_sem_comprovante: 'a resposta dava o horário como garantido sem consulta nem comprovante — trocada pelo recado com a chave',
  chave_pedida: 'o paciente pediu o Pix — a chave saiu por código',
  equipe_envia_a_chave: 'a resposta mandava a equipe enviar a chave — a chave saiu por código',
  chave_oferecida: 'a resposta só perguntava se ele queria a chave — a chave saiu por código',
  pagar_na_clinica: 'o paciente quer pagar só na clínica — saiu a taxa em uma frase e a chave, na mesma mensagem',
  insistiu_na_clinica: 'o paciente insiste em pagar só na clínica depois de receber a chave — fica com a equipe, sem prometer o horário',
};

/** O que `resumir_lead_para_sdr` devolve quando NÃO criou a nota. */
const RESUMO_QUE_NAO_SAIU = /^(?:falhou|ERRO|Sem hist)/i;

async function resumirComPrazo(
  resumir: NonNullable<FerramentasDaTaxa['resumir']>,
  leadId: number,
  prazoMs: number,
): Promise<{ ok: boolean; detalhe: string; estourou: boolean }> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<never>((_, rejeita) => {
    timer = setTimeout(() => {
      ac.abort();
      rejeita(new Error(`prazo de ${prazoMs} ms estourado — chamada cancelada`));
    }, prazoMs);
  });
  try {
    // a chamada pode terminar (ou falhar) depois de perder a corrida: sem o catch isso viraria rejeição sem dono
    const chamada = Promise.resolve().then(() => resumir.invoke({ leadId, focusHint: FOCO_DO_RESUMO_DA_INSISTENCIA }, { signal: ac.signal }));
    chamada.catch(() => undefined);
    const resultado = String(await Promise.race([chamada, prazo]));
    return { ok: !RESUMO_QUE_NAO_SAIU.test(resultado), detalhe: resultado.slice(0, 200), estourou: false };
  } catch (err) {
    return { ok: false, detalhe: `falhou: ${err instanceof Error ? err.message : String(err)}`.slice(0, 200), estourou: ac.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}

/** A tarefa fala com o Kommo e o banco: sem prazo própria, um Kommo lento seguraria a resposta ao paciente. */
function comPrazo<T>(promessa: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<never>((_, rejeita) => {
    timer = setTimeout(() => rejeita(new Error(`prazo de ${ms} ms estourado`)), ms);
  });
  promessa.catch(() => undefined);
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(timer));
}

/** Tarefa e resumo andam juntos; a equipe está avisada se UM deles saiu. Nunca lança. */
async function avisarAEquipe(f: FerramentasDaTaxa): Promise<boolean> {
  const leadId = f.leadId;
  if (leadId === null) return false;
  const prazoMs = f.prazoDoResumoMs ?? PRAZO_DO_RESUMO_DA_TAXA_MS;
  const [tarefa, resumo] = await Promise.all([
    f.abrirTarefa ? comPrazo(Promise.resolve().then(f.abrirTarefa), prazoMs).catch((): 'falhou' => 'falhou') : Promise.resolve(null),
    f.resumir ? resumirComPrazo(f.resumir, leadId, prazoMs) : Promise.resolve(null),
  ]);
  const tarefaSaiu = tarefa === 'criada' || tarefa === 'repetida';
  if (resumo && !resumo.ok) {
    await f.recorder.step({
      kind: 'ERROR',
      title: resumo.estourou
        ? 'Taxa de reserva: o paciente insiste em pagar só na clínica e o resumo para a equipe estourou o prazo (chamada cancelada)'
        : 'Taxa de reserva: o paciente insiste em pagar só na clínica e o resumo para a equipe NÃO saiu',
      payload: { leadId, resultado: resumo.detalhe, tarefa },
    });
  }
  return tarefaSaiu || !!resumo?.ok;
}

export interface DecisaoDaTaxa {
  /** a troca que valeria; null = a resposta sai como veio */
  troca: TrocaDaTaxa | null;
  /** por que a trava disparou e a resposta ficou como veio */
  liberadaPor?: 'consulta_gravada' | 'cartao_pago' | 'cartao_ilegivel';
  erroDoCartao?: string;
}

/**
 * A decisão com as provas que o prompt pode não ter trazido (consulta gravada, cartão pago). SÓ LÊ — sem passo no rastro, sem
 * tarefa, sem resumo —, por isso serve também para conferir a reescrita de outras travas (`reabreAfirmacao` do grafo).
 */
export async function decidirATaxa(
  texto: string,
  dados: DadosDaTaxa | null,
  ctx: ContextoDaTaxa,
  f: Pick<FerramentasDaTaxa, 'consultaGravada' | 'cartaoDizPago' | 'prazoDaLeituraMs'>,
): Promise<DecisaoDaTaxa> {
  const prazoMs = f.prazoDaLeituraMs ?? PRAZO_DA_LEITURA_MS;
  const troca = travaDaTaxaDeReserva(texto, dados, ctx);
  if (!troca) return { troca: null };
  // O prompt pode não ter trazido a consulta (a IA marcou antes e o bloco falhou): o vínculo gravado por agendar_consulta decide.
  // Só é lido quando a trava já disparou.
  if (await comPrazo(Promise.resolve().then(f.consultaGravada), prazoMs).catch(() => false)) return { troca: null, liberadaPor: 'consulta_gravada' };
  // Quem já pagou (campo do cartão) não paga de novo — só o pedido EXPLÍCITO da chave segue atendido (mesma regra do comprovante
  // antigo). Sem ler o cartão (erro ou prazo) não dá para saber se pagou: vale a mesma regra, e o erro vai no rastro.
  let cartaoPago: boolean;
  let erroDoCartao: string | undefined;
  try {
    cartaoPago = await comPrazo(Promise.resolve().then(f.cartaoDizPago), prazoMs);
  } catch (err) {
    cartaoPago = true; // na dúvida, trata como quem pode ter pago
    erroDoCartao = err instanceof Error ? err.message : String(err);
  }
  if (cartaoPago) {
    const soOPedido = travaDaTaxaDeReserva(texto, dados, { ...ctx, jaMandouComprovante: true });
    const liberadaPor = erroDoCartao === undefined ? 'cartao_pago' : 'cartao_ilegivel';
    return soOPedido ? { troca: soOPedido, erroDoCartao } : { troca: null, liberadaPor, erroDoCartao };
  }
  return { troca };
}

/**
 * Aplica a taxa de reserva ao texto final do turno. Nunca lança: o que falhar aqui deixa a resposta como veio (ou com o
 * recado sem promessa), nunca sem resposta.
 */
export async function aplicarTaxaDeReservaNaSaida(
  texto: string,
  dados: DadosDaTaxa | null,
  ctx: ContextoDaTaxa,
  f: FerramentasDaTaxa,
): Promise<SaidaDaTaxa> {
  const decisao = await decidirATaxa(texto, dados, ctx, f);
  const troca = decisao.troca;
  if (decisao.erroDoCartao !== undefined) {
    await f.recorder.step({
      kind: 'ERROR',
      title: troca
        ? 'Taxa de reserva: não consegui ler o cartão para ver se ele já pagou — só o pedido explícito da chave foi atendido'
        : 'Taxa de reserva: não consegui ler o cartão para ver se ele já pagou — a resposta saiu como veio',
      payload: { erro: decisao.erroDoCartao },
    });
  }
  if (!troca) {
    if (decisao.liberadaPor === 'cartao_pago') {
      await f.recorder.step({
        kind: 'THINKING',
        title: 'Taxa de reserva: o cartão já está com "✓ Consulta pg antecipado" marcado — a taxa não é pedida de novo',
        payload: { original: texto },
      });
    }
    return { texto, troca: null, liberadaPor: decisao.liberadaPor };
  }

  // Insistiu em pagar só na clínica: a equipe precisa ver. Só promete que ela fala com o paciente se a tarefa ou o resumo saiu —
  // por isso o texto final só existe depois, e é ESSE (não o que a trava previu) que vai para o rastro.
  const insistiu = troca.motivo === 'insistiu_na_clinica';
  const equipeAvisada = insistiu ? await avisarAEquipe(f).catch(() => false) : undefined;
  const final = insistiu ? recadoDaInsistencia(!!equipeAvisada, troca.preservouOResto ? (troca.resto ?? null) : null) : troca.texto;
  const trocaFinal: TrocaDaTaxa = { ...troca, texto: final };

  await f.recorder.step({
    kind: 'THINKING',
    title: `💳 Taxa de reserva: ${QUEM_FALOU[troca.motivo]}${troca.preservouOResto ? ' (o resto da resposta ficou)' : ''}`,
    payload: { motivo: troca.motivo, original: texto, final, preservouOResto: troca.preservouOResto ?? false, equipeAvisada },
  });

  if (insistiu && !equipeAvisada) {
    await f.recorder.step({
      kind: 'ERROR',
      title: 'Taxa de reserva: o paciente insiste em pagar só na clínica e NADA chegou à equipe — o recado não promete que ela fala com ele',
      payload: { leadId: f.leadId, temTarefa: !!f.abrirTarefa, temResumo: !!f.resumir },
    });
    await f
      .alertar?.(
        `⚠️ ${f.slug ?? 'unidade'} — lead ${f.leadId ?? '?'} recebeu a chave Pix e INSISTE em pagar só na clínica, mas NADA confirmado chegou à equipe (tarefa e resumo falharam, estouraram o prazo ou a unidade não os tem; uma tarefa lenta ainda pode aparecer no Kommo). Avisar a equipe à mão.`,
      )
      .catch(() => undefined);
  }
  return insistiu ? { texto: final, troca: trocaFinal, equipeAvisada } : { texto: final, troca: trocaFinal };
}
