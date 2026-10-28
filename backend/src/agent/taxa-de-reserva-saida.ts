/**
 * A saída da taxa de reserva (Boa Vista) no fim do turno: o que o grafo faz com a decisão pura de `taxa-de-reserva.ts`.
 *
 * Tirado do `graph.ts` para poder ser testado sem subir o grafo. Recebe as ferramentas e o recorder; devolve o texto final.
 *
 *  - O que o prompt não trouxe e o código confere antes de trocar: a consulta gravada no vínculo (`agendar_consulta`) e o campo
 *    do cartão "✓ Consulta pg antecipado" (`pagouOAntecipado`). Quem já pagou NUNCA recebe de novo "seu horário não está
 *    garantido" + a chave, nem quando a equipe demorou mais de 24 h para criar a consulta. Sem conseguir ler o cartão, a resposta
 *    sai como veio: pedir pagamento de novo a quem pode ter pago é pior que deixar o modelo falar.
 *  - Insistência em pagar só na clínica: a equipe recebe a TAREFA (e o resumo, com prazo que cancela a chamada). O recado só
 *    promete "a equipe vai falar com você" se algum dos dois saiu; senão ele não promete nada.
 *  - Falha ou demora de qualquer ferramenta nunca derruba a resposta ao paciente.
 */
import type { TrocaDaTaxa, ContextoDaTaxa, DadosDaTaxa } from './taxa-de-reserva.js';
import { RECADO_INSISTIU_NA_CLINICA, RECADO_INSISTIU_SEM_PROMESSA, travaDaTaxaDeReserva } from './taxa-de-reserva.js';
import type { TraceRecorder } from './trace-recorder.js';

/** O mesmo prazo do resumo do sinal de alerta (passe-por-sinal.ts). */
export const PRAZO_DO_RESUMO_DA_TAXA_MS = 8_000;

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
export async function decidirATaxa(texto: string, dados: DadosDaTaxa | null, ctx: ContextoDaTaxa, f: Pick<FerramentasDaTaxa, 'consultaGravada' | 'cartaoDizPago'>): Promise<DecisaoDaTaxa> {
  const troca = travaDaTaxaDeReserva(texto, dados, ctx);
  if (!troca) return { troca: null };
  // O prompt pode não ter trazido a consulta (a IA marcou antes e o bloco falhou): o vínculo gravado por agendar_consulta decide.
  // Só é lido quando a trava já disparou.
  if (await f.consultaGravada().catch(() => false)) return { troca: null, liberadaPor: 'consulta_gravada' };
  // Quem já pagou (campo do cartão) não paga de novo — só o pedido EXPLÍCITO da chave segue atendido (mesma regra do comprovante
  // antigo). Sem ler o cartão não dá para saber: a resposta fica como veio.
  try {
    if (await f.cartaoDizPago()) {
      const soOPedido = travaDaTaxaDeReserva(texto, dados, { ...ctx, jaMandouComprovante: true });
      return soOPedido ? { troca: soOPedido } : { troca: null, liberadaPor: 'cartao_pago' };
    }
  } catch (err) {
    return { troca: null, liberadaPor: 'cartao_ilegivel', erroDoCartao: err instanceof Error ? err.message : String(err) };
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
  if (!troca) {
    if (decisao.liberadaPor === 'cartao_ilegivel') {
      await f.recorder.step({
        kind: 'ERROR',
        title: 'Taxa de reserva: não consegui ler o cartão para ver se ele já pagou — a resposta saiu como veio',
        payload: { erro: decisao.erroDoCartao },
      });
    } else if (decisao.liberadaPor === 'cartao_pago') {
      await f.recorder.step({
        kind: 'THINKING',
        title: 'Taxa de reserva: o cartão já está com "✓ Consulta pg antecipado" marcado — a taxa não é pedida de novo',
        payload: { original: texto },
      });
    }
    return { texto, troca: null, liberadaPor: decisao.liberadaPor };
  }

  await f.recorder.step({
    kind: 'THINKING',
    title: `💳 Taxa de reserva: ${QUEM_FALOU[troca.motivo]}${troca.preservouOResto ? ' (o resto da resposta ficou)' : ''}`,
    payload: { motivo: troca.motivo, original: texto, final: troca.texto, preservouOResto: troca.preservouOResto ?? false },
  });

  if (troca.motivo !== 'insistiu_na_clinica') return { texto: troca.texto, troca };

  // Insistiu em pagar só na clínica: a equipe precisa ver. Só promete que ela fala com o paciente se a tarefa ou o resumo saiu.
  const equipeAvisada = await avisarAEquipe(f).catch(() => false);
  if (!equipeAvisada) {
    await f.recorder.step({
      kind: 'ERROR',
      title: 'Taxa de reserva: o paciente insiste em pagar só na clínica e NADA chegou à equipe — o recado não promete que ela fala com ele',
      payload: { leadId: f.leadId, temTarefa: !!f.abrirTarefa, temResumo: !!f.resumir },
    });
    await f
      .alertar?.(
        `⚠️ ${f.slug ?? 'unidade'} — lead ${f.leadId ?? '?'} recebeu a chave Pix e INSISTE em pagar só na clínica, mas NADA chegou à equipe (tarefa e resumo falharam ou a unidade não os tem). Avisar a equipe à mão.`,
      )
      .catch(() => undefined);
  }
  return { texto: equipeAvisada ? RECADO_INSISTIU_NA_CLINICA : RECADO_INSISTIU_SEM_PROMESSA, troca, equipeAvisada };
}
