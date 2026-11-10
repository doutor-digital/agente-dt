/**
 * Geração do link do sinal (lib/sinal-pix.ts): corpo enviado ao Asaas, idempotência, teto por dia, falhas sem derrubar a resposta e a
 * validade do link. Sem banco e sem rede: o banco e o Asaas são falsos.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ErroAsaas } from './integracoes/asaas.js';
import { unidadeDona } from '../agent/rede-doutor-hernia.js';
import { gerarSinalPix, nomeDaClinica, TETO_LINKS_POR_UNIDADE_DIA, urlDoAsaasValida, validadeDoLink, type BancoDoSinal, type DepsDoSinal, type LinhaDoSinal } from './sinal-pix.js';

const UNIT = { id: 'u1', slug: 'doutor-hernia-araguaina', name: 'Araguaína', sinalPixCentavos: 5000, spineTimezone: 'America/Sao_Paulo' };
const AGORA = new Date('2026-11-10T15:00:00Z'); // 12h em São Paulo, dia 10/11
const CONSULTA = '2026-11-14';

function bancoFalso(linhas: LinhaDoSinal[] = []) {
  const criados: LinhaDoSinal[] = [...linhas];
  let n = 0;
  const banco: BancoDoSinal = {
    findFirst: async ({ where }) =>
      criados
        .filter((l) => l.unitId === where.unitId && l.leadId === where.leadId && where.status.in.includes(l.status) && l.criadoEm >= where.criadoEm.gte)
        .sort((a, b) => b.criadoEm.getTime() - a.criadoEm.getTime())[0] ?? null,
    count: async ({ where }) => criados.filter((l) => l.unitId === where.unitId && l.criadoEm >= where.criadoEm.gte).length,
    create: async ({ data }) => {
      const l: LinhaDoSinal = { id: `s${++n}`, paymentId: null, status: 'pendente', criadoEm: AGORA, pagoEm: null, avisadoEm: null, ...data };
      criados.push(l);
      return l;
    },
  };
  return { banco, criados };
}

function asaasFalso(resposta: unknown | Error = { id: '725104409743', url: 'https://www.asaas.com/c/725104409743' }) {
  const chamadas: Array<{ metodo: string; caminho: string; corpo: Record<string, unknown> | undefined; chave: string }> = [];
  const escrever = (async (_conta: string, chave: string, metodo: string, caminho: string, corpo?: Record<string, unknown>) => {
    chamadas.push({ metodo, caminho, corpo, chave });
    if (resposta instanceof Error) throw resposta;
    return resposta;
  }) as unknown as DepsDoSinal['escrever'];
  return { escrever, chamadas };
}

function deps(over: Partial<DepsDoSinal> & { banco?: BancoDoSinal } = {}): DepsDoSinal {
  return {
    banco: bancoFalso().banco,
    chave: async () => ({ unitId: 'u1', slug: UNIT.slug, chave: '$aact_chave_secreta_de_teste_0000000000' }),
    escrever: asaasFalso().escrever,
    agora: () => AGORA,
    ...over,
  };
}

test('cria o link PIX de R$ 50, uso único, até a véspera da consulta, com a referência da Sofia — e só POST /paymentLinks', async () => {
  const f = asaasFalso();
  const { banco, criados } = bancoFalso();
  const r = await gerarSinalPix(UNIT, 28000001, CONSULTA, deps({ escrever: f.escrever, banco }));
  assert.deepEqual(r, { tipo: 'link', url: 'https://www.asaas.com/c/725104409743', novo: true, valor: 50, venceEm: '2026-11-13' });
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
  assert.equal(criados.length, 1);
  assert.equal(criados[0]!.linkId, '725104409743');
  assert.equal(criados[0]!.valorCentavos, 5000);
});

test('idempotência: pedir de novo devolve o MESMO link e não chama o Asaas; duas chamadas ao mesmo tempo criam um só', async () => {
  const f = asaasFalso();
  const { banco, criados } = bancoFalso();
  const d = deps({ escrever: f.escrever, banco });
  const [a, b] = await Promise.all([gerarSinalPix(UNIT, 1, CONSULTA, d), gerarSinalPix(UNIT, 1, CONSULTA, d)]);
  assert.equal(a.tipo === 'link' && a.novo, true);
  assert.equal(b.tipo === 'link' && b.novo, false);
  assert.equal(a.tipo === 'link' && b.tipo === 'link' && a.url === b.url, true);
  const c = await gerarSinalPix(UNIT, 1, CONSULTA, d);
  assert.equal(c.tipo === 'link' && c.novo, false);
  assert.equal(f.chamadas.length, 1, 'nunca um segundo link');
  assert.equal(criados.length, 1);
  // outro paciente tem o seu
  await gerarSinalPix(UNIT, 2, CONSULTA, d);
  assert.equal(f.chamadas.length, 2);
});

test('sinal já pago: devolve "já pago" e não gera outro', async () => {
  const f = asaasFalso();
  const pago: LinhaDoSinal = { id: 'p', unitId: 'u1', leadId: '1', linkId: 'L', url: 'https://www.asaas.com/c/L', valorCentavos: 5000, venceEm: '2026-11-13', status: 'pago', paymentId: 'pay_1', criadoEm: new Date('2026-11-08T12:00:00Z'), pagoEm: AGORA, avisadoEm: null };
  const r = await gerarSinalPix(UNIT, 1, CONSULTA, deps({ escrever: f.escrever, banco: bancoFalso([pago]).banco }));
  assert.deepEqual(r, { tipo: 'ja-pago' });
  assert.equal(f.chamadas.length, 0);
});

test('link pendente que já venceu, ou que acaba antes da nova consulta, não é reaproveitado', async () => {
  const f = asaasFalso({ id: '2', url: 'https://www.asaas.com/c/2' });
  const velho: LinhaDoSinal = { id: 'v', unitId: 'u1', leadId: '1', linkId: '1', url: 'https://www.asaas.com/c/1', valorCentavos: 5000, venceEm: '2026-11-09', status: 'pendente', paymentId: null, criadoEm: new Date('2026-11-06T12:00:00Z'), pagoEm: null, avisadoEm: null };
  const r = await gerarSinalPix(UNIT, 1, CONSULTA, deps({ escrever: f.escrever, banco: bancoFalso([velho]).banco }));
  assert.equal(r.tipo === 'link' && r.novo, true);
  const curto: LinhaDoSinal = { ...velho, venceEm: '2026-11-11' }; // vale hoje, mas a consulta nova pede até 13/11
  const r2 = await gerarSinalPix(UNIT, 1, CONSULTA, deps({ escrever: asaasFalso({ id: '3', url: 'https://www.asaas.com/c/3' }).escrever, banco: bancoFalso([curto]).banco }));
  assert.equal(r2.tipo === 'link' && r2.novo, true);
  assert.equal(r2.tipo === 'link' && r2.url, 'https://www.asaas.com/c/3');
});

test('teto por unidade: no limite, não cria mais link e avisa que foi o teto; reaproveitar não gasta o teto', async () => {
  const f = asaasFalso();
  const cheios: LinhaDoSinal[] = Array.from({ length: TETO_LINKS_POR_UNIDADE_DIA }, (_, i) => ({
    id: `c${i}`, unitId: 'u1', leadId: `outro${i}`, linkId: `L${i}`, url: 'https://www.asaas.com/c/x', valorCentavos: 5000, venceEm: '2026-11-13', status: 'pendente', paymentId: null, criadoEm: new Date('2026-11-10T10:00:00Z'), pagoEm: null, avisadoEm: null,
  }));
  const r = await gerarSinalPix(UNIT, 999, CONSULTA, deps({ escrever: f.escrever, banco: bancoFalso(cheios).banco }));
  assert.equal(r.tipo, 'falhou');
  assert.equal(r.tipo === 'falhou' && r.motivo, 'teto');
  assert.equal(f.chamadas.length, 0);
  // quem já tem link recebe o dele mesmo com o teto cheio
  const dele = bancoFalso([...cheios, { ...cheios[0]!, id: 'meu', leadId: '999', linkId: 'MEU', url: 'https://www.asaas.com/c/meu' }]).banco;
  const r2 = await gerarSinalPix(UNIT, 999, CONSULTA, deps({ escrever: f.escrever, banco: dele }));
  assert.equal(r2.tipo === 'link' && r2.url, 'https://www.asaas.com/c/meu');
});

test('falha do Asaas (401, 403, timeout, resposta ruim) e unidade sem chave NUNCA lançam: viram "falhou" e nada é gravado', async () => {
  for (const erro of [new ErroAsaas('o Asaas recusou a chave (401)', 401), new ErroAsaas('o Asaas negou a gravação (403)', 403), new ErroAsaas('sem resposta do Asaas em /paymentLinks', null)]) {
    const { banco, criados } = bancoFalso();
    const r = await gerarSinalPix(UNIT, 1, CONSULTA, deps({ escrever: asaasFalso(erro).escrever, banco }));
    assert.equal(r.tipo, 'falhou');
    assert.equal(r.tipo === 'falhou' && r.motivo, 'asaas');
    assert.equal(criados.length, 0);
  }
  for (const resposta of [{ id: '1' }, { id: '1', url: 'http://www.asaas.com/c/1' }, { id: '1', url: 'https://evil.example.com/c/1' }, { url: 'https://www.asaas.com/c/1' }, null]) {
    const r = await gerarSinalPix(UNIT, 1, CONSULTA, deps({ escrever: asaasFalso(resposta).escrever }));
    assert.equal(r.tipo, 'falhou', JSON.stringify(resposta));
  }
  const f = asaasFalso();
  const semChave = await gerarSinalPix(UNIT, 1, CONSULTA, deps({ escrever: f.escrever, chave: async () => null }));
  assert.equal(semChave.tipo === 'falhou' && semChave.motivo, 'sem-chave');
  assert.equal(f.chamadas.length, 0);
  // a chave nunca aparece no resultado
  const r = await gerarSinalPix(UNIT, 1, CONSULTA, deps({ escrever: asaasFalso(new ErroAsaas('erro', 500)).escrever }));
  assert.ok(!JSON.stringify(r).includes('aact'));
});

test('unidade sem sinal configurado nunca chama o Asaas', async () => {
  const f = asaasFalso();
  const r = await gerarSinalPix({ ...UNIT, sinalPixCentavos: null }, 1, CONSULTA, deps({ escrever: f.escrever }));
  assert.equal(r.tipo, 'falhou');
  assert.equal(f.chamadas.length, 0);
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
