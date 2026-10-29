import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { ErroPlanilha, idDaPlanilha, interpretarChavePlanilha, lerPlanilhaPublica, lerXlsx, limparAba, testarChavePlanilha } from './planilha.js';
import { xlsxFalso } from './xlsx-falso.js';

// Planilha FICTÍCIA: nomes, CPFs e senhas inventados. Nunca a planilha real de ninguém.
const SENHA_1 = 'Fic$enha-Um-9981';
const SENHA_2 = 'zz-outra-8842';
const COLADO = '111.222.333-44/Fic$enha-Colada-7';

const CLIENTES = xlsxFalso([
  {
    nome: 'Clientes',
    linhas: [
      ['Nome', 'CPF', 'Telefone', 'Senha Meu INSS', 'Situação', 'Observações'],
      ['Maria Souza', '12345678909', '(11) 98765-4321', SENHA_1, 'Em análise', 'Ligar depois & confirmar <rg>'],
      ['João Lima', '987.654.321-00', 11912345678, SENHA_2, 'Concedido', `acesso ${COLADO}`],
      ['Pedro Alves', '55566677788', '1133334444', '', 'Em análise', 'retorno em 30 dias'],
      ['Lia Prado', null, '', '', 'Em análise', 'ok'],
      [],
      ['Ana Reis', null, '', '', 'Indeferido', ''],
    ],
  },
  { nome: 'Escondida', escondida: true, linhas: [['Segredo'], ['não deve aparecer']] },
  { nome: 'Datas', linhas: [['Evento', 'Quando'], ['Audiência', { data: 46000 }]] },
]);

function jsonDe(x: unknown) {
  return JSON.stringify(x);
}

test('lê as abas do xlsx, com texto compartilhado, entidades XML, linha vazia e data com estilo', () => {
  const abas = lerXlsx(CLIENTES);
  assert.deepEqual(abas.map((a) => a.nome), ['Clientes', 'Datas'], 'aba escondida fica de fora');
  const c = abas[0]!;
  assert.deepEqual(c.linhas[0], ['Nome', 'CPF', 'Telefone', 'Senha Meu INSS', 'Situação', 'Observações']);
  assert.equal(c.linhas[1]![5], 'Ligar depois & confirmar <rg>');
  assert.equal(c.linhas[2]![2], '11912345678');
  assert.equal(abas[1]!.linhas[1]![1], '2025-12-09', 'serial 46000 com formato dd/mm/yyyy vira data');
});

test('lê também texto "inline" e rejeita arquivo que não é xlsx', () => {
  const inline = xlsxFalso([{ nome: 'A', formaAlternativa: 'inline', linhas: [['x', 'y']] }]);
  assert.deepEqual(lerXlsx(inline)[0]!.linhas[0], ['x', 'y']);
  assert.throws(() => lerXlsx(Buffer.from('<html>faça login</html>')), ErroPlanilha);
  assert.throws(() => lerXlsx(CLIENTES.subarray(0, 100)), ErroPlanilha);
});

test('xlsx que descomprime além do teto (zip bomb) é recusado', () => {
  const gigante = deflateRawSync(Buffer.alloc(80 * 1024 * 1024, 'a'));
  const nome = Buffer.from('xl/workbook.xml');
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(gigante.length, 18);
  local.writeUInt32LE(100, 22); // mente sobre o tamanho
  local.writeUInt16LE(nome.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(gigante.length, 20);
  central.writeUInt32LE(100, 24);
  central.writeUInt16LE(nome.length, 28);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(1, 8);
  fim.writeUInt16LE(1, 10);
  fim.writeUInt32LE(46 + nome.length, 12);
  fim.writeUInt32LE(30 + nome.length + gigante.length, 16);
  assert.throws(() => lerXlsx(Buffer.concat([local, nome, gigante, central, nome, fim])), ErroPlanilha);
});

test('limparAba: a coluna de senha é DESCARTADA e o valor dela não aparece em lugar nenhum', () => {
  const aba = limparAba(lerXlsx(CLIENTES)[0]!);
  assert.deepEqual(aba.cabecalhos, ['Nome', 'CPF', 'Telefone', 'Situação', 'Observações']);
  assert.equal(aba.colunasDescartadas.length, 1);
  assert.equal(aba.colunasDescartadas[0]!.cabecalho, 'Senha Meu INSS');
  const tudo = jsonDe(aba);
  for (const proibido of [SENHA_1, SENHA_2, 'Fic$enha-Colada-7', '12345678909', '987.654.321-00', '98765-4321', '11912345678']) {
    assert.equal(tudo.includes(proibido), false, `vazou: ${proibido}`);
  }
});

test('limparAba: CPF e telefone mascarados; CPF+senha colados numa célula de texto livre saem omitidos', () => {
  const aba = limparAba(lerXlsx(CLIENTES)[0]!);
  assert.deepEqual(aba.linhas[0], ['Maria Souza', '***.***.***-09', '(**) *****-4321', 'Em análise', 'Ligar depois & confirmar <rg>']);
  assert.equal(aba.linhas[1]![1], '***.***.***-00');
  assert.equal(aba.linhas[1]![2], '(**) *****-5678');
});

test('limparAba: coluna sem cabeçalho de senha mas com valor CPF/senha colado é descartada inteira (as outras células dela podem ser só a senha)', () => {
  const aba = limparAba({
    nome: 'X',
    linhas: [
      ['Nome', 'Acesso'],
      ['Maria', COLADO],
      ['João', 'Zx-77-ab9'],
    ],
  });
  assert.deepEqual(aba.cabecalhos, ['Nome']);
  assert.match(aba.colunasDescartadas[0]!.motivo, /CPF\/senha/);
  assert.equal(jsonDe(aba).includes('Zx-77-ab9'), false);
});

test('limparAba: sem linha de cabeçalho de verdade, o CPF/senha colado na 1ª linha também não passa', () => {
  const aba = limparAba({ nome: 'X', linhas: [[COLADO, 'Maria'], ['x', 'y']] });
  assert.equal(jsonDe(aba).includes('Fic$enha-Colada-7'), false);
});

test('limparAba: título e legenda acima do cabeçalho não escondem a coluna de senha (senha só em texto puro, sem CPF colado)', () => {
  const aba = limparAba({
    nome: 'X',
    linhas: [
      ['Cadastro de clientes 2026'],
      ['Atualizado em 10/2026'],
      ['Nome', 'CPF', 'Senha Meu INSS', 'Situação'],
      ['Maria', '12345678909', 'so-a-senha-111', 'Em análise'],
      ['João', '98765432100', 'outra-senha-222', 'Concedido'],
    ],
  });
  assert.deepEqual(aba.cabecalhos, ['Nome', 'CPF', 'Situação']);
  assert.equal(jsonDe(aba).includes('so-a-senha-111'), false);
  assert.equal(jsonDe(aba).includes('outra-senha-222'), false);
  assert.deepEqual(aba.numerosDasLinhas, [4, 5], 'o número é o da planilha do Google, não o da lista');
});

test('limparAba: o texto da coluna de senha é achado mesmo se o cabeçalho real não for a linha escolhida', () => {
  // cabeçalho "Nome | Senha" tem 2 células e a linha de dados abaixo tem 4: o corte de 60% elege a de dados
  const aba = limparAba({
    nome: 'X',
    linhas: [
      ['Nome', '', 'Senha', ''],
      ['Maria', 'a', 'minha-senha-333', 'b'],
      ['João', 'c', 'senha-do-joao-444', 'd'],
    ],
  });
  assert.equal(jsonDe(aba).includes('minha-senha-333'), false);
  assert.equal(jsonDe(aba).includes('senha-do-joao-444'), false);
});

test('limparAba: linhas em branco no meio não deslocam o número da linha', () => {
  const aba = limparAba({ nome: 'X', linhas: [['A', 'B'], ['1', '2'], [], ['3', '4'], ['', ''], ['5', '6']] });
  assert.deepEqual(aba.numerosDasLinhas, [2, 4, 6]);
  assert.deepEqual(aba.linhas, [['1', '2'], ['3', '4'], ['5', '6']]);
});

test('limparAba: cabeçalho vazio ou repetido ganha nome; linhas em branco somem; conta o total', () => {
  const aba = limparAba({ nome: 'X', linhas: [['A', '', 'A'], ['1', '2', '3'], [], ['', '', ''], ['4', '5', '6']] });
  assert.deepEqual(aba.cabecalhos, ['A', 'coluna B', 'A (2)']);
  assert.equal(aba.linhasTotal, 2);
  assert.equal(aba.truncado, false);
});

test('id da planilha: aceita o id puro ou a URL, e recusa o que não parece id (nada de montar URL com texto livre)', () => {
  const id = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';
  assert.equal(idDaPlanilha(id), id);
  assert.equal(idDaPlanilha(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=0#gid=0`), id);
  assert.throws(() => idDaPlanilha('../../etc/passwd'), ErroPlanilha);
  assert.throws(() => idDaPlanilha('curto'), ErroPlanilha);
  assert.throws(() => idDaPlanilha(`${id}/export?x=1`), ErroPlanilha);
});

test('chave do cofre: "apelido=id;outro=url", modo público; JSON de conta de serviço é o gancho (ainda não lê)', () => {
  const a = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';
  const b = 'B1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';
  assert.deepEqual(interpretarChavePlanilha(`clientes=${a}; https://docs.google.com/spreadsheets/d/${b}/edit?gid=3`), [
    { apelido: 'clientes', id: a, modo: 'publico' },
    { apelido: 'planilha 2', id: b, modo: 'publico' },
  ]);
  assert.deepEqual(interpretarChavePlanilha(a), [{ apelido: 'principal', id: a, modo: 'publico' }]);
  assert.throws(() => interpretarChavePlanilha('{"type":"service_account","private_key":"x"}'), /conta de serviço/);
  assert.throws(() => interpretarChavePlanilha('   '), ErroPlanilha);
});

const ID = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v';

function fetcherQue(resp: () => Response, chamadas: string[] = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push(`${init?.method ?? 'GET'} ${String(url)}`);
    return resp();
  }) as typeof fetch;
}

test('planilha pública: GET no export xlsx do Google, só leitura, e já devolve limpa', async () => {
  const chamadas: string[] = [];
  const p = await lerPlanilhaPublica(ID, fetcherQue(() => new Response(new Uint8Array(CLIENTES), { status: 200 }), chamadas));
  assert.deepEqual(chamadas, [`GET https://docs.google.com/spreadsheets/d/${ID}/export?format=xlsx`]);
  assert.deepEqual(p.abas.map((a) => a.nome), ['Clientes', 'Datas']);
  assert.equal(jsonDe(p).includes(SENHA_1), false);
});

test('planilha privada: o Google devolve a página de login; a mensagem explica e não despeja o HTML', async () => {
  const html = '<html><body>Faça login em accounts.google.com — conteúdo qualquer</body></html>';
  await assert.rejects(lerPlanilhaPublica(ID, fetcherQue(() => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }))), (e: Error) => {
    assert.match(e.message, /qualquer pessoa com o link/);
    assert.equal(e.message.includes('accounts.google.com'), false);
    return true;
  });
  await assert.rejects(lerPlanilhaPublica(ID, fetcherQue(() => new Response('nope', { status: 403 }))), /qualquer pessoa com o link/);
  await assert.rejects(lerPlanilhaPublica(ID, fetcherQue(() => new Response('nope', { status: 404 }))), /não encontrada/);
});

test('arquivo grande demais é recusado sem carregar tudo', async () => {
  const grande = new Response(new Uint8Array(30 * 1024 * 1024), { status: 200 });
  await assert.rejects(lerPlanilhaPublica(ID, fetcherQue(() => grande)), /grande demais/);
});

test('teste da chave: confere que lê e devolve só nomes das abas e contagem, nunca conteúdo', async () => {
  const r = await testarChavePlanilha(`clientes=${ID}`, fetcherQue(() => new Response(new Uint8Array(CLIENTES), { status: 200 })));
  assert.match(r, /Planilha · clientes · 2 abas/);
  assert.match(r, /Clientes/);
  for (const proibido of ['Maria', SENHA_1, 'Souza']) assert.equal(r.includes(proibido), false);
});
