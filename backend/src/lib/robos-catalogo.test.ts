/**
 * O catálogo da tela «Robôs»: todas as regras de `candidatos()` aparecem nele (e nenhuma sobra), o que vem do código é descoberto de verdade
 * (modelos, respeita sem-follow-up), o tempo configurável desloca o horário exatamente isso e na direção certa, e cada regra que fala com o
 * paciente tem texto de exemplo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const { candidatos } = await import('./chatwoot-regua.js');
const { catalogo, descobrir, regraDoCatalogo, REGRAS_COM_DESCRICAO } = await import('./robos-catalogo.js');
const { TEMPO, validarTempo, emUnidade, etiquetaDoTempo, descreverMinutos } = await import('./robos-tempo.js');
const { TEXTOS_PARAU } = await import('./chatwoot-regua-textos.js');

/** As regras que o FONTE da régua escreve (`regra: 'x'`, `[48, 'x', 'parau_…']`, `vespera: ['x', …]`): quebra se alguém criar regra e esquecer o catálogo. */
function regrasDoFonte(): Set<string> {
  const fonte = readFileSync(fileURLToPath(new URL('./chatwoot-regua.ts', import.meta.url)), 'utf8');
  const achadas = new Set<string>();
  for (const m of fonte.matchAll(/regra:\s*'([a-z0-9-]+)'/g)) achadas.add(m[1]!);
  for (const m of fonte.matchAll(/\['([a-z0-9-]+)',\s*(?:'parau_|etapa)/g)) achadas.add(m[1]!);
  for (const m of fonte.matchAll(/\[\s*'([a-z0-9-]+)',\s*'parau_/g)) achadas.add(m[1]!);
  return achadas;
}

test('o catálogo cobre TODA regra do fonte da régua (e não guarda regra que o código não monta mais)', () => {
  const fonte = regrasDoFonte();
  const doCatalogo = new Set(catalogo().map((r) => r.regra));
  assert.ok(fonte.size >= 30, 'achou as regras no fonte (' + fonte.size + ')');
  for (const r of fonte) assert.ok(doCatalogo.has(r), `regra «${r}» está no código da régua mas não no catálogo da tela Robôs`);
  for (const r of doCatalogo) assert.ok(fonte.has(r), `regra «${r}» está no catálogo mas o código da régua não a monta`);
  // e a descoberta (rodando candidatos() de verdade) acha o mesmo conjunto
  const achadas = new Set(descobrir().keys());
  for (const r of fonte) assert.ok(achadas.has(r), `nenhuma conversa de exemplo acende a regra «${r}» (acrescente uma em robos-catalogo.ts)`);
  // toda regra do catálogo tem nome, quando, grupo e (se fala com o paciente) modelo e texto
  for (const r of catalogo()) {
    assert.ok(!r.semMeta, `regra «${r.regra}» sem descrição em português (META)`);
    assert.ok(r.nome.length > 3 && r.quando.length > 10, r.regra);
    if (!r.interna) {
      assert.ok(r.modelos.length >= 1, r.regra);
      for (const m of r.modelos) {
        assert.ok(m.modelo in TEXTOS_PARAU, m.modelo);
        assert.ok(m.texto && m.texto.length > 20 && !m.texto.includes('{{'), `${r.regra}/${m.modelo}: texto de exemplo`);
      }
    } else {
      assert.equal(r.modelos.length, 1);
      assert.ok(r.modelos[0]!.texto, r.regra);
    }
  }
  assert.deepEqual([...REGRAS_COM_DESCRICAO].sort(), [...doCatalogo].sort());
});

test('o que vem do código é DESCOBERTO: modelos por regra, internas e quem respeita o sem-follow-up', () => {
  const r = (x: string) => regraDoCatalogo(x)!;
  assert.deepEqual(r('followup-48h').modelos.map((m) => m.modelo), ['parau_lead_reengajamento_48h']);
  assert.deepEqual(r('consulta-vespera').modelos.map((m) => m.modelo), ['parau_consulta_lembrete_vespera', 'parau_sessao_lembrete_vespera']);
  assert.equal(r('espera-retomar').modelos.length, 4);
  for (const x of ['lead-quente-parado', 'sem-resposta-24h', 'pendencia-fechou']) assert.equal(r(x).interna, true, x);
  // respeitam o sem-follow-up (o código os esconde com a etiqueta)
  for (const x of ['followup-48h', 'followup-96h', 'followup-120h', 'falta-48h', 'decisao-4d', 'decisao-7d', 'decisao-30d', 'espera-retomar', 'espera-retomada2', 'sdr-retomada', 'sdr-reativacao']) {
    assert.equal(r(x).respeitaSemFollowUp, true, x);
    assert.ok(r(x).condicoes.includes('Não pediu para parar'), x);
  }
  // aviso de consulta/sessão e o que o paciente pediu/precisa NÃO respeitam
  for (const x of ['consulta-vespera', 'consulta-dia', 'consulta-preparo', 'sessao-dia', 'prepagamento', 'alta-conclusao', 'sdr-confirmar-retorno', 'sdr-boas-vindas']) assert.equal(r(x).respeitaSemFollowUp, false, x);
  // grupos
  assert.equal(r('alta-nps').grupo, 'tratamento');
  assert.equal(r('sdr-retomada').grupo, 'sdr');
  assert.equal(r('followup-48h').grupo, 'comercial');
});

// ── tempo: mexer no número desloca o horário exatamente isso, na direção certa ─────────────────────

const AGORA = '2026-11-16T12:00:00Z';
const visto = (valor = 'sim', desde = AGORA) => ({ valor, desde: new Date(desde), inicial: false });
function conv(attrs: Record<string, unknown>, etiquetas: string[] = [], ultima: unknown = null) {
  return { id: 1, nome: 'Maria da Silva', etiquetas, attrs, criadaEm: new Date('2026-10-01T12:00:00Z'), atendente: 'Ana', ultima: ultima as never, telefone: '+5594999990000' };
}
const saiuNaoCliente = { saida: true, privada: false, autorId: 4, autorTipo: 'user', criadaEm: new Date('2026-11-15T12:00:00Z') };
const CONSULTA = { data_consulta: '2026-11-18', hora_consulta: '14:30' };
/** uma conversa em que a regra aparece, e os vistos dela */
const CENARIOS: Record<string, { c: ReturnType<typeof conv>; v: Map<string, ReturnType<typeof visto>> }> = {
  'consulta-vespera': { c: conv({ etapa: 'Agendado', situacao_consulta: 'Agendado', ...CONSULTA }), v: new Map() },
  'consulta-dia': { c: conv({ etapa: 'Agendado', situacao_consulta: 'Agendado', ...CONSULTA }), v: new Map() },
  'consulta-preparo': { c: conv({ etapa: 'Agendado', situacao_consulta: 'Agendado', ...CONSULTA }), v: new Map() },
  'sessao-dia': { c: conv({ funil: 'Tratamento', etapa_tratamento: 'Em tratamento', proxima_sessao: '2026-11-18', hora_sessao: '10:00' }), v: new Map() },
  'prepagamento-pendente': { c: conv({ etapa: 'Agendado', situacao_consulta: 'Agendado', pagamento_antecipado: 'sim' }), v: new Map([['etapa', visto('Agendado')]]) },
  'pos-atendimento': { c: conv({ etapa: 'Compareceu', situacao_consulta: 'Atendido', data_consulta: '2026-11-10', hora_consulta: '10:00' }), v: new Map() },
  'decisao-4d': { c: conv({ etapa: 'Pós-consulta', situacao_consulta: 'Atendido', data_consulta: '2026-11-10', hora_consulta: '10:00' }), v: new Map() },
  'decisao-7d': { c: conv({ etapa: 'Pós-consulta', situacao_consulta: 'Atendido', data_consulta: '2026-11-10', hora_consulta: '10:00' }), v: new Map() },
  'decisao-30d': { c: conv({ etapa: 'Pós-consulta', situacao_consulta: 'Atendido', data_consulta: '2026-11-10', hora_consulta: '10:00' }), v: new Map() },
  'followup-48h': { c: conv({ etapa: 'Perdido' }), v: new Map([['etapa', visto('Perdido')]]) },
  'followup-96h': { c: conv({ etapa: 'Perdido' }), v: new Map([['etapa', visto('Perdido')]]) },
  'followup-120h': { c: conv({ etapa: 'Perdido' }), v: new Map([['etapa', visto('Perdido')]]) },
  'falta-48h': { c: conv({ etapa: 'Agendado', situacao_consulta: 'Não compareceu', data_consulta: '2026-11-14', hora_consulta: '09:00' }), v: new Map() },
  'espera-retomada2': { c: conv({ etapa: 'Sofia qualifica', retomar_em: '2026-11-18', motivo_espera: 'Exames' }), v: new Map() },
  'alta-nps': { c: conv({ funil: 'Tratamento', etapa_tratamento: 'Alta' }), v: new Map([['etapa_tratamento', visto('Alta')]]) },
  'alta-retorno-60d': { c: conv({ categoria_consulta: 'Retorno após tratamento', data_alta: '2026-10-01' }), v: new Map() },
  'pendencia-documento': { c: conv({ funil: 'Tratamento', etapa_tratamento: 'Em tratamento', motivo_nao_fechamento: 'Solicitado exames', data_consulta: '2026-11-10', hora_consulta: '10:00' }, ['pendencia-exame-avisado']), v: new Map() },
  'lead-quente-parado': { c: conv({ etapa: 'Sofia qualifica', qualificacao: 'Quente' }, [], saiuNaoCliente), v: new Map() },
  'sem-resposta-24h': { c: conv({ etapa: 'Sofia qualifica' }, [], saiuNaoCliente), v: new Map() },
};
const MIN = 60_000;
const alvoDe = (regra: string, tempoMin?: number) => {
  const { c, v } = CENARIOS[regra]!;
  const ajustes = tempoMin === undefined ? undefined : { tempoMin: new Map([[regra, tempoMin]]) };
  const achados = candidatos(c, v, ajustes).filter((k) => k.regra === regra);
  assert.ok(achados.length >= 1, `cenário não acende ${regra}`);
  return achados[0]!.alvo.getTime();
};

test('todo robô com tempo tem cenário de teste (e o contrário), e o tempo de fábrica está dentro dos limites', () => {
  assert.deepEqual(Object.keys(CENARIOS).sort(), Object.keys(TEMPO).sort());
  for (const [regra, e] of Object.entries(TEMPO)) {
    assert.ok(e.minMin <= e.padraoMin && e.padraoMin <= e.maxMin, regra);
    assert.ok(e.unidades.length >= 1, regra);
    if (e.diasInteiros) assert.equal(e.padraoMin % 1440, 0, regra);
  }
});

test('o tempo configurado desloca o horário EXATAMENTE isso, na direção do robô; o de fábrica não muda nada', () => {
  for (const [regra, e] of Object.entries(TEMPO)) {
    const base = alvoDe(regra);
    assert.equal(alvoDe(regra, e.padraoMin), base, `${regra}: pôr o valor de fábrica não muda o horário`);
    const mais = e.diasInteiros ? 1440 : 60;
    const novo = e.padraoMin + mais;
    const delta = alvoDe(regra, novo) - base;
    // «antes»: esperar mais = sair MAIS CEDO; «depois»: esperar mais = sair MAIS TARDE
    const esperado = (e.direcao === 'antes' ? -1 : 1) * mais * MIN;
    assert.equal(delta, esperado, `${regra}: +${mais} min`);
  }
});

test('validação do tempo: mesma direção, unidade do robô, inteiro, dentro do mínimo e do máximo, dias inteiros onde o robô age às 09:00', () => {
  const ok = (r: string, numero: unknown, unidade: unknown, direcao: unknown) => validarTempo(r, { numero, unidade, direcao });
  assert.deepEqual(ok('consulta-vespera', 30, 'horas', 'antes'), { ok: true, minutos: 1800 });
  // o texto diz «amanhã»: a véspera só vale de 16 h a 32 h antes (48 h e 2 dias seriam mentira)
  assert.equal(ok('consulta-vespera', 48, 'horas', 'antes').ok, false);
  assert.equal(ok('consulta-vespera', 2, 'dias', 'antes').ok, false, 'a véspera é em horas');
  assert.equal(ok('consulta-vespera', 15, 'horas', 'antes').ok, false);
  assert.equal(ok('consulta-vespera', 16, 'horas', 'antes').ok, true);
  assert.equal(ok('consulta-vespera', 32, 'horas', 'antes').ok, true);
  assert.equal(ok('consulta-vespera', 33, 'horas', 'antes').ok, false);
  // «Foi bom te receber ontem»: 16 h a 32 h; «faz cerca de um mês»: 21 a 45 dias; «já se passaram 60 dias»: 55 a 65 dias
  assert.equal(ok('pos-atendimento', 12, 'horas', 'depois').ok, false);
  assert.equal(ok('pos-atendimento', 3, 'dias', 'depois').ok, false);
  assert.equal(ok('pos-atendimento', 28, 'horas', 'depois').ok, true);
  assert.equal(ok('decisao-30d', 20, 'dias', 'depois').ok, false);
  assert.equal(ok('decisao-30d', 46, 'dias', 'depois').ok, false);
  assert.equal(ok('decisao-30d', 21, 'dias', 'depois').ok, true);
  assert.equal(ok('decisao-30d', 45, 'dias', 'depois').ok, true);
  assert.equal(ok('alta-retorno-60d', 54, 'dias', 'depois').ok, false);
  assert.equal(ok('alta-retorno-60d', 66, 'dias', 'depois').ok, false);
  assert.equal(ok('alta-retorno-60d', 55, 'dias', 'depois').ok, true);
  assert.equal(ok('alta-retorno-60d', 65, 'dias', 'depois').ok, true);
  // «de hoje» / «até amanhã»
  assert.equal(ok('consulta-dia', 7, 'horas', 'antes').ok, false);
  assert.equal(ok('prepagamento-pendente', 2, 'dias', 'depois').ok, false);
  // «antes» não pode virar «depois» (e vice-versa)
  assert.equal(ok('consulta-vespera', 24, 'horas', 'depois').ok, false);
  assert.equal(ok('followup-48h', 48, 'horas', 'antes').ok, false);
  // limites
  assert.equal(ok('consulta-vespera', 1, 'horas', 'antes').ok, false);
  assert.equal(ok('consulta-dia', 20, 'minutos', 'antes').ok, false); // abaixo de 30 min
  assert.equal(ok('consulta-dia', 6, 'horas', 'antes').ok, true);
  assert.equal(ok('followup-48h', 11, 'dias', 'depois').ok, false);
  // unidade que o robô não aceita, número quebrado, negativo, texto
  assert.equal(ok('decisao-4d', 96, 'horas', 'depois').ok, false);
  assert.equal(ok('decisao-4d', 5, 'dias', 'depois').ok, true);
  assert.equal(ok('consulta-dia', 1.5, 'horas', 'antes').ok, false);
  assert.equal(ok('consulta-dia', -3, 'horas', 'antes').ok, false);
  assert.equal(ok('consulta-dia', '3', 'horas', 'antes').ok, false);
  assert.equal(ok('consulta-dia', 3, 'semanas', 'antes').ok, false);
  // robô sem tempo para mudar
  assert.equal(ok('alta-conclusao', 1, 'horas', 'depois').ok, false);
  assert.equal(ok('sdr-retomada', 1, 'horas', 'depois').ok, false);
  assert.equal(ok('regra-que-nao-existe', 1, 'horas', 'depois').ok, false);
});

test('como a tela escreve o tempo', () => {
  assert.equal(etiquetaDoTempo('consulta-vespera', 1440), '1 dia antes da consulta ou da sessão');
  assert.equal(etiquetaDoTempo('followup-48h', 2880), '2 dias depois de virar Perdido');
  assert.equal(etiquetaDoTempo('consulta-dia', 180), '3 h antes da consulta');
  assert.equal(descreverMinutos(90), '1 h 30 min');
  assert.deepEqual(emUnidade('consulta-dia', 180), { numero: 3, unidade: 'horas' });
  assert.deepEqual(emUnidade('consulta-dia', 45), { numero: 45, unidade: 'minutos' });
  assert.deepEqual(emUnidade('decisao-4d', 5760), { numero: 4, unidade: 'dias' });
});

test('a ordem das sequências nunca se inverte: followup 48 h < 96 h < 120 h; pós-atendimento < decisão 4 d < 7 d < 30 d; preparo < hoje < véspera', async () => {
  const { ordemQuebrada, SEQUENCIAS, TEMPO: T2 } = await import('./robos-tempo.js');
  const efetivo = (o: Record<string, number> = {}) => (r: string) => o[r] ?? T2[r]!.padraoMin;
  // valores de fábrica respeitam a ordem
  for (const seq of SEQUENCIAS) for (let i = 1; i < seq.length; i++) assert.ok(T2[seq[i - 1]!]!.padraoMin < T2[seq[i]!]!.padraoMin, `${seq[i - 1]} < ${seq[i]}`);
  // as regras de cada sequência existem
  for (const seq of SEQUENCIAS) for (const r of seq) assert.ok(T2[r], r);
  assert.equal(ordemQuebrada('followup-96h', 100 * 60, efetivo()), null);
  assert.match(ordemQuebrada('followup-96h', 48 * 60, efetivo()) ?? '', /DEPOIS de «followup-48h»/);
  assert.match(ordemQuebrada('followup-96h', 120 * 60, efetivo()) ?? '', /ANTES de «followup-120h»/);
  assert.match(ordemQuebrada('followup-48h', 97 * 60, efetivo()) ?? '', /ANTES de «followup-96h»/);
  assert.match(ordemQuebrada('decisao-4d', 8 * 1440, efetivo()) ?? '', /ANTES de «decisao-7d»/);
  assert.match(ordemQuebrada('decisao-7d', 4 * 1440, efetivo()) ?? '', /DEPOIS de «decisao-4d»/);
  assert.match(ordemQuebrada('decisao-4d', 1 * 1440, efetivo({ 'pos-atendimento': 30 * 60 })) ?? '', /DEPOIS de «pos-atendimento»/);
  assert.match(ordemQuebrada('consulta-dia', 30, efetivo()) ?? '', /DEPOIS de «consulta-preparo»/);
  assert.match(ordemQuebrada('consulta-preparo', 4 * 60, efetivo()) ?? '', /ANTES de «consulta-dia»/);
  assert.equal(ordemQuebrada('alta-nps', 1, efetivo()), null, 'robô fora de sequência');
});
