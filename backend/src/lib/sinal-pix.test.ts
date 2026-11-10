/**
 * Geração do link do sinal (lib/sinal-pix.ts): corpo enviado ao Asaas, idempotência POR CLÍNICA (comercial e Resgate dividem cartão e conta),
 * sinal amarrado à CONSULTA (e à remarcação dela), teto por dia, falhas sem derrubar a resposta, Asaas fora da trava. Sem banco e sem rede.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErroAsaas } from './integracoes/asaas.js';
import { unidadeDona } from '../agent/rede-doutor-hernia.js';
import {
  acompanharRemarcacao,
  gerarSinalPix,
  instanteLocal,
  nomeDaClinica,
  TETO_LINKS_POR_UNIDADE_DIA,
  urlDoAsaasValida,
  validadeDoLink,
  type BancoDoSinal,
  type DepsDoSinal,
  type LinhaDoSinal,
} from './sinal-pix.js';

const UNIT = { id: 'u1', slug: 'doutor-hernia-araguaina', name: 'Araguaína', sinalPixCentavos: 5000, spineTimezone: 'America/Sao_Paulo' };
const RESGATE = { id: 'u2', slug: 'araguaina-resgate', name: 'Araguaína - Resgate', sinalPixCentavos: 5000, spineTimezone: 'America/Sao_Paulo' };
const AGORA = new Date('2026-11-10T15:00:00Z'); // 12h em São Paulo, dia 10/11
const CONSULTA = '2026-11-14T09:00';

const linha = (over: Partial<LinhaDoSinal> = {}): LinhaDoSinal => ({
  id: 'x', unitId: 'u1', clinica: 'doutor-hernia-araguaina', leadId: '1', linkId: 'L', url: 'https://www.asaas.com/c/L', valorCentavos: 5000, venceEm: '2026-11-13',
  consultaEm: CONSULTA, status: 'pendente', paymentId: null, criadoEm: new Date('2026-11-09T12:00:00Z'), pagoEm: null, avisadoEm: null, ...over,
});

function bancoFalso(linhas: LinhaDoSinal[] = []) {
  const rows: LinhaDoSinal[] = [...linhas];
  let n = 0;
  const banco: BancoDoSinal = {
    findMany: async ({ where }) =>
      rows.filter((l) => l.clinica === where.clinica && l.leadId === where.leadId && where.status.in.includes(l.status) && l.criadoEm >= where.criadoEm.gte).sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime()),
    count: async ({ where }) => rows.filter((l) => l.clinica === where.clinica && l.criadoEm >= where.criadoEm.gte).length,
    create: async ({ data }) => {
      const l: LinhaDoSinal = { id: `s${++n}`, paymentId: null, status: 'pendente', criadoEm: AGORA, pagoEm: null, avisadoEm: null, ...data };
      rows.push(l);
      return l;
    },
    updateMany: async ({ where, data }) => {
      const l = rows.find((r) => r.id === where.id);
      if (l) Object.assign(l, data);
      return { count: l ? 1 : 0 };
    },
    deleteMany: async ({ where }) => {
      const i = rows.findIndex((r) => r.id === where.id);
      if (i >= 0) rows.splice(i, 1);
      return { count: i >= 0 ? 1 : 0 };
    },
  };
  return { banco, rows };
}

function asaasFalso(resposta: unknown | Error = { id: '725104409743', url: 'https://www.asaas.com/c/725104409743' }) {
  const chamadas: Array<{ metodo: string; caminho: string; corpo: Record<string, unknown> | undefined; chave: string; dentroDaTrava: boolean }> = [];
  const estado = { dentroDaTrava: false };
  const escrever = (async (_conta: string, chave: string, metodo: string, caminho: string, corpo?: Record<string, unknown>) => {
    chamadas.push({ metodo, caminho, corpo, chave, dentroDaTrava: estado.dentroDaTrava });
    if (resposta instanceof Error) throw resposta;
    return resposta;
  }) as unknown as DepsDoSinal['escrever'];
  return { escrever, chamadas, estado };
}

function deps(over: Partial<DepsDoSinal> = {}): DepsDoSinal {
  return {
    banco: bancoFalso().banco,
    chave: async () => ({ unitId: 'u1', slug: UNIT.slug, chave: '$aact_chave_secreta_de_teste_0000000000' }),
    escrever: asaasFalso().escrever,
    agora: () => AGORA,
    esperar: async () => undefined,
    ...over,
  };
}

test('cria o link PIX de R$ 50, uso único, até a véspera da consulta, com a referência da Sofia — e só POST /paymentLinks', async () => {
  const f = asaasFalso();
  const { banco, rows } = bancoFalso();
  const r = await gerarSinalPix(UNIT, 28000001, CONSULTA, deps({ escrever: f.escrever, banco }));
  assert.deepEqual(r, { tipo: 'link', url: 'https://www.asaas.com/c/725104409743', novo: true, valor: 50, venceEm: '2026-11-13', registrado: true });
  assert.equal(f.chamadas.length, 1);
  assert.equal(f.chamadas[0]!.metodo, 'POST');
  assert.equal(f.chamadas[0]!.caminho, '/paymentLinks');
  assert.deepEqual(f.chamadas[0]!.corpo, {
    name: 'Sinal consulta Doutor Hérnia Araguaína',
    description: 'Sinal de R$ 50,00 para garantir a consulta (o restante é pago na clínica, no dia).',
    billingType: 'PIX',
    chargeType: 'DETACHED',
    value: 50,
    limit: 1,
    endDate: '2026-11-13',
    externalReference: 'sofia-sinal:doutor-hernia-araguaina:28000001',
    notificationEnabled: false,
  });
  // uma linha só: a reserva virou o link
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.linkId, '725104409743');
  assert.equal(rows[0]!.status, 'pendente');
  assert.equal(rows[0]!.valorCentavos, 5000);
  assert.equal(rows[0]!.clinica, 'doutor-hernia-araguaina');
  assert.equal(rows[0]!.consultaEm, CONSULTA);
});

test('a chamada ao Asaas acontece FORA da trava (a transação do banco não fica aberta durante os 30 s do Asaas)', async () => {
  const f = asaasFalso();
  await gerarSinalPix(UNIT, 1, CONSULTA, deps({
    escrever: f.escrever,
    travar: async (_c, fn) => {
      f.estado.dentroDaTrava = true;
      try {
        return await fn(bancoDaTrava);
      } finally {
        f.estado.dentroDaTrava = false;
      }
    },
  }));
  assert.equal(f.chamadas.length, 1);
  assert.equal(f.chamadas[0]!.dentroDaTrava, false);
});
const bancoDaTrava = bancoFalso().banco;

test('idempotência: pedir de novo devolve o MESMO link e não chama o Asaas; duas chamadas ao mesmo tempo criam um só', async () => {
  const f = asaasFalso();
  const { banco, rows } = bancoFalso();
  const d = deps({ escrever: f.escrever, banco });
  const [a, b] = await Promise.all([gerarSinalPix(UNIT, 1, CONSULTA, d), gerarSinalPix(UNIT, 1, CONSULTA, d)]);
  const links = [a, b].filter((x) => x.tipo === 'link');
  assert.equal(links.length, 2);
  assert.equal(links.filter((x) => x.tipo === 'link' && x.novo).length, 1);
  assert.equal(a.tipo === 'link' && b.tipo === 'link' && a.url === b.url, true);
  const c = await gerarSinalPix(UNIT, 1, CONSULTA, d);
  assert.equal(c.tipo === 'link' && c.novo, false);
  assert.equal(f.chamadas.length, 1, 'nunca um segundo link');
  assert.equal(rows.length, 1);
  await gerarSinalPix(UNIT, 2, CONSULTA, d); // outro paciente tem o seu
  assert.equal(f.chamadas.length, 2);
});

test('COMERCIAL e RESGATE dividem o cartão e a conta Asaas: o sinal é da clínica — o 2º lado reaproveita o link, vê "já pago" e divide o teto', async () => {
  const f = asaasFalso();
  const { banco, rows } = bancoFalso();
  const d = deps({ escrever: f.escrever, banco });
  const a = await gerarSinalPix(RESGATE, 5, CONSULTA, d);
  assert.equal(a.tipo === 'link' && a.novo, true);
  assert.equal(rows[0]!.clinica, 'doutor-hernia-araguaina');
  assert.equal(rows[0]!.unitId, 'u2', 'quem gerou fica registrado');
  const b = await gerarSinalPix(UNIT, 5, CONSULTA, d);
  assert.equal(b.tipo === 'link' && b.novo, false);
  assert.equal(b.tipo === 'link' && a.tipo === 'link' && b.url === a.url, true);
  assert.equal(f.chamadas.length, 1, 'o segundo link não nasce');
  // já pago por um lado: o outro não cobra de novo
  rows[0]!.status = 'pago';
  assert.deepEqual(await gerarSinalPix(UNIT, 5, CONSULTA, d), { tipo: 'ja-pago' });
  assert.deepEqual(await gerarSinalPix(RESGATE, 5, CONSULTA, d), { tipo: 'ja-pago' });
  assert.equal(f.chamadas.length, 1);
  assert.equal(unidadeDona('araguaina-resgate'), 'doutor-hernia-araguaina');
});

test('sinal já pago da MESMA consulta: "já pago"; da consulta que já passou (compareceu ou faltou) e consulta nova: SINAL NOVO', async () => {
  const f = asaasFalso({ id: '2', url: 'https://www.asaas.com/c/2' });
  const pagoDaConsultaAtual = linha({ status: 'pago', paymentId: 'pay_1' });
  assert.deepEqual(await gerarSinalPix(UNIT, 1, CONSULTA, deps({ escrever: f.escrever, banco: bancoFalso([pagoDaConsultaAtual]).banco })), { tipo: 'ja-pago' });
  assert.equal(f.chamadas.length, 0);
  // o pago era de uma consulta de 05/11 (já passou): a consulta nova de 14/11 pede sinal novo
  const pagoDeConsultaPassada = linha({ status: 'pago', paymentId: 'pay_0', consultaEm: '2026-11-05T09:00', criadoEm: new Date('2026-11-01T12:00:00Z') });
  const r = await gerarSinalPix(UNIT, 1, CONSULTA, deps({ escrever: f.escrever, banco: bancoFalso([pagoDeConsultaPassada]).banco }));
  assert.equal(r.tipo === 'link' && r.novo, true);
  assert.equal(f.chamadas.length, 1);
  // consulta de HOJE ainda não passou (12:00 agora, consulta 18:00): continua valendo; às 18:01 já não
  const hoje = linha({ status: 'pago', consultaEm: '2026-11-10T18:00' });
  assert.deepEqual(await gerarSinalPix(UNIT, 1, '2026-11-10T18:00', deps({ escrever: f.escrever, banco: bancoFalso([hoje]).banco })), { tipo: 'ja-pago' });
  const depois = await gerarSinalPix(UNIT, 1, '2026-11-12T09:00', deps({ escrever: asaasFalso({ id: '3', url: 'https://www.asaas.com/c/3' }).escrever, banco: bancoFalso([hoje]).banco, agora: () => new Date('2026-11-10T21:30:00Z') }));
  assert.equal(depois.tipo === 'link' && depois.novo, true);
});

test('REMARCAÇÃO mantém o sinal: a data do sinal acompanha a consulta e "já pago"/link continuam valendo; consulta que já passou não é movida', async () => {
  const { banco, rows } = bancoFalso([linha({ status: 'pago', id: 'a' }), linha({ id: 'b', leadId: '9', consultaEm: '2026-11-05T09:00', status: 'pago', criadoEm: new Date('2026-11-01T12:00:00Z') })]);
  assert.equal(await acompanharRemarcacao(UNIT, 1, '2026-11-20T10:00', banco, AGORA), 1);
  assert.equal(rows.find((r) => r.id === 'a')!.consultaEm, '2026-11-20T10:00');
  // a de 05/11 (já passou) é de outra consulta: remarcar não a ressuscita
  assert.equal(await acompanharRemarcacao(UNIT, 9, '2026-11-20T10:00', banco, AGORA), 0);
  assert.equal(rows.find((r) => r.id === 'b')!.consultaEm, '2026-11-05T09:00');
  // depois da remarcação, o sinal vale para a data nova (mais de 10 dias depois da original, ainda "já pago")
  const f = asaasFalso();
  assert.deepEqual(await gerarSinalPix(UNIT, 1, '2026-11-20T10:00', deps({ escrever: f.escrever, banco })), { tipo: 'ja-pago' });
  assert.equal(f.chamadas.length, 0);
});

test('link pendente que ainda vale é SEMPRE reaproveitado (mesmo que acabe antes de uma consulta remarcada); vencido, não', async () => {
  const f = asaasFalso({ id: '3', url: 'https://www.asaas.com/c/3' });
  const curto = linha({ id: 'c', venceEm: '2026-11-11', url: 'https://www.asaas.com/c/curto', consultaEm: '2026-11-20T10:00' });
  const r = await gerarSinalPix(UNIT, 1, '2026-11-20T10:00', deps({ escrever: f.escrever, banco: bancoFalso([curto]).banco }));
  assert.equal(r.tipo === 'link' && r.novo, false);
  assert.equal(r.tipo === 'link' && r.url, 'https://www.asaas.com/c/curto');
  assert.equal(f.chamadas.length, 0);
  const velho = linha({ id: 'v', venceEm: '2026-11-09' });
  const r2 = await gerarSinalPix(UNIT, 1, CONSULTA, deps({ escrever: f.escrever, banco: bancoFalso([velho]).banco }));
  assert.equal(r2.tipo === 'link' && r2.novo, true);
});

test('reserva de outra geração: espera e reaproveita o link dela; reserva velha (processo que caiu) é ignorada; sem fim, "em andamento"', async () => {
  const f = asaasFalso({ id: '9', url: 'https://www.asaas.com/c/9' });
  const reserva = linha({ id: 'r', status: 'criando', linkId: 'reserva:x', url: '', criadoEm: AGORA });
  const { banco, rows } = bancoFalso([reserva]);
  let esperas = 0;
  // a outra geração termina na 3ª espera
  const esperar = async () => { if (++esperas === 3) Object.assign(rows[0]!, { status: 'pendente', linkId: 'OUTRA', url: 'https://www.asaas.com/c/outra' }); };
  const r = await gerarSinalPix(UNIT, 1, CONSULTA, deps({ escrever: f.escrever, banco, esperar }));
  assert.equal(r.tipo === 'link' && r.url, 'https://www.asaas.com/c/outra');
  assert.equal(f.chamadas.length, 0);
  // reserva de 5 min atrás: ninguém a está executando
  const velha = linha({ id: 'rv', status: 'criando', linkId: 'reserva:y', url: '', criadoEm: new Date(AGORA.getTime() - 5 * 60_000) });
  const r2 = await gerarSinalPix(UNIT, 1, CONSULTA, deps({ escrever: f.escrever, banco: bancoFalso([velha]).banco }));
  assert.equal(r2.tipo === 'link' && r2.novo, true);
  // nunca termina
  const presa = bancoFalso([linha({ id: 'rp', status: 'criando', linkId: 'reserva:z', url: '', criadoEm: AGORA })]).banco;
  const r3 = await gerarSinalPix(UNIT, 1, CONSULTA, deps({ escrever: f.escrever, banco: presa }));
  assert.equal(r3.tipo === 'falhou' && r3.motivo, 'em-andamento');
});

test('teto POR CLÍNICA: no limite não cria mais link (conta também o que o outro lado gerou); reaproveitar não gasta o teto', async () => {
  const f = asaasFalso();
  const cheios: LinhaDoSinal[] = Array.from({ length: TETO_LINKS_POR_UNIDADE_DIA }, (_, i) => linha({ id: `c${i}`, unitId: i % 2 ? 'u2' : 'u1', leadId: `outro${i}`, linkId: `L${i}`, criadoEm: new Date('2026-11-10T10:00:00Z') }));
  const r = await gerarSinalPix(UNIT, 999, CONSULTA, deps({ escrever: f.escrever, banco: bancoFalso(cheios).banco }));
  assert.equal(r.tipo === 'falhou' && r.motivo, 'teto');
  assert.equal(f.chamadas.length, 0);
  const dele = bancoFalso([...cheios, linha({ id: 'meu', leadId: '999', linkId: 'MEU', url: 'https://www.asaas.com/c/meu', criadoEm: new Date('2026-11-10T10:00:00Z') })]).banco;
  const r2 = await gerarSinalPix(UNIT, 999, CONSULTA, deps({ escrever: f.escrever, banco: dele }));
  assert.equal(r2.tipo === 'link' && r2.url, 'https://www.asaas.com/c/meu');
});

test('falha do Asaas (401, 403, timeout, resposta ruim) e unidade sem chave NUNCA lançam, nada fica gravado e a reserva é largada', async () => {
  for (const erro of [new ErroAsaas('o Asaas recusou a chave (401)', 401), new ErroAsaas('o Asaas negou a gravação (403)', 403), new ErroAsaas('sem resposta do Asaas em /paymentLinks', null)]) {
    const { banco, rows } = bancoFalso();
    const r = await gerarSinalPix(UNIT, 1, CONSULTA, deps({ escrever: asaasFalso(erro).escrever, banco }));
    assert.equal(r.tipo === 'falhou' && r.motivo, 'asaas');
    assert.equal(rows.length, 0);
  }
  for (const resposta of [{ id: '1' }, { id: '1', url: 'http://www.asaas.com/c/1' }, { id: '1', url: 'https://evil.example.com/c/1' }, { url: 'https://www.asaas.com/c/1' }, null]) {
    const { banco, rows } = bancoFalso();
    const r = await gerarSinalPix(UNIT, 1, CONSULTA, deps({ escrever: asaasFalso(resposta).escrever, banco }));
    assert.equal(r.tipo, 'falhou', JSON.stringify(resposta));
    assert.equal(rows.length, 0);
  }
  const f = asaasFalso();
  const { banco, rows } = bancoFalso();
  const semChave = await gerarSinalPix(UNIT, 1, CONSULTA, deps({ escrever: f.escrever, banco, chave: async () => null }));
  assert.equal(semChave.tipo === 'falhou' && semChave.motivo, 'sem-chave');
  assert.equal(f.chamadas.length, 0);
  assert.equal(rows.length, 0);
  const r = await gerarSinalPix(UNIT, 1, CONSULTA, deps({ escrever: asaasFalso(new ErroAsaas('erro', 500)).escrever }));
  assert.ok(!JSON.stringify(r).includes('aact'));
});

test('link criado no Asaas mas banco falhou ao gravar: devolve o link (o paciente pode pagar) marcado como NÃO registrado, para a equipe conferir', async () => {
  const b = bancoFalso();
  const banco: BancoDoSinal = { ...b.banco, updateMany: async () => { throw new Error('banco fora'); } };
  const r = await gerarSinalPix(UNIT, 1, CONSULTA, deps({ banco }));
  assert.equal(r.tipo === 'link' && r.url, 'https://www.asaas.com/c/725104409743');
  assert.equal(r.tipo === 'link' && r.registrado, false);
});

test('fuso inválido na unidade não derruba a geração (cai no de São Paulo)', async () => {
  const r = await gerarSinalPix({ ...UNIT, spineTimezone: 'Nao/Existe' }, 1, CONSULTA, deps());
  assert.equal(r.tipo, 'link');
});

test('unidade sem sinal configurado nunca chama o Asaas', async () => {
  const f = asaasFalso();
  const r = await gerarSinalPix({ ...UNIT, sinalPixCentavos: null }, 1, CONSULTA, deps({ escrever: f.escrever }));
  assert.equal(r.tipo, 'falhou');
  assert.equal(f.chamadas.length, 0);
});

test('instanteLocal: "AAAA-MM-DDTHH:mm" no relógio da unidade, comparável como texto com agendadoPara', () => {
  assert.equal(instanteLocal(AGORA, 'America/Sao_Paulo'), '2026-11-10T12:00');
  assert.equal(instanteLocal(AGORA, 'America/Manaus'), '2026-11-10T11:00');
  assert.ok('2026-11-10T11:59' < instanteLocal(AGORA, 'America/Sao_Paulo') && '2026-11-10T12:01' > instanteLocal(AGORA, 'America/Sao_Paulo'));
});

test('validadeDoLink: véspera da consulta, nunca antes de hoje nem além de 60 dias; sem data, 3 dias', () => {
  assert.equal(validadeDoLink('2026-11-10', '2026-11-14'), '2026-11-13');
  assert.equal(validadeDoLink('2026-11-10', '2026-11-11'), '2026-11-10');
  assert.equal(validadeDoLink('2026-11-10', '2026-11-10'), '2026-11-10');
  assert.equal(validadeDoLink('2026-11-10', '2026-11-01'), '2026-11-10');
  assert.equal(validadeDoLink('2026-11-10', '2027-06-01'), '2027-01-09');
  assert.equal(validadeDoLink('2026-11-10', null), '2026-11-13');
  assert.equal(validadeDoLink('2026-11-10', 'lixo'), '2026-11-13');
});

test('urlDoAsaasValida: só https no domínio do Asaas', () => {
  assert.equal(urlDoAsaasValida('https://www.asaas.com/c/1'), true);
  assert.equal(urlDoAsaasValida('https://sandbox.asaas.com/c/1'), true);
  for (const ruim of ['http://www.asaas.com/c/1', 'https://asaas.com.evil.io/c/1', 'https://evil.io/asaas.com', 'javascript:alert(1)', '', null, 7]) assert.equal(urlDoAsaasValida(ruim), false, String(ruim));
});

test('as 6 unidades Resgate apontam para a clínica dona (a chave do Asaas é da clínica) e as outras para si mesmas', () => {
  const esperado: Record<string, string> = {
    'acailandia-resgate': 'doutor-hernia-acailandia',
    'araguaina-resgate': 'doutor-hernia-araguaina',
    'balsas-resgate': 'doutor-hernia-balsas',
    'canaa-resgate': 'doutor-hernia-canaa',
    'maraba-resgate': 'doutor-hernia-maraba',
    'porto-resgate': 'doutor-hernia-porto',
  };
  for (const [resgate, dona] of Object.entries(esperado)) assert.equal(unidadeDona(resgate), dona, resgate);
  for (const s of ['doutor-hernia-araguaina', 'doutor-hernia-imperatriz', 'hm-tecnologia', 'default']) assert.equal(unidadeDona(s), s);
});

test('nomeDaClinica: o título do link não repete "Doutor Hérnia" nem carrega "Resgate"', () => {
  assert.equal(nomeDaClinica('Doutor Hérnia Araguaína'), 'Araguaína');
  assert.equal(nomeDaClinica('Araguaína - Resgate'), 'Araguaína');
  assert.equal(nomeDaClinica('Doutor Hérnia - Marabá'), 'Marabá');
  assert.equal(nomeDaClinica('Balsas'), 'Balsas');
});
