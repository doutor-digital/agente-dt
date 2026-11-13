/**
 * Telas Oportunidades / Marketing / Gestor: só a conta (pura). Agora = 2026-11-13 15:00 UTC (12:00 em Belém, sexta).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  credenciaisDeAnuncio,
  diasDoPeriodo,
  emailDoPerfil,
  hashDoEmail,
  indicadores,
  linhasPorAnuncio,
  linhasPorCampanha,
  leadDaConversa,
  montarGestor,
  montarMarketing,
  montarOportunidades,
  papelNaConta,
  parseValor,
  podeVerGestao,
  quemAgendouDe,
  referralDasMensagens,
  resolverPeriodo,
  semaforoDe,
  somarFaturado,
  sufixoDaUnidade,
  type LinhaAnuncio,
} from './chatwoot-gestor.js';

const AGORA = Date.parse('2026-11-13T15:00:00Z');
const s = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function conv(id: number, o: Record<string, any> = {}) {
  return {
    id,
    status: 'open',
    inbox_id: 3,
    created_at: s('2026-11-13T10:00:00Z'),
    last_activity_at: s('2026-11-13T12:00:00Z'),
    labels: [],
    custom_attributes: {},
    meta: { sender: { name: `Paciente ${id}`, phone_number: '+5594999990000', custom_attributes: {} }, assignee: null },
    last_non_activity_message: null,
    ...o,
  };
}

// ── permissão ──────────────────────────────────────────────────────────────────

test('Gestor/Marketing: administrador vê; agente só se o e-mail estiver na lista; sem lista, ninguém além do administrador', () => {
  assert.equal(podeVerGestao('administrator', 'x@y.com', undefined), true);
  assert.equal(podeVerGestao('agent', 'ana@dd.com', undefined), false);
  assert.equal(podeVerGestao('agent', 'ana@dd.com', ''), false);
  assert.equal(podeVerGestao('agent', 'ana@dd.com', 'bia@dd.com, ANA@dd.com'), true);
  assert.equal(podeVerGestao('agent', ' Ana@DD.com ', 'ana@dd.com;bia@dd.com'), true);
  assert.equal(podeVerGestao('agent', 'outra@dd.com', 'ana@dd.com'), false);
  assert.equal(podeVerGestao('agent', null, 'ana@dd.com'), false);
  assert.equal(podeVerGestao(null, null, 'ana@dd.com'), false);
});

test('papel e e-mail saem do perfil do Chatwoot, na conta certa', () => {
  const perfil = { name: 'Ana', email: ' Ana@DD.com ', accounts: [{ id: 2, role: 'administrator' }, { id: 1, role: 'agent' }] };
  assert.equal(papelNaConta(perfil, 1), 'agent');
  assert.equal(papelNaConta(perfil, 2), 'administrator');
  assert.equal(papelNaConta(perfil, 9), null);
  assert.equal(papelNaConta({ accounts: [{ id: 1 }] }, 1), 'agent'); // sem role: o menos poderoso
  assert.equal(papelNaConta(null, 1), null);
  assert.equal(emailDoPerfil(perfil), 'ana@dd.com');
  assert.equal(emailDoPerfil({ email: 'sem-arroba' }), null);
});

test('o menu recebe hash, não e-mail', () => {
  const h = hashDoEmail(' Ana@DD.com ');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, hashDoEmail('ana@dd.com'));
  assert.ok(!h.includes('ana'));
});

// ── períodos ───────────────────────────────────────────────────────────────────

test('períodos: manhã, fim do dia, semana, quinzena e mês (Belém)', () => {
  const p = (k: string) => resolverPeriodo(k, AGORA);
  assert.equal(p('fimdia').de, '2026-11-13');
  assert.equal(p('fimdia').inicioMs, Date.parse('2026-11-13T03:00:00Z'));
  assert.equal(p('manha').inicioMs, Date.parse('2026-11-12T21:00:00Z')); // 18h de ontem em Belém
  assert.equal(p('manha').de, '2026-11-12');
  assert.equal(p('semana').de, '2026-11-07');
  assert.equal(p('quinzena').de, '2026-10-30');
  assert.equal(p('mes').de, '2026-11-01');
  assert.equal(p('mes').ate, '2026-11-13');
  assert.equal(p('lixo').chave, 'semana'); // inválido cai na semana
  assert.equal(resolverPeriodo(undefined, AGORA).chave, 'semana');
  assert.equal(p('fimdia').fimMs, AGORA);
});

test('período anterior: mesmo tamanho, logo antes; o mês compara com o mesmo trecho do mês passado', () => {
  const sem = resolverPeriodo('semana', AGORA);
  assert.equal(sem.anterior.de, '2026-10-31');
  assert.equal(sem.anterior.ate, '2026-11-06');
  assert.equal(sem.rotuloAnterior, 'vs semana anterior');
  const dia = resolverPeriodo('fimdia', AGORA);
  assert.equal(dia.anterior.inicioMs, Date.parse('2026-11-12T03:00:00Z'));
  assert.equal(dia.anterior.fimMs, AGORA - 86_400_000);
  assert.equal(dia.rotuloAnterior, 'vs ontem');
  const mes = resolverPeriodo('mes', AGORA);
  assert.equal(mes.anterior.de, '2026-10-01');
  assert.equal(mes.anterior.ate, '2026-10-13');
  assert.ok(mes.anterior.fimMs < mes.inicioMs);
  // janeiro compara com dezembro do ano anterior
  const jan = resolverPeriodo('mes', Date.parse('2027-01-10T15:00:00Z'));
  assert.equal(jan.anterior.de, '2026-12-01');
  // dia 31 vs mês curto: nunca invade o mês corrente
  const mar = resolverPeriodo('mes', Date.parse('2026-03-31T15:00:00Z'));
  assert.equal(mar.anterior.de, '2026-02-01');
  assert.ok(mar.anterior.fimMs < mar.inicioMs);
  // «Manhã» depois das 18h dura mais de 24 h: a janela anterior não pode invadir a atual
  const noite = resolverPeriodo('manha', Date.parse('2026-11-14T02:00:00Z')); // 23h de Belém
  assert.ok(noite.anterior.fimMs < noite.inicioMs);
  assert.deepEqual(diasDoPeriodo('2026-11-11', '2026-11-13'), ['2026-11-11', '2026-11-12', '2026-11-13']);
});

// ── valores e razões ──────────────────────────────────────────────────────────

test('valor fechado: R$, ponto de milhar, vírgula, número e lixo', () => {
  assert.equal(parseValor('R$ 2.620,00'), 2620);
  assert.equal(parseValor('2.620'), 2620);
  assert.equal(parseValor('2620,5'), 2620.5);
  assert.equal(parseValor('2620.5'), 2620.5);
  assert.equal(parseValor(3100), 3100);
  assert.equal(parseValor('abc'), 0);
  assert.equal(parseValor(''), 0);
  assert.equal(parseValor(-5), 0);
  assert.equal(parseValor(null), 0);
});

test('CAC, retorno e custo por consulta; sem base vira null (nunca estima)', () => {
  assert.deepEqual(indicadores(3920, 23580, 9, 21), { retorno: 6, cac: 435.56, custoPorConsulta: 186.67 });
  assert.deepEqual(indicadores(null, 23580, 9, 21), { retorno: null, cac: null, custoPorConsulta: null });
  assert.deepEqual(indicadores(0, 23580, 9, 21), { retorno: null, cac: null, custoPorConsulta: null });
  assert.deepEqual(indicadores(1000, 0, 0, 0), { retorno: 0, cac: null, custoPorConsulta: null }); // gastou e não fechou: retorno 0x, CAC indefinido
  assert.deepEqual(indicadores(1000, null, 2, 4), { retorno: null, cac: 500, custoPorConsulta: 250 });
});

test('faturado da franquia: só o período, sem cancelado, sem preço fica de fora, por dia', () => {
  const dia = (iso: string) => iso.slice(0, 10);
  const r = somarFaturado(
    [
      { price: 2600, created: '2026-11-10T12:00:00Z', statusName: 'EM ANDAMENTO' },
      { price: 1000, created: '2026-11-10T15:00:00Z', statusName: 'FINALIZADO' },
      { price: 900, created: '2026-11-11T12:00:00Z', statusName: 'CANCELADO' },
      { price: 800, created: '2026-10-01T12:00:00Z', statusName: 'EM ANDAMENTO' }, // fora do período
      { price: 0, created: '2026-11-12T12:00:00Z', statusName: 'EM ANDAMENTO' },
      { price: null, created: null, statusName: null },
    ],
    '2026-11-01',
    '2026-11-13',
    dia,
  );
  assert.equal(r.valor, 3600);
  assert.equal(r.tratamentos, 2);
  assert.equal(r.semPreco, 1);
  assert.deepEqual(r.porDia, { '2026-11-10': 3600 });
});

// ── de qual campanha veio ─────────────────────────────────────────────────────

test('campanha: a 1ª mensagem do paciente com referral define; resposta nossa e mensagem sem referral não contam', () => {
  const msgs = [
    { id: 3, message_type: 0, created_at: 300, content_attributes: { referral: { source_id: '999999999', headline: 'Outro' } } },
    { id: 1, message_type: 1, created_at: 100, content_attributes: { referral: { source_id: '111111111' } } }, // nossa
    { id: 2, message_type: 0, created_at: 200, content_attributes: { referral: { source_id: '120248357965620289', source_type: 'ad', source_url: 'https://fb.me/x', headline: 'Dor na coluna?', body: 'texto do anúncio' } } },
  ];
  const r = referralDasMensagens(msgs);
  assert.deepEqual(r, { anuncioId: '120248357965620289', tipo: 'ad', url: 'https://fb.me/x', titulo: 'Dor na coluna?' });
  assert.equal(referralDasMensagens([{ id: 1, message_type: 0, created_at: 1, content_attributes: {} }]), null);
  assert.equal(referralDasMensagens([]), null);
  assert.equal(referralDasMensagens(null as any), null);
  // id de anúncio malformado não vira «campanha»; sem título nem link, nem entra
  assert.equal(referralDasMensagens([{ id: 1, message_type: 0, created_at: 1, content_attributes: { referral: { source_id: 'abc' } } }]), null);
});

const L = (id: number, ad: string | null, qual: string | null, o: Record<string, any> = {}) => {
  const c = conv(id, { custom_attributes: { ...(qual ? { qualificacao: qual } : {}), ...o } });
  return leadDaConversa(c, ad ? { anuncioId: ad, tipo: 'ad', url: null, titulo: `Anúncio ${ad.slice(-3)}` } : null);
};

test('tabela por anúncio: leads, quentes, agendou, fechou, % frio e «Sem campanha gravada»', () => {
  const leads = [
    L(1, '111111', 'Quente', { etapa: 'Agendado' }),
    L(2, '111111', 'Frio'),
    L(3, '111111', 'Frio'),
    L(4, '111111', 'Quente', { etapa: 'Fechou', fechou_tratamento: 'sim', valor_fechado: '2620' }),
    L(5, '222222', 'Morno'),
    L(6, null, 'Frio'),
    L(7, null, null),
  ];
  const t = linhasPorAnuncio(leads, null);
  assert.equal(t.linhas.length, 2);
  const a = t.linhas[0]!;
  assert.deepEqual([a.leads, a.quentes, a.agendou, a.fechou, a.frios, a.pctFrio, a.faturado], [4, 2, 2, 1, 2, 50, 2620]);
  assert.equal(a.codigo, '…11111');
  assert.equal(t.semCampanha.leads, 2);
  assert.equal(t.semCampanha.pctFrio, 50);
  assert.equal(t.semCampanha.titulo, 'Sem campanha gravada');
  assert.equal(t.omitidas, 0);
});

test('tabela vazia: sem lead, tudo zero e % frio null (não 0%)', () => {
  const t = linhasPorAnuncio([], null);
  assert.equal(t.linhas.length, 0);
  assert.equal(t.semCampanha.leads, 0);
  assert.equal(t.semCampanha.pctFrio, null);
});

test('código do contato vale quando não há referral; o do anúncio vem antes', () => {
  const c = conv(1, { meta: { sender: { name: 'X', phone_number: '+5594999990000', custom_attributes: { campanha_codigo: '4332', campanha_nome: 'ENG · RMKT' } } } });
  const lead = leadDaConversa(c, null);
  assert.equal(lead.codigo, '4332');
  const t = linhasPorAnuncio([lead], null);
  assert.equal(t.linhas[0]!.titulo, 'ENG · RMKT');
  assert.equal(t.linhas[0]!.codigo, '4332');
  assert.equal(t.semCampanha.leads, 0);
});

const GASTOS: LinhaAnuncio[] = [
  { anuncioId: '111111', anuncioNome: 'Vídeo 1', campanhaId: '9001', campanhaNome: 'ENG | LAL', gasto: 1000 },
  { anuncioId: '111112', anuncioNome: 'Vídeo 2', campanhaId: '9001', campanhaNome: 'ENG | LAL', gasto: 840.5 },
  { anuncioId: '333333', anuncioNome: 'Teste', campanhaId: '9002', campanhaNome: 'TESTE', gasto: 310 },
];

test('por campanha: junta os anúncios da mesma campanha, mostra campanha que gastou sem lead, CAC só com fechamento', () => {
  const leads = [L(1, '111111', 'Quente', { etapa: 'Fechou', fechou_tratamento: 'sim', valor_fechado: '2000' }), L(2, '111112', 'Frio'), L(3, null, null)];
  const t = linhasPorCampanha(leads, GASTOS);
  assert.equal(t.linhas.length, 2);
  const lal = t.linhas[0]!;
  assert.equal(lal.titulo, 'ENG | LAL');
  assert.equal(lal.investido, 1840.5);
  assert.equal(lal.leads, 2);
  assert.equal(lal.fechou, 1);
  assert.equal(lal.cac, 1840.5);
  const teste = t.linhas[1]!;
  assert.deepEqual([teste.titulo, teste.investido, teste.leads, teste.cac], ['TESTE', 310, 0, null]);
  assert.equal(t.semCampanha.leads, 1);
  assert.equal(t.semCampanha.investido, null);
});

test('por campanha sem Meta: o anúncio do lead vira a linha, investido null', () => {
  const t = linhasPorCampanha([L(1, '777777', 'Quente')], null);
  assert.equal(t.linhas[0]!.investido, null);
  assert.equal(t.linhas[0]!.cac, null);
  assert.equal(t.linhas[0]!.titulo, 'Anúncio 777');
});

// ── Marketing ──────────────────────────────────────────────────────────────────

test('quem agendou: Sofia (qualquer grafia), pessoa pelo nome, vazio = Sem registro', () => {
  assert.equal(quemAgendouDe('Sofia (IA)'), 'Sofia');
  assert.equal(quemAgendouDe('sofia'), 'Sofia');
  assert.equal(quemAgendouDe('IA'), 'Sofia');
  assert.equal(quemAgendouDe('Cleia'), 'Cleia');
  assert.equal(quemAgendouDe(''), 'Sem registro');
  assert.equal(quemAgendouDe(null), 'Sem registro');
});

test('relatório do marketing: cartões, qualificação, quem agendou e variação', () => {
  const periodo = resolverPeriodo('fimdia', AGORA);
  const conversas = [
    conv(1, { custom_attributes: { qualificacao: 'Quente', etapa: 'Agendado', quem_agendou: 'Sofia' } }),
    conv(2, { custom_attributes: { qualificacao: 'Frio', etapa: 'Sofia qualifica' }, labels: ['sem-resposta'] }),
    conv(3, { custom_attributes: { etapa: 'Sofia qualifica' } }),
    conv(4, { created_at: s('2026-11-12T12:00:00Z'), custom_attributes: { qualificacao: 'Morno', etapa: 'Agendado', quem_agendou: 'Cleia' } }), // ontem
    conv(5, { created_at: s('2026-11-12T13:00:00Z'), custom_attributes: { etapa: 'Sofia qualifica' } }), // ontem
    conv(6, { created_at: s('2026-11-01T10:00:00Z'), labels: ['pagou-antecipado'] }), // antiga, com atividade hoje
    conv(7, { created_at: s('2026-11-01T10:00:00Z'), custom_attributes: { situacao_consulta: 'Não compareceu', data_consulta: '2026-11-12' } }),
  ];
  const r = montarMarketing({ conversas, referrals: new Map(), periodo, agendaramNoPeriodo: new Set([1, 99]), agendaramNoPeriodoAnterior: new Set([4]) }, AGORA);
  assert.deepEqual(r.cartoes, { amanheceram: 3, interagiram: 2, naoInteragiram: 1, agendaram: 1, pagaramAntecipado: 1 });
  assert.deepEqual(r.qualificacao, { quente: 1, morno: 0, frio: 1, semQualificacao: 1 });
  assert.deepEqual(r.quemAgendou, [{ quem: 'Sofia', agendamentos: 1 }]); // o id 99 não é desta pessoa: não conta
  assert.equal(r.faltaramOntem, 1);
  assert.deepEqual(r.anterior, { amanheceram: 2, interagiram: 2, naoInteragiram: 0, agendaram: 1 });
  assert.equal(r.total.leads, 3);
  assert.equal(r.semCampanha.leads, 3);
  // sem a janela anterior (leitura cortada) não há comparação
  const sem = montarMarketing({ conversas, referrals: new Map(), periodo, agendaramNoPeriodo: new Set([1]) }, AGORA);
  assert.equal(sem.anterior, null);
});

test('relatório do marketing sem conversa nenhuma: zeros, tabela vazia, sem erro', () => {
  const r = montarMarketing({ conversas: [], referrals: new Map(), periodo: resolverPeriodo('semana', AGORA), agendaramNoPeriodo: new Set() }, AGORA);
  assert.deepEqual(r.cartoes, { amanheceram: 0, interagiram: 0, naoInteragiram: 0, agendaram: 0, pagaramAntecipado: 0 });
  assert.equal(r.campanhas.length, 0);
  assert.equal(r.quemAgendou.length, 0);
  assert.equal(r.total.pctFrio, null);
});

// ── Gestor ──────────────────────────────────────────────────────────────────────

test('gestor: fonte ligada → todos os números, variação e série por dia', () => {
  const periodo = resolverPeriodo('semana', AGORA);
  const conversas = [
    conv(1, { created_at: s('2026-11-10T12:00:00Z'), custom_attributes: { etapa: 'Fechou', fechou_tratamento: 'sim', valor_fechado: '2620', qualificacao: 'Quente' } }),
    conv(2, { created_at: s('2026-11-11T12:00:00Z'), custom_attributes: { etapa: 'Agendado' } }),
    conv(3, { created_at: s('2026-11-12T12:00:00Z'), custom_attributes: { etapa: 'Sofia qualifica' } }),
    conv(4, { created_at: s('2026-11-03T12:00:00Z'), custom_attributes: { etapa: 'Fechou', fechou_tratamento: 'sim', valor_fechado: '1000' } }), // semana anterior
  ];
  const refs = new Map([[1, { anuncioId: '111111', tipo: 'ad', url: null, titulo: 'x' }]]);
  const p = montarGestor({
    conversas,
    referrals: refs,
    gastos: GASTOS,
    investido: { estado: 'ok', valor: 2150.5, moeda: 'BRL', motivo: null, porDia: { '2026-11-10': 500 } },
    faturadoFranquia: { valor: 9000, fonte: 'franquia', motivo: null, porDia: { '2026-11-10': 5000 } },
    anterior: { investido: { estado: 'ok', valor: 1000, moeda: null, motivo: null }, faturado: { valor: 4500, fonte: 'franquia', motivo: null } },
    periodo,
  });
  assert.equal(p.leads, 3);
  assert.equal(p.fecharam, 1);
  assert.equal(p.agendaram, 2); // Fechou e Agendado
  assert.deepEqual(p.indicadores, { retorno: 4.2, cac: 2150.5, custoPorConsulta: 1075.25 });
  assert.equal(p.faturado.fonte, 'franquia');
  assert.equal(p.faturadoDasConversas, 2620);
  assert.equal(p.anterior!.investido, 1000);
  assert.equal(p.anterior!.indicadores.cac, 1000); // 1 fechou na semana anterior
  assert.equal(p.serie.length, 7);
  assert.deepEqual(p.serie.find((x) => x.dia === '2026-11-10'), { dia: '2026-11-10', investido: 500, faturado: 5000 });
  assert.deepEqual(p.serie.find((x) => x.dia === '2026-11-09'), { dia: '2026-11-09', investido: 0, faturado: 0 });
  assert.equal(p.total.leads, 3);
  assert.equal(p.total.investido, 2150.5);
  assert.equal(p.campanhas[0]!.titulo, 'ENG | LAL'); // ordenado por investido
});

test('gestor: Meta não ligada → investido null, retorno/CAC/custo null, o resto continua (nada inventado)', () => {
  const p = montarGestor({
    conversas: [conv(1, { custom_attributes: { etapa: 'Fechou', fechou_tratamento: 'sim', valor_fechado: '2620' } })],
    referrals: new Map(),
    gastos: null,
    investido: { estado: 'conectar', valor: null, moeda: null, motivo: 'Falta ligar a conta' },
    faturadoFranquia: { valor: null, fonte: null, motivo: 'a franquia não respondeu' },
    periodo: resolverPeriodo('fimdia', AGORA),
  });
  assert.equal(p.investido.estado, 'conectar');
  assert.deepEqual(p.indicadores, { retorno: null, cac: null, custoPorConsulta: null });
  // franquia fora do ar: o faturado cai para o valor fechado nas conversas, dizendo a fonte
  assert.deepEqual([p.faturado.valor, p.faturado.fonte], [2620, 'conversas']);
  assert.equal(p.serie.length, 0); // um dia só: sem gráfico
  assert.equal(p.anterior, null);
  assert.equal(p.total.investido, null);
});

test('gestor sem lead nenhum: zeros e nenhuma linha, sem dividir por zero', () => {
  const p = montarGestor({
    conversas: [],
    referrals: new Map(),
    gastos: [],
    investido: { estado: 'ok', valor: 0, moeda: 'BRL', motivo: null },
    faturadoFranquia: { valor: 0, fonte: 'franquia', motivo: null },
    periodo: resolverPeriodo('mes', AGORA),
  });
  assert.equal(p.leads, 0);
  assert.deepEqual(p.indicadores, { retorno: null, cac: null, custoPorConsulta: null });
  assert.equal(p.campanhas.length, 0);
});

test('conta de anúncios por unidade: nomes das envs e o que falta', () => {
  assert.equal(sufixoDaUnidade('doutor-hernia-parauapebas'), 'PARAUAPEBAS');
  assert.equal(sufixoDaUnidade('doutor-hernia-rio-verde'), 'RIO_VERDE');
  assert.deepEqual(credenciaisDeAnuncio('doutor-hernia-parauapebas', {}), { falta: ['META_ADS_TOKEN_PARAUAPEBAS', 'META_ADS_CONTA_PARAUAPEBAS'] });
  assert.deepEqual(credenciaisDeAnuncio('doutor-hernia-parauapebas', { META_ADS_TOKEN_PARAUAPEBAS: 'tok' }), { falta: ['META_ADS_CONTA_PARAUAPEBAS'] });
  assert.deepEqual(credenciaisDeAnuncio('doutor-hernia-parauapebas', { META_ADS_TOKEN_PARAUAPEBAS: 'tok', META_ADS_CONTA_PARAUAPEBAS: 'act_12345678' }), { token: 'tok', conta: '12345678' });
  assert.deepEqual(credenciaisDeAnuncio('doutor-hernia-parauapebas', { META_ADS_TOKEN_PARAUAPEBAS: 'tok', META_ADS_CONTA_PARAUAPEBAS: 'abc' }), { falta: ['META_ADS_CONTA_PARAUAPEBAS'] });
});

// ── Oportunidades ───────────────────────────────────────────────────────────────

test('oportunidades: as quatro listas, o semáforo e a ordem', () => {
  const conversas = [
    conv(1, { custom_attributes: { etapa: 'Compareceu', data_consulta: '2026-11-12' } }), // ontem: verde
    conv(2, { custom_attributes: { etapa: 'Pós-consulta', data_consulta: '2026-11-08', motivo_espera: 'objeção: valor' } }), // 5 dias: amarelo
    conv(3, { custom_attributes: { etapa: 'Compareceu', data_consulta: '2026-11-02' } }), // 11 dias: vermelho
    conv(4, { custom_attributes: { etapa: 'Compareceu', data_consulta: '2026-11-12' }, meta: { sender: { name: 'Com semáforo', phone_number: '', custom_attributes: { semaforo: 'vermelho' } } } }), // o do contato manda
    conv(5, { custom_attributes: { etapa: 'Fechou', fechou_tratamento: 'sim', data_alta: '2026-09-13' } }), // 61 dias
    conv(6, { custom_attributes: { etapa: 'Fechou', fechou_tratamento: 'sim', data_alta: '2026-09-14' } }), // 60 dias: entra (≥ 60)
    conv(7, { custom_attributes: { etapa: 'Fechou', fechou_tratamento: 'sim', data_alta: '2026-09-15' } }), // 59 dias: não
    conv(8, { labels: ['ficou-de-ver-depois'], custom_attributes: { etapa: 'Resgate', retomar_em: '2026-11-20', motivo_espera: 'vai ver com o marido' } }),
    conv(9, { custom_attributes: { etapa: 'Resgate', retomar_em: '2026-11-12' } }), // venceu
    conv(10, { custom_attributes: { etapa: 'Resgate', retomar_em: '2026-11-30' } }), // futuro, sem etiqueta: não
    conv(11, { labels: ['pagou-antecipado'], custom_attributes: { etapa: 'Agendado', data_consulta: '2026-11-14', hora_consulta: '08:00:00', situacao_consulta: 'Agendado' } }),
    conv(12, { labels: ['pagou-antecipado'], custom_attributes: { etapa: 'Compareceu', data_consulta: '2026-11-05' } }), // já consultou: não é «por vir»
    conv(13, { labels: ['pagou-antecipado'], custom_attributes: { etapa: 'Agendado', data_consulta: '2026-11-01' } }), // data passada: não
    conv(14, { custom_attributes: { etapa: 'Pós-consulta', data_consulta: '2026-11-01', fechou_tratamento: 'sim' } }), // fechou: não
  ];
  const o = montarOportunidades(conversas, AGORA);
  // o 12 pagou o sinal, mas já consultou e não fechou: está aqui, e não em «Pagou antecipado» (a consulta não é mais «por vir»)
  assert.deepEqual(o.naoFecharam.map((x) => [x.id, x.semaforo]), [[3, 'Vermelho'], [12, 'Vermelho'], [4, 'Vermelho'], [2, 'Amarelo'], [1, 'Verde']]);
  assert.match(o.naoFecharam.find((x) => x.id === 2)!.detalhe, /Consulta 08\/11 · Pós-consulta · objeção: valor/);
  assert.deepEqual(o.retorno60.map((x) => x.id), [6, 5]);
  assert.match(o.retorno60[0]!.detalhe, /Alta em 14\/09/);
  assert.deepEqual(o.verDepois.map((x) => x.id).sort(), [8, 9]);
  assert.deepEqual(o.pagouAntecipado.map((x) => x.id), [11]);
  assert.match(o.pagouAntecipado[0]!.detalhe, /Sinal pago · consulta 14\/11 às 08:00/);
  assert.deepEqual(o.totais, { naoFecharam: 5, retorno60: 2, verDepois: 2, pagouAntecipado: 1 });
  // o telefone vai para o «Ligar»; sem telefone, null
  assert.equal(o.naoFecharam.find((x) => x.id === 3)!.telefone, '+5594999990000');
  assert.equal(o.naoFecharam.find((x) => x.id === 4)!.telefone, null);
});

test('oportunidades: lista longa mostra só as primeiras, mas o total é o verdadeiro; tudo vazio não quebra', () => {
  const muitas = Array.from({ length: 80 }, (_, i) => conv(1000 + i, { custom_attributes: { etapa: 'Compareceu', data_consulta: '2026-11-01' } }));
  const o = montarOportunidades(muitas, AGORA);
  assert.equal(o.naoFecharam.length, 60);
  assert.equal(o.totais.naoFecharam, 80);
  const v = montarOportunidades([], AGORA);
  assert.deepEqual(v.totais, { naoFecharam: 0, retorno60: 0, verDepois: 0, pagouAntecipado: 0 });
});

test('semáforo sem dado do contato e sem data de consulta usa a última atividade', () => {
  const antigo = conv(1, { last_activity_at: s('2026-11-01T12:00:00Z'), custom_attributes: { etapa: 'Compareceu' } });
  assert.equal(semaforoDe(antigo, '2026-11-13'), 'Vermelho');
});
