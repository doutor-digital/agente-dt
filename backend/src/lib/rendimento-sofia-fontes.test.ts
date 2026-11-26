import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { mensagemDaSofiaConversando } from './mensagem-da-ia.js';
import { agendaEmFatias, contaComoSofia, janelaDaUnidade, origemDoTelefone } from './rendimento-sofia-fontes.js';

// servidor que finge ser a franquia: recusa busca de mais de 100 dias com 400, como a franquia de verdade
interface Corpo { initialDate: string; endDate: string }
const pedidos: Corpo[] = [];
let totalDePaginas = 1;
let servidor: http.Server;
let base = '';

before(async () => {
  servidor = http.createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      const corpo = JSON.parse(b || '{}') as Corpo;
      pedidos.push(corpo);
      const dias = (Date.parse(`${corpo.endDate}T00:00:00Z`) - Date.parse(`${corpo.initialDate}T00:00:00Z`)) / 86_400_000;
      res.setHeader('content-type', 'application/json');
      if (dias > 100) {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: 'intervalo de datas máximo 100 dias' }));
      }
      res.end(JSON.stringify({ status: 'success', data: { data: [{ idSchedule: 1, clientName: 'Maria Silva', categoryName: 'AVALIAÇÃO', idStatus: 37, dateAttendance: '2026-11-27T11:30:00.000Z' }], total: 1, page: 1, rowsPerPage: 100, totalPages: totalDePaginas } }));
    });
  });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});
after(() => servidor.close());

const unit = () => ({ spineBaseUrl: base, spineToken: 't', spineTimezone: 'America/Sao_Paulo' }) as never;

test('ROI: a agenda de 150 dias é lida em fatias de 90 (a franquia recusa mais de 100 dias com 400) e sem repetir dia', async () => {
  pedidos.length = 0;
  totalDePaginas = 1;
  const r = await agendaEmFatias(unit(), '2026-08-01', '2026-12-28');
  assert.ok(r);
  assert.equal(r.completa, true);
  // o corpo leva o fim EXCLUSIVO (o cliente soma 1 dia): as fatias são 01/08–29/10 e 30/10–28/12, sem dia repetido nem faltando, nenhuma com mais de 100 dias
  assert.deepEqual(pedidos.map((p) => [p.initialDate, p.endDate]), [['2026-08-01', '2026-10-30'], ['2026-10-30', '2026-12-29']]);
  totalDePaginas = 99;
  assert.equal((await agendaEmFatias(unit(), '2026-11-01', '2026-11-10'))?.completa, false, 'fatia cortada: a lista diz que não está completa');
  totalDePaginas = 1;
});

test('SQL do telefone: a classe de não-dígitos é [^0-9] (um \\D dentro de template do JS vira a letra D e o telefone nunca bateria)', () => {
  const src = readFileSync(new URL('./rendimento-sofia-fontes.ts', import.meta.url), 'utf8');
  const sql = src.slice(src.indexOf('const f = await prisma.$queryRaw'), src.indexOf('out.set(nome, origemDoTelefone'));
  assert.match(sql, /regexp_replace\(coalesce\(c\.phone, ''\), '\[\^0-9\]', '', 'g'\)/);
  assert.equal(sql.includes('\\D'), false);
});

const D = (x: string) => new Date(`${x}Z`);

test('janela da unidade: dias na hora da unidade (São Paulo −3, Manaus −4), com limite superior exclusivo; data ruim = null', () => {
  const sp = janelaDaUnidade({ spineTimezone: 'America/Sao_Paulo' }, '2026-11-01', '2026-11-30')!;
  assert.equal(sp.desde.toISOString(), '2026-11-01T03:00:00.000Z');
  assert.equal(sp.ateExclusivo.toISOString(), '2026-12-01T03:00:00.000Z');
  assert.equal(janelaDaUnidade({ spineTimezone: 'America/Manaus' }, '2026-11-01', '2026-11-01')!.ateExclusivo.toISOString(), '2026-11-02T04:00:00.000Z');
  assert.equal(janelaDaUnidade({ spineTimezone: 'America/Sao_Paulo' }, 'ontem', 'hoje'), null);
});

test('«sofia» = FALA DELA (role assistant) dentro da janela: tempo de vida da conversa e total de mensagens não contam; a Sofia que retoma o lead DEPOIS do período não o torna «sofia»', () => {
  // conversa de agosto, 80 mensagens dela no total, mas NENHUMA dentro do período (a retomada foi em dezembro): a contagem da janela é 0
  assert.equal(contaComoSofia({ falasNaJanela: 0 }), false);
  assert.equal(contaComoSofia({ falasNaJanela: 1 }), true);
  // o telefone dessa conversa: falas só FORA da janela → nem «sofia» nem «equipe» (não dá para provar nenhum dos dois)
  assert.equal(origemDoTelefone({ naJanela: 0, total: 80 }), 'desconhecido');
  assert.equal(origemDoTelefone({ naJanela: 3, total: 80 }), 'sofia');
  // «equipe» só sem conversa NUNCA, em qualquer data
  assert.equal(origemDoTelefone({ naJanela: 0, total: 0 }), 'equipe');
});

test('SQL das conversas: lê `messages` por role = assistant e created_at com os DOIS limites; não usa inicio_em, ultima_msg_em nem msgs_ia; o telefone, em qualquer data', () => {
  const src = readFileSync(new URL('./rendimento-sofia-fontes.ts', import.meta.url), 'utf8');
  const conv = src.slice(src.indexOf('// só conversa com FALA da Sofia'), src.indexOf('return linhas.map('));
  assert.match(conv, /\$\{E_SOFIA\}/, 'só a Sofia CONVERSANDO (E_SOFIA), não qualquer mensagem assistant');
  assert.equal(conv.includes("m.role = 'assistant'"), false);
  assert.match(conv, /max\(o\.spine_id_schedule\) FILTER \(WHERE o\.agendou_ia\)/, 'o idSchedule só vale com agendou_ia (o botão da equipe grava o mesmo campo)');
  assert.match(conv, /m\.created_at >= \$\{desde\} AND m\.created_at < \$\{ateExclusivo\}/);
  for (const proibido of ['inicio_em', 'ultima_msg_em', 'msgs_ia']) assert.equal(conv.includes(proibido), false, proibido);
  const fone = src.slice(src.indexOf('const f = await prisma.$queryRaw'), src.indexOf('out.set(nome, origemDoTelefone'));
  assert.match(fone, /\$\{E_SOFIA\}/);
  assert.equal(fone.includes("m.role = 'assistant'"), false);
  assert.match(fone, /count\(\*\)::int AS "total"/, 'o total é de QUALQUER data (sem limite de data)');
  const semFone = src.slice(src.indexOf('async primeirosNomesSemTelefone'), src.indexOf('async conversasDaSofia'));
  assert.match(semFone, /EXISTS \(SELECT 1 FROM messages m WHERE m\.conversation_id = c\.id AND \$\{E_SOFIA\}\)/);
  assert.equal(semFone.includes('created_at'), false, 'sem limite de data');
});

test('MENSAGEM AUTOMÁTICA NÃO É A SOFIA: a equipe marca, a confirmação D-1 sai (role assistant) e o paciente NÃO vira «sofia»; régua, reativação, cutucada, lembrete e fala da equipe também não', () => {
  // o que cada worker grava em `messages.meta` (a MESMA regra que o resumo de qualidade usa)
  const automaticas: Array<[string, unknown]> = [
    ['confirmação D-1 (reminder-worker)', { origem: 'confirmacao_d1' }],
    ['confirmação dia útil', { origem: 'confirmacao_dia_util' }],
    ['lembrete do Kommo', { origem: 'lembrete_kommo' }],
    ['reativação', { reactivation: 1 }],
    ['degrau da régua (follow-up)', { followUp: 2 }],
    ['cutucada depois da equipe', { cutucada: 1 }],
    ['fala da equipe copiada do Kommo', { origem: 'kommo_talks' }],
    ['fala escrita pela equipe', { autor: 'equipe' }],
    ['cartão de chegada', { via: 'chat_cartao' }],
    ['nota interna', { via: 'lead_note' }],
  ];
  for (const [quem, meta] of automaticas) assert.equal(mensagemDaSofiaConversando(meta), false, quem);
  // a Sofia de verdade (turno do agente, enviado pelo canal)
  for (const meta of [{ via: 'meta' }, { via: 'salesbot' }, { via: 'pix_do_sinal' }, {}]) assert.equal(mensagemDaSofiaConversando(meta), true, JSON.stringify(meta));
  // cenário: a equipe marcou; só a D-1 saiu na janela → zero falas da Sofia → não conta
  const msgsDaJanela = [{ meta: { origem: 'confirmacao_d1' } }, { meta: { origem: 'confirmacao_d1' } }];
  assert.equal(contaComoSofia({ falasNaJanela: msgsDaJanela.filter((m) => mensagemDaSofiaConversando(m.meta)).length }), false);
  // com UMA fala real dela junto, conta
  assert.equal(contaComoSofia({ falasNaJanela: [...msgsDaJanela, { meta: { via: 'meta' } }].filter((m) => mensagemDaSofiaConversando(m.meta)).length }), true);
  // e o telefone: só D-1 em qualquer data = nenhuma conversa da Sofia → equipe (a prova por ausência vale), nunca «sofia»
  assert.equal(origemDoTelefone({ naJanela: 0, total: msgsDaJanela.filter((m) => mensagemDaSofiaConversando(m.meta)).length }), 'equipe');
});
