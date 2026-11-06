/**
 * O "¤ Valor da Consulta" gravado pela Sofia NO MOMENTO de agendar, só em unidade com pagamento antecipado.
 *
 * Por quê: os modelos de WhatsApp "consulta prepagamento" ("a consulta com pagamento antecipado é {{valor}}") e "dados pix"
 * ("Valor: {{valor}}") leem este campo assim que o cartão entra em AGENDADO com `¤ Pagamento antecipado` = Sim — e quem move o
 * cartão é a Sofia, no mesmo turno, bem antes da próxima varredura da franquia (até 15 min). Sem o valor já no cartão, o paciente
 * recebia "…é ." Aqui a Sofia grava o valor ANTES de carimbar a forma de pagamento.
 *
 * NÃO é uma segunda regra: usa `decidirValorDaConsulta` e `gravarValorDaConsulta`, as mesmas da varredura, com as mesmas fontes e a
 * mesma chave (`valor-consulta`: desligado não faz nada, seco só registra). Os dois caminhos concordam sempre, então não há
 * regravação. Unidade sem preço antecipado nas fontes (Timbó) não passa por aqui: a varredura cuida, como sempre.
 */
import type { Unit } from '@prisma/client';
import type { KommoClient, KommoLead } from '../services/kommo.service.js';
import { SPINE_STATUS } from '../services/spine.service.js';
import { estadoDaAutomacao } from './automacoes-estado.js';
import { fusoDaUnidade } from './fuso.js';
import { logger } from './logger.js';
import { normalizar } from './franquia-sync.js';
import { registrarSimulacao } from './so-no-papel.js';
import { CAMPO_VALOR_DA_CONSULTA, consultaEhHoje, decidirValorDaConsulta, epochDaConsulta, precosDaUnidade, sinaisDoCartao } from './valor-consulta.js';
import { gravarValorDaConsulta, robotPodeTrocar, valorNoCartao, type CampoDoValor } from './valor-consulta-aplicar.js';
import { marcasNoBanco, type MarcasDoValor } from './valor-consulta-marca.js';

/** O campo na conta (id, tipo, opções) muda raramente: uma leitura por unidade a cada 10 min, não uma por agendamento. */
const CAMPOS_TTL_MS = 10 * 60_000;
const campoGuardado = new Map<string, { campo: CampoDoValor | null; expiraEm: number }>();
export function _limparCacheDoCampo(): void { campoGuardado.clear(); }

async function campoDoValor(unit: Unit, kommo: KommoClient): Promise<CampoDoValor | null> {
  const g = campoGuardado.get(unit.id);
  if (g && g.expiraEm > Date.now()) return g.campo;
  const bruto = (await kommo.listLeadCustomFields()) as { _embedded?: { custom_fields?: Array<{ id: number; name: string; type: string; enums?: Array<{ id: number; value: string }> | null }> } } | undefined;
  const campos = (bruto?._embedded?.custom_fields ?? []).filter((c) => normalizar(c.name) === normalizar(CAMPO_VALOR_DA_CONSULTA));
  const def = campos.find((c) => c.name === CAMPO_VALOR_DA_CONSULTA) ?? campos[0] ?? null;
  const campo = def ? { id: def.id, type: def.type as CampoDoValor['type'], enums: (def.enums ?? []).map((e) => ({ id: e.id, value: e.value })) } : null;
  campoGuardado.set(unit.id, { campo, expiraEm: Date.now() + CAMPOS_TTL_MS });
  return campo;
}

export async function valorDaConsultaAoAgendar(a: {
  unit: Unit;
  kommo: KommoClient;
  leadId: number;
  leadAtual: KommoLead | null;
  /** "2026-11-07" e "14:30", no relógio da unidade */
  data: string;
  hora: string;
  /**
   * o que a Sofia VAI gravar em ¤ Pagamento antecipado (`decidirPagamentoAntecipado`). null = ela não mexe no campo (a forma já estava
   * no cartão, por ex. a SDR pôs Sim antes): vale a forma que o cartão mostra.
   */
  pagamento: 'Sim' | 'Não' | null;
  ehRetorno: boolean;
  /** o agendamento é a avaliação (categoria 1, o padrão)? Outra categoria não recebe o preço da avaliação */
  ehAvaliacao?: boolean;
  marcas?: MarcasDoValor;
  agoraEpoch?: number;
}): Promise<string> {
  const { unit, kommo, leadId, leadAtual } = a;
  const estado = estadoDaAutomacao(unit.slug, 'valor-consulta', process.env.VALOR_CONSULTA_SLUGS);
  if (estado === 'desligado') return 'desligado';
  // como na varredura: o sincronizador desligado não tem robô para o guia esconder o campo, e em seco inteiro nada grava
  const sync = estadoDaAutomacao(unit.slug, 'franquia-sync', process.env.FRANQUIA_SYNC_SLUGS);
  if (sync === 'desligado') return 'franquia-sync-desligado';
  const precos = precosDaUnidade(unit);
  if (precos.divergente) return 'precos-divergentes';
  if (precos.antecipado === null) return 'sem-antecipado';
  if (a.ehRetorno || a.ehAvaliacao === false || !leadAtual) return 'sem-avaliacao-ou-forma';
  // as saídas que não dependem do campo vêm ANTES da leitura dos campos da conta (uma chamada ao Kommo por agendamento)
  if (unit.spineBookingRequiresPayment) return 'taxa-de-reserva';
  const sinais = sinaisDoCartao(leadAtual, a.pagamento);
  if (sinais.comConvenio) return 'convenio';

  const campo = await campoDoValor(unit, kommo);

  const agoraEpoch = a.agoraEpoch ?? Math.floor(Date.now() / 1000);
  const fuso = fusoDaUnidade(unit);
  const consultaEpoch = epochDaConsulta(a.data, a.hora, fuso);
  const marcas = a.marcas ?? marcasNoBanco;
  const noCartao = campo ? valorNoCartao(leadAtual, campo.id) : null;
  const marca = noCartao !== null ? await marcas.ler(unit.id, leadId).catch(() => null) : null;

  const d = decidirValorDaConsulta({
    estado,
    // a Sofia acabou de marcar uma avaliação; o que importa para a regra é o horário e que ainda vai acontecer
    consulta: { categoryName: 'AVALIAÇÃO', idStatus: SPINE_STATUS.AGENDADO },
    consultaEpoch,
    agoraEpoch,
    tipoDoCampo: campo?.type ?? null,
    noCartao,
    preco: precos.noDia,
    secoGlobal: sync === 'seco',
    precoAntecipado: precos.antecipado,
    forma: sinais.forma,
    consultaHoje: consultaEhHoje(consultaEpoch, agoraEpoch, fuso),
    taxaDeReserva: Boolean(unit.spineBookingRequiresPayment),
    comConvenio: sinais.comConvenio,
    marcaCentavos: marca?.centavos ?? null,
    marcaQual: marca?.qual ?? null,
  });
  if (d.acao === 'nada' || !campo) return d.acao === 'nada' ? d.motivo : 'sem-campo';

  if (d.acao === 'gravaria') {
    if (d.troca && !(await robotPodeTrocar(kommo, leadId, campo.id))) return 'troca-recusada';
    logger.info({ unit: unit.slug, leadId, campo: CAMPO_VALOR_DA_CONSULTA, valor: d.valor, motivo: d.motivo }, 'valor-consulta [seco, ao agendar]: gravaria');
    registrarSimulacao(unit, 'valor-consulta', { leadId, acao: 'gravaria', alvo: CAMPO_VALOR_DA_CONSULTA, valor: d.valor, motivo: d.motivo });
    return 'gravaria';
  }
  const r = await gravarValorDaConsulta({ unit, kommo, leadId, campo, decisao: d, marcaEsperada: marca?.centavos ?? null, marcas, origem: 'sofia', fresco: leadAtual });
  if (r === 'gravou') logger.info({ unit: unit.slug, leadId, campo: CAMPO_VALOR_DA_CONSULTA, valor: d.valor, troca: d.troca === true, motivo: d.motivo }, 'valor-consulta [ao agendar]: gravado');
  return r;
}
