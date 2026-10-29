import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { lerXlsx, limparAba, MAX_DESCOMPRIMIDO } from './planilha.js';
import { limparRegistro, mascararArgumentos, mascararTexto, normalizarCabecalho } from './mascaras.js';

// Reprovação do PR #160: tudo aqui é FICTÍCIO. A senha de teste tem símbolos para o `includes` não acertar por acaso.
const P = 'Zq7#Fict!x91';
const aba = (linhas: string[][]) => limparAba({ nome: 'A', linhas });
const vaza = (x: unknown) => JSON.stringify(x).includes('Zq7');

// ---------------------------------------------------------------- relatório de colunas descartadas (ALTA 1 e 2)

test('colunas descartadas: o texto da célula que motivou o descarte NUNCA vira o "cabeçalho" do relatório', () => {
  const r = aba([['Nome', 'CPF', 'INSS', 'Obs'], ['Ana Fict', '111.222.333-44', 'MinhaSenha@2024', 'a senha do gov é Gx#Fict55'], ['Bia Fict', '555.666.777-88', 'Outra#99', 'ok']]);
  const s = JSON.stringify(r);
  for (const proibido of ['MinhaSenha@2024', 'Gx#Fict55', 'Outra#99', 'a senha do gov']) assert.equal(s.includes(proibido), false, proibido);
  assert.deepEqual(r.colunasDescartadas.map((d) => d.cabecalho), ['coluna C', 'coluna D']);
});

test('colunas descartadas: nem o cabeçalho de verdade quando ele pode ser a própria senha (planilha sem linha de cabeçalho)', () => {
  const r = aba([['Ana', 'minhasenha1'], ['Bia', 'x']]);
  assert.equal(vaza(r), false);
  assert.equal(JSON.stringify(r.colunasDescartadas).includes('minhasenha1'), false);
  assert.deepEqual(r.colunasDescartadas.map((d) => d.cabecalho), ['coluna B']);
});

test('cabeçalho com caixa alternada ("SêNhA") ainda é senha, e camelCase ("meuInssPass") também', () => {
  for (const h of ['SêNhA', 'sEnHa', 'MeuInssPass', 'senhaGov']) assert.equal(vaza(aba([['Nome', h], ['Ana', P]])), false, h);
});

test('cabeçalho de senha com mais de 40 caracteres também descarta a coluna', () => {
  const cab = 'Senha do Meu INSS (atualizar quando o cliente trocar)';
  assert.ok(cab.length > 40);
  const r = aba([['Nome', 'CPF', cab], ['Ana', '111.222.333-44', P]]);
  assert.deepEqual(r.cabecalhos, ['Nome', 'CPF']);
  assert.equal(vaza(r), false);
});

test('cabeçalho de senha fora das 10 primeiras linhas (título e notas em cima) também descarta', () => {
  const linhas = [...Array.from({ length: 11 }, (_, i) => [`nota ${i}`]), ['Nome', 'Senha'], ['Ana', P]];
  assert.equal(vaza(aba(linhas)), false);
});

test('cabeçalhos de credencial sem a palavra senha: Acesso, Credenciais, Chave e INSS sozinho; "Benefício INSS" é dado e fica', () => {
  for (const h of ['Acesso', 'Credenciais', 'Chave', 'INSS', 'Gov']) {
    const r = aba([['Nome', h], ['Ana', P]]);
    assert.equal(vaza(r), false, h);
    assert.deepEqual(r.cabecalhos, ['Nome'], h);
  }
  const ok = aba([['Nome', 'Benefício INSS'], ['Ana', '123456']]);
  assert.deepEqual(ok.cabecalhos, ['Nome', 'Benefício INSS']);
});

test('"INSS", "Gov", "Acesso negado" e "Chave" como VALOR de célula não derrubam a coluna (as palavras extras valem só no cabeçalho)', () => {
  const r = aba([['Nome', 'Órgão', 'Obs'], ['Ana', 'INSS', 'Acesso negado'], ['Bia', 'Gov', 'Chave de 2ª via'], ['Cris', 'INSS', 'ok']]);
  assert.deepEqual(r.cabecalhos, ['Nome', 'Órgão', 'Obs']);
  assert.deepEqual(r.colunasDescartadas, []);
});

test('texto de senha numa célula do topo descarta a coluna, e o relatório diz que foi por isso (não pelo cabeçalho)', () => {
  const r = aba([['Nome', 'Dados'], ['Ana', `a senha é ${P}`]]);
  assert.deepEqual(r.colunasDescartadas, [{ cabecalho: 'coluna B', motivo: 'texto de senha/login nas primeiras linhas da coluna' }]);
});

test('coluna de telefone com nome ("11987654321 Maria") não é descartada pela regra dos 30%; a célula some, o telefone não vaza', () => {
  const linhas = [['Nome', 'Contato'], ...Array.from({ length: 5 }, (_, i) => [`P${i}`, `1198765432${i} Maria`])];
  const r = aba(linhas);
  assert.deepEqual(r.cabecalhos, ['Nome', 'Contato']);
  assert.equal(JSON.stringify(r).includes('9876543'), false);
});

// ---------------------------------------------------------------- CPF e senha na mesma célula (ALTA 3)

const FORMATOS: Array<[string, string]> = [
  ['barra', `111.222.333-44/${P}`],
  ['hífen', `111.222.333-44 - ${P}`],
  ['espaço', `111.222.333-44 ${P}`],
  ['dois-pontos', `111.222.333-44: ${P}`],
  ['sem pontuação e hífen', `11122233344 - ${P}`],
  ['quebra de linha', `111.222.333-44\n${P}`],
  ['senha com espaço', `111.222.333-44 ${P} com espaço`],
];

test('CPF e senha na mesma célula, qualquer separador: a célula não carrega a senha (mascararTexto em modo célula)', () => {
  for (const [nome, v] of FORMATOS) {
    const m = mascararTexto(v, 'celula');
    assert.equal(m.includes('Zq7'), false, nome);
    assert.equal(m.includes('espaço'), false, nome);
  }
});

test('CPF e senha na mesma célula: coluna toda neutra é descartada pela regra dos 30%; com 20% só a célula é omitida', () => {
  for (const [nome, v] of FORMATOS) {
    const cheia = aba([['Nome', 'Dados'], ['Ana', v], ['Bia', v]]);
    assert.equal(vaza(cheia), false, `100% ${nome}`);
    assert.deepEqual(cheia.cabecalhos, ['Nome'], `100% ${nome}`);
    const poucas = [['Nome', 'Dados'], ...Array.from({ length: 10 }, (_, i) => [`P${i}`, i < 2 ? v : `obs ${i}`])];
    assert.equal(vaza(aba(poucas)), false, `20% ${nome}`);
  }
});

test('CPF sozinho na célula (nada depois) continua só mascarado', () => {
  assert.equal(mascararTexto('111.222.333-44', 'celula'), '***.***.***-44');
  assert.equal(mascararTexto('111.222.333-44  ', 'celula'), '***.***.***-44  ');
});

test('os marcadores de omissão são idempotentes: passar a máscara duas vezes não come "senha omitido"', () => {
  const uma = mascararTexto(`x ${FORMATOS[0]![1]} y senha: ${P}`, 'celula');
  assert.equal(mascararTexto(uma, 'celula'), uma);
});

// ---------------------------------------------------------------- texto livre (MÉDIA 4 e 6)

test('CPF sem pontuação, com hífen só no fim ou com espaços, em texto livre, é mascarado (mesma cobertura do pii.ts)', () => {
  assert.equal(mascararTexto('CPF 12345678909 do autor'), 'CPF ***.***.***-09 do autor');
  assert.equal(mascararTexto('cpf: 98765432100'), 'cpf: ***.***.***-00');
  assert.equal(mascararTexto('123456789-09'), '***.***.***-09');
  assert.equal(mascararTexto('123 456 789 09'), '***.***.***-09');
  assert.equal(mascararTexto('tel 11987654321'), 'tel (**) *****-4321', 'telefone de 11 dígitos continua telefone');
  for (const s of ['5010331-15.2024.4.03.6201', '50103311520244036201', '2026-10-29', 'R$ 1.234,56', '12345678']) assert.equal(mascararTexto(s), s, s);
});

test('"senha" sem dois-pontos nem igual: "senha - X", "senha gov X", "a senha do gov é X", "senha X"', () => {
  for (const t of [`senha - ${P}`, `senha gov ${P}`, `a senha do gov é ${P}`, `senha ${P}`, `Senha do Meu INSS ${P}`, `senhas: ${P}`, `senha\n${P}`]) {
    assert.equal(mascararTexto(t).includes('Zq7'), false, t);
  }
  assert.equal(mascararTexto('cliente esqueceu a senha'), 'cliente esqueceu a senha');
  assert.equal(mascararTexto('senha: x trocar'), '[senha omitida] trocar');
});

test('NIT e RG formatados em texto não saem', () => {
  assert.equal(mascararTexto('NIT 123.45678.90-1').includes('45678'), false);
  assert.equal(mascararTexto('RG 12.345.678-9').includes('345.678'), false);
  assert.equal(mascararTexto('CNPJ 12.345.678/0001-95'), 'CNPJ 12.345.678/0001-95');
});

// ---------------------------------------------------------------- registro de API no `completo` (BAIXA 7)

test('limparRegistro: NIT, RG, CNH, CTPS e document_number saem, em qualquer profundidade e em qualquer caixa', () => {
  const r = limparRegistro({
    id: 7, name: 'Fulana Fict', birthdate: '1980-05-15',
    nit: '123.45678.90-1', NIT: '12345678901', pis: '12345678901', rg_numero: '12.345.678-9', rgOrgaoEmissor: 'SSP', document_number: '99887766', documentNumber: '99887766', cnh: '123',
    ctps_numero: '1',
    customers: [{ nit: '12345678901', rg: '1234567', outro: 'ok' }],
  });
  const s = JSON.stringify(r);
  for (const proibido of ['45678', '12345678901', '12.345.678', 'SSP', '99887766', '1234567"']) assert.equal(s.includes(proibido), false, proibido);
  assert.equal((r as { name: string }).name, 'Fulana Fict');
  // "inss", "acesso" e "chave" são dado comum em registro de API: só as chaves de credencial de verdade saem
  const comuns = limparRegistro({ inss: 'sim', acesso: '2026-10-01', chave_acesso: 'x1', orgao: 'INSS', meu_inss_pass: 'Segredo#1' }) as Record<string, string>;
  assert.deepEqual(Object.keys(comuns).sort(), ['acesso', 'chave_acesso', 'inss', 'orgao']);
  assert.equal((r as { customers: Array<{ outro: string }> }).customers[0]!.outro, 'ok');
  assert.equal(normalizarCabecalho('Meu_INSS-Pass'), 'meu inss pass');
});

// ---------------------------------------------------------------- argumentos da auditoria (MÉDIA 5)

test('mascararArgumentos: CPF digitado sem pontuação, com hífen ou com espaços não fica inteiro; o resto passa', () => {
  for (const cpf of ['12345678909', '123456789-09', '123 456 789 09', '123.456.789-09']) {
    for (const campo of ['busca', 'cpfCnpj', 'qualquer']) {
      const m = JSON.stringify(mascararArgumentos({ unidade: 'serra', maxLinhas: 5, completo: true, [campo]: cpf, lista: [`cpf ${cpf}`] }));
      assert.equal(/12345678909|123456789-09|123 456 789 09|123\.456\.789-09/.test(m), false, `${campo}: ${cpf}`);
      assert.match(m, /"unidade":"serra"/);
      assert.match(m, /"maxLinhas":5/);
    }
  }
  assert.equal(JSON.stringify(mascararArgumentos({ busca: `senha - ${P}` })).includes('Zq7'), false);
  assert.deepEqual(mascararArgumentos({ unidade: 'serra', processo: '5010331-15.2024.4.03.6201' }), { unidade: 'serra', processo: '5010331-15.2024.4.03.6201' });
});

// ---------------------------------------------------------------- teto de descompressão no zip inteiro (BAIXA 8)

function zip(entradas: Array<{ nome: string; dados: Buffer }>, armazenado = false): Buffer {
  const locais: Buffer[] = [];
  const centrais: Buffer[] = [];
  let off = 0;
  for (const e of entradas) {
    const nome = Buffer.from(e.nome);
    const comp = armazenado ? e.dados : deflateRawSync(e.dados, { level: 9 });
    const metodo = armazenado ? 0 : 8;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(metodo, 8); l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(e.dados.length, 22); l.writeUInt16LE(nome.length, 26);
    locais.push(l, nome, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(metodo, 10); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(e.dados.length, 24); c.writeUInt16LE(nome.length, 28); c.writeUInt32LE(off, 42);
    centrais.push(c, nome);
    off += 30 + nome.length + comp.length;
  }
  const cd = Buffer.concat(centrais);
  const f = Buffer.alloc(22);
  f.writeUInt32LE(0x06054b50, 0); f.writeUInt16LE(entradas.length, 8); f.writeUInt16LE(entradas.length, 10); f.writeUInt32LE(cd.length, 12); f.writeUInt32LE(off, 16);
  return Buffer.concat([...locais, cd, f]);
}

test('o teto de descompressão vale para o zip inteiro: várias abas de 15 MB (abaixo do teto cada uma) somam além dele', () => {
  const n = 3;
  const wb = Buffer.from(`<workbook xmlns:r="r"><sheets>${Array.from({ length: n }, (_, i) => `<sheet name="S${i}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  const rels = Buffer.from(`<Relationships>${Array.from({ length: n }, (_, i) => `<Relationship Id="rId${i + 1}" Target="worksheets/s${i}.xml"/>`).join('')}</Relationships>`);
  const folha = Buffer.alloc(15 * 1024 * 1024, 0x20);
  assert.ok(n * folha.length > MAX_DESCOMPRIMIDO && folha.length < MAX_DESCOMPRIMIDO);
  const grande = zip([{ nome: 'xl/workbook.xml', dados: wb }, { nome: 'xl/_rels/workbook.xml.rels', dados: rels }, ...Array.from({ length: n }, (_, i) => ({ nome: `xl/worksheets/s${i}.xml`, dados: folha }))]);
  assert.throws(() => lerXlsx(grande), /grande demais/);
  // o mesmo vale para entradas ARMAZENADAS (sem compressão), que não passam pelo inflate
  const guardado = zip([{ nome: 'xl/workbook.xml', dados: wb }, { nome: 'xl/_rels/workbook.xml.rels', dados: rels }, ...Array.from({ length: n }, (_, i) => ({ nome: `xl/worksheets/s${i}.xml`, dados: folha }))], true);
  assert.throws(() => lerXlsx(guardado), /grande demais/);
  // duas abas (30 MB no total) cabem
  const duas = zip([{ nome: 'xl/workbook.xml', dados: Buffer.from(wb.toString().replace(/<sheet name="S2"[^>]*\/>/, '')) }, { nome: 'xl/_rels/workbook.xml.rels', dados: rels }, ...[0, 1].map((i) => ({ nome: `xl/worksheets/s${i}.xml`, dados: folha }))]);
  assert.equal(lerXlsx(duas).length, 2);
});
