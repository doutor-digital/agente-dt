/**
 * Tudo que o Joaoof MANDA ao João passa por aqui — e só aqui. Três garantias:
 *   1. modo `desligado` não manda nada; modo `seco` DECIDE e REGISTRA o aviso (tabela `joaoof_avisos`, seco=true) mas não chama o Telegram;
 *   2. um aviso por assunto: o par (tipo, chave) é único no banco, então o mesmo urgente nunca sai duas vezes (nem em dois processos);
 *   3. teto de urgentes por dia: o excesso não é mandado na hora — fica para o resumo (o João disse que aviso demais foi o que matou o 9103).
 */
import type { ModoJoaoof } from './config.js';
import { hojeIso, nomeDaUnidade } from './resumo.js';
import { trechoCurto } from './privacidade.js';
import type { AvisoJoaoof, Demanda, JoaoofRepo, UnidadeJoaoof } from './repo.js';

export const MAX_URGENTES_POR_DIA = 6;
/** reserva de envio mais velha que isto (s) é de um envio que falhou: pode ser retomada */
export const ESPERA_ANTES_DE_REENVIAR_S = 120;

export interface DepsEntrega {
  repo: JoaoofRepo;
  modo: () => ModoJoaoof;
  enviar: (texto: string) => Promise<boolean>;
  agora: () => Date;
}

export type Entrega = 'enviado' | 'seco' | 'repetido' | 'falhou' | 'desligado';

/**
 * `garantia`:
 *  - `no-maximo-uma` (padrão; resumo e avisos de sistema): marca como enviado ANTES de enviar. Nunca em dobro; queda no meio perde aquele aviso.
 *  - `pelo-menos-uma` (URGENTE: risco a paciente, IA parada): envia e SÓ DEPOIS marca. Queda ou erro ao gravar entre o envio e a marca = o aviso é
 *    retomado depois da reserva (`ESPERA_ANTES_DE_REENVIAR_S`) e sai de novo: um 🚨 repetido é melhor que um 🚨 perdido.
 */
export async function entregar(
  deps: DepsEntrega,
  a: { tipo: AvisoJoaoof['tipo']; chave: string; texto: string; demandaId?: string | null; garantia?: 'no-maximo-uma' | 'pelo-menos-uma' },
): Promise<Entrega> {
  const antesDeEnviar = (a.garantia ?? 'no-maximo-uma') === 'no-maximo-uma';
  const modo = deps.modo();
  if (modo === 'desligado') return 'desligado';
  if (modo === 'seco') {
    // namespace próprio: o que foi «decidido» em seco não impede o envio real quando o João ligar
    const novo = await deps.repo.registrarAviso({ tipo: a.tipo, chave: `seco:${a.chave}`, demandaId: a.demandaId ?? null, texto: a.texto, enviado: false, seco: true });
    return novo ? 'seco' : 'repetido';
  }
  const existente = await deps.repo.buscarAviso(a.tipo, a.chave);
  if (existente?.enviado) return 'repetido';
  if (!existente) {
    // MARCA COMO ENVIADO ANTES de enviar: a linha entra já com enviado=true, então nenhuma outra instância (nem um retry depois de um erro ao gravar)
    // manda o mesmo resumo em dobro. Se o envio falha, a marca volta a false e o aviso é retomado depois.
    const reivindicou = await deps.repo.registrarAviso({ tipo: a.tipo, chave: a.chave, demandaId: a.demandaId ?? null, texto: a.texto, enviado: antesDeEnviar, seco: false });
    if (!reivindicou) return 'repetido';
  } else if (!(await deps.repo.reivindicarReenvio(a.tipo, a.chave, ESPERA_ANTES_DE_REENVIAR_S))) {
    // linha não enviada com reserva velha = o envio anterior falhou, e só UMA instância ganha a retomada
    return 'repetido';
  } else if (antesDeEnviar) {
    await deps.repo.marcarAvisoEnviado(a.tipo, a.chave, true);
  }
  // enviar pode lançar (config do canal, rede): em qualquer não-confirmação a marca VOLTA, para o aviso ser retomado depois (não fica «enviado» sem ter saído)
  let ok = false;
  try {
    ok = await deps.enviar(a.texto);
  } catch {
    ok = false;
  }
  if (!ok && antesDeEnviar) await deps.repo.marcarAvisoEnviado(a.tipo, a.chave, false).catch(() => undefined);
  // pelo-menos-uma: a marca vem DEPOIS do envio confirmado. Se gravar falhar, o aviso fica retomável (sai de novo depois da reserva) — nunca perdido.
  if (ok && !antesDeEnviar) await deps.repo.marcarAvisoEnviado(a.tipo, a.chave, true).catch(() => undefined);
  return ok ? 'enviado' : 'falhou';
}

export function textoDoUrgente(d: Demanda, unidades: UnidadeJoaoof[]): string {
  const onde = nomeDaUnidade(d.unidadeSlug, unidades);
  const quem = d.solicitante ? ` — ${d.solicitante}` : '';
  const linhas = [`🚨 URGENTE #${d.numero} · ${onde}${quem}`, d.titulo];
  if (d.motivo) linhas.push(`Por quê: ${d.motivo}`);
  if (d.trecho) linhas.push(`“${trechoCurto(d.trecho, 200)}”`);
  linhas.push('Responda do seu jeito: "feito", "passa pra Lia", "isso não é urgente"…');
  return linhas.join('\n');
}

/** Avisa uma demanda urgente, uma única vez. Respeita o teto diário; o que passa dele espera pelo resumo. */
export async function avisarUrgente(deps: DepsEntrega, d: Demanda, unidades: UnidadeJoaoof[]): Promise<Entrega | 'adiado'> {
  if (d.prioridade !== 'urgente' || d.status === 'feita' || d.status === 'descartada') return 'repetido';
  // urgência que o PRÓPRIO João definiu (ele subiu a prioridade) não gera 🚨 para ele
  if (d.camposDoJoao.includes('prioridade')) return 'repetido';
  const hoje = hojeIso(deps.agora());
  const chaveDoDia = `urgentes:${deps.modo() === 'seco' ? 'seco:' : ''}${hoje}`;
  const feitos = (await deps.repo.lerEstado<{ n: number }>(chaveDoDia))?.n ?? 0;
  const jaAvisada = await deps.repo.buscarAviso('urgente', `${deps.modo() === 'seco' ? 'seco:' : ''}d:${d.id}`);
  if (jaAvisada && (jaAvisada.enviado || jaAvisada.seco)) {
    // o 🚨 já saiu (a linha diz enviado) mas a demanda ficou sem `avisadaEm` (queda entre uma gravação e outra): completa, para ela sair da lista de candidatas
    if (jaAvisada.enviado && !jaAvisada.seco && !d.avisadaEm) await deps.repo.atualizarDemanda(d.numero, { avisadaEm: deps.agora() });
    return 'repetido';
  }
  // o teto vale para TUDO que ainda não saiu, inclusive o que ficou retomável depois de uma queda do Telegram: 10 retomadas de uma vez seriam 10 🚨 juntos
  if (feitos >= MAX_URGENTES_POR_DIA) return 'adiado';
  const r = await entregar(deps, { tipo: 'urgente', chave: `d:${d.id}`, texto: textoDoUrgente(d, unidades), demandaId: d.id, garantia: 'pelo-menos-uma' });
  if (r === 'enviado' || r === 'seco') await deps.repo.gravarEstado(chaveDoDia, { n: feitos + 1 });
  // só o envio REAL marca a demanda como avisada: o que foi «decidido» em seco não pode impedir o 🚨 de verdade quando o João ligar
  if (r === 'enviado') await deps.repo.atualizarDemanda(d.numero, { avisadaEm: deps.agora() });
  return r;
}

/** `2026-11-27/08` */
export const chaveDoResumo = (agora: Date, hora: number) => `${hojeIso(agora)}/${String(hora).padStart(2, '0')}`;
