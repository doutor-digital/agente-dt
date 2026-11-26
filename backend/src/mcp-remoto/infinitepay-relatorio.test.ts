import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CofreDeArquivos } from './cofre-arquivos.js';
import { criarContextoInfinitepay, type ContaInfinitepay } from './infinitepay.js';
import {
  LEIAUTES_CSV, centavosDoTexto, chavesDosMovimentos, coberturaDoPeriodo, dataDoOfx, decodificar, descricaoSegura, importarRelatorio, lerCsv, lerOfx, lerRelatorio, totaisDasVendas, totaisDoExtrato,
  type ImportacaoGuardada, type LeiauteCsv,
} from './infinitepay-relatorio.js';
import { relatoriosEmMemoria } from './infinitepay-relatorio-armazem.js';
import {
  COMO_EXPORTAR, importarEnvio, infinitepayExtrato, infinitepayImportacoes, infinitepayVendas, pedirRelatorio, registrarImportacaoRelatoriosSePermitido, registrarLeituraRelatorios,
} from './infinitepay-relatorio-ferramentas.js';

const UNI = 'doutor-hernia-acailandia';

// ----------------------------------------------------------------- amostras (SINTÉTICAS: escritas pela especificação do OFX, não são da InfinitePay)
const OFX_V1 = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20261126120000[-3:BRT]<LANGUAGE>POR</SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>BRL
<BANKACCTFROM><BANKID>0001<ACCTID>987654321<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261101000000[-3:BRT]<DTEND>20261115235959[-3:BRT]
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261103120000[-3:BRT]<TRNAMT>1500.50<FITID>A1<MEMO>Venda cartao credito 3x
</STMTTRN>
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261104<TRNAMT>200.00<FITID>A2<NAME>PIX RECEBIDO<MEMO>MARIA SOUZA CPF 52998224725
</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261110<TRNAMT>-350,25<FITID>A3<MEMO>Transferencia enviada
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>1350.25<DTASOF>20261115</LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>
`;

const OFX_V2 = `<?xml version="1.0" encoding="UTF-8"?>
<?OFX OFXHEADER="200" VERSION="211" SECURITY="NONE" OLDFILEUID="NONE" NEWFILEUID="NONE"?>
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST><DTSTART>20261116</DTSTART><DTEND>20261130</DTEND>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261120</DTPOSTED><TRNAMT>99.90</TRNAMT><FITID>B1</FITID><MEMO>Link de pagamento</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261125</DTPOSTED><TRNAMT>10.00</TRNAMT><FITID>B2</FITID><MEMO>Pix</MEMO></STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>
`;

// ----------------------------------------------------------------- números e textos

test('centavosDoTexto: formatos brasileiro e americano, sinal, parênteses e lixo', () => {
  assert.equal(centavosDoTexto('1500.50'), 150050);
  assert.equal(centavosDoTexto('1.500,50'), 150050);
  assert.equal(centavosDoTexto('R$ 10,00'), 1000);
  assert.equal(centavosDoTexto('-350,25'), -35025);
  assert.equal(centavosDoTexto('(12,00)'), -1200);
  assert.equal(centavosDoTexto('1,234'), 123400, '1,234 com 3 casas depois da vírgula é milhar');
  assert.equal(centavosDoTexto('abc'), undefined);
  assert.equal(centavosDoTexto(''), undefined);
  assert.equal(centavosDoTexto('99999999999'), undefined, 'valor absurdo é recusado');
});

test('centavosDoTexto com pontoEhMilhar (CSV em português): "1.500" é mil e quinhentos, "12.5" não é número; sem a opção o ponto continua decimal (OFX)', () => {
  assert.equal(centavosDoTexto('1.500', { pontoEhMilhar: true }), 150000);
  assert.equal(centavosDoTexto('1.234.567', { pontoEhMilhar: true }), 123456700);
  assert.equal(centavosDoTexto('12.5', { pontoEhMilhar: true }), undefined);
  assert.equal(centavosDoTexto('1.500,50', { pontoEhMilhar: true }), 150050);
  assert.equal(centavosDoTexto('1.500'), 150, 'sem a opção: o ponto é decimal, como o OFX escreve');
});

test('texto em Windows-1252 (OFX com CHARSET:1252, CSV do Excel) não vira lixo; UTF-8 continua UTF-8', () => {
  assert.equal(decodificar(Buffer.from([0x54, 0x72, 0x61, 0x6e, 0x73, 0x66, 0x65, 0x72, 0xea, 0x6e, 0x63, 0x69, 0x61])), 'Transferência');
  assert.equal(decodificar(Buffer.from('Transferência José', 'utf8')), 'Transferência José');
});

test('descrição: CPF, telefone e e-mail saem mascarados; texto longo é cortado', () => {
  const d = descricaoSegura('PIX de MARIA CPF 529.982.247-25 fone 63 99999-8888 maria@exemplo.com');
  assert.equal(d.includes('52998'), false);
  assert.equal(d.includes('99999'), false);
  assert.equal(d.includes('@'), false);
  assert.match(d, /MARIA/);
  assert.equal(descricaoSegura('x'.repeat(500)).length, 200);
});

// ----------------------------------------------------------------- OFX

test('OFX v1 (SGML): lê data, valor com sinal (ponto ou vírgula), FITID e período; não lê conta nem agência', () => {
  const r = lerOfx(OFX_V1);
  assert.equal(r.ignoradas, 0);
  assert.deepEqual(r.linhas.map((l) => [l.data, l.valorCentavos, l.idExterno]), [['2026-11-03', 150050, 'A1'], ['2026-11-04', 20000, 'A2'], ['2026-11-10', -35025, 'A3']]);
  assert.equal(r.periodoInicio, '2026-11-01');
  assert.equal(r.periodoFim, '2026-11-15');
  const todo = JSON.stringify(r);
  assert.equal(todo.includes('987654321'), false, 'número da conta nunca é lido');
  assert.equal(todo.includes('52998224725'), false, 'documento na descrição sai mascarado');
  assert.match(r.linhas[1]!.descricao, /PIX RECEBIDO - MARIA SOUZA/);
});

test('OFX v2 (XML): mesma leitura, sem tratar o arquivo como XML', () => {
  const r = lerOfx(OFX_V2);
  assert.equal(r.linhas.length, 2);
  assert.equal(r.periodoInicio, '2026-11-16');
  assert.equal(r.periodoFim, '2026-11-30');
  assert.equal(r.linhas[0]!.valorCentavos, 9990);
});

test('OFX: lançamento sem data ou sem valor é CONTADO como ignorado, nunca adivinhado; arquivo que não é OFX é recusado', () => {
  const ruim = OFX_V1.replace('<DTPOSTED>20261104<TRNAMT>200.00', '<DTPOSTED>20269999<TRNAMT>200.00').replace('<TRNAMT>-350,25', '<TRNAMT>quase');
  const r = lerOfx(ruim);
  assert.equal(r.linhas.length, 1);
  assert.equal(r.ignoradas, 2);
  assert.throws(() => lerOfx('data;valor\n2026-11-01;10'), /não parece um arquivo OFX/);
});

test('FITID repetido em lançamentos DIFERENTES (contador que recomeça todo mês) não os apaga; o mesmo lançamento que reaparece continua sendo reconhecido', () => {
  const nov = lerOfx(OFX_V1.replace('<FITID>A1', '<FITID>1').replace('<FITID>A2', '<FITID>2').replace('<FITID>A3', '<FITID>3'));
  const dez = lerOfx(OFX_V1.replace(/20261103/, '20261203').replace(/20261104/, '20261204').replace(/20261110/, '20261210').replace('<FITID>A1', '<FITID>1').replace('<FITID>A2', '<FITID>2').replace('<FITID>A3', '<FITID>3'));
  const kNov = chavesDosMovimentos(nov.linhas);
  const kDez = chavesDosMovimentos(dez.linhas);
  assert.equal(kNov.filter((k) => kDez.includes(k)).length, 0, 'mesmo FITID, outro dia: chaves diferentes');
  assert.deepEqual(chavesDosMovimentos(nov.linhas), kNov, 'o mesmo arquivo dá as mesmas chaves');
});

test('OFX sem FITID: a chave é o hash da linha com a ORDEM entre linhas iguais, então duas vendas iguais no mesmo dia não viram uma', () => {
  const sem = lerOfx(
    OFX_V1.replace(/<FITID>A\d/g, '')
      .replace('<TRNAMT>200.00', '<TRNAMT>1500.50')
      .replace('<NAME>PIX RECEBIDO<MEMO>MARIA SOUZA CPF 52998224725', '<MEMO>Venda cartao credito 3x')
      .replace('<DTPOSTED>20261104', '<DTPOSTED>20261103'),
  );
  const chaves = chavesDosMovimentos(sem.linhas);
  assert.equal(new Set(chaves).size, chaves.length);
  assert.equal(chaves[0]!.endsWith('#1'), true);
  assert.equal(chaves[1]!.endsWith('#2'), true);
  assert.equal(chaves[0]!.slice(0, -2), chaves[1]!.slice(0, -2), 'mesma linha, ordens diferentes');
});

// ----------------------------------------------------------------- CSV

test('CSV: aspas, aspas duplas, quebra dentro do campo, BOM e delimitador pela primeira linha', () => {
  const r = lerCsv('﻿Data;Descrição;Valor\r\n01/11/2026;"Venda; com ponto e vírgula";"1.500,50"\r\n02/11/2026;"linha\ncom quebra";10,00\r\n03/11/2026;"aspas ""duplas""";1,00');
  assert.equal(r.delimitador, ';');
  assert.deepEqual(r.cabecalho, ['Data', 'Descrição', 'Valor']);
  assert.equal(r.linhas.length, 3);
  assert.equal(r.linhas[0]![1], 'Venda; com ponto e vírgula');
  assert.equal(r.linhas[1]![1], 'linha\ncom quebra');
  assert.equal(r.linhas[2]![1], 'aspas "duplas"');
  assert.equal(lerCsv('a,b\n1,2').delimitador, ',');
  assert.equal(lerCsv('a\tb\n1\t2').delimitador, '\t');
  assert.throws(() => lerCsv('a;b\n"aberta;2'), /cortado ou corrompido/);
});

// ----------------------------------------------------------------- importar

const buf = (s: string) => Buffer.from(s, 'utf8');

test('importar OFX: grava as linhas, devolve período e totais; o mesmo arquivo de novo não muda nada', async () => {
  const arm = relatoriosEmMemoria();
  const r = await importarRelatorio(arm, { unidade: UNI, relatorio: 'extrato', tipoDoCofre: 'ofx', conteudo: buf(OFX_V1), importadoPor: 'lia@x.com' });
  assert.ok(r.importado);
  if (!r.importado) return;
  assert.equal(r.importacao.linhasLidas, 3);
  assert.equal(r.importacao.linhasNovas, 3);
  assert.equal(r.importacao.periodoInicio, '2026-11-01');
  assert.deepEqual(r.totais, { entradas: 1700.5, saidas: -350.25, liquido: 1350.25 });
  const de_novo = await importarRelatorio(arm, { unidade: UNI, relatorio: 'extrato', tipoDoCofre: 'ofx', conteudo: buf(OFX_V1), importadoPor: 'lia@x.com' });
  assert.equal(de_novo.importado, false);
  assert.equal(arm.importacoesGravadas.length, 1);
  assert.equal((await arm.movimentos({ unidade: UNI, limite: 100 })).length, 3);
});

test('arquivos que se sobrepõem: o lançamento que repete (mesmo FITID) não entra duas vezes e conta como repetido', async () => {
  const arm = relatoriosEmMemoria();
  await importarRelatorio(arm, { unidade: UNI, relatorio: 'extrato', tipoDoCofre: 'ofx', conteudo: buf(OFX_V1), importadoPor: 'x' });
  const sobreposto = OFX_V1.replace('<DTEND>20261115235959[-3:BRT]', '<DTEND>20261120').replace('</BANKTRANLIST>', '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261118<TRNAMT>50.00<FITID>A9<MEMO>novo\n</STMTTRN></BANKTRANLIST>');
  const r = await importarRelatorio(arm, { unidade: UNI, relatorio: 'extrato', tipoDoCofre: 'ofx', conteudo: buf(sobreposto), importadoPor: 'x' });
  assert.ok(r.importado);
  if (!r.importado) return;
  assert.equal(r.importacao.linhasLidas, 4);
  assert.equal(r.importacao.linhasNovas, 1);
  assert.equal(r.importacao.linhasRepetidas, 3);
  assert.equal((await arm.movimentos({ unidade: UNI, limite: 100 })).length, 4);
});

test('o MESMO arquivo já importado em OUTRA unidade é recusado (relatório de uma clínica na conta de outra dobraria o dinheiro)', async () => {
  const arm = relatoriosEmMemoria();
  await importarRelatorio(arm, { unidade: UNI, relatorio: 'extrato', tipoDoCofre: 'ofx', conteudo: buf(OFX_V1), importadoPor: 'x' });
  const outra = await importarRelatorio(arm, { unidade: 'doutor-hernia-serra', relatorio: 'extrato', tipoDoCofre: 'ofx', conteudo: buf(OFX_V1), importadoPor: 'x' });
  assert.equal(outra.importado, false);
  if (outra.importado || outra.motivo !== 'arquivo_de_outra_unidade') throw new Error('esperava arquivo_de_outra_unidade');
  assert.deepEqual(outra.unidades, [UNI]);
  assert.match(outra.aviso, /dobra o dinheiro/);
  assert.equal((await arm.movimentos({ unidade: 'doutor-hernia-serra', limite: 100 })).length, 0, 'nada entrou na segunda unidade');
  assert.equal((await arm.importacoes('doutor-hernia-serra')).length, 0);
  assert.equal((await arm.importacoes(UNI)).length, 1);
  // na MESMA unidade continua sendo "já importado", não "outra unidade"
  const mesma = await importarRelatorio(arm, { unidade: UNI, relatorio: 'extrato', tipoDoCofre: 'ofx', conteudo: buf(OFX_V1), importadoPor: 'x' });
  assert.equal(!mesma.importado && mesma.motivo, 'ja_importado');
});

// ----------------------------------------------------------------- conta (ACCTID)

const COM_CONTA = (acct: string, extra = '') => OFX_V1.replace('<ACCTID>987654321', `<ACCTID>${acct}`).replace('<FITID>A1', `<FITID>A1${extra}`);

test('ACCTID é lido só como hash + final: o número da conta não aparece em lugar nenhum do resultado', () => {
  const r = lerOfx(OFX_V1);
  assert.equal(r.conta?.final, '4321');
  assert.match(r.conta!.hash, /^[0-9a-f]{32}$/);
  assert.equal(JSON.stringify(r).includes('987654321'), false);
  assert.notEqual(lerOfx(COM_CONTA('111111111')).conta!.hash, r.conta!.hash);
  assert.equal(lerOfx(OFX_V1.replace(/<BANKACCTFROM>.*<\/BANKACCTFROM>/, '')).conta, undefined, 'sem ACCTID, sem conta');
  assert.throws(() => lerOfx(OFX_V1.replace('</BANKTRANLIST>', '</BANKTRANLIST><BANKACCTFROM><ACCTID>555555555</BANKACCTFROM>')), /MAIS DE UMA conta/);
});

test('extrato de OUTRA conta que a já importada da unidade: recusado sem gravar; com aceitarOutraConta passa, avisa e registra as duas contas', async () => {
  const arm = relatoriosEmMemoria();
  const base = { unidade: UNI, relatorio: 'extrato' as const, tipoDoCofre: 'ofx' as const, importadoPor: 'x' };
  assert.ok((await importarRelatorio(arm, { ...base, conteudo: buf(OFX_V1) })).importado);
  const outra = buf(COM_CONTA('111112222', 'z').replace('<DTSTART>20261101000000[-3:BRT]<DTEND>20261115235959[-3:BRT]', '<DTSTART>20261201<DTEND>20261215'));
  const r = await importarRelatorio(arm, { ...base, conteudo: outra });
  assert.equal(r.importado, false);
  if (r.importado || r.motivo !== 'outra_conta') throw new Error('esperava outra_conta');
  assert.match(r.aviso, /OUTRA conta \(final 2222\).*final 4321/);
  assert.match(r.proximoPasso, /aceitarOutraConta=true/);
  assert.equal(JSON.stringify(r).includes('111112222'), false, 'o número da conta nunca sai');
  assert.equal(arm.importacoesGravadas.length, 1, 'nada foi gravado');
  const aceita = await importarRelatorio(arm, { ...base, conteudo: outra, aceitarOutraConta: true });
  assert.ok(aceita.importado);
  if (aceita.importado) assert.match(String(aceita.aviso), /conta nova para esta unidade \(final 2222\).*DUAS contas/);
  // depois de aceita, a conta passa a ser conhecida: o próximo arquivo dela entra sem pedir nada
  const terceira = buf(COM_CONTA('111112222', 'y').replace('<DTSTART>20261101000000[-3:BRT]<DTEND>20261115235959[-3:BRT]', '<DTSTART>20261216<DTEND>20261231'));
  const t = await importarRelatorio(arm, { ...base, conteudo: terceira });
  assert.ok(t.importado);
  // a mesma conta de sempre nunca é recusada
  assert.ok(arm.importacoesGravadas.every((i) => i.contaFinal));
});

test('arquivo sem ACCTID: importa, mas avisa que não deu para conferir a conta', async () => {
  const arm = relatoriosEmMemoria();
  const sem = OFX_V1.replace(/<BANKACCTFROM>.*<\/BANKACCTFROM>/, '');
  const r = await importarRelatorio(arm, { unidade: UNI, relatorio: 'extrato', tipoDoCofre: 'ofx', conteudo: buf(sem), importadoPor: 'x' });
  assert.ok(r.importado);
  if (r.importado) assert.match(String(r.aviso), /não declara a conta/);
});

test('período que se SOBREPÕE com lançamentos novos de outro identificador: avisa (risco de contar em dobro); sem sobreposição, não', async () => {
  const arm = relatoriosEmMemoria();
  const base = { unidade: UNI, relatorio: 'extrato' as const, tipoDoCofre: 'ofx' as const, importadoPor: 'x' };
  await importarRelatorio(arm, { ...base, conteudo: buf(OFX_V1) });
  // os MESMOS 3 lançamentos com FITID diferentes, período que se sobrepõe: entram como novos e é exatamente o risco
  const refeito = OFX_V1.replace(/<FITID>A(\d)/g, '<FITID>B$1').replace('<DTEND>20261115235959[-3:BRT]', '<DTEND>20261118');
  const r = await importarRelatorio(arm, { ...base, conteudo: buf(refeito) });
  assert.ok(r.importado);
  if (!r.importado) return;
  assert.equal(r.importacao.linhasNovas, 3);
  assert.match(String(r.aviso), /SE SOBREPÕE a um já importado e 3 linha\(s\) entraram como novas.*contados em dobro/);
  // período seguinte, sem encostar: sem esse aviso
  const dezembro = OFX_V1.replace(/<FITID>A(\d)/g, '<FITID>C$1').replace('<DTSTART>20261101000000[-3:BRT]<DTEND>20261115235959[-3:BRT]', '<DTSTART>20261201<DTEND>20261215').replace(/20261103|20261104|20261110/g, '20261205');
  const d = await importarRelatorio(arm, { ...base, conteudo: buf(dezembro) });
  assert.ok(d.importado);
  if (d.importado) assert.doesNotMatch(String(d.aviso ?? ''), /SOBREPÕE/);
});

// ----------------------------------------------------------------- fuso do DTPOSTED

test('DTPOSTED: o deslocamento entre colchetes é respeitado e o dia é o de Brasília; sem ele a data vale como está', () => {
  assert.equal(dataDoOfx('20261103'), '2026-11-03');
  assert.equal(dataDoOfx('20261103120000'), '2026-11-03', 'hora sem fuso: o dia como está');
  assert.equal(dataDoOfx('20261103235900[-3:BRT]'), '2026-11-03', 'já é Brasília');
  assert.equal(dataDoOfx('20261104010000[0:GMT]'), '2026-11-03', '01h00 GMT de 04/11 = 22h00 de 03/11 em Brasília');
  assert.equal(dataDoOfx('20261104020000[0:GMT]'), '2026-11-03', '23h00 de 03/11 em Brasília');
  assert.equal(dataDoOfx('20261104030000[0:GMT]'), '2026-11-04', '00h00 de 04/11 em Brasília');
  assert.equal(dataDoOfx('20261103120000[0:GMT]'), '2026-11-03', 'o meio-dia GMT que os bancos usam para "só a data" fica no mesmo dia');
  assert.equal(dataDoOfx('20261103230000[-5:EST]'), '2026-11-04', '23h EST = 01h do dia seguinte em Brasília');
  assert.equal(dataDoOfx('20261103120000.000[-3:BRT]'), '2026-11-03', 'milésimos');
  assert.equal(dataDoOfx('20261103120000[5.5:IST]'), '2026-11-03', 'deslocamento fracionário');
  assert.equal(dataDoOfx('20261103250000[0:GMT]'), '2026-11-03', 'hora impossível: cai no dia escrito, sem inventar');
  assert.equal(dataDoOfx('20261103120000[99:XXX]'), '2026-11-03', 'deslocamento impossível: idem');
  assert.equal(dataDoOfx('20269999'), undefined);
  assert.equal(dataDoOfx(undefined), undefined);
});

test('OFX com DTPOSTED em GMT: o lançamento da noite de Brasília fica no dia certo', () => {
  const r = lerOfx(OFX_V1.replace('<DTPOSTED>20261104<TRNAMT>200.00', '<DTPOSTED>20261104010000[0:GMT]<TRNAMT>200.00'));
  assert.equal(r.linhas[1]!.data, '2026-11-03');
});

// ----------------------------------------------------------------- tempo linear (o arquivo vem de fora)

test('descricaoSegura é LINEAR: 100 mil caracteres, de qualquer forma, em menos de 50 ms (a regex de e-mail antiga levava 3,3 s com 20 mil)', () => {
  const casos: Record<string, string> = {
    'a sem espaço': 'a'.repeat(100_000),
    'arrobas': '@'.repeat(100_000),
    'a@ alternado': 'a@'.repeat(50_000),
    'a. alternado': 'a.'.repeat(50_000),
    'x@y. sem fim': `x@${'y.'.repeat(50_000)}`,
    'dígitos': '1'.repeat(100_000),
    'dígitos e separadores': '1 '.repeat(50_000),
    'espaços': ' '.repeat(100_000),
    'palavras': 'maria souza '.repeat(8_000),
  };
  for (const [nome, texto] of Object.entries(casos)) {
    const t0 = performance.now();
    const saida = descricaoSegura(texto);
    const ms = performance.now() - t0;
    assert.ok(ms < 50, `${nome}: ${ms.toFixed(1)} ms`);
    assert.ok(saida.length <= 200, nome);
  }
  assert.equal(descricaoSegura('PIX maria@exemplo.com.br pago'), 'PIX [e-mail] pago');
  assert.equal(descricaoSegura('a@@b.c'), '[e-mail]');
});

test('um OFX com 20 mil caracteres no NAME e no MEMO é lido em tempo curto, sem travar', () => {
  const grande = OFX_V1.replace('<NAME>PIX RECEBIDO<MEMO>MARIA SOUZA CPF 52998224725', `<NAME>${'a@'.repeat(10_000)}<MEMO>${'b.'.repeat(10_000)}`);
  const t0 = performance.now();
  const r = lerOfx(grande);
  assert.ok(performance.now() - t0 < 200);
  assert.ok(r.linhas.every((l) => l.descricao.length <= 200));
});

test('OFX só vale para extrato: para vendas manda usar o CSV (nada é gravado)', async () => {
  const arm = relatoriosEmMemoria();
  await assert.rejects(() => importarRelatorio(arm, { unidade: UNI, relatorio: 'vendas', tipoDoCofre: 'ofx', conteudo: buf(OFX_V1), importadoPor: 'x' }), /use o CSV/);
  assert.equal(arm.importacoesGravadas.length, 0);
});

test('CSV de leiaute DESCONHECIDO: nada é gravado, só o cabeçalho volta (nunca as linhas), e o mesmo arquivo pode ser importado depois', async () => {
  const arm = relatoriosEmMemoria();
  const csv = 'Data;Valor bruto;Taxa;Pagador\n01/11/2026;100,00;3,50;MARIA SOUZA 52998224725\n02/11/2026;50,00;1,00;JOSE';
  const r = await importarRelatorio(arm, { unidade: UNI, relatorio: 'vendas', tipoDoCofre: 'csv', conteudo: buf(csv), importadoPor: 'x' });
  assert.equal(r.importado, false);
  if (r.importado || r.motivo !== 'leiaute_desconhecido') throw new Error('esperava leiaute_desconhecido');
  assert.deepEqual(r.cabecalho, ['Data', 'Valor bruto', 'Taxa', 'Pagador']);
  assert.equal(r.linhasNoArquivo, 2);
  assert.equal(JSON.stringify(r).includes('MARIA'), false, 'nenhuma linha de dados vai na resposta');
  assert.equal(r.semCabecalho, false);
  assert.equal(arm.importacoesGravadas.length, 0);
  assert.equal(arm.shas.size, 0, 'não conta como importado: depois do leiaute cadastrado entra normalmente');
});

test('CSV SEM cabeçalho: a primeira linha é dado e NÃO volta ao chat (nem nome, nem documento, nem valor)', async () => {
  const arm = relatoriosEmMemoria();
  const csv = '2026-11-03;Maria Souza;123.456.789-01;150,00\n2026-11-04;José Lima;987.654.321-00;80,00';
  const r = await importarRelatorio(arm, { unidade: UNI, relatorio: 'vendas', tipoDoCofre: 'csv', conteudo: buf(csv), importadoPor: 'x' });
  assert.equal(r.importado, false);
  if (r.importado || r.motivo !== 'leiaute_desconhecido') throw new Error('esperava leiaute_desconhecido');
  assert.equal(r.semCabecalho, true);
  assert.deepEqual(r.cabecalho, []);
  const tudo = JSON.stringify(r);
  for (const dado of ['Maria', '123.456', '150,00', '2026-11-03']) assert.equal(tudo.includes(dado), false, dado);
  assert.match(r.aviso, /NÃO parece um cabeçalho/);
});

test('CSV com um leiaute cadastrado: vendas por forma, bruto, líquido e taxa (leiaute de TESTE, não da InfinitePay)', async () => {
  const fake: LeiauteCsv = {
    nome: 'teste-sintetico',
    relatorio: 'vendas',
    reconhece: (c) => c.join('|') === 'quando|forma|bruto|liquido|parcelas',
    ler: (csv) => ({
      ignoradas: 0,
      vendas: csv.linhas.map((l) => ({
        quando: `${l[0]}T15:00:00.000Z`, forma: l[1] as 'credito', valorBrutoCentavos: centavosDoTexto(l[2]!)!, valorLiquidoCentavos: centavosDoTexto(l[3]!)!, parcelas: Number(l[4]),
      })),
      periodoInicio: '2026-11-01', periodoFim: '2026-11-30',
    }),
  };
  LEIAUTES_CSV.push(fake);
  try {
    const arm = relatoriosEmMemoria();
    const completo = 'quando;forma;bruto;liquido;parcelas\n2026-11-03;credito;1000,00;960,00;3\n2026-11-03;pix;200,00;200,00;1\n2026-11-04;credito;100,00;97,00;1';
    const r = await importarRelatorio(arm, { unidade: UNI, relatorio: 'vendas', tipoDoCofre: 'csv', conteudo: buf(completo), importadoPor: 'x' });
    assert.ok(r.importado);
    const ctx = ctxCom();
    const v = await infinitepayVendas(ctx, arm, { inicio: '2026-11-01', fim: '2026-11-30' });
    assert.equal(v.resumo.vendas, 3);
    assert.equal(v.resumo.bruto, 1300);
    assert.equal(v.resumo.liquido, 1257);
    assert.equal(v.resumo.taxa, 43);
    assert.equal(v.resumo.taxaEfetivaPercentual, 3.31);
    assert.deepEqual(Object.keys(v.grupos), ['credito', 'credito parcelado', 'pix']);
    assert.equal(v.grupos['credito parcelado']!.bruto, 1000);
    assert.equal(v.cobertura.periodoPedidoCompleto, true);
  } finally {
    LEIAUTES_CSV.splice(LEIAUTES_CSV.indexOf(fake), 1);
  }
  assert.equal(LEIAUTES_CSV.length, 0, 'o registro de leiautes volta a ficar vazio');
});

test('vendas por dia usam o dia de BRASÍLIA: a venda das 22h30 de 30/11 (01:30 UTC de 01/12) é do dia 30', async () => {
  const arm = relatoriosEmMemoria();
  await arm.gravar({
    unidade: UNI, relatorio: 'vendas', formato: 'csv', leiaute: 't', sha256: 'x', bytes: 1, periodoInicio: '2026-11-01', periodoFim: '2026-11-30', importadoPor: 'x', movimentos: [],
    vendas: [{ quando: '2026-12-01T01:30:00.000Z', valorBrutoCentavos: 10000, forma: 'pix', chave: 'v1' }, { quando: '2026-12-01T03:30:00.000Z', valorBrutoCentavos: 500, forma: 'pix', chave: 'v2' }],
  });
  const r = await infinitepayVendas(ctxCom(), arm, { inicio: '2026-11-01', fim: '2026-11-30', agruparPor: 'dia' });
  assert.deepEqual(Object.keys(r.grupos), ['2026-11-30'], 'a venda das 00:30 de 01/12 em Brasília fica de fora do período');
  assert.equal(r.resumo.bruto, 100);
});

test('extrato: o padrão é SÓ extrato (recebível nunca soma junto) e a descrição só aparece para quem tem permissão', async () => {
  const arm = relatoriosEmMemoria();
  await arm.gravar({
    unidade: UNI, relatorio: 'extrato', formato: 'ofx', leiaute: 'ofx', sha256: 'a', bytes: 1, periodoInicio: '2026-11-01', periodoFim: '2026-11-30', importadoPor: 'x', vendas: [],
    movimentos: [{ tipo: 'extrato', data: '2026-11-03', valorCentavos: 10000, descricao: 'PIX MARIA SOUZA', chave: 'a' }],
  });
  await arm.gravar({
    unidade: UNI, relatorio: 'recebiveis', formato: 'csv', leiaute: 't', sha256: 'b', bytes: 1, periodoInicio: '2026-11-01', periodoFim: '2026-11-30', importadoPor: 'x', vendas: [],
    movimentos: [{ tipo: 'recebivel', data: '2026-11-03', valorCentavos: 10000, descricao: 'mesmo dinheiro', chave: 'b' }],
  });
  const padrao = await infinitepayExtrato(ctxCom(), arm, { inicio: '2026-11-01', fim: '2026-11-30' });
  assert.equal(padrao.resumo.entradas, 100, 'não somou o recebível por cima do extrato');
  assert.equal(padrao.tipo, 'extrato');
  assert.equal(JSON.stringify(padrao).includes('MARIA'), false, 'sem permissão de escrita a descrição não sai');
  assert.match(String(padrao.descricoes), /omitidas/);
  const dono = await infinitepayExtrato(ctxCom(), arm, { inicio: '2026-11-01', fim: '2026-11-30' }, { descricoes: true });
  assert.equal(dono.itens[0]!.descricao, 'PIX MARIA SOUZA');
  const rec = await infinitepayExtrato(ctxCom(), arm, { inicio: '2026-11-01', fim: '2026-11-30', tipo: 'recebivel' });
  assert.equal(rec.resumo.entradas, 100);
  assert.equal(rec.cobertura.arquivosImportados, 1, 'a cobertura é a dos arquivos do MESMO tipo');
});

test('linhas repetidas sem sobreposição de período: a importação avisa (FITID pode ter sido reaproveitado)', async () => {
  const arm = relatoriosEmMemoria();
  await importarRelatorio(arm, { unidade: UNI, relatorio: 'extrato', tipoDoCofre: 'ofx', conteudo: buf(OFX_V1), importadoPor: 'x' });
  // mesmo conteúdo de linhas, mas num arquivo que declara OUTRO período (dezembro) e portanto não se sobrepõe
  const outro = OFX_V1.replace('<DTSTART>20261101000000[-3:BRT]<DTEND>20261115235959[-3:BRT]', '<DTSTART>20261201<DTEND>20261215');
  const r = await importarRelatorio(arm, { unidade: UNI, relatorio: 'extrato', tipoDoCofre: 'ofx', conteudo: buf(outro), importadoPor: 'x' });
  assert.ok(r.importado);
  if (!r.importado) return;
  assert.equal(r.importacao.linhasRepetidas, 3);
  assert.match(String(r.aviso), /SEM que o período do arquivo encontre outro/);
  const sobreposto = await importarRelatorio(arm, { unidade: UNI, relatorio: 'extrato', tipoDoCofre: 'ofx', conteudo: buf(OFX_V1.replace('<MEMO>Transferencia enviada', '<MEMO>Transferencia enviada 2')), importadoPor: 'x' });
  assert.ok(sobreposto.importado);
  if (sobreposto.importado) assert.equal(sobreposto.aviso, undefined, 'sobreposição legítima não avisa');
});

test('importar com a unidade fora do ar NÃO deixa o envio preso: o arquivo continua disponível para nova tentativa', async () => {
  const c = await cenario();
  try {
    const ctx = ctxCom();
    const p = await pedirRelatorio(ctx, c.deps, QUEM, { relatorio: 'extrato' });
    await c.enviar(p.linkDeEnvio.split('/').pop()!, 'e.ofx', buf(OFX_V1));
    const semConta = criarContextoInfinitepay(new Map(), { async listar() { return []; }, async porOrderNsu() { return null; } });
    await assert.rejects(() => importarEnvio(semConta, c.deps, QUEM, { envio: p.envio }), /nenhuma unidade com a InfinitePay/);
    const r = await importarEnvio(ctx, c.deps, QUEM, { envio: p.envio });
    assert.ok(r.importado, 'a segunda tentativa funciona: o envio não ficou "em uso"');
  } finally {
    c.limpar();
  }
});

test('o registro de leiautes de CSV nasce VAZIO: nenhum leiaute da InfinitePay é inventado', () => {
  assert.equal(LEIAUTES_CSV.length, 0);
  const l = lerRelatorio(buf('a;b\n1;2'), 'csv', 'vendas');
  assert.equal(l.reconhecido, false);
});

// ----------------------------------------------------------------- cobertura e totais

const imp = (de: string, ate: string): ImportacaoGuardada => ({ id: de, relatorio: 'extrato', formato: 'ofx', leiaute: 'ofx', periodoInicio: de, periodoFim: ate, linhasLidas: 1, linhasNovas: 1, importadoPor: 'x', importadoEm: '', contaHash: null, contaFinal: null });

test('cobertura: sem importação diz que zero é falta de dado; junta períodos vizinhos; lista as lacunas do período pedido', () => {
  assert.match(coberturaDoPeriodo([], '2026-11-01', '2026-11-30').aviso, /ZERO por falta de dado/);
  const c = coberturaDoPeriodo([imp('2026-11-16', '2026-11-30'), imp('2026-11-01', '2026-11-15')], '2026-10-25', '2026-12-05');
  assert.deepEqual(c.periodosImportados, [{ de: '2026-11-01', ate: '2026-11-30' }], 'quinzenas vizinhas viram um mês');
  assert.deepEqual(c.lacunas, [{ de: '2026-10-25', ate: '2026-10-31' }, { de: '2026-12-01', ate: '2026-12-05' }]);
  assert.equal(c.periodoPedidoCompleto, false);
  const buraco = coberturaDoPeriodo([imp('2026-11-01', '2026-11-10'), imp('2026-11-20', '2026-11-30')], '2026-11-01', '2026-11-30');
  assert.deepEqual(buraco.lacunas, [{ de: '2026-11-11', ate: '2026-11-19' }]);
  assert.equal(coberturaDoPeriodo([imp('2026-11-01', '2026-11-30')], '2026-11-05', '2026-11-20').periodoPedidoCompleto, true);
});

test('totais: extrato soma entradas e saídas; vendas calculam a taxa só sobre as que têm líquido', () => {
  assert.deepEqual(totaisDoExtrato([
    { tipo: 'extrato', data: '2026-11-01', dataPrevista: null, valorCentavos: 10000, descricao: 'a' },
    { tipo: 'extrato', data: '2026-11-02', dataPrevista: null, valorCentavos: -2500, descricao: 'b' },
  ]), { lancamentos: 2, entradas: 100, saidas: -25, liquido: 75 });
  const t = totaisDasVendas([
    { quando: '2026-11-01T10:00:00Z', valorBrutoCentavos: 10000, valorLiquidoCentavos: 9700, forma: 'credito', parcelas: 1, bandeira: null, status: null },
    { quando: '2026-11-01T11:00:00Z', valorBrutoCentavos: 5000, valorLiquidoCentavos: null, forma: 'pix', parcelas: null, bandeira: null, status: null },
  ]);
  assert.equal(t.bruto, 150);
  assert.equal(t.taxa, 3);
  assert.equal(t.taxaEfetivaPercentual, 3, 'a venda sem líquido fica de fora da taxa');
  assert.equal(t.vendasSemValorLiquido, 1);
  assert.equal(totaisDasVendas([]).liquido, null);
});

// ----------------------------------------------------------------- as ferramentas, com o cofre de verdade

function ctxCom() {
  const conta: ContaInfinitepay = { slug: UNI, nome: 'Açailândia', chaveFinal: '…rstu', temHandle: false, fonte: { consultar: async () => ({ sucesso: true, pago: true }), testar: async () => undefined } };
  return criarContextoInfinitepay(new Map([[UNI, conta]]), { async listar() { return []; }, async porOrderNsu() { return null; } });
}

async function cenario() {
  const dir = mkdtempSync(path.join(tmpdir(), 'ip-relatorio-'));
  const cofre = new CofreDeArquivos({ dir: path.join(dir, 'cofre') });
  const armazem = relatoriosEmMemoria();
  const deps = { cofre, baseUrl: () => 'https://conector.exemplo.com/', armazem };
  const enviar = async (token: string, nome: string, conteudo: Buffer) => {
    const r = cofre.reservar(token);
    return cofre.guardar(r, nome, conteudo);
  };
  return { cofre, armazem, deps, enviar, limpar: () => rmSync(dir, { recursive: true, force: true }) };
}

const QUEM = { id: 'u1', email: 'lia@exemplo.com' };

test('fluxo completo: pedir → a clínica envia o .ofx → importar → extrato; o arquivo some do cofre', async () => {
  const c = await cenario();
  try {
    const ctx = ctxCom();
    const p = await pedirRelatorio(ctx, c.deps, QUEM, { relatorio: 'extrato' });
    assert.match(p.linkDeEnvio, /^https:\/\/conector\.exemplo\.com\/arquivos\/enviar\/[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(p.aceita, ['ofx', 'csv']);
    assert.ok(p.comoBaixar.some((x) => /SALDO/.test(x)));
    const token = p.linkDeEnvio.split('/').pop()!;
    const guardado = await c.enviar(token, 'extrato-nov.ofx', buf(OFX_V1));
    assert.equal(guardado.tipo, 'ofx');
    const r = await importarEnvio(ctx, c.deps, QUEM, { envio: p.envio });
    assert.ok(r.importado);
    assert.equal(r.arquivoApagadoDoCofre, true);
    assert.equal(c.cofre.ver(QUEM.id, p.envio).estado, 'apagado');
    const e = await infinitepayExtrato(ctx, c.armazem, { inicio: '2026-11-01', fim: '2026-11-30' });
    assert.equal(e.resumo.liquido, 1350.25);
    assert.equal(e.fonte.startsWith('RELATÓRIO IMPORTADO'), true);
    assert.deepEqual(e.cobertura.lacunas, [{ de: '2026-11-16', ate: '2026-11-30' }], 'o arquivo cobre só até 15/11: a segunda metade do mês aparece como lacuna');
    assert.equal(e.cobertura.periodoPedidoCompleto, false);
    const lista = await infinitepayImportacoes(ctx, c.armazem, {});
    assert.equal(lista.importacoes.length, 1);
  } finally {
    c.limpar();
  }
});

test('o envio de relatório aceita só os tipos pedidos: PDF, texto qualquer e o OFX no pedido de vendas são recusados', async () => {
  const c = await cenario();
  try {
    const ctx = ctxCom();
    const vendas = await pedirRelatorio(ctx, c.deps, QUEM, { relatorio: 'vendas' });
    assert.deepEqual(vendas.aceita, ['csv']);
    const t = vendas.linkDeEnvio.split('/').pop()!;
    // no pedido de vendas (só CSV) o OFX nem é reconhecido como OFX: continua sendo "texto" e a extensão .ofx o recusa
    await assert.rejects(() => c.enviar(t, 'vendas.ofx', buf(OFX_V1)), /diz ser \.ofx, mas o conteúdo é texto/);
    const ext = await pedirRelatorio(ctx, c.deps, QUEM, { relatorio: 'extrato' });
    await assert.rejects(() => c.enviar(ext.linkDeEnvio.split('/').pop()!, 'x.pdf', Buffer.from('%PDF-1.7\nx')), /só aceitamos extrato OFX/);
  } finally {
    c.limpar();
  }
});

test('importar: envio de outro fluxo (sem destino de relatório), de outra pessoa ou ainda sem arquivo é recusado e nada é gravado', async () => {
  const c = await cenario();
  try {
    const ctx = ctxCom();
    const alheio = c.cofre.pedirEnvio({ userId: QUEM.id, finalidade: 'contrato para assinar', tipos: ['pdf'] });
    await assert.rejects(() => importarEnvio(ctx, c.deps, QUEM, { envio: alheio.id }), /não foi pedido por infinitepay_pedir_relatorio/);
    const p = await pedirRelatorio(ctx, c.deps, QUEM, { relatorio: 'extrato' });
    await assert.rejects(() => importarEnvio(ctx, c.deps, QUEM, { envio: p.envio }), /ainda não chegou/);
    await assert.rejects(() => importarEnvio(ctx, c.deps, { id: 'outra-pessoa' }, { envio: p.envio }), /não encontrado/);
    assert.equal(c.armazem.importacoesGravadas.length, 0);
  } finally {
    c.limpar();
  }
});

test('importar CSV desconhecido pelo fluxo: devolve o cabeçalho, apaga o arquivo do cofre e não grava', async () => {
  const c = await cenario();
  try {
    const ctx = ctxCom();
    const p = await pedirRelatorio(ctx, c.deps, QUEM, { relatorio: 'vendas' });
    await c.enviar(p.linkDeEnvio.split('/').pop()!, 'vendas.csv', buf('Data;Valor\n01/11/2026;10,00'));
    const r = await importarEnvio(ctx, c.deps, QUEM, { envio: p.envio });
    assert.equal(r.importado, false);
    assert.equal('cabecalho' in r ? r.cabecalho.join(',') : '', 'Data,Valor');
    assert.equal(c.armazem.importacoesGravadas.length, 0);
    assert.equal(c.cofre.ver(QUEM.id, p.envio).estado, 'apagado');
  } finally {
    c.limpar();
  }
});

test('fluxo: extrato de OUTRA conta é recusado e o arquivo FICA no cofre; com aceitarOutraConta=true entra sem a clínica enviar de novo', async () => {
  const c = await cenario();
  try {
    const ctx = ctxCom();
    const p1 = await pedirRelatorio(ctx, c.deps, QUEM, { relatorio: 'extrato' });
    await c.enviar(p1.linkDeEnvio.split('/').pop()!, 'a.ofx', buf(OFX_V1));
    assert.ok((await importarEnvio(ctx, c.deps, QUEM, { envio: p1.envio })).importado);
    const outra = OFX_V1.replace('<ACCTID>987654321', '<ACCTID>555566667').replace('<DTSTART>20261101000000[-3:BRT]<DTEND>20261115235959[-3:BRT]', '<DTSTART>20261201<DTEND>20261215');
    const p2 = await pedirRelatorio(ctx, c.deps, QUEM, { relatorio: 'extrato' });
    await c.enviar(p2.linkDeEnvio.split('/').pop()!, 'b.ofx', buf(outra));
    const r = await importarEnvio(ctx, c.deps, QUEM, { envio: p2.envio });
    assert.equal(r.importado, false);
    assert.equal(r.arquivoApagadoDoCofre, false);
    assert.equal(c.cofre.ver(QUEM.id, p2.envio).estado, 'recebido', 'o arquivo continua guardado para a confirmação');
    const ok = await importarEnvio(ctx, c.deps, QUEM, { envio: p2.envio, aceitarOutraConta: true });
    assert.ok(ok.importado);
    assert.equal(c.cofre.ver(QUEM.id, p2.envio).estado, 'apagado');
  } finally {
    c.limpar();
  }
});

test('fluxo: o mesmo arquivo de OUTRA unidade é recusado e sai do cofre', async () => {
  const c = await cenario();
  try {
    const conta = (slug: string): ContaInfinitepay => ({ slug, nome: slug, chaveFinal: '…x', temHandle: false, fonte: { consultar: async () => ({ sucesso: true, pago: true }), testar: async () => undefined } });
    const ctx = criarContextoInfinitepay(new Map([[UNI, conta(UNI)], ['doutor-hernia-serra', conta('doutor-hernia-serra')]]), { async listar() { return []; }, async porOrderNsu() { return null; } });
    const p1 = await pedirRelatorio(ctx, c.deps, QUEM, { unidade: UNI, relatorio: 'extrato' });
    await c.enviar(p1.linkDeEnvio.split('/').pop()!, 'a.ofx', buf(OFX_V1));
    assert.ok((await importarEnvio(ctx, c.deps, QUEM, { envio: p1.envio })).importado);
    const p2 = await pedirRelatorio(ctx, c.deps, QUEM, { unidade: 'serra', relatorio: 'extrato' });
    await c.enviar(p2.linkDeEnvio.split('/').pop()!, 'a.ofx', buf(OFX_V1));
    const r = await importarEnvio(ctx, c.deps, QUEM, { envio: p2.envio });
    assert.equal(!r.importado && r.motivo, 'arquivo_de_outra_unidade');
    assert.equal(c.cofre.ver(QUEM.id, p2.envio).estado, 'apagado');
    assert.equal((await c.armazem.importacoes('doutor-hernia-serra')).length, 0);
  } finally {
    c.limpar();
  }
});

test('vendas sem nenhuma importação: zero por falta de dado, e diz como começar', async () => {
  const r = await infinitepayVendas(ctxCom(), relatoriosEmMemoria(), { inicio: '2026-11-01', fim: '2026-11-30' });
  assert.equal(r.resumo.vendas, 0);
  assert.match(r.cobertura.aviso, /ZERO por falta de dado/);
  assert.match(String(r.proximoPasso), /infinitepay_pedir_relatorio/);
});

test('período inválido: início depois do fim, mais de 366 dias e data que não existe', async () => {
  const arm = relatoriosEmMemoria();
  await assert.rejects(() => infinitepayExtrato(ctxCom(), arm, { inicio: '2026-11-30', fim: '2026-11-01' }), /início vem depois/);
  await assert.rejects(() => infinitepayExtrato(ctxCom(), arm, { inicio: '2025-01-01', fim: '2026-11-30' }), /passa de 366 dias/);
  await assert.rejects(() => infinitepayVendas(ctxCom(), arm, { inicio: '2026-02-30', fim: '2026-03-01' }), /não é uma data que existe/);
});

test('portão: leitura vale para todos; pedir e importar só para quem escreve', () => {
  const nomes: string[] = [];
  const server = { registerTool: (n: string) => nomes.push(n) } as never;
  registrarLeituraRelatorios(server, ctxCom(), relatoriosEmMemoria());
  assert.deepEqual(nomes, ['infinitepay_extrato', 'infinitepay_vendas', 'infinitepay_importacoes']);
  const deps = { cofre: {} as never, baseUrl: () => 'x', armazem: relatoriosEmMemoria() };
  assert.equal(registrarImportacaoRelatoriosSePermitido(server, ctxCom(), deps, 'u1', new Set(['outro']), (() => undefined) as never), false);
  assert.equal(nomes.length, 3);
  assert.equal(registrarImportacaoRelatoriosSePermitido(server, ctxCom(), deps, 'u1', new Set(['u1']), (() => undefined) as never), true);
  assert.deepEqual(nomes.slice(3), ['infinitepay_pedir_relatorio', 'infinitepay_importar_relatorio']);
});

test('os passos de exportação citam os menus da Central de Ajuda da InfinitePay', () => {
  assert.match(COMO_EXPORTAR.vendas.passos.join(' '), /Suas Vendas.*Recebendo hoje.*Relatório/);
  assert.match(COMO_EXPORTAR.extrato.passos.join(' '), /SALDO.*download/s);
  assert.match(COMO_EXPORTAR.recebiveis.passos.join(' '), /Seus recebimentos/);
});
