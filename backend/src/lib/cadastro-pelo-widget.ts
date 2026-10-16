/**
 * "Só cadastrar na franquia" de dentro do Kommo — o botão do widget que liga o cartão ao paciente SEM marcar
 * consulta.
 *
 * Pedido do João (16/10/2026): em Petrópolis o único jeito de cadastrar pelo cartão era "Cadastrar e marcar", que
 * obriga escolher dia e horário. A recepção tem paciente que quer o cadastro feito antes de decidir o horário, e
 * sem o botão ela abria a franquia e redigitava nome e telefone — que é onde nascem os cadastros repetidos.
 *
 * Isto NÃO revoga a regra de 26/09 ("só vira lead na franquia quem agenda", ver `cadastro-na-franquia.ts`): aquela
 * regra é sobre a IA e os robôs cadastrarem sozinhos todo clique de anúncio. Aqui é uma pessoa da recepção, num
 * cartão, decidindo. Robô nenhum chama esta função.
 *
 * Mesmas guardas do "Marcar consulta" (`marcacao-widget.ts`): sobrenome, DDD, o cartão existe NESTA conta, o
 * telefone digitado é o do contato do cartão e, no Kommo dividido (Petrópolis + Caxias), a franquia é a da
 * ⌂ Unidade de atendimento do cartão. A diferença que importa: aqui a busca do paciente existente é mais larga
 * (nome completo, "primeiro último", só o primeiro), porque a franquia NÃO busca por telefone e cadastrar em dobro
 * é o erro que este botão existe para evitar. Se a franquia não responder à busca, nada é criado.
 */
import type { Unit } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { SpineService } from '../services/spine.service.js';
import { createKommoClient, type KommoClient } from '../services/kommo.service.js';
import { esquemaDaUnidade } from './kommo-schema.js';
import { TraceRecorder } from '../agent/trace-recorder.js';
import { telefoneDoLead, unidadeFresca } from '../agent/agenda-tools.js';
import { travaDaUnidadeDeAtendimento } from './trava-unidade-atendimento.js';
import { contaDoKommo, unidadeDoCartao } from './crm-compartilhado.js';
import { termosDeBusca } from './widget-agenda.js';
import { emAndamento, fim8, validarNome, validarTelefone, type Recusa } from './marcacao-widget.js';

export interface EntradaCadastro {
  leadId: number;
  nome: string;
  telefone: string;
  cidade?: string | null;
  uf?: string | null;
}

export interface Cadastrado {
  ok: true;
  idClient: number;
  /** `true` = criado agora; `false` = a franquia já tinha este paciente e o cartão só foi ligado a ele. */
  novoCadastro: boolean;
  /** `true` = o cartão já estava ligado a um paciente antes do clique; nada foi feito na franquia. */
  jaLigado: boolean;
  nome: string;
  /** Kommo dividido: a unidade do cartão (ex.: "Caxias"). */
  unidade?: string;
  cartao: { camposEmBranco: string[] };
  /** `false` quando o paciente existe na franquia mas o vínculo não gravou no banco — avise, o sincronizador ainda casa pelo telefone. */
  vinculoGravado: boolean;
}

/** Procura o paciente pelo telefone entre os resultados de vários nomes. `null` = a franquia não respondeu a nenhuma busca. */
export async function pacienteExistente(
  unit: Unit,
  nome: string,
  tituloDoCartao: string,
  fone: string,
): Promise<{ idClient: number; nome: string | null } | 'nao_achou' | null> {
  const alvo = fim8(fone);
  let respondeu = false;
  for (const termo of termosDeBusca(tituloDoCartao, nome)) {
    const r = await SpineService.searchClients(unit, termo, 100).catch(() => null);
    if (!r?.ok) continue;
    respondeu = true;
    const igual = (r.data?.clients ?? []).find((c) => c.idClient && fim8(c.whatsapp) === alvo);
    if (igual?.idClient) return { idClient: igual.idClient, nome: igual.name };
  }
  return respondeu ? 'nao_achou' : null;
}

/** As frases de recusa da divisão Petrópolis × Caxias nasceram para o "Marcar": aqui nada se marca, nada se cadastra. */
const paraCadastro = (motivo: string) =>
  motivo
    .replace(/Nada foi marcado/g, 'Nada foi cadastrado')
    .replace(/Marque na agenda de/g, 'Cadastre na franquia de')
    .replace(/A marcação pelo widget/g, 'O cadastro pelo widget');

/** Dois cliques quase juntos não podem virar dois cadastros — nem "Marcar" e "Só cadastrar" no mesmo cartão: a trava é a mesma. */

/** `opcoes.kommo` só existe para o teste trocar o cliente do Kommo; em produção ele nasce do token da conta. */
export async function cadastrarPeloWidget(
  unitBase: Unit,
  entrada: EntradaCadastro,
  opcoes: { kommo?: KommoClient } = {},
): Promise<Cadastrado | Recusa> {
  const chave = `${unitBase.id}:${entrada.leadId}`;
  if (emAndamento.has(chave)) {
    return { ok: false, codigo: 'em_andamento', motivo: 'Já estou cadastrando ou marcando este cartão. Aguarde a resposta.' };
  }
  emAndamento.add(chave);
  try {
    return await cadastrarInterno(unitBase, entrada, opcoes);
  } finally {
    emAndamento.delete(chave);
  }
}

async function cadastrarInterno(unitBase: Unit, entrada: EntradaCadastro, opcoes: { kommo?: KommoClient }): Promise<Cadastrado | Recusa> {
  const t0 = Date.now();
  const unitDoPedido = (await unidadeFresca(unitBase.id)) ?? unitBase;
  let unit: Unit = unitDoPedido;
  const recorder = new TraceRecorder(randomUUID(), unitDoPedido.id);
  const passo = (kind: 'THINKING' | 'TOOL_RESULT' | 'ERROR' | 'KOMMO_ACTION', title: string, payload?: unknown) =>
    recorder.step({ kind, title, payload }).catch(() => undefined);
  const recusar = async (r: Recusa): Promise<Recusa> => {
    await passo('ERROR', `widget cadastrar RECUSADO (${r.codigo}): ${r.motivo}`, { leadId: entrada.leadId });
    await recorder.finalize({ status: 'FAILED', latencyMs: Date.now() - t0, iaDecision: `widget_cadastrar:${r.codigo}` }).catch(() => undefined);
    return r;
  };

  await passo('THINKING', `Recepção pediu cadastro na franquia pelo widget (sem consulta): lead ${entrada.leadId}`, { leadId: entrada.leadId });

  if (!unit.spineEnabled || !unit.spineToken) {
    return recusar({ ok: false, codigo: 'sem_franquia', motivo: 'A franquia não está conectada nesta unidade.' });
  }
  const contaKommo = await contaDoKommo(unitDoPedido);
  const kommo = opcoes.kommo ?? (contaKommo.kommoAccessToken ? createKommoClient(contaKommo) : undefined);
  // Sem o cartão não há como conferir telefone nem unidade: cadastrar às cegas é o paciente no prontuário errado.
  if (!kommo) return recusar({ ok: false, codigo: 'lead_invalido', motivo: 'Não consegui ler o cartão no Kommo. Nada foi cadastrado.' });

  const trava = await travaDaUnidadeDeAtendimento(unit, entrada.leadId, kommo);
  if (trava) return recusar({ ok: false, codigo: trava.codigo, motivo: paraCadastro(trava.motivo) });
  const vn = validarNome(entrada.nome);
  if (!vn.ok) return recusar(vn);
  const vt = validarTelefone(entrada.telefone);
  if (!vt.ok) return recusar(vt);
  const { nome } = vn;
  const { fone } = vt;

  const lead = await kommo.getLead(entrada.leadId).catch(() => null);
  if (!lead) return recusar({ ok: false, codigo: 'lead_invalido', motivo: 'Este cartão não existe nesta conta do Kommo.' });
  // Kommo dividido (Petrópolis + Caxias): toda escrita na franquia segue a unidade do cartão (regra do João, 14/10).
  const dono = await unidadeDoCartao(unitDoPedido, lead);
  if (dono.tipo === 'recusa') return recusar({ ok: false, codigo: dono.codigo, motivo: paraCadastro(dono.motivo) });
  unit = dono.unit;
  const rotulo = dono.tipo === 'unidade' ? dono.rotulo : undefined;
  if (rotulo) await passo('THINKING', `Conta dividida: o cartão é de ${rotulo} — cadastro na franquia de ${rotulo}`, { unidade: unit.slug });

  const foneLead = await telefoneDoLead(kommo, entrada.leadId);
  if (!fim8(foneLead)) {
    return recusar({ ok: false, codigo: 'lead_sem_telefone', motivo: 'O contato deste cartão não tem telefone. Coloque o telefone no contato antes de cadastrar — é ele que liga o cartão ao paciente.' });
  }
  if (fim8(foneLead) !== fim8(fone)) {
    return recusar({
      ok: false, codigo: 'telefone_nao_bate',
      motivo: `O telefone digitado não é o do contato deste cartão (…${fim8(foneLead)}). Corrija o contato ou o número antes de cadastrar.`,
    });
  }

  // Cartão já ligado a um paciente: o clique não cria nada (é o segundo clique, ou a Sofia/o sincronizador já ligou).
  const vinculo = await prisma.spineLeadLink.findFirst({ where: { unitId: unit.id, kommoLeadId: entrada.leadId } });
  if (vinculo?.spineIdClient) {
    await recorder.finalize({ status: 'SUCCESS', latencyMs: Date.now() - t0, iaDecision: 'widget_cadastrar:ja_ligado' }).catch(() => undefined);
    return { ok: true, idClient: vinculo.spineIdClient, novoCadastro: false, jaLigado: true, nome: vinculo.nome ?? nome, unidade: rotulo, cartao: { camposEmBranco: [] }, vinculoGravado: true };
  }

  const existente = await pacienteExistente(unit, nome, lead.name ?? '', fone);
  if (existente === null) {
    return recusar({ ok: false, codigo: 'cadastro_falhou', motivo: 'A franquia não respondeu à busca do paciente. Nada foi cadastrado — tente de novo em instantes.' });
  }

  let idClient: number;
  let novoCadastro = false;
  if (existente !== 'nao_achou') {
    idClient = existente.idClient;
    await passo('TOOL_RESULT', `Paciente já existia na franquia: ${existente.nome ?? '?'} (idClient ${idClient}) — só liguei o cartão`);
  } else {
    let criado: number | null = null;
    if (vinculo?.spineIdLead) {
      const c = await SpineService.convertLead(unit, { idLead: vinculo.spineIdLead, name: nome, idSource: unit.spineDefaultSourceId, whatsapp: fone });
      if (c.ok && c.data?.idClient) criado = c.data.idClient;
    }
    if (criado === null) {
      const r = await SpineService.createClient(unit, {
        name: nome, whatsapp: fone, idSource: unit.spineDefaultSourceId, idLead: vinculo?.spineIdLead ?? null,
        addressCity: entrada.cidade?.trim().toUpperCase() || null, addressUf: SpineService.resolverUf(entrada.uf ?? null),
      });
      if (!r.ok || !r.data?.idClient) {
        return recusar({ ok: false, codigo: 'cadastro_falhou', motivo: `A franquia não aceitou o cadastro (${r.error ?? 'sem detalhe'}).` });
      }
      criado = r.data.idClient;
    }
    idClient = criado;
    novoCadastro = true;
    await passo('TOOL_RESULT', `Paciente cadastrado na franquia sem consulta: ${nome} (idClient ${idClient})`);
  }

  // O vínculo é o que faz o sincronizador seguir este paciente pelo id, e não pelo nome. Sem consulta: os campos
  // de agenda do vínculo ficam como estão.
  let vinculoGravado = true;
  await prisma.spineLeadLink
    .upsert({
      where: { unitId_kommoLeadId: { unitId: unit.id, kommoLeadId: entrada.leadId } },
      update: { spineIdClient: idClient, nome, status: 'ok' },
      create: { unitId: unit.id, kommoLeadId: entrada.leadId, spineIdClient: idClient, nome, status: 'ok' },
    })
    .catch((err) => { vinculoGravado = false; logger.warn({ err: String(err), unit: unit.slug, leadId: entrada.leadId }, 'widget cadastrar: falha ao gravar vínculo'); });

  // Cartão: só o id da franquia e uma nota. Nada de etapa nem de campo de agendamento — não houve agendamento.
  const cartao = { camposEmBranco: [] as string[] };
  try {
    const esquema = await esquemaDaUnidade(contaKommo, kommo); // os campos são da CONTA do Kommo
    const idCampo = esquema.campoPorNome('⚙ idClient (franquia)');
    if (idCampo === null) cartao.camposEmBranco.push('⚙ idClient (franquia)');
    else await kommo.setLeadCustomFieldValue(entrada.leadId, idCampo, 'numeric', idClient).catch(() => cartao.camposEmBranco.push('⚙ idClient (franquia)'));
    await kommo
      .addLeadNote(entrada.leadId, `${novoCadastro ? 'Paciente cadastrado' : 'Cartão ligado ao paciente que já existia'} na franquia${rotulo ? ` de ${rotulo}` : ''} pela recepção, pelo widget, sem consulta marcada (idClient ${idClient}).`)
      .catch(() => null);
    await passo('KOMMO_ACTION', `Cartão ligado ao paciente${cartao.camposEmBranco.length ? ` — em branco: ${cartao.camposEmBranco.join(', ')}` : ''}`, cartao);
  } catch (err) {
    logger.warn({ err: String(err), unit: unit.slug, leadId: entrada.leadId }, 'widget cadastrar: falha ao carimbar o cartão (o paciente ESTÁ na franquia)');
    await passo('ERROR', 'Paciente na franquia, mas não consegui carimbar o cartão — o sincronizador completa em até 15 min', { err: String(err) });
  }

  await recorder.finalize({ status: 'SUCCESS', latencyMs: Date.now() - t0, iaDecision: novoCadastro ? 'widget_cadastrar' : 'widget_cadastrar:ligou_existente' }).catch(() => undefined);
  logger.info({ unit: unit.slug, leadId: entrada.leadId, idClient, novoCadastro }, 'widget cadastrar: paciente na franquia sem consulta');
  return { ok: true, idClient, novoCadastro, jaLigado: false, nome, unidade: rotulo, cartao, vinculoGravado };
}
