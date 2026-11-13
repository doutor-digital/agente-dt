import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import {
  avisosDaRegraDeCliente,
  conferenciaDaUnidade,
  ehCliente,
  regraDeClienteDoAmbiente,
  unidadeConfere,
  usaRegraDeCliente,
  type LeadLido,
  type PortaDoKommo,
} from './disparo/conferencia.js';
import { alertaSemAndar } from './disparo/alerta.js';
import { ROTULO_DA_EXCLUSAO, campanhaUsaPrimeiroNome, rotuloDaExclusao, triar } from './disparo/regras.js';
import type { FranquiaPorta } from './disparo/franquia.js';
import { KommoApiError } from '../services/kommo.service.js';
import { SPINE_STATUS } from '../services/spine.service.js';

const JURIDICO = 14026239;
const COMERCIAL = 13964971;
const CONTRATO_ASSINADO = 108260519;
const GANHO = 142;
const PERDIDO = 143;
const REGRA = `magalhaes-advocacia=${JURIDICO},${COMERCIAL}/${CONTRATO_ASSINADO},${COMERCIAL}/${GANHO}`;
const env = (v: string) => ({ DISPARO_REGRA_CLIENTE: v }) as NodeJS.ProcessEnv;

const ESCRITORIO = { id: 'u-mag', slug: 'magalhaes-advocacia', spineToken: null } as unknown as Unit;
const CLINICA = { id: 'u-cl', slug: 'doutor-hernia-canaa', spineToken: 'tok' } as unknown as Unit;
const PESSOA = { leadId: 10, nomeCompleto: 'Maria da Silva', telefone: '5563991021043' };

/** Um cartão do mundo falso: funil, etapa e os contatos dele. */
type Cartao = { pipeline_id?: number; status_id?: number; contatos?: number[] };

/**
 * Um Kommo de mentira. `cartoes` por id; `contatos` = ids dos cartões de cada contato (como o `with=leads` devolve).
 * `falha` liga uma falha por vez: o cartão (lança/404/204), o contato (null/lança) ou a leitura dos outros cartões (lança/sem um deles).
 */
function kommoFalso(
  cartoes: Record<number, Cartao>,
  contatos: Record<number, number[]> = {},
  falha: { lead?: 'lanca' | '404' | '204'; contato?: 'null' | 'lanca'; lista?: 'lanca' | 'corta'; telefone?: 'lanca' | 'cheia' } = {},
  /** os contatos que a BUSCA POR TELEFONE devolve (os de fora do cartão: contato duplicado) */
  porTelefone: Array<{ id: number; telefones: string[]; leadIds: number[] }> = [],
) {
  const chamadas: { getLead: number; contato: number; lista: number; telefone: number; final8?: string } = { getLead: 0, contato: 0, lista: 0, telefone: 0 };
  const porta: PortaDoKommo = {
    getLead: async (id) => {
      chamadas.getLead++;
      if (falha.lead === 'lanca') throw new Error('kommo 500');
      if (falha.lead === '404') throw new KommoApiError('getLead: 404', 404, null);
      if (falha.lead === '204') return '';
      const c = cartoes[id];
      if (!c) return '';
      return { id, pipeline_id: c.pipeline_id, status_id: c.status_id, _embedded: { contacts: (c.contatos ?? []).map((x) => ({ id: x })) } };
    },
    leadsDoContato: async (id) => {
      chamadas.contato++;
      if (falha.contato === 'null') return null;
      if (falha.contato === 'lanca') throw new Error('boom');
      return contatos[id] ?? [];
    },
    contatosPorTelefone: async (final8) => {
      chamadas.telefone++;
      chamadas.final8 = final8;
      if (falha.telefone === 'lanca') throw new Error('kommo 403');
      if (falha.telefone === 'cheia') return Array.from({ length: 50 }, (_, i) => ({ id: 1000 + i, telefones: ['+55 63 98888-0000'], leadIds: [] }));
      return porTelefone;
    },
    listLeadsPorIds: async (ids) => {
      chamadas.lista++;
      if (falha.lista === 'lanca') throw new Error('kommo 429');
      const achados: LeadLido[] = ids.filter((id) => cartoes[id]).map((id) => ({ id, pipeline_id: cartoes[id]!.pipeline_id, status_id: cartoes[id]!.status_id }));
      return falha.lista === 'corta' ? achados.slice(1) : achados;
    },
  };
  return { porta, chamadas };
}

const confere = (unit: Unit, ambiente: NodeJS.ProcessEnv, k: ReturnType<typeof kommoFalso>, p: { leadId: number | null; nomeCompleto: string; telefone: string } = PESSOA) =>
  conferenciaDaUnidade(unit, { env: ambiente, kommo: k.porta })(p);
/** O caso simples: o cartão 10 sozinho num funil e etapa. */
const sozinho = (pipeline_id: number, status_id: number) => kommoFalso({ 10: { pipeline_id, status_id, contatos: [1] } }, { 1: [10] });

test('escritório (sem franquia, com regra): cliente do funil jurídico, em QUALQUER etapa (inclusive 142/143), fica de fora', async () => {
  for (const etapa of [1, 77777, GANHO, PERDIDO]) {
    assert.equal(await confere(ESCRITORIO, env(REGRA), sozinho(JURIDICO, etapa)), 'ja-cliente', `etapa ${etapa}`);
  }
});

test('escritório: no Comercial, "6 - Contrato assinado" e "Fechado - ganho" são clientes', async () => {
  assert.equal(await confere(ESCRITORIO, env(REGRA), sozinho(COMERCIAL, CONTRATO_ASSINADO)), 'ja-cliente');
  assert.equal(await confere(ESCRITORIO, env(REGRA), sozinho(COMERCIAL, GANHO)), 'ja-cliente');
});

test('escritório: "Fechado - perdido" (143) do Comercial é LIVRE — reengajar perdido é o objetivo; lead novo também', async () => {
  assert.equal(await confere(ESCRITORIO, env(REGRA), sozinho(COMERCIAL, PERDIDO)), 'livre');
  assert.equal(await confere(ESCRITORIO, env(REGRA), sozinho(COMERCIAL, 99999)), 'livre', 'etapa qualquer do Comercial');
  assert.equal(await confere(ESCRITORIO, env(REGRA), sozinho(555, GANHO)), 'livre', 'ganho de OUTRO funil não é regra');
  assert.equal(await confere(ESCRITORIO, env(REGRA), kommoFalso({ 10: { pipeline_id: COMERCIAL, status_id: 5 } })), 'livre', 'cartão sem contato: só ele mesmo');
});

test('escritório: confere a PESSOA — cartão perdido etiquetado + cartão no Jurídico SEM etiqueta, do mesmo contato = ja-cliente', async () => {
  const k = kommoFalso({ 10: { pipeline_id: COMERCIAL, status_id: PERDIDO, contatos: [1] }, 11: { pipeline_id: JURIDICO, status_id: 7 } }, { 1: [10, 11] });
  assert.equal(await confere(ESCRITORIO, env(REGRA), k), 'ja-cliente');
  // e o contrário: o outro cartão do contato é só um lead aberto/perdido = livre
  const k2 = kommoFalso({ 10: { pipeline_id: COMERCIAL, status_id: PERDIDO, contatos: [1] }, 11: { pipeline_id: COMERCIAL, status_id: 4 } }, { 1: [10, 11] });
  assert.equal(await confere(ESCRITORIO, env(REGRA), k2), 'livre');
});

test('escritório: o cliente pode estar no 2º contato do cartão; UM cartão de cliente basta mesmo que outro não volte na leitura', async () => {
  const k = kommoFalso({ 10: { pipeline_id: COMERCIAL, status_id: 4, contatos: [1, 2] }, 12: { pipeline_id: COMERCIAL, status_id: CONTRATO_ASSINADO } }, { 1: [10], 2: [10, 12, 13] });
  assert.equal(await confere(ESCRITORIO, env(REGRA), k), 'ja-cliente', 'o 13 nem existe na resposta, mas o 12 já decide');
});

test('escritório: o lead é lido FRESCO a cada conferência (quem fechou contrato depois da montagem sai na hora do envio)', async () => {
  const cartoes: Record<number, Cartao> = { 10: { pipeline_id: COMERCIAL, status_id: 5, contatos: [1] } };
  const k = kommoFalso(cartoes, { 1: [10] });
  const conferir = conferenciaDaUnidade(ESCRITORIO, { env: env(REGRA), kommo: k.porta });
  assert.equal(await conferir(PESSOA), 'livre');
  cartoes[10]!.status_id = CONTRATO_ASSINADO;
  assert.equal(await conferir(PESSOA), 'ja-cliente');
  assert.equal(k.chamadas.getLead, 2);
});

test('escritório: QUALQUER leitura que falha no caminho = indisponivel, NUNCA livre', async () => {
  const mundo = { 10: { pipeline_id: COMERCIAL, status_id: 5, contatos: [1] }, 11: { pipeline_id: COMERCIAL, status_id: PERDIDO } };
  const contatos = { 1: [10, 11] };
  assert.equal(await confere(ESCRITORIO, env(REGRA), kommoFalso(mundo, contatos, { lead: 'lanca' })), 'indisponivel', 'cartão: erro');
  assert.equal(await confere(ESCRITORIO, env(REGRA), kommoFalso(mundo, contatos, { contato: 'null' })), 'indisponivel', 'contato: não consegui perguntar');
  assert.equal(await confere(ESCRITORIO, env(REGRA), kommoFalso(mundo, contatos, { contato: 'lanca' })), 'indisponivel', 'contato: lançou');
  assert.equal(await confere(ESCRITORIO, env(REGRA), kommoFalso(mundo, contatos, { lista: 'lanca' })), 'indisponivel', 'cartões do contato: erro/429');
  assert.equal(await confere(ESCRITORIO, env(REGRA), kommoFalso(mundo, contatos, { lista: 'corta' })), 'indisponivel', 'cartão do contato que não voltou na resposta');
  assert.equal(await confere(ESCRITORIO, env(REGRA), kommoFalso({ 10: { status_id: 5 } })), 'indisponivel', 'cartão sem funil');
  assert.equal(await confere(ESCRITORIO, env(REGRA), kommoFalso({ 10: { pipeline_id: COMERCIAL } })), 'indisponivel', 'cartão sem etapa');
  assert.equal(await confere(ESCRITORIO, env(REGRA), sozinho(COMERCIAL, 5), { ...PESSOA, leadId: null }), 'indisponivel', 'sem cartão não há o que olhar');
});

test('escritório: cartão que não existe mais (204/vazio: apagado/mesclado) = lead-inexistente; 404 ADIA (pode ser conta errada)', async () => {
  assert.equal(await confere(ESCRITORIO, env(REGRA), kommoFalso({}, {}, { lead: '404' })), 'indisponivel', '404 não descarta ninguém');
  assert.equal(await confere(ESCRITORIO, env(REGRA), kommoFalso({}, {}, { lead: '204' })), 'lead-inexistente');
  assert.equal(await confere(ESCRITORIO, env(REGRA), kommoFalso({})), 'lead-inexistente', 'lead desconhecido do Kommo falso volta vazio');
  // 500 NÃO é "sumiu": continua indisponível
  const quebra: PortaDoKommo = { ...kommoFalso({}).porta, getLead: async () => { throw new KommoApiError('x', 500, null); } };
  assert.equal(await conferenciaDaUnidade(ESCRITORIO, { env: env(REGRA), kommo: quebra })(PESSOA), 'indisponivel');
});

test('escritório: CONTATO DUPLICADO com o mesmo telefone e sem etiqueta — o cartão do Jurídico dele conta (ja-cliente)', async () => {
  // contato 1 (do cartão etiquetado, perdido) e contato 2 (outro contato, MESMO telefone, cartão 20 no Jurídico). O 2 não está no cartão 10.
  const mundo = { 10: { pipeline_id: COMERCIAL, status_id: PERDIDO, contatos: [1] }, 20: { pipeline_id: JURIDICO, status_id: 3, contatos: [2] } };
  const dupla = [{ id: 2, telefones: ['+55 63 99102-1043'], leadIds: [20] }];
  const k = kommoFalso(mundo, { 1: [10] }, {}, dupla);
  assert.equal(await confere(ESCRITORIO, env(REGRA), k), 'ja-cliente');
  assert.equal(k.chamadas.final8, '91021043', 'a busca é pelos 8 últimos dígitos');
  // sem o contato duplicado no resultado, a mesma pessoa é livre (prova que o que decide é a busca por telefone)
  assert.equal(await confere(ESCRITORIO, env(REGRA), kommoFalso(mundo, { 1: [10] })), 'livre');
});

test('escritório: busca por telefone confere o NÚMERO — mesmo telefone sem o 9 vale; mesmos 8 dígitos em OUTRO DDD não; lixo da busca difusa não', async () => {
  const mundo = { 10: { pipeline_id: COMERCIAL, status_id: PERDIDO, contatos: [1] }, 20: { pipeline_id: JURIDICO, status_id: 3 } };
  const com = (telefones: string[]) => kommoFalso(mundo, { 1: [10] }, {}, [{ id: 2, telefones, leadIds: [20] }]);
  assert.equal(await confere(ESCRITORIO, env(REGRA), com(['(63) 9102-1043'])), 'ja-cliente', 'sem DDI e sem o nono dígito (12 dígitos com 55)');
  assert.equal(await confere(ESCRITORIO, env(REGRA), com(['556391021043'])), 'ja-cliente');
  assert.equal(await confere(ESCRITORIO, env(REGRA), com(['+55 11 99102-1043'])), 'livre', 'outro DDD é outra pessoa');
  assert.equal(await confere(ESCRITORIO, env(REGRA), com(['+55 63 98888-0000'])), 'livre', 'a busca difusa trouxe quem não é');
  assert.equal(await confere(ESCRITORIO, env(REGRA), com(['91021043'])), 'ja-cliente', 'número sem DDD: casa pelos 8 últimos (lado seguro)');
});

test('escritório: busca por telefone que falha ou volta CHEIA (teto) = indisponivel, nunca livre', async () => {
  const mundo = { 10: { pipeline_id: COMERCIAL, status_id: PERDIDO, contatos: [1] } };
  assert.equal(await confere(ESCRITORIO, env(REGRA), kommoFalso(mundo, { 1: [10] }, { telefone: 'lanca' })), 'indisponivel');
  assert.equal(await confere(ESCRITORIO, env(REGRA), kommoFalso(mundo, { 1: [10] }, { telefone: 'cheia' })), 'indisponivel');
  // cartão do contato duplicado que o Kommo não devolve em filter[id] também não prova nada
  const k = kommoFalso(mundo, { 1: [10] }, {}, [{ id: 2, telefones: ['+55 63 99102-1043'], leadIds: [77] }]);
  assert.equal(await confere(ESCRITORIO, env(REGRA), k), 'indisponivel');
});

test('sem franquia e SEM regra = indisponivel para todos (como hoje); regra de outra unidade não vale; regra inválida não vale', async () => {
  const k = sozinho(1, 1);
  assert.equal(await confere(ESCRITORIO, {} as NodeJS.ProcessEnv, k), 'indisponivel');
  assert.equal(await confere(ESCRITORIO, env(`outra-unidade=${JURIDICO}`), k), 'indisponivel');
  assert.equal(await confere(ESCRITORIO, env(`magalhaes-advocacia=${JURIDICO},abc`), k), 'indisponivel', 'item ruim invalida a entrada toda');
  assert.equal(await confere(ESCRITORIO, env(`${JURIDICO}`), k), 'indisponivel', 'formato global/antigo: ninguém');
  assert.deepEqual(k.chamadas, { getLead: 0, contato: 0, lista: 0, telefone: 0 }, 'sem regra nem toca no Kommo');
  assert.equal(unidadeConfere(ESCRITORIO, {} as NodeJS.ProcessEnv), false);
  assert.equal(unidadeConfere(ESCRITORIO, env(REGRA)), true);
  assert.equal(usaRegraDeCliente(ESCRITORIO, env(REGRA)), true);
  assert.equal(usaRegraDeCliente(ESCRITORIO, {} as NodeJS.ProcessEnv), false);
});

test('COM franquia o comportamento é o de sempre: a franquia responde, o Kommo não é tocado, nem com regra de cliente na unidade', async () => {
  const k = sozinho(JURIDICO, GANHO);
  const franquia = (agenda: 'falha' | Array<{ clientName: string; dateAttendanceUtc: string; idStatus: number }>): FranquiaPorta => ({
    searchSchedules: (async () => (agenda === 'falha' ? { ok: false, error: 'fora do ar' } : { ok: true, data: { schedules: agenda, pages: 1, total: 0 } })) as unknown as FranquiaPorta['searchSchedules'],
    searchTreatments: (async () => ({ ok: true, data: { treatments: [] } })) as unknown as FranquiaPorta['searchTreatments'],
    idClientDoLead: (async () => null) as unknown as FranquiaPorta['idClientDoLead'],
    getClient: (async () => ({ ok: true, data: { client: { schedules: [], treatments: [] } } })) as unknown as FranquiaPorta['getClient'],
  });
  const amanha = new Date(Date.now() + 86_400_000).toISOString();
  const comRegra = env(`doutor-hernia-canaa=${JURIDICO}`);
  const c = (f: FranquiaPorta) => conferenciaDaUnidade(CLINICA, { env: comRegra, kommo: k.porta, franquia: f })(PESSOA);
  assert.equal(await c(franquia([])), 'livre', 'franquia livre = livre, mesmo o cartão estando no funil da regra');
  assert.equal(await c(franquia([{ clientName: 'Maria da Silva', dateAttendanceUtc: amanha, idStatus: SPINE_STATUS.AGENDADO }])), 'consulta-futura');
  assert.equal(await c(franquia('falha')), 'indisponivel');
  assert.deepEqual(k.chamadas, { getLead: 0, contato: 0, lista: 0, telefone: 0 });
  assert.equal(unidadeConfere(CLINICA, {} as NodeJS.ProcessEnv), true);
  assert.equal(usaRegraDeCliente(CLINICA, comRegra), false, 'a triagem de cartões repetidos fica desligada na franquia');
});

test('o valor de config da Magalhães: funil inteiro + duas etapas; várias unidades na mesma variável', () => {
  const regra = regraDeClienteDoAmbiente('magalhaes-advocacia', env(`outra=1; ${REGRA} \n`))!;
  assert.deepEqual([...regra.funis], [JURIDICO]);
  assert.deepEqual([...regra.etapas].sort(), [`${COMERCIAL}/${GANHO}`, `${COMERCIAL}/${CONTRATO_ASSINADO}`].sort());
  assert.equal(ehCliente(regra, { pipeline_id: JURIDICO, status_id: PERDIDO }), true);
  assert.equal(ehCliente(regra, { pipeline_id: COMERCIAL, status_id: PERDIDO }), false);
  assert.deepEqual(avisosDaRegraDeCliente(env(REGRA)), []);
  assert.equal(avisosDaRegraDeCliente(env(`${JURIDICO}; magalhaes-advocacia=x`)).length, 2, 'avisa entrada global e entrada com item ruim');
  assert.equal(regraDeClienteDoAmbiente('magalhaes-advocacia', env(`magalhaes-advocacia=${COMERCIAL}/0`)), null, 'etapa 0 é erro de digitação: entrada inteira inválida');
  assert.equal(avisosDaRegraDeCliente(env(`${REGRA};${REGRA}`)).length, 1, 'avisa slug repetido');
});

test('entrada sem "=" é lixo: UM aviso de formato, sem slug falso e sem aviso de "repetido"', () => {
  assert.equal(avisosDaRegraDeCliente(env(`${JURIDICO};${JURIDICO}`)).length, 2, 'duas entradas ruins = dois avisos de formato');
  const a = avisosDaRegraDeCliente(env(`lixo;lixo;${REGRA}`));
  assert.equal(a.length, 2);
  assert.ok(a.every((t) => /não vale/.test(t) && !/mais de uma vez/.test(t)), a.join(' | '));
  assert.deepEqual(avisosDaRegraDeCliente(env('=14026239')).length, 1, 'sem slug também é lixo');
});

const cand = (leadId: number, nome: string, tel: string) => ({ leadId, nome, telefoneBruto: tel });
const triarComKommo = (candidatos: ReturnType<typeof cand>[], k: ReturnType<typeof kommoFalso>, conferirCartoesRepetidos = true) => {
  const franquia = conferenciaDaUnidade(ESCRITORIO, { env: env(REGRA), kommo: k.porta });
  return triar(candidatos, { jaNaCampanha: new Set(), pediramSair: new Set(), franquia: (e) => franquia({ leadId: e.leadId, nomeCompleto: e.nomeCompleto, telefone: e.telefone }), conferirCartoesRepetidos });
};

test('triagem: "ja-cliente" e "lead-inexistente" ficam de fora, contados com rótulo próprio; indisponível não entra', async () => {
  const k = kommoFalso({ 1: { pipeline_id: JURIDICO, status_id: 5 }, 2: { pipeline_id: COMERCIAL, status_id: PERDIDO } });
  const r = await triarComKommo([cand(1, 'Maria Souza', '5563991021043'), cand(2, 'Joana Lima', '5563992021043'), cand(3, 'Ana Costa', '5563993021043')], k);
  assert.deepEqual(r.elegiveis.map((e) => e.nome), ['Joana']);
  assert.deepEqual(r.fora, { 'ja-cliente': 1, 'lead-inexistente': 1 });
  assert.match(ROTULO_DA_EXCLUSAO['ja-cliente'], /cliente/);
  assert.match(ROTULO_DA_EXCLUSAO['lead-inexistente'], /não existe mais/);
  const caiu = await triarComKommo([cand(1, 'Maria Souza', '5563991021043')], kommoFalso({}, {}, { lead: 'lanca' }));
  assert.deepEqual(caiu.fora, { 'franquia-indisponivel': 1 });
});

test('triagem: pessoa com 2 cartões etiquetados (mesmo telefone, contatos DIFERENTES): o 1º perdido, o 2º no Jurídico = ja-cliente, ninguém entra', async () => {
  const k = kommoFalso({ 1: { pipeline_id: COMERCIAL, status_id: PERDIDO, contatos: [1] }, 2: { pipeline_id: JURIDICO, status_id: 3, contatos: [2] } }, { 1: [1], 2: [2] });
  const r = await triarComKommo([cand(1, 'Maria Souza', '5563991021043'), cand(2, 'Maria Souza', '5563991021043')], k);
  assert.deepEqual(r.elegiveis, []);
  assert.deepEqual(r.fora, { 'repetido-na-lista': 1, 'ja-cliente': 1 });
});

test('triagem: os dois cartões livres = entra UMA vez (o repetido só é contado); cartão repetido que sumiu não derruba a pessoa; leitura que falha derruba', async () => {
  const dois = { 1: { pipeline_id: COMERCIAL, status_id: PERDIDO, contatos: [1] }, 2: { pipeline_id: COMERCIAL, status_id: 4, contatos: [2] } };
  const r = await triarComKommo([cand(1, 'Maria Souza', '5563991021043'), cand(2, 'Maria Souza', '5563991021043')], kommoFalso(dois, { 1: [1], 2: [2] }));
  assert.deepEqual(r.elegiveis.map((e) => e.leadId), [1]);
  assert.deepEqual(r.fora, { 'repetido-na-lista': 1 });
  // o cartão 9 não existe: não prova nada contra a pessoa, ela segue pelo 1º
  const r2 = await triarComKommo([cand(1, 'Maria Souza', '5563991021043'), cand(9, 'Maria Souza', '5563991021043')], kommoFalso(dois, { 1: [1] }));
  assert.deepEqual(r2.elegiveis.map((e) => e.leadId), [1]);
  assert.deepEqual(r2.fora, { 'repetido-na-lista': 1 });
  // o cartão 2 NÃO pôde ser lido (erro): na dúvida a pessoa sai
  const k3 = kommoFalso(dois, { 1: [1], 2: [2] });
  const getLead = k3.porta.getLead;
  k3.porta.getLead = async (id) => (id === 2 ? Promise.reject(new Error('kommo 500')) : getLead(id));
  const r3 = await triarComKommo([cand(1, 'Maria Souza', '5563991021043'), cand(2, 'Maria Souza', '5563991021043')], k3);
  assert.deepEqual(r3.elegiveis, []);
  assert.deepEqual(r3.fora, { 'repetido-na-lista': 1, 'franquia-indisponivel': 1 });
});

test('triagem: 1º cartão sumiu (lead-inexistente) e o 2º, do mesmo telefone, é válido = a pessoa entra pelo 2º', async () => {
  const k = kommoFalso({ 2: { pipeline_id: COMERCIAL, status_id: 4, contatos: [2] } }, { 2: [2] });
  const r = await triarComKommo([cand(1, 'Maria Souza', '5563991021043'), cand(2, 'Maria Souza', '5563991021043')], k);
  assert.deepEqual(r.elegiveis.map((e) => e.leadId), [2]);
  assert.deepEqual(r.fora, { 'lead-inexistente': 1 });
});

test('triagem: sem a regra de cartão (franquia) o repetido continua só repetido, sem conferência extra', async () => {
  const k = kommoFalso({ 1: { pipeline_id: COMERCIAL, status_id: PERDIDO, contatos: [1] }, 2: { pipeline_id: JURIDICO, status_id: 3, contatos: [2] } }, { 1: [1], 2: [2] });
  const r = await triarComKommo([cand(1, 'Maria Souza', '5563991021043'), cand(2, 'Maria Souza', '5563991021043')], k, false);
  assert.deepEqual(r.elegiveis.map((e) => e.leadId), [1]);
  assert.deepEqual(r.fora, { 'repetido-na-lista': 1 });
  assert.equal(k.chamadas.getLead, 1);
});

test('nome: a exclusão por "nome que não serve para saudação" só vale se a campanha usa primeiroNome', async () => {
  const franquia = () => 'livre' as const;
  const gente = [cand(1, 'Maria Souza', '5563991021043'), cand(2, '28/04/25 facebook', '5563992021043'), cand(3, null as unknown as string, '5563993021043')];
  const ctx = { jaNaCampanha: new Set<string>(), pediramSair: new Set<string>(), franquia };
  // campanha SEM nome no modelo (coluna_trabalho_pesado: variaveis = []): ninguém sai por nome
  const sem = await triar(gente, { ...ctx, exigeNome: campanhaUsaPrimeiroNome([]) });
  assert.deepEqual(sem.elegiveis.map((e) => [e.leadId, e.nome]), [[1, 'Maria'], [2, ''], [3, '']]);
  assert.deepEqual(sem.fora, {});
  // texto fixo e unidade também não precisam de nome
  assert.equal(campanhaUsaPrimeiroNome(['unidade', 'texto:oi']), false);
  // campanha COM primeiroNome: segue excluindo
  const com = await triar(gente, { ...ctx, exigeNome: campanhaUsaPrimeiroNome(['primeiroNome']) });
  assert.deepEqual(com.elegiveis.map((e) => e.leadId), [1]);
  assert.deepEqual(com.fora, { 'nome-invalido': 2 });
  // ausente = exige (o padrão seguro)
  assert.deepEqual((await triar(gente, ctx)).fora, { 'nome-invalido': 2 });
});

test('textos: sem franquia fala em Kommo (painel e alerta de onda parada); com franquia o texto é o de sempre', () => {
  assert.match(rotuloDaExclusao('franquia-indisponivel', true), /Kommo/);
  assert.equal(rotuloDaExclusao('franquia-indisponivel'), ROTULO_DA_EXCLUSAO['franquia-indisponivel']);
  assert.match(ROTULO_DA_EXCLUSAO['franquia-indisponivel'], /franquia/);
  assert.equal(rotuloDaExclusao('motivo-novo-qualquer', true), 'motivo-novo-qualquer');
  const sem = alertaSemAndar({ unidade: 'magalhaes-advocacia', rodadas: 5, adiados: 3, confereNoKommo: true });
  assert.match(sem, /Kommo/);
  assert.doesNotMatch(sem, /franquia|Spine/);
  assert.match(alertaSemAndar({ unidade: 'doutor-hernia-canaa', rodadas: 5, adiados: 3 }), /franquia \(API Spine\)/);
});
