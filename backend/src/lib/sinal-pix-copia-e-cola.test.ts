/**
 * Sinal da Sofia 2.0 como Pix COPIA-E-COLA (11/11/2026): geração no Asaas (`POST /pix/qrCodes/static`), baixa pelo `pixQrCodeId`, o texto
 * que a ferramenta devolve à Sofia e o envio do código numa mensagem só dele. Sem banco e sem rede.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copiaEColaValido, gerarSinalPix, type BancoDoSinal, type DepsDoSinal, type LinhaDoSinal } from './sinal-pix.js';
import { conciliar, type PagamentoDoAsaas } from './sinal-pix-worker.js';
import { guardarPixDoTurno, pixDoSinalDoTurno, textoDoSinal } from '../agent/sinal-pix-tool.js';
import { enviarPixDoSinal, esperarRespostaSair, type EnvioDoPix } from './pix-do-sinal-envio.js';

// BR Code de verdade tem espaço no nome e na cidade do recebedor
const PIX =
  '00020126580014br.gov.bcb.pix0136a1b2c3d4-0000-1111-2222-333344445555520400005303986540550.005802BR5920ATTIVA CORPO E MENTE6009ARAGUAINA62290525sofiasinalaraguaina2800016304A1B2';

const UNIT = { id: 'u1', slug: 'doutor-hernia-araguaina', name: 'Araguaína', sinalPixCentavos: 5000, spineTimezone: 'America/Sao_Paulo' };
const AGORA = new Date('2026-11-10T15:00:00Z');
const CONSULTA = '2026-11-14T09:00';

function bancoFalso(linhas: LinhaDoSinal[] = []) {
  const rows: LinhaDoSinal[] = [...linhas];
  let n = 0;
  const banco: BancoDoSinal = {
    findMany: async ({ where }) =>
      rows.filter((l) => l.clinica === where.clinica && l.leadId === where.leadId && where.status.in.includes(l.status) && l.criadoEm >= where.criadoEm.gte),
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

function asaas(opts: { chaves?: unknown; qr?: unknown } = {}) {
  const escritas: Array<{ caminho: string; corpo: Record<string, unknown> | undefined }> = [];
  const leituras: string[] = [];
  const escrever = (async (_c: string, _k: string, _m: string, caminho: string, corpo?: Record<string, unknown>) => {
    escritas.push({ caminho, corpo });
    return opts.qr ?? { id: 'qr_123', payload: PIX, encodedImage: 'iVBOR...' };
  }) as unknown as DepsDoSinal['escrever'];
  const ler = (async (_c: string, _k: string, caminho: string) => {
    leituras.push(caminho);
    return opts.chaves ?? { data: [{ key: 'a1b2c3d4-0000-1111-2222-333344445555', status: 'ACTIVE', type: 'EVP' }] };
  }) as unknown as NonNullable<DepsDoSinal['ler']>;
  return { escrever, ler, escritas, leituras };
}

function deps(over: Partial<DepsDoSinal>): DepsDoSinal {
  return {
    banco: bancoFalso().banco,
    chave: async () => ({ unitId: 'u1', slug: UNIT.slug, chave: '$aact_teste' }),
    escrever: asaas().escrever,
    agora: () => AGORA,
    esperar: async () => undefined,
    ...over,
  };
}

test('copiaEColaValido: BR Code com espaço no nome do recebedor vale; sem CRC, sem domínio do Pix ou com quebra de linha, não', () => {
  assert.equal(copiaEColaValido(PIX), true);
  assert.equal(copiaEColaValido(PIX.slice(0, -8)), false);
  assert.equal(copiaEColaValido(PIX.replace('br.gov.bcb.pix', 'xx')), false);
  assert.equal(copiaEColaValido(PIX.replace('ATTIVA', 'ATT\nIVA')), false);
  assert.equal(copiaEColaValido('https://www.asaas.com/c/abc'), false);
});

test('gera Pix copia-e-cola de R$ 50, valor fixo, um pagamento só, até o fim da véspera — e grava o id do QR e o código', async () => {
  const f = asaas();
  const { banco, rows } = bancoFalso();
  const r = await gerarSinalPix(UNIT, 28000001, CONSULTA, deps({ banco, escrever: f.escrever, ler: f.ler }));
  assert.deepEqual(r, { tipo: 'link', url: PIX, novo: true, valor: 50, venceEm: '2026-11-13', registrado: true, copiaECola: true });
  assert.deepEqual(f.leituras, ['/pix/addressKeys']);
  assert.equal(f.escritas.length, 1);
  assert.equal(f.escritas[0]!.caminho, '/pix/qrCodes/static');
  const corpo = f.escritas[0]!.corpo!;
  assert.equal(corpo.value, 50);
  assert.equal(corpo.allowsMultiplePayments, false);
  assert.equal(corpo.format, 'PAYLOAD');
  assert.equal(corpo.expirationDate, '2026-11-13 23:59:59');
  assert.equal(corpo.addressKey, 'a1b2c3d4-0000-1111-2222-333344445555');
  assert.equal(corpo.externalReference, 'sofia-sinal:doutor-hernia-araguaina:28000001');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.linkId, 'qr_123');
  assert.equal(rows[0]!.url, PIX);
});

test('pedir de novo devolve o MESMO código (marcado como copia-e-cola) e não cria outro QR', async () => {
  const f = asaas();
  const { banco } = bancoFalso();
  await gerarSinalPix(UNIT, 28000001, CONSULTA, deps({ banco, escrever: f.escrever, ler: f.ler }));
  const r2 = await gerarSinalPix(UNIT, 28000001, CONSULTA, deps({ banco, escrever: f.escrever, ler: f.ler }));
  assert.deepEqual(r2, { tipo: 'link', url: PIX, novo: false, valor: 50, venceEm: '2026-11-13', copiaECola: true });
  assert.equal(f.escritas.length, 1);
});

test('conta sem chave Pix ativa, ou resposta sem código válido: falha (a equipe manda o Pix) e nada fica gravado', async () => {
  for (const f of [asaas({ chaves: { data: [] } }), asaas({ qr: { id: 'qr_9', payload: 'lixo' } }), asaas({ qr: { payload: PIX } })]) {
    const { banco, rows } = bancoFalso();
    const r = await gerarSinalPix(UNIT, 28000001, CONSULTA, deps({ banco, escrever: f.escrever, ler: f.ler }));
    assert.equal(r.tipo, 'falhou');
    assert.equal(rows.length, 0);
  }
});

test('baixa: o pagamento que nasce do QR casa pelo pixQrCodeId; o link antigo segue casando pelo paymentLink', () => {
  const l = (linkId: string): LinhaDoSinal => ({
    id: linkId, unitId: 'u1', clinica: 'doutor-hernia-araguaina', leadId: '1', linkId, url: PIX, valorCentavos: 5000, venceEm: '2026-11-13',
    consultaEm: CONSULTA, status: 'pendente', paymentId: null, criadoEm: AGORA, pagoEm: null, avisadoEm: null,
  });
  const pag = (over: Partial<PagamentoDoAsaas>): PagamentoDoAsaas => ({ id: 'pay_1', status: 'RECEIVED', value: 50, billingType: 'PIX', ...over });
  assert.deepEqual(conciliar([l('qr_123')], [pag({ pixQrCodeId: 'qr_123' })], '2026-11-11').map((d) => d.tipo), ['pago']);
  assert.deepEqual(conciliar([l('qr_123')], [pag({ pixQrCodeId: 'qr_999' })], '2026-11-11'), []);
  assert.deepEqual(conciliar([l('lnk_1')], [pag({ paymentLink: 'lnk_1' })], '2026-11-11').map((d) => d.tipo), ['pago']);
});

test('texto à Sofia: o código vai em mensagem separada — ela NÃO escreve código, chave nem link', () => {
  const s = { sinal: 50, comSinal: 250, restoNoDia: 200, semSinal: 350 } as Parameters<typeof textoDoSinal>[1];
  const t = textoDoSinal({ tipo: 'link', url: PIX, novo: true, valor: 50, venceEm: '2026-11-13', copiaECola: true }, s, false);
  assert.ok(!t.includes(PIX));
  assert.match(t, /mensagem SEPARADA/);
  assert.match(t, /Pix copia e cola/);
  assert.match(t, /R\$ 250/);
});

test('o Pix do turno é lido uma vez só', () => {
  guardarPixDoTurno('t-1', PIX);
  assert.equal(pixDoSinalDoTurno('t-1'), PIX);
  assert.equal(pixDoSinalDoTurno('t-1'), undefined);
});

// ---------- envio do código à parte ----------

function envio(over: Partial<EnvioDoPix> & { vistas?: Array<Array<{ type: string; text: string; created_at: number }>>; enviarFalha?: Error; via?: string } = {}) {
  const passos: Array<{ kind: string; title: string }> = [];
  const enviados: string[] = [];
  const tarefas: string[] = [];
  const registrados: string[] = [];
  let leitura = 0;
  let relogio = 1_794_400_000_000;
  const kommo = {
    sendChatReply: async ({ text }: { text: string }) => {
      if (over.enviarFalha) throw over.enviarFalha;
      enviados.push(text);
      return { via: (over.via ?? 'salesbot') as 'salesbot' };
    },
    listTalkMessages: async () => over.vistas?.[Math.min(leitura++, over.vistas.length - 1)] ?? [],
    createTask: async ({ text }: { text: string }) => {
      tarefas.push(text);
      return { id: 1 };
    },
    getLead: async () => ({ id: 1, name: 'Paciente' }),
  } as unknown as EnvioDoPix['kommo'];
  const a: EnvioDoPix = {
    unit: { id: 'u-envio', slug: 'doutor-hernia-araguaina' },
    leadId: Math.floor(Math.random() * 1e9),
    chatId: 'c', talkId: '16183', contactId: '9',
    respostaAnterior: 'Consulta marcada! Na próxima mensagem vai o código do Pix: é só copiar e colar no app do banco.',
    viaSalesbot: true,
    modoWidget: false,
    recorder: { traceId: `tr-${Math.random()}`, step: async (s: { kind: string; title: string }) => void passos.push(s) } as unknown as EnvioDoPix['recorder'],
    kommo,
    registrar: async (t) => void registrados.push(t),
    dedupe: { avisoRecente: async () => false, marcarAviso: async () => undefined } as unknown as EnvioDoPix['dedupe'],
    alertar: async () => undefined,
    esperar: async (ms) => void (relogio += ms),
    agora: () => relogio,
    ...over,
  };
  return { a, passos, enviados, tarefas, registrados, agoraSeg: () => Math.floor(relogio / 1000) };
}

test('sem Pix no turno: nada sai', async () => {
  const e = envio();
  assert.equal(await enviarPixDoSinal(e.a), 'sem-pix');
  assert.deepEqual(e.enviados, []);
});

test('espera a explicação aparecer na conversa e só então manda o código, sozinho', async () => {
  const e = envio();
  const saiu = { type: 'outgoing', text: e.a.respostaAnterior, created_at: Math.floor(1_794_400_000_000 / 1000) };
  e.a.kommo = { ...e.a.kommo, listTalkMessages: (() => { let i = 0; return async () => (i++ < 2 ? [] : [saiu]); })() } as EnvioDoPix['kommo'];
  guardarPixDoTurno(e.a.recorder.traceId, PIX);
  assert.equal(await enviarPixDoSinal(e.a), 'enviado');
  assert.deepEqual(e.enviados, [PIX]);
  assert.deepEqual(e.registrados, [PIX]);
});

test('a explicação não aparece no prazo: manda o código assim mesmo (duplicado é melhor que nenhum)', async () => {
  const e = envio();
  guardarPixDoTurno(e.a.recorder.traceId, PIX);
  assert.equal(await enviarPixDoSinal(e.a), 'enviado-sem-confirmar-anterior');
  assert.deepEqual(e.enviados, [PIX]);
});

test('envio falhou, virou nota ou modo widget: tarefa para a equipe com o código, sem lançar', async () => {
  for (const over of [{ enviarFalha: new Error('500') }, { via: 'lead_note' }, { modoWidget: true }] as const) {
    const e = envio(over);
    guardarPixDoTurno(e.a.recorder.traceId, PIX);
    assert.equal(await enviarPixDoSinal(e.a), 'falhou');
    assert.equal(e.tarefas.length, 1, JSON.stringify(over));
    assert.ok(e.tarefas[0]!.includes(PIX));
    assert.deepEqual(e.registrados, []);
  }
});

test('esperarRespostaSair: leitura que falha não trava; para no prazo', async () => {
  let t = 0;
  const r = await esperarRespostaSair(async () => { throw new Error('x'); }, 'qualquer texto longo', async (ms) => void (t += ms), () => t, 5_000);
  assert.equal(r, false);
  assert.ok(t <= 5_000);
});
