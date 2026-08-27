import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { SpineService, type SpineUnit } from './spine.service.js';

// Servidor que finge ser a API da franquia aplicando as regras do "Guia de
// Integração — API Spine 1.9.3". Cada 400 que ele devolve é um 400 que a
// franquia devolveria de verdade — sem gastar uma requisição lá.

interface Chamada {
  metodo: string;
  rota: string;
  corpo: Record<string, unknown>;
  headers: Record<string, string | undefined>;
}

const chamadas: Chamada[] = [];
let servidor: http.Server;
let base = '';

const FONE_ENVIO = /^\+55\d{10,11}$/;

function erro(msgs: string[]) {
  return { status: 400, corpo: { error: msgs[0], errors: msgs } };
}

function paginacao(p: unknown, maximo = 100): string[] {
  if (p === undefined) return [];
  const q = p as { page?: number; rowsPerPage?: number };
  const e: string[] = [];
  if (q.page !== undefined && q.page < 1) e.push('page começa em 1');
  if (q.rowsPerPage !== undefined && q.rowsPerPage > maximo) {
    e.push(`rowsPerPage máximo ${maximo}`);
  }
  return e;
}

function intervalo(c: Record<string, unknown>, maxDias = 100): string[] {
  const ini = c.initialDate as string | undefined;
  const fim = c.endDate as string | undefined;
  if (!ini || !fim) return [];
  const dias = (Date.parse(`${fim}T00:00:00Z`) - Date.parse(`${ini}T00:00:00Z`)) / 86_400_000;
  return dias > maxDias ? [`intervalo de datas máximo ${maxDias} dias`] : [];
}

function nome(v: unknown, campo = 'name'): string[] {
  if (typeof v !== 'string') return [`${campo} é obrigatório`];
  if (v.trim().length < 2) return [`${campo}: mínimo 2 caracteres`];
  if (v.length > 255) return [`${campo}: máximo 255 caracteres`];
  return [];
}

function fone(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  return FONE_ENVIO.test(String(v)) ? [] : ['whatsapp deve ser +55DDNNNNNNNNN'];
}

const ROTAS: Record<string, (c: Record<string, unknown>) => { status: number; corpo: unknown }> = {
  'POST /api/clients': (c) => {
    const e = [
      ...(c.idSource === undefined ? ['idSource é obrigatório'] : []),
      ...nome(c.name),
      ...fone(c.whatsapp),
    ];
    return e.length ? erro(e) : { status: 200, corpo: { success: true, idClient: 991 } };
  },

  'POST /api/clients/search': (c) => {
    const e = [
      ...(c.name !== undefined ? nome(c.name) : []),
      ...paginacao(c.pagination),
    ];
    return e.length
      ? erro(e)
      : { status: 200, corpo: { status: 'ok', data: { data: [], total: 0, totalPages: 1 } } };
  },

  'POST /api/leads': (c) => {
    const e = [
      ...nome(c.name),
      ...(typeof c.description !== 'string' || !c.description.trim()
        ? ['description é obrigatório']
        : []),
      ...(c.idLeadsCategory === undefined ? ['idLeadsCategory é obrigatório'] : []),
      ...(c.idSource === undefined ? ['idSource é obrigatório'] : []),
      ...fone(c.whatsapp),
    ];
    return e.length ? erro(e) : { status: 200, corpo: { success: true, idLead: 771 } };
  },

  'POST /api/leads/search': (c) => {
    const e = [...paginacao(c.pagination), ...intervalo(c)];
    return e.length
      ? erro(e)
      : { status: 200, corpo: { status: 'ok', data: { data: [], totalPages: 1 } } };
  },

  'POST /api/leads/convert': (c) => {
    const e = [...(c.idLead === undefined ? ['idLead é obrigatório'] : []), ...nome(c.name)];
    return e.length ? erro(e) : { status: 200, corpo: { success: true, idClient: 991 } };
  },

  'POST /api/schedules': (c) => {
    const e: string[] = [];
    if (c.idClient === undefined) e.push('idClient é obrigatório');
    if (c.idCategory === undefined) e.push('idCategory é obrigatório');

    const bruto = c.dateAttendance;
    if (typeof bruto !== 'string') {
      e.push('dateAttendance é obrigatório');
    } else {
      // COMPORTAMENTO VERIFICADO EM PRODUÇÃO (26/08/2026, paciente 351701):
      // mandamos "2026-09-08T17:00:00" sem fuso e a franquia gravou
      // "2026-09-08T20:00:00.000Z" — ou seja, ela lê a data SEM FUSO como
      // hora local do Brasil (-03:00) e converte pra UTC ela mesma.
      // O guia §9.2 fala em "convenção UTC", mas isso vale pro que ela
      // DEVOLVE (sempre com Z), não pro que a gente manda.
      const quando = Date.parse(bruto.endsWith('Z') ? bruto : `${bruto}-03:00`);
      if (Number.isNaN(quando)) e.push('dateAttendance: use ISO 8601');
      else {
        if (quando <= Date.now()) e.push('dateAttendance deve ser futura');
        const minutos = Number(bruto.slice(14, 16));
        if (minutos % 30 !== 0) e.push('horários em intervalos de 30 minutos');
      }
    }
    return e.length ? erro(e) : { status: 200, corpo: { success: true, idSchedule: 551 } };
  },

  'POST /api/schedules/search': (c) => {
    const e = [...paginacao(c.pagination), ...(c.name !== undefined ? nome(c.name) : [])];
    return e.length
      ? erro(e)
      : { status: 200, corpo: { status: 'ok', data: { data: [], total: 0, totalPages: 1 } } };
  },

  'DELETE /api/schedules': (c) =>
    c.idSchedule === undefined
      ? erro(['idSchedule é obrigatório'])
      : { status: 200, corpo: { success: true, idSchedule: c.idSchedule } },

  'PATCH /api/schedules/confirm': (c) =>
    c.idSchedule === undefined
      ? erro(['idSchedule é obrigatório'])
      : { status: 200, corpo: { success: true, idSchedule: c.idSchedule } },

  'POST /api/bi/leads/sources': (c) => {
    const e = [
      ...(c.initialDate === undefined || c.endDate === undefined
        ? ['initialDate e endDate são obrigatórios']
        : []),
      ...intervalo(c),
    ];
    return e.length ? erro(e) : { status: 200, corpo: { data: { sources: [], total: 0 } } };
  },
};

before(async () => {
  servidor = http.createServer((req, res) => {
    let cru = '';
    req.on('data', (p) => (cru += p));
    req.on('end', () => {
      const corpo = cru ? (JSON.parse(cru) as Record<string, unknown>) : {};
      const chave = `${req.method} ${(req.url || '').split('?')[0]}`;
      chamadas.push({
        metodo: req.method || '',
        rota: (req.url || '').split('?')[0],
        corpo,
        headers: {
          authorization: req.headers.authorization,
          'content-type': req.headers['content-type'],
        },
      });

      const handler = ROTAS[chave];
      const r = handler
        ? handler(corpo)
        : { status: 404, corpo: { error: 'endpoint não encontrado' } };
      res.statusCode = r.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(r.corpo));
    });
  });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(servidor.address() as AddressInfo).port}`;
});

after(() => servidor.close());

function unidade(): SpineUnit {
  return {
    spineBaseUrl: base,
    spineToken: 'token-de-mentira',
    spineTimezone: 'America/Sao_Paulo',
  } as SpineUnit;
}

function ultima(): Chamada {
  return chamadas[chamadas.length - 1];
}

function amanha(hora: string): string {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.toISOString().slice(0, 10)}T${hora}`;
}

// ── §2: cabeçalhos obrigatórios ────────────────────────────────────────────

test('manda Bearer e Content-Type como o guia exige', async () => {
  await SpineService.ping(unidade());
  assert.equal(ultima().headers.authorization, 'Bearer token-de-mentira');
  assert.match(String(ultima().headers['content-type']), /application\/json/);
});

// ── §9.3: WhatsApp no envio é +55DDNNNNNNNNN ───────────────────────────────

test('normaliza celular de 11 dígitos para +55DDNNNNNNNNN', () => {
  assert.equal(SpineService.normalizarWhatsapp('(63) 99102-1043'), '+5563991021043');
  assert.match(SpineService.normalizarWhatsapp('(63) 99102-1043'), FONE_ENVIO);
});

test('número que já vem com 55 não ganha 55 de novo', () => {
  assert.equal(SpineService.normalizarWhatsapp('5563991021043'), '+5563991021043');
});

test('número curto demais não pode virar payload válido', () => {
  const lixo = SpineService.normalizarWhatsapp('9910');
  assert.ok(!FONE_ENVIO.test(lixo), `"${lixo}" passaria como telefone e a franquia recusaria`);
});

// ── §10.1: POST /api/clients ───────────────────────────────────────────────

test('cadastro de paciente passa na validação da franquia', async () => {
  const r = await SpineService.createClient(unidade(), {
    name: 'Maria das Dores Silva',
    whatsapp: '(63) 99102-1043',
    idSource: 23,
    addressCity: 'Imperatriz',
    addressUf: 'MA',
  });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.data?.idClient, 991);
});

test('paciente com nome de 1 letra é recusado antes de sujar o CRM', async () => {
  const r = await SpineService.createClient(unidade(), {
    name: 'J',
    whatsapp: '(63) 99102-1043',
    idSource: 23,
  });
  assert.equal(r.ok, false);
  assert.match(String(r.error), /mínimo 2 caracteres/);
});

// PENDÊNCIA CONHECIDA: mandamos idLead no POST /api/clients, mas o guia §10.1
// não lista esse campo, e o GET /api/clients/{id} não devolve nada de lead —
// não há como provar que a franquia honrou. O caminho documentado pra ligar
// lead↔paciente é POST /api/leads/convert (§10.2). Enquanto não confirmarmos
// com o suporte, o lead e o paciente podem estar soltos um do outro lá dentro.
test('idLead não é campo documentado do cadastro de paciente', { todo: 'confirmar com o suporte da franquia ou migrar pra /api/leads/convert' }, async () => {
  await SpineService.createClient(unidade(), {
    name: 'Maria das Dores Silva',
    whatsapp: '(63) 99102-1043',
    idSource: 23,
    idLead: 771,
  });
  const enviado = Object.keys(ultima().corpo);
  const documentados = new Set([
    'idSource', 'name', 'idProfession', 'whatsapp', 'email', 'cpf', 'birthdate', 'gender',
    'addressZip', 'address', 'addressNumber', 'addressDistrict', 'addressComp',
    'addressCity', 'addressUf',
  ]);
  const fora = enviado.filter((k) => !documentados.has(k));
  assert.deepEqual(
    fora,
    [],
    `campos fora do guia §10.1: ${fora.join(', ')} — o elo lead↔paciente é /api/leads/convert`,
  );
});

// ── §10.2: POST /api/leads ─────────────────────────────────────────────────

test('cadastro de lead leva os 4 campos obrigatórios do guia', async () => {
  const r = await SpineService.createLead(unidade(), {
    name: 'Maria das Dores Silva',
    description: 'veio pelo Instagram',
    idSource: 23,
    whatsapp: '(63) 99102-1043',
  });
  assert.equal(r.ok, true, r.error);
  for (const campo of ['name', 'description', 'idLeadsCategory', 'idSource']) {
    assert.ok(campo in ultima().corpo, `faltou ${campo}`);
  }
});

test('lead sem descrição ainda passa (o código põe "-")', async () => {
  const r = await SpineService.createLead(unidade(), {
    name: 'Maria das Dores Silva',
    description: '',
    idSource: 23,
  });
  assert.equal(r.ok, true, r.error);
});

// ── §10.3: POST /api/schedules — o caso da data ────────────────────────────

test('agendamento leva os 3 obrigatórios', async () => {
  const r = await SpineService.createSchedule(unidade(), {
    idClient: 991,
    dateAttendanceLocal: amanha('14:00:00'),
    idCategory: 1,
  });
  assert.equal(r.ok, true, r.error);
});

// TRAVA ANTI-"CONSERTO": a hora do agendamento vai SEM fuso, de propósito.
// Verificado em produção: mandamos 17:00 sem fuso, a franquia gravou 20:00Z,
// que é 17:00 em Canaã. Se alguém ler o §9.2 do guia ("convenção UTC") e
// converter pra UTC antes de mandar, TODA consulta anda 3 horas pra trás.
test('a hora vai sem fuso — converter pra UTC quebraria a agenda em 3h', async () => {
  const combinado = amanha('14:00:00');
  await SpineService.createSchedule(unidade(), {
    idClient: 991,
    dateAttendanceLocal: combinado,
    idCategory: 1,
  });

  const enviado = String(ultima().corpo.dateAttendance);
  assert.equal(enviado, combinado, 'a hora tem que sair igualzinha à combinada');
  assert.ok(!enviado.endsWith('Z'), 'não pode mandar com Z — a franquia já trata como hora local');
  assert.ok(!/[+-]\d{2}:\d{2}$/.test(enviado), 'não pode mandar com offset de fuso');

  // E a leitura de volta tem que fechar: 14:00 local vira 17:00Z lá.
  const comoAFranquiaGrava = `${enviado}-03:00`;
  assert.equal(
    SpineService.instanteNoFuso(new Date(comoAFranquiaGrava), 'America/Sao_Paulo'),
    combinado,
  );
});

test('horário quebrado (14:20) é recusado — a agenda é de 30 em 30', async () => {
  const r = await SpineService.createSchedule(unidade(), {
    idClient: 991,
    dateAttendanceLocal: amanha('14:20:00'),
    idCategory: 1,
  });
  assert.equal(r.ok, false, 'a franquia só aceita :00 e :30');
});

test('data no passado é recusada', async () => {
  const ontem = new Date(Date.now() - 86_400_000).toISOString().slice(0, 19);
  const r = await SpineService.createSchedule(unidade(), {
    idClient: 991,
    dateAttendanceLocal: ontem,
    idCategory: 1,
  });
  assert.equal(r.ok, false);
});

// ── §6: paginação ──────────────────────────────────────────────────────────

test('nenhuma busca pede mais de 100 por página', async () => {
  const u = unidade();
  await SpineService.searchClients(u, 'Maria');
  await SpineService.searchLeads(u, { initialDate: '2026-08-01', endDate: '2026-08-20' });
  await SpineService.searchSchedules(u, { initialDate: '2026-08-01', endDate: '2026-08-20', rowsPerPage: 500 });

  const buscas = chamadas.filter((c) => c.rota.endsWith('/search'));
  for (const b of buscas) {
    const p = b.corpo.pagination as { page?: number; rowsPerPage?: number } | undefined;
    if (!p) continue;
    assert.ok((p.rowsPerPage ?? 0) <= 100, `${b.rota} pediu ${p.rowsPerPage}`);
    assert.ok((p.page ?? 1) >= 1, `${b.rota} pediu page ${p.page}`);
  }
});

// ── §9.3: busca de texto exige 2 caracteres ────────────────────────────────

test('busca de paciente com 1 letra não vai pra franquia', async () => {
  const r = await SpineService.searchClients(unidade(), 'J');
  assert.equal(r.ok, false, 'deveria barrar antes de gastar a requisição');
});

// ── §10.2 / §10.7: intervalo máximo de 100 dias ────────────────────────────

test('BI recusa intervalo acima de 100 dias sem chamar a franquia', async () => {
  const antes = chamadas.length;
  const r = await SpineService.biLeadsSources(unidade(), {
    initialDate: '2026-01-01',
    endDate: '2026-12-31',
  });
  assert.equal(r.ok, false);
  assert.equal(chamadas.length, antes, 'não pode nem tentar');
});

test('busca de leads também respeita os 100 dias', async () => {
  const r = await SpineService.searchLeads(unidade(), {
    initialDate: '2026-01-01',
    endDate: '2026-12-31',
  });
  assert.equal(r.ok, false, 'intervalo de 364 dias — o guia §10.2 limita a 100');
});

// ── §10.3: cancelar e confirmar ────────────────────────────────────────────

test('cancelamento manda idSchedule no corpo do DELETE', async () => {
  const r = await SpineService.cancelSchedule(unidade(), 551);
  assert.equal(r.ok, true, r.error);
  assert.equal(ultima().corpo.idSchedule, 551);
});

test('confirmação usa PATCH em /api/schedules/confirm', async () => {
  const r = await SpineService.confirmSchedule(unidade(), 551);
  assert.equal(r.ok, true, r.error);
  assert.equal(ultima().metodo, 'PATCH');
});

// ── §13: erros vêm legíveis pra quem for ler o log ─────────────────────────

test('401 vira mensagem em português, não "Request failed"', async () => {
  const u = { ...unidade(), spineBaseUrl: `${base}/rota-que-nao-existe` } as SpineUnit;
  const r = await SpineService.ping(u);
  assert.equal(r.ok, false);
  assert.match(String(r.error), /404|endpoint/);
});
