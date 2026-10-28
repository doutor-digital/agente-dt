import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FREIOS_PADRAO } from './disparo/freios.js';
import { LIMITE_DA_TABELA, linkDoCartao, montarPainelDaOnda, motivoSemNumero, ordenarDestinatarios, semTextoDeSair, telefoneMascarado, type DadosDoPainel, type LinhaDoDestinatario } from './disparo/painel.js';

const base = (extra: Partial<DadosDoPainel> = {}, onda: Partial<DadosDoPainel['onda']> = {}): DadosDoPainel => ({
  onda: {
    id: 'o1', estado: 'montada', total: 27, etiqueta: 'Outubro Rosa · Dia 2', impressao: 'abc123', aprovadaPor: null, aprovadaEm: null, pausaMotivo: null,
    template: 'canaa_resgate_150_arte', idioma: 'pt_BR', textoModelo: 'Oi {{1}}, aqui é a {{2}}.', variaveis: ['primeiroNome', 'unidade'], cabecalho: { tipo: 'image', link: 'https://x.com/arte4.jpg' },
    ...onda,
  },
  campanhaNome: 'Outubro Rosa', unidade: { slug: 'doutor-hernia-canaa', nome: 'Doutor Hérnia Canaã' }, modo: 'seco', freios: FREIOS_PADRAO,
  resumo: { candidatos: 40, fora: { 'consulta-futura': 9, 'pediu-sair': 1, 'tratamento-aberto': 0 } }, contagem: { pendente: 27 }, simulados: 0,
  amostra: [{ nome: 'Maria', telefone: '5563991021043' }, { nome: '<b>Ana</b>', telefone: '5563988880002' }],
  conferenciaMeta: { ok: true }, podeAprovar: true, listaDeTeste: null,
  ...extra,
});

test('a tela mostra unidade, quantas pessoas, o texto final com as variáveis resolvidas e a amostra', () => {
  const html = montarPainelDaOnda(base());
  assert.ok(html.includes('Doutor Hérnia Canaã'));
  assert.ok(html.includes('<b>27</b><span>pessoas vão receber'));
  assert.ok(html.includes('Oi Maria, aqui é a Doutor Hérnia Canaã.'), 'texto final, sem {{1}}');
  assert.ok(!/\{\{\d\}\}/.test(html.replace(/<script[\s\S]*<\/script>/, '')), 'nenhuma variável sobrando na página');
  assert.ok(html.includes('tem consulta marcada na franquia'));
  assert.ok(html.includes('pediu para sair'));
  assert.ok(!html.includes('tem tratamento aberto'), 'motivo com zero não aparece');
  assert.ok(html.includes('Aprovar esta onda (27 pessoas)'));
});

test('MODO SECO fica gritado no topo: aprovar não manda nada', () => {
  assert.match(montarPainelDaOnda(base()), /MODO SECO[\s\S]*Aprovar NÃO manda mensagem nenhuma/);
  assert.match(montarPainelDaOnda(base({ modo: 'ligado' })), /UNIDADE LIGADA/);
  assert.match(montarPainelDaOnda(base({ modo: 'ligado', listaDeTeste: ['5563991021043'] })), /lista de teste: só 1 número/);
  assert.match(montarPainelDaOnda(base({ modo: 'ligado', listaDeTeste: [] })), /SEM lista de teste[\s\S]*ninguém recebe/);
  assert.match(montarPainelDaOnda(base({ modo: 'ligado', listaDeTeste: null })), /TODOS os aprovados recebem/);
});

test('telefone aparece mascarado e nome do paciente é escapado', () => {
  const html = montarPainelDaOnda(base());
  assert.equal(telefoneMascarado('5563991021043'), '+55 63 9••••-••43');
  assert.ok(html.includes('+55 63 9••••-••43'));
  assert.ok(!html.includes('5563991021043'));
  assert.ok(!html.includes('<b>Ana</b>'));
  assert.ok(html.includes('&lt;b&gt;Ana&lt;/b&gt;'));
});

test('o botão manda de volta o total e a impressão que a página mostrou (a lista não muda no meio)', () => {
  const html = montarPainelDaOnda(base());
  assert.ok(html.includes('total=27'));
  assert.ok(html.includes('impressao="abc123"'));
});

test('botão de aprovar trava sem permissão ou sem a conferência da Meta', () => {
  assert.match(montarPainelDaOnda(base({ podeAprovar: false })), /<button id="aprovar" disabled>/);
  assert.match(montarPainelDaOnda(base({ conferenciaMeta: { ok: false, motivo: 'texto diferente' } })), /<button id="aprovar" disabled>/);
  assert.match(montarPainelDaOnda(base({ conferenciaMeta: { ok: false, motivo: 'texto diferente' } })), /A Meta não confere:<\/b> texto diferente/);
  assert.match(montarPainelDaOnda(base()), /<button id="aprovar" >/);
});

test('onda já aprovada ou cancelada não oferece aprovar; aprovada oferece parar', () => {
  const aprovada = montarPainelDaOnda(base({}, { estado: 'aprovada', aprovadaPor: 'joao@x.com', aprovadaEm: new Date('2026-10-24T15:00:00Z') }));
  assert.ok(!aprovada.includes('id="aprovar"'));
  assert.ok(aprovada.includes('Parar e cancelar'));
  assert.ok(aprovada.includes('Aprovada por joao@x.com'));
  const cancelada = montarPainelDaOnda(base({}, { estado: 'cancelada', pausaMotivo: 'nenhuma pessoa elegível' }));
  assert.ok(!cancelada.includes('id="aprovar"') && !cancelada.includes('id="cancelar"'));
  assert.ok(cancelada.includes('nenhuma pessoa elegível'));
});

test('os freios aparecem com os números', () => {
  const html = montarPainelDaOnda(base());
  assert.ok(html.includes('9h às 18h'));
  assert.ok(html.includes('30 por hora e 100 por 24 horas'));
  assert.ok(html.includes('mais de 3 pessoas responderem SAIR'));
});

const D = (iso: string) => new Date(iso);
const linha = (extra: Partial<LinhaDoDestinatario> = {}): LinhaDoDestinatario => ({ nome: 'Maria', telefone: '5563991021043', estado: 'enviado', motivo: null, enviadoEm: D('2026-10-28T17:35:00Z'), simuladoEm: null, kommoLeadId: 123456, ...extra });

test('tabela por pessoa: nome, telefone mascarado, estado, hora de São Paulo, motivo e link do cartão', () => {
  const html = montarPainelDaOnda(base({
    kommoSubdominio: 'drcanaa',
    destinatarios: [
      linha(),
      linha({ nome: 'Ana', telefone: '5563988880002', estado: 'falhou', enviadoEm: null, motivo: 'Meta 131026: número sem WhatsApp', kommoLeadId: 777 }),
      linha({ nome: 'Bia', telefone: '5563988880003', estado: 'pendente', enviadoEm: null, kommoLeadId: null }),
    ],
  }));
  assert.ok(html.includes('<h2>Pessoa por pessoa</h2>'));
  assert.ok(html.includes('<td class="esq bom">enviado</td>'));
  assert.ok(html.includes('<td class="esq ruim">FALHOU</td>'));
  assert.ok(html.includes('<td class="esq mudo">pendente</td>'));
  assert.match(html, /28\/10[^<]*14:35/, '17:35 UTC é 14:35 em São Paulo');
  assert.ok(html.includes('Meta 131026: número sem WhatsApp'));
  assert.ok(html.includes('<a href="https://drcanaa.kommo.com/leads/detail/123456" target="_blank" rel="noopener noreferrer">123456</a>'));
  assert.ok(html.includes('https://drcanaa.kommo.com/leads/detail/777'));
  assert.ok(!html.includes('5563988880002') && !html.includes('5563991021043'), 'telefone nunca inteiro');
});

test('tabela por pessoa: sem subdomínio só o número do cartão; sem cartão, traço; nome e motivo escapados', () => {
  const html = montarPainelDaOnda(base({ destinatarios: [linha({ nome: '<i>X</i>', motivo: '<script>alert(1)</script>', estado: 'falhou' }), linha({ kommoLeadId: null })] }));
  assert.ok(html.includes('<td class="esq">123456</td>'), 'sem link, só o número');
  assert.ok(!html.includes('<i>X</i>') && html.includes('&lt;i&gt;X&lt;/i&gt;'));
  assert.ok(!html.includes('<script>alert(1)'), 'motivo escapado');
  assert.equal(linkDoCartao('a"><b', 5), null, 'subdomínio estranho não vira link');
  assert.equal(linkDoCartao('drcanaa', null), null);
});

test('tabela por pessoa: modo seco mostra "receberia", não uma hora que pareça envio', () => {
  const html = montarPainelDaOnda(base({ destinatarios: [linha({ estado: 'pendente', enviadoEm: null, simuladoEm: D('2026-10-28T12:00:00Z') })] }));
  assert.match(html, /receberia \(seco\) 28\/10[^<]*09:00/);
});

test('tabela por pessoa: avisa quando cortou e não avisa quando coube', () => {
  const cortada = montarPainelDaOnda(base({ destinatarios: [linha()], destinatariosTotal: 450 }));
  assert.ok(cortada.includes('Mostrando 1 de 450 pessoas'));
  assert.ok(!montarPainelDaOnda(base({ destinatarios: [linha()], destinatariosTotal: 1 })).includes('Mostrando'));
  assert.ok(montarPainelDaOnda(base({ destinatarios: [] })).includes('Sem destinatários.'));
});

test('motivo da falha não deixa número de telefone passar', () => {
  assert.equal(motivoSemNumero('Meta 131026: 5563991021043 não tem WhatsApp'), 'Meta 131026: •••• não tem WhatsApp');
  assert.equal(motivoSemNumero('recusou +55 63 99102-1043 agora'), 'recusou •••• agora', 'telefone formatado também');
  assert.equal(motivoSemNumero('Meta 131048: spam em 28/10/2026'), 'Meta 131048: spam em 28/10/2026', 'código e data ficam');
  assert.equal(motivoSemNumero(null), '');
  assert.equal(motivoSemNumero('recusou (63) 99102-1043 agora'), 'recusou •••• agora', 'telefone com DDD entre parênteses também');
  assert.equal(motivoSemNumero('recusou 63 99102 1043'), 'recusou ••••', 'espaços como separador também');
  assert.equal(motivoSemNumero('Meta 131049 wamid.HBgNNTU2Mzk5MTAyMTA0MxUCABEYEjk3 não entregue'), 'Meta 131049 wamid.•••• não entregue', 'o id da mensagem na Meta carrega o telefone codificado');
  assert.equal(motivoSemNumero('recusado em 2026-10-28 12:30 por 5563991021043'), 'recusado em 2026-10-28 12:30 por ••••', 'data e hora não são telefone');
  assert.ok(!motivoSemNumero('x WAMID.HBgNNTU2Mzk5MTAyMTA0MxUCABEYEjk3=').includes('HBgN'), 'maiúsculas também');
  const html = montarPainelDaOnda(base({ destinatarios: [linha({ estado: 'falhou', motivo: 'recusou 5563991021043' })] }));
  assert.ok(!html.includes('5563991021043'));
});

test('ordem: enviados (recente primeiro), depois falhas (recente primeiro), depois pendentes (ordem da fila); corta no limite', () => {
  const l = (nome: string, estado: string, enviadoEm: string | null, atualizadoEm: string, criadoEm = '2026-10-28T08:00:00Z') => ({ nome, estado, enviadoEm: enviadoEm ? D(enviadoEm) : null, atualizadoEm: D(atualizadoEm), criadoEm: D(criadoEm) });
  const ordem = ordenarDestinatarios([
    l('pend2', 'pendente', null, '2026-10-28T09:02:00Z', '2026-10-28T08:02:00Z'),
    l('falha-velha', 'falhou', null, '2026-10-28T10:00:00Z'),
    l('env-velho', 'enviado', '2026-10-28T11:00:00Z', '2026-10-28T11:00:00Z'),
    l('pend1', 'pendente', null, '2026-10-28T09:01:00Z', '2026-10-28T08:01:00Z'),
    l('env-novo', 'enviado', '2026-10-28T12:00:00Z', '2026-10-28T12:00:00Z'),
    l('falha-nova', 'descartado', null, '2026-10-28T13:00:00Z'),
    l('saiu', 'saiu', null, '2026-10-28T12:30:00Z'),
  ]).map((x) => x.nome);
  assert.deepEqual(ordem, ['env-novo', 'env-velho', 'falha-nova', 'saiu', 'falha-velha', 'pend1', 'pend2']);
  const muitos = Array.from({ length: LIMITE_DA_TABELA + 50 }, (_, i) => l(`p${i}`, 'pendente', null, '2026-10-28T09:00:00Z'));
  assert.equal(ordenarDestinatarios(muitos).length, LIMITE_DA_TABELA);
  assert.equal(LIMITE_DA_TABELA, 200);
});

test('pendentes na ordem em que o worker os pega: quem foi adiado (atualizadoEm novo) vai para o fim, empate pelo id', () => {
  const p = (id: string, atualizadoEm: string, criadoEm: string) => ({ id, nome: id, estado: 'pendente', enviadoEm: null, atualizadoEm: D(atualizadoEm), criadoEm: D(criadoEm) });
  const r = ordenarDestinatarios([
    p('b', '2026-10-28T09:00:00Z', '2026-10-28T08:00:00Z'),
    p('adiada', '2026-10-28T12:00:00Z', '2026-10-28T07:00:00Z'), // a 1ª a ser criada, mas adiada: vai para o fim
    p('a', '2026-10-28T09:00:00Z', '2026-10-28T08:00:30Z'),
  ]).map((x) => x.nome);
  assert.deepEqual(r, ['a', 'b', 'adiada'], 'empate de atualizadoEm desempata pelo id; adiada por último (criadoEm não manda)');
});

test('passando do limite, as falhas ficam e os enviados é que são cortados (mas a ordem na tela segue enviados > falhas)', () => {
  const l = (nome: string, estado: string, min: number) => ({ nome, estado, enviadoEm: estado === 'enviado' ? D(`2026-10-28T12:${String(min).padStart(2, '0')}:00Z`) : null, atualizadoEm: D(`2026-10-28T12:${String(min).padStart(2, '0')}:00Z`), criadoEm: D('2026-10-28T08:00:00Z') });
  const r = ordenarDestinatarios([l('e1', 'enviado', 10), l('e2', 'enviado', 20), l('e3', 'enviado', 30), l('f1', 'falhou', 5), l('s1', 'saiu', 6), l('p1', 'pendente', 0)], 4).map((x) => x.nome);
  assert.deepEqual(r, ['e3', 'e2', 's1', 'f1'], 'cabem 4: as 2 falhas + os 2 enviados mais novos; o pendente e o enviado velho caem');
});

test('a chave de serviço continua sem o texto do SAIR, e a tabela por pessoa continua lá', () => {
  const d = semTextoDeSair(base({ destinatarios: [linha()], saidas: [{ nome: 'Rita', resposta: 'me tira da lista', quando: null }] }));
  assert.equal(d.saidas?.[0]?.resposta, '');
  assert.equal(d.destinatarios?.length, 1);
  assert.ok(!montarPainelDaOnda(d).includes('me tira da lista'));
});
