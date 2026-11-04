import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CacheQueAguentaFalha,
  PRAZOS_DA_PAGINA_IA,
  autorDaMudanca,
  candidatosCartaoVazio,
  cartaoDaPagina,
  conferir,
  contarPorColuna,
  criarFilaDeUm,
  etapasAbertas,
  horaCurta,
  inicioDoDiaEpoch,
  resumirMudancas,
  type CartaoDaPagina,
  type MudancaLida,
} from './ia-unidade.js';
import { codigoConfere, criarLimiteDeTentativas } from './codigo-publico.js';

// Regras e contas da página /ia/:slug (04/11/2026, pedido de Timbó). Dados no formato do Kommo de Timbó/Cerquilho.

const TZ = 'America/Sao_Paulo';
const AGORA = new Date('2026-11-04T18:00:00Z'); // 15:00 em Brasília
const AGORA_S = Math.floor(AGORA.getTime() / 1000);
const H = 3600;
const D = 86_400;

function cartao(p: Partial<CartaoDaPagina> & { etapa: string }): CartaoDaPagina {
  return { id: 1, nome: 'Paciente', comercial: true, atualizadoEpoch: AGORA_S - D, consultaEpoch: null, situacao: null, retomarEmEpoch: null, temCampo: true, ...p };
}

const ETAPAS_TIMBO = ['Incoming leads', 'EM QUALIFICAÇÃO', 'EM ESPERA', 'CONFERIR NA FRANQUIA', 'AGENDADO', 'NÃO COMPARECEU', 'COMPARECEU', 'EM NEGOCIAÇÃO', 'RETORNO PÓS-TRATAMENTO', 'GANHO / CONCLUÍDO', 'PERDIDO'];
const ETAPAS_CERQUILHO = [...ETAPAS_TIMBO, 'DESMARCOU'];
const ctx = (extra: Partial<Parameters<typeof conferir>[1]> = {}) => ({ agora: AGORA, etapasDaConta: ETAPAS_TIMBO, ...extra });
const regras = (r: ReturnType<typeof conferir>) => r.grupos.map((g) => g.regra);

// ── dia da unidade ──

test('início do dia: meia-noite no fuso da unidade (Brasília UTC−3, Boa Vista UTC−4)', () => {
  assert.equal(inicioDoDiaEpoch(AGORA, 'America/Sao_Paulo'), Date.parse('2026-11-04T03:00:00Z') / 1000);
  assert.equal(inicioDoDiaEpoch(AGORA, 'America/Boa_Vista'), Date.parse('2026-11-04T04:00:00Z') / 1000);
  // 22:30 em Brasília já é 05/11 em UTC — o dia da unidade continua 04/11
  assert.equal(inicioDoDiaEpoch(new Date('2026-11-05T01:30:00Z'), 'America/Sao_Paulo'), Date.parse('2026-11-04T03:00:00Z') / 1000);
  // 00:10 em Brasília: dia novo
  assert.equal(inicioDoDiaEpoch(new Date('2026-11-05T03:10:00Z'), 'America/Sao_Paulo'), Date.parse('2026-11-05T03:00:00Z') / 1000);
  assert.equal(horaCurta(Date.parse('2026-11-04T17:05:00Z') / 1000, TZ), '14:05');
});

// ── o cartão como o Kommo devolve (field_name nos valores: nada de id de campo) ──

test('cartaoDaPagina lê data da consulta, situação e retomar em PELO NOME do campo', () => {
  const lead = {
    id: 5368768,
    name: 'João Augusto 04/11/2026',
    updated_at: AGORA_S - 2 * D,
    custom_fields_values: [
      { field_id: 999, field_name: '◷ Data da Consulta', values: [{ value: AGORA_S - 20 * H }] },
      { field_id: 111, field_name: '✓ Situação da consulta', values: [{ value: 'Agendado', enum_id: 1 }] },
      { field_id: 222, field_name: '◷ Retomar em', values: [{ value: AGORA_S + 5 * D }] },
    ],
  };
  const c = cartaoDaPagina(lead, 'AGENDADO', true);
  assert.equal(c.consultaEpoch, AGORA_S - 20 * H);
  assert.equal(c.situacao, 'Agendado');
  assert.equal(c.retomarEmEpoch, AGORA_S + 5 * D);
  assert.equal(c.temCampo, true);
  const vazio = cartaoDaPagina({ id: 7, name: 'Lead #7', updated_at: 1, custom_fields_values: null }, 'EM QUALIFICAÇÃO', true);
  assert.equal(vazio.temCampo, false);
  assert.equal(vazio.situacao, null);
  // só cabeçalho/valor vazio também é cartão vazio
  assert.equal(cartaoDaPagina({ id: 8, name: 'x', custom_fields_values: [{ field_name: '##^Consulta', values: [{ value: '' }] }] }, 'AGENDADO', true).temCampo, false);
  assert.equal(cartaoDaPagina({ id: 9, name: '   ' }, 'AGENDADO', true).nome, 'Cartão 9');
});

// ── Conferir ──

test('AGENDADO com a consulta passada há mais de 12 h: marcar COMPARECEU ou NÃO COMPARECEU (11 h não, 13 h sim)', () => {
  const r = conferir(
    [
      cartao({ id: 1, nome: 'Passou há 13 h', etapa: 'AGENDADO', consultaEpoch: AGORA_S - 13 * H }),
      cartao({ id: 2, nome: 'Passou há 11 h', etapa: 'AGENDADO', consultaEpoch: AGORA_S - 11 * H }),
      cartao({ id: 3, nome: 'Amanhã', etapa: 'AGENDADO', consultaEpoch: AGORA_S + D }),
      cartao({ id: 4, nome: 'Sem data', etapa: 'AGENDADO', consultaEpoch: null }),
      cartao({ id: 5, nome: 'Passou, mas já compareceu', etapa: 'COMPARECEU', consultaEpoch: AGORA_S - 3 * D }),
    ],
    ctx(),
  );
  assert.deepEqual(regras(r), ['consulta_passada']);
  assert.deepEqual(r.grupos[0].itens.map((i) => i.leadId), [1]);
  assert.equal(r.grupos[0].itens[0].oQueFazer, 'Marcar COMPARECEU ou NÃO COMPARECEU.');
});

test('Atendido ainda em AGENDADO ou EM QUALIFICAÇÃO: mover para COMPARECEU (e vence a regra da data passada)', () => {
  const r = conferir(
    [
      cartao({ id: 1, etapa: 'AGENDADO', situacao: 'Atendido', consultaEpoch: AGORA_S - 3 * D }),
      cartao({ id: 2, etapa: 'EM QUALIFICAÇÃO', situacao: 'Atendido' }),
      cartao({ id: 3, etapa: 'COMPARECEU', situacao: 'Atendido' }),
      cartao({ id: 4, etapa: 'EM NEGOCIAÇÃO', situacao: 'Atendido' }),
    ],
    ctx(),
  );
  assert.deepEqual(regras(r), ['atendido_fora']);
  assert.deepEqual(r.grupos[0].itens.map((i) => i.leadId).sort(), [1, 2]);
  assert.equal(r.grupos[0].itens[0].oQueFazer, 'Mover para COMPARECEU.');
});

test('Desmarcado fora de EM ESPERA/DESMARCOU/PERDIDO: o texto só cita a coluna que a conta TEM (Timbó sem DESMARCOU, Cerquilho com)', () => {
  const cartoes = [
    cartao({ id: 1, etapa: 'AGENDADO', situacao: 'Desmarcado' }),
    cartao({ id: 2, etapa: 'COMPARECEU', situacao: 'Desmarcado' }),
    cartao({ id: 3, etapa: 'EM ESPERA', situacao: 'Desmarcado', retomarEmEpoch: AGORA_S + D }),
    cartao({ id: 4, etapa: 'DESMARCOU', situacao: 'Desmarcado' }),
    cartao({ id: 5, etapa: 'PERDIDO', situacao: 'Desmarcado' }),
  ];
  const timbo = conferir(cartoes, ctx());
  assert.deepEqual(timbo.grupos[0].itens.map((i) => i.leadId).sort(), [1, 2]);
  assert.equal(timbo.grupos[0].itens[0].oQueFazer, 'Mover para EM ESPERA.');
  const cerquilho = conferir(cartoes, ctx({ etapasDaConta: ETAPAS_CERQUILHO }));
  assert.equal(cerquilho.grupos[0].itens[0].oQueFazer, 'Mover para EM ESPERA ou DESMARCOU.');
  assert.deepEqual(cerquilho.grupos[0].itens.map((i) => i.leadId).sort(), [1, 2]);
});

test('EM ESPERA sem ◷ Retomar em: preencher a data (com a data, não aparece)', () => {
  const r = conferir(
    [cartao({ id: 1, etapa: 'EM ESPERA' }), cartao({ id: 2, etapa: 'EM ESPERA', retomarEmEpoch: AGORA_S + 10 * D }), cartao({ id: 3, etapa: 'AGENDADO' })],
    ctx(),
  );
  assert.deepEqual(regras(r), ['espera_sem_data']);
  assert.deepEqual(r.grupos[0].itens.map((i) => i.leadId), [1]);
});

test('cartões vazios de EM QUALIFICAÇÃO: só o número e 5 exemplos; com campo, mexido há pouco ou com conversa não contam', () => {
  const vazios = Array.from({ length: 560 }, (_, i) => cartao({ id: 1000 + i, nome: `Lead #${1000 + i}`, etapa: 'EM QUALIFICAÇÃO', temCampo: false, atualizadoEpoch: AGORA_S - 30 * D }));
  const naoVazios = [
    cartao({ id: 1, etapa: 'EM QUALIFICAÇÃO', temCampo: true, atualizadoEpoch: AGORA_S - 30 * D }),
    cartao({ id: 2, etapa: 'EM QUALIFICAÇÃO', temCampo: false, atualizadoEpoch: AGORA_S - 6 * D }),
    cartao({ id: 3, etapa: 'Incoming leads', temCampo: false, atualizadoEpoch: AGORA_S - 30 * D }),
    cartao({ id: 4, etapa: 'EM QUALIFICAÇÃO', temCampo: false, atualizadoEpoch: AGORA_S - 30 * D }),
  ];
  const r = conferir([...vazios, ...naoVazios], ctx({ comConversaRecente: new Set([4]) }));
  assert.deepEqual(regras(r), ['cartao_vazio']);
  assert.equal(r.grupos[0].total, 560);
  assert.equal(r.grupos[0].itens.length, PRAZOS_DA_PAGINA_IA.maxExemplosVazios);
  assert.equal(r.total, 560);
  // o controller só consulta o banco para os candidatos (inclui o 4, que a conversa depois exclui)
  assert.equal(candidatosCartaoVazio([...vazios, ...naoVazios], AGORA).length, 561);
});

test('Conferir: cada cartão cai em uma regra só, lista longa é cortada mas o total é inteiro, só vale no funil COMERCIAL', () => {
  const muitos = Array.from({ length: 40 }, (_, i) => cartao({ id: 100 + i, etapa: 'EM ESPERA' }));
  const r = conferir(
    [
      ...muitos,
      cartao({ id: 1, etapa: 'AGENDADO', situacao: 'Desmarcado', consultaEpoch: AGORA_S - 5 * D }), // desmarcado vence a data passada
      cartao({ id: 2, etapa: 'EM TRATAMENTO', comercial: false, situacao: 'Desmarcado' }),
      cartao({ id: 3, etapa: 'EM ESPERA', comercial: false }),
    ],
    ctx(),
  );
  assert.deepEqual(regras(r), ['desmarcado_fora', 'espera_sem_data']);
  const espera = r.grupos.find((g) => g.regra === 'espera_sem_data')!;
  assert.equal(espera.total, 40);
  assert.equal(espera.itens.length, PRAZOS_DA_PAGINA_IA.maxPorGrupo);
  assert.equal(r.total, 41);
});

test('Conferir acha etapa e situação PELO NOME, sem acento e com maiúsculas diferentes (nada de id chumbado)', () => {
  const r = conferir([cartao({ id: 1, etapa: 'Em Qualificacao', situacao: 'ATENDIDO' }), cartao({ id: 2, etapa: 'em espera' })], ctx());
  assert.deepEqual(regras(r), ['atendido_fora', 'espera_sem_data']);
});

test('Conferir: os mais antigos primeiro', () => {
  const r = conferir(
    [
      cartao({ id: 1, etapa: 'AGENDADO', consultaEpoch: AGORA_S - 2 * D }),
      cartao({ id: 2, etapa: 'AGENDADO', consultaEpoch: AGORA_S - 9 * D }),
      cartao({ id: 3, etapa: 'AGENDADO', consultaEpoch: AGORA_S - 5 * D }),
    ],
    ctx(),
  );
  assert.deepEqual(r.grupos[0].itens.map((i) => i.leadId), [2, 3, 1]);
});

// ── colunas ──

test('contagem por coluna: funil COMERCIAL primeiro, na ordem do Kommo, 142/143 fora, coluna sem cartão aparece com 0', () => {
  const funis = [
    { id: 20, name: 'TRATAMENTO', statuses: [{ id: 21, name: 'EM TRATAMENTO', sort: 20 }, { id: 142, name: 'ALTA', sort: 10000 }] },
    { id: 10, name: 'COMERCIAL', statuses: [{ id: 12, name: 'AGENDADO', sort: 30 }, { id: 11, name: 'EM QUALIFICAÇÃO', sort: 20 }, { id: 142, name: 'GANHO / CONCLUÍDO', sort: 10000 }, { id: 143, name: 'PERDIDO', sort: 11000 }] },
    { id: 30, name: 'ANTIGO', is_archive: true, statuses: [{ id: 31, name: 'X', sort: 1 }] },
  ];
  const r = contarPorColuna(
    [
      { pipeline_id: 10, status_id: 11 }, { pipeline_id: 10, status_id: 11 }, { pipeline_id: 10, status_id: 12 }, { pipeline_id: 20, status_id: 21 },
    ],
    funis,
  );
  assert.deepEqual(r.map((f) => f.funil), ['COMERCIAL', 'TRATAMENTO']);
  assert.deepEqual(r[0].etapas, [{ nome: 'EM QUALIFICAÇÃO', total: 2 }, { nome: 'AGENDADO', total: 1 }]);
  assert.equal(r[0].total, 3);
  assert.deepEqual(r[1].etapas, [{ nome: 'EM TRATAMENTO', total: 1 }]);
  assert.deepEqual(etapasAbertas(funis), [
    { pipelineId: 20, statusId: 21 },
    { pipelineId: 10, statusId: 12 },
    { pipelineId: 10, statusId: 11 },
  ]);
});

// ── quem mudou a coluna ──

const USUARIOS = new Map([[12586363, 'Doutor Digital'], [15905863, 'Doutor Hérnia Timbó'], [777, 'Maria da Recepção']]);
const mud = (p: Partial<MudancaLida> = {}): MudancaLida => ({
  leadId: 5368768, nome: 'João Augusto 04/11/2026', por: 0, em: AGORA_S - 600,
  de: { pipelineId: 14523243, statusId: 112321351 }, para: { pipelineId: 14523243, statusId: 112321359 }, ...p,
});

test('autor: a Sofia é reconhecida pelo banco (mesmo cartão + mesma coluna + poucos segundos), mesmo com created_by 0', () => {
  const ia = [{ leadId: 5368768, statusId: 112321359, em: AGORA_S - 600 + 20 }];
  assert.deepEqual(autorDaMudanca(mud(), USUARIOS, ia), { tipo: 'ia', nome: 'Sofia (IA)' });
  // coluna diferente, cartão diferente ou 10 min de distância: NÃO é a Sofia
  assert.equal(autorDaMudanca(mud(), USUARIOS, [{ ...ia[0], statusId: 1 }]).tipo, 'robo');
  assert.equal(autorDaMudanca(mud(), USUARIOS, [{ ...ia[0], leadId: 1 }]).tipo, 'robo');
  assert.equal(autorDaMudanca(mud(), USUARIOS, [{ ...ia[0], em: AGORA_S }]).tipo, 'robo');
});

test('autor: 0 = robô automático; usuário com nome = equipe; login da consultoria separado; usuário removido não vira "robô"', () => {
  assert.equal(autorDaMudanca(mud(), USUARIOS, []).tipo, 'robo');
  assert.deepEqual(autorDaMudanca(mud({ por: 777 }), USUARIOS, []), { tipo: 'equipe', nome: 'Maria da Recepção' });
  assert.deepEqual(autorDaMudanca(mud({ por: 15905863 }), USUARIOS, []), { tipo: 'equipe', nome: 'Doutor Hérnia Timbó' });
  assert.equal(autorDaMudanca(mud({ por: 12586363 }), USUARIOS, []).tipo, 'consultoria');
  assert.equal(autorDaMudanca(mud({ por: 4242 }), USUARIOS, []).tipo, 'equipe');
  // se o token da Sofia for de um usuário da clínica, o par do banco ainda a reconhece
  assert.equal(autorDaMudanca(mud({ por: 15905863 }), USUARIOS, [{ leadId: 5368768, statusId: 112321359, em: AGORA_S - 590 }]).tipo, 'ia');
});

test('resumo das mudanças: contagem por tipo e por pessoa, lista com as 30 mais recentes (de → para → quem → hora)', () => {
  const nomes = new Map([[`14523243:112321351`, 'EM QUALIFICAÇÃO'], [`14523243:112321359`, 'AGENDADO']]);
  const mudancas: MudancaLida[] = [
    mud({ leadId: 1, por: 777, em: AGORA_S - 100 }),
    mud({ leadId: 2, por: 777, em: AGORA_S - 200 }),
    mud({ leadId: 3, por: 15905863, em: AGORA_S - 300 }),
    mud({ leadId: 4, por: 0, em: AGORA_S - 400, nome: null }),
    mud({ leadId: 5, por: 0, em: AGORA_S - 500 }),
    mud({ leadId: 6, por: 0, em: AGORA_S - 600, de: { pipelineId: 1, statusId: 2 } }),
    mud({ leadId: 7, por: 0, em: AGORA_S - 700, para: null }), // sem destino: não é mudança de coluna legível
  ];
  const r = resumirMudancas(mudancas, {
    usuarios: USUARIOS,
    movimentosDaIa: [{ leadId: 5, statusId: 112321359, em: AGORA_S - 500 }],
    nomeDaColuna: (p, s) => nomes.get(`${p}:${s}`) ?? null,
    tz: TZ,
  });
  assert.equal(r.total, 6);
  assert.deepEqual(r.porTipo.map((t) => [t.tipo, t.total]), [['equipe', 3], ['ia', 1], ['robo', 2]]);
  assert.deepEqual(r.pessoas, [{ nome: 'Maria da Recepção', total: 2 }, { nome: 'Doutor Hérnia Timbó', total: 1 }]);
  assert.deepEqual(r.lista.map((l) => l.leadId), [1, 2, 3, 4, 5, 6]);
  assert.equal(r.lista[0].de, 'EM QUALIFICAÇÃO');
  assert.equal(r.lista[0].para, 'AGENDADO');
  assert.equal(r.lista[0].quem, 'Maria da Recepção');
  assert.equal(r.lista[3].paciente, 'Cartão 4');
  assert.equal(r.lista[4].quem, 'Sofia (IA)');
  assert.equal(r.lista[5].de, 'coluna removida');
  assert.match(r.lista[0].hora, /^\d{2}:\d{2}$/);

  const cem = Array.from({ length: 100 }, (_, i) => mud({ leadId: 100 + i, por: 777, em: AGORA_S - i }));
  const longa = resumirMudancas(cem, { usuarios: USUARIOS, movimentosDaIa: [], nomeDaColuna: () => null, tz: TZ });
  assert.equal(longa.total, 100);
  assert.equal(longa.lista.length, PRAZOS_DA_PAGINA_IA.maxMudancasNaLista);
  assert.equal(longa.lista[0].leadId, 100);
});

// ── cache: a página não pode deixar a Sofia lenta ──

test('cache: dentro de 5 min é UMA leitura só; passou o prazo, lê de novo', async () => {
  let relogio = 1_000_000;
  let leituras = 0;
  const cache = new CacheQueAguentaFalha<number>(5 * 60_000, 60_000, () => relogio);
  const ler = async () => ++leituras;
  assert.equal((await cache.obter('timbosc', ler)).ok, true);
  relogio += 4 * 60_000;
  const r2 = await cache.obter('timbosc', ler);
  assert.equal(leituras, 1);
  assert.equal(r2.ok && r2.valor, 1);
  relogio += 61_000;
  const r3 = await cache.obter('timbosc', ler);
  assert.equal(leituras, 2);
  assert.equal(r3.ok && r3.valor, 2);
  // outra conta tem a sua própria leitura
  await cache.obter('drherniacerquilho', ler);
  assert.equal(leituras, 3);
});

test('cache: vários pedidos juntos viram UMA ida ao Kommo', async () => {
  let leituras = 0;
  const cache = new CacheQueAguentaFalha<number>(300_000, 60_000);
  const ler = async () => {
    leituras++;
    await new Promise((r) => setTimeout(r, 20));
    return 7;
  };
  const rs = await Promise.all([cache.obter('c', ler), cache.obter('c', ler), cache.obter('c', ler)]);
  assert.equal(leituras, 1);
  assert.ok(rs.every((r) => r.ok && r.valor === 7));
});

test('cache: o Kommo falhou — não pergunta de novo por 60 s, e a última leitura boa continua na tela marcada como antiga', async () => {
  let relogio = 0;
  let leituras = 0;
  let falha = false;
  const cache = new CacheQueAguentaFalha<string>(300_000, 60_000, () => relogio);
  const ler = async () => {
    leituras++;
    if (falha) throw new Error('403 Forbidden');
    return 'colunas de 14:00';
  };
  await cache.obter('c', ler);
  relogio += 301_000;
  falha = true;
  const r = await cache.obter('c', ler);
  assert.deepEqual(r.ok && r.desatualizado, true);
  assert.equal(r.ok && r.valor, 'colunas de 14:00');
  // 5 toques no botão "Atualizar" em 30 s: nenhuma chamada nova ao Kommo
  relogio += 30_000;
  for (let i = 0; i < 5; i++) await cache.obter('c', ler);
  assert.equal(leituras, 2);
  // depois de 60 s tenta de novo; voltou: leitura nova, sem aviso
  relogio += 31_000;
  falha = false;
  const volta = await cache.obter('c', ler);
  assert.equal(leituras, 3);
  assert.equal(volta.ok && volta.desatualizado, false);
});

test('cache: sem nenhuma leitura boa e o Kommo fora, devolve ok:false (a página mostra "indisponível") e protege por 60 s', async () => {
  let relogio = 0;
  let leituras = 0;
  const cache = new CacheQueAguentaFalha<string>(300_000, 60_000, () => relogio);
  const ler = async () => {
    leituras++;
    throw new Error('timeout');
  };
  const a = await cache.obter('c', ler);
  assert.equal(a.ok, false);
  await cache.obter('c', ler);
  relogio += 59_000;
  await cache.obter('c', ler);
  assert.equal(leituras, 1);
  relogio += 2_000;
  await cache.obter('c', ler);
  assert.equal(leituras, 2);
});

test('cache: leitura incompleta vale menos (ttlDoValor)', async () => {
  let relogio = 0;
  let leituras = 0;
  const cache = new CacheQueAguentaFalha<{ incompleto: boolean }>(300_000, 60_000, () => relogio);
  const ler = async () => ({ incompleto: ++leituras === 1 });
  const ttl = (v: { incompleto: boolean }) => (v.incompleto ? 60_000 : 300_000);
  await cache.obter('c', ler, ttl);
  relogio += 61_000;
  await cache.obter('c', ler, ttl);
  assert.equal(leituras, 2);
  relogio += 120_000;
  await cache.obter('c', ler, ttl);
  assert.equal(leituras, 2);
});

test('fila de um: as montagens do Kommo rodam uma de cada vez, e uma que falha não trava a seguinte', async () => {
  const fila = criarFilaDeUm();
  const ordem: string[] = [];
  const t = (nome: string, ms: number, falha = false) => () =>
    new Promise<string>((resolve, reject) => {
      ordem.push(`começa ${nome}`);
      setTimeout(() => {
        ordem.push(`termina ${nome}`);
        falha ? reject(new Error(nome)) : resolve(nome);
      }, ms);
    });
  const [a, b, c] = await Promise.allSettled([fila(t('timbo', 30)), fila(t('cerquilho', 5, true)), fila(t('serra', 5))]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'rejected');
  assert.equal(c.status, 'fulfilled');
  assert.deepEqual(ordem, ['começa timbo', 'termina timbo', 'começa cerquilho', 'termina cerquilho', 'começa serra', 'termina serra']);
});

// ── a porta (código da unidade) ──

test('código da unidade: igual passa, diferente/vazio/sem código cadastrado não', () => {
  assert.equal(codigoConfere('482913', '482913'), true);
  assert.equal(codigoConfere('482913', ' 482913 '), true);
  assert.equal(codigoConfere('482913', '482914'), false);
  assert.equal(codigoConfere('482913', ''), false);
  assert.equal(codigoConfere('482913', undefined), false);
  assert.equal(codigoConfere('482913', '482913      lixo'), false, 'não corta a entrada em 12 caracteres');
  assert.equal(codigoConfere(null, ''), false, 'unidade sem código nunca abre (Cerquilho hoje)');
});

test('limite: só ERRO conta; 12 erros bloqueiam; acertar zera; outro ip não é afetado; a janela de 10 min vence', () => {
  let t = 0;
  const lim = criarLimiteDeTentativas(() => t);
  assert.equal(lim.bloqueado('ip:slug'), false, 'consultar não conta');
  for (let i = 0; i < 11; i++) lim.registrarErro('ip:slug');
  assert.equal(lim.bloqueado('ip:slug'), false);
  lim.registrarErro('ip:slug');
  assert.equal(lim.bloqueado('ip:slug'), true);
  assert.equal(lim.bloqueado('outro-ip:slug'), false);
  t += 11 * 60_000;
  assert.equal(lim.bloqueado('ip:slug'), false, 'a janela de 10 min passou');
  for (let i = 0; i < 12; i++) lim.registrarErro('ip:slug');
  lim.limpar('ip:slug');
  assert.equal(lim.bloqueado('ip:slug'), false, 'acertar o código zera');
});

test('limite: milhares de chaves de OUTRAS unidades não zeram o contador de quem está sendo adivinhado (só saem as vencidas)', () => {
  let t = 0;
  const lim = criarLimiteDeTentativas(() => t, 100);
  for (let i = 0; i < 12; i++) lim.registrarErro('ip:doutor-hernia-timbo');
  assert.equal(lim.bloqueado('ip:doutor-hernia-timbo'), true);
  // 5x o teto de chaves, todas dentro da janela: o mapa não passa do teto
  for (let i = 0; i < 500; i++) {
    t += 10;
    lim.registrarErro(`ip:inventado-${i}`);
  }
  assert.ok(lim.tamanho() <= 100);
  // chaves vencidas saem primeiro: a da unidade real (mais antiga) só sai se não houver vencida, e aqui a janela ainda vale
  // (a Timbó foi a primeira a entrar: com o teto cheio de chaves vivas a mais antiga é a que sai — por isso o controller
  // NÃO registra slug que não existe; o teste abaixo cobre o caso real)
  const lim2 = criarLimiteDeTentativas(() => t, 100);
  for (let i = 0; i < 12; i++) lim2.registrarErro('ip:doutor-hernia-timbo');
  for (let i = 0; i < 5000; i++) {
    // slugs inventados dão 404 no controller e nunca chegam ao limite; aqui só consultamos, como ele faz
    lim2.bloqueado(`ip:inventado-${i}`);
  }
  assert.equal(lim2.tamanho(), 1);
  assert.equal(lim2.bloqueado('ip:doutor-hernia-timbo'), true, 'o contador da unidade real continua');
  // vencidas saem antes das vivas
  const lim3 = criarLimiteDeTentativas(() => t, 3);
  lim3.registrarErro('velha-1');
  lim3.registrarErro('velha-2');
  t += 11 * 60_000;
  lim3.registrarErro('viva-1');
  lim3.registrarErro('viva-2');
  lim3.registrarErro('viva-3');
  assert.equal(lim3.tamanho(), 3);
});
