/**
 * Tela «Robôs»: quem pode mexer (só administrador), troca de modelo (só aprovado e com as mesmas variáveis), tempo validado, o que o worker lê,
 * a lista e a aba «Enviados» (nunca outra unidade, nunca capi/kapso) e a classificação de cada linha do registro.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const E = await import('./robos-estado.js');
const { TEXTOS_PARAU } = await import('./chatwoot-regua-textos.js');

type Linha = import('./robos-estado.js').LinhaDoRobo;
type Disp = import('./robos-estado.js').LinhaDeDisparo;

function bancoFalso(o: { linhas?: Record<string, Linha[]>; disparos?: Disp[] } = {}) {
  const linhas = o.linhas ?? {};
  const gravacoes: Array<{ slug: string; regra: string; m: unknown; por: string }> = [];
  const pedidosDeDisparo: Array<{ caixas: number[]; limite: number }> = [];
  const banco: import('./robos-estado.js').BancoDosRobos = {
    async linhas(slug) {
      return (linhas[slug] ?? []).map((l) => ({ ...l }));
    },
    async salvar(slug, regra, m, por) {
      gravacoes.push({ slug, regra, m, por });
      const lista = (linhas[slug] ??= []);
      let l = lista.find((x) => x.regra === regra);
      if (!l) lista.push((l = { regra, ligado: true, tempoMin: null, modelos: {}, por: null, em: new Date() }));
      if (m.ligado !== undefined) l.ligado = m.ligado;
      if (m.tempoMin !== undefined) l.tempoMin = m.tempoMin;
      if (m.modelos !== undefined) l.modelos = m.modelos;
      l.por = por;
      l.em = new Date();
    },
    async disparos(caixas, desde, limite) {
      pedidosDeDisparo.push({ caixas, limite });
      // o banco falso devolve TUDO (inclusive de outra caixa): quem filtra é o código sob teste
      return (o.disparos ?? []).filter((d) => d.criadoEm >= desde);
    },
  };
  return { banco, gravacoes, linhas, pedidosDeDisparo };
}

const todosAprovados = (): import('./robos-estado.js').Aprovados => new Map(Object.keys(TEXTOS_PARAU).map((m) => [m, null] as const));
const ADMIN = 'administrator';

// ── permissão ──────────────────────────────────────────────────────────────────────────────────────

test('só administrador do Chatwoot muda robô; atendente é recusada e nada é gravado', async () => {
  const { banco, gravacoes } = bancoFalso();
  for (const papel of ['agent', null, undefined, '', 'Administrator ']) {
    const r = await E.mudarRobo(banco, { slug: 'doutor-hernia-parauapebas', regra: 'consulta-vespera', papel, por: 'Ana', ligado: false, aprovados: null });
    assert.deepEqual(r, { ok: false, status: 403, erro: 'só quem administra o CRM configura os robôs — peça para a Suzanne ou para o João' }, String(papel));
  }
  assert.equal(gravacoes.length, 0);
  assert.equal(E.podeMexerNosRobos('administrator'), true);
  assert.equal(E.podeMexerNosRobos('agent'), false);
  // administrador liga/desliga e fica o nome de quem mexeu
  const r = await E.mudarRobo(banco, { slug: 'doutor-hernia-parauapebas', regra: 'consulta-vespera', papel: ADMIN, por: 'Suzanne', ligado: false, aprovados: null });
  assert.deepEqual(r, { ok: true, regra: 'consulta-vespera' });
  assert.deepEqual(gravacoes, [{ slug: 'doutor-hernia-parauapebas', regra: 'consulta-vespera', m: { ligado: false }, por: 'Suzanne' }]);
});

test('pedido inválido: robô que não existe, ligado que não é booleano, nada para mudar', async () => {
  const { banco, gravacoes } = bancoFalso();
  const p = { slug: 's', papel: ADMIN, por: 'Su', aprovados: null };
  assert.equal((await E.mudarRobo(banco, { ...p, regra: 'inventado', ligado: true })).ok, false);
  assert.equal((await E.mudarRobo(banco, { ...p, regra: 'consulta-vespera', ligado: 'sim' })).ok, false);
  assert.equal((await E.mudarRobo(banco, { ...p, regra: 'consulta-vespera' })).ok, false);
  assert.equal((await E.mudarRobo(banco, { ...p, regra: 123, ligado: true })).ok, false);
  assert.equal(gravacoes.length, 0);
});

// ── tempo ──────────────────────────────────────────────────────────────────────────────────────────

test('tempo: valida, grava em minutos, igual ao de fábrica volta ao de fábrica, e nunca troca antes por depois', async () => {
  const { banco, gravacoes } = bancoFalso();
  const p = { slug: 's', papel: ADMIN, por: 'Su', aprovados: null, regra: 'consulta-vespera' };
  assert.deepEqual(await E.mudarRobo(banco, { ...p, tempo: { numero: 30, unidade: 'horas', direcao: 'antes' } }), { ok: true, regra: 'consulta-vespera' });
  assert.deepEqual(gravacoes[0]!.m, { tempoMin: 1800 });
  // o mesmo valor de fábrica (24 h) não deixa «personalizado» à toa
  await E.mudarRobo(banco, { ...p, tempo: { numero: 24, unidade: 'horas', direcao: 'antes' } });
  assert.deepEqual(gravacoes[1]!.m, { tempoMin: null });
  // voltar ao de fábrica
  await E.mudarRobo(banco, { ...p, tempo: null });
  assert.deepEqual(gravacoes[2]!.m, { tempoMin: null });
  // antes ↔ depois, limites e robô sem tempo: 400 e nada gravado
  const n = gravacoes.length;
  for (const tempo of [{ numero: 24, unidade: 'horas', direcao: 'depois' }, { numero: 1, unidade: 'horas', direcao: 'antes' }, { numero: 30, unidade: 'dias', direcao: 'antes' }]) {
    const r = await E.mudarRobo(banco, { ...p, tempo });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.status, 400);
  }
  assert.equal((await E.mudarRobo(banco, { ...p, regra: 'alta-conclusao', tempo: { numero: 1, unidade: 'horas', direcao: 'depois' } })).ok, false);
  assert.equal(gravacoes.length, n);
});

// ── modelo ─────────────────────────────────────────────────────────────────────────────────────────

const VESPERA_SESSAO = { parau_consulta_lembrete_vespera: ['parau_sessao_lembrete_vespera'] } as const; // uma alternativa DECLARADA, só para o teste

test('modelo: a lista de alternativas declaradas hoje é VAZIA — nenhuma troca é aceita, nem entre os modelos do mesmo robô', async () => {
  assert.deepEqual(E.ALTERNATIVAS_DE_MODELO, {});
  const { banco, gravacoes } = bancoFalso();
  const base = { slug: 's', papel: ADMIN, por: 'Su' };
  const todos = todosAprovados();
  // véspera de consulta × véspera de sessão, espera exames × viagem: mesma forma, mas o texto é de outra condição
  for (const [regra, padrao, novo] of [
    ['consulta-vespera', 'parau_consulta_lembrete_vespera', 'parau_sessao_lembrete_vespera'],
    ['espera-retomar', 'parau_espera_exames', 'parau_espera_viagem'],
    ['followup-48h', 'parau_lead_reengajamento_48h', 'parau_consulta_pos_atendimento'],
  ] as const) {
    const r = await E.mudarRobo(banco, { ...base, regra, modelo: { padrao, novo }, aprovados: todos });
    assert.equal(r.ok, false, `${padrao} → ${novo}`);
    assert.match(!r.ok ? r.erro : '', /não há essa alternativa aprovada/);
    assert.deepEqual(E.opcoesDeModelo(padrao, todos).map((o) => o.modelo), [padrao], 'a tela mostra só o de fábrica (seletor desabilitado)');
    assert.equal(E.modeloCompativel(padrao, novo), false);
  }
  assert.equal(gravacoes.length, 0, 'nada recusado foi gravado');
  // voltar ao de fábrica (novo = padrão) segue permitido
  const volta = await E.mudarRobo(banco, { ...base, regra: 'consulta-vespera', modelo: { padrao: 'parau_consulta_lembrete_vespera', novo: 'parau_consulta_lembrete_vespera' }, aprovados: todos });
  assert.equal(volta.ok, true);
  // a tela entrega uma única opção por modelo de fábrica
  const v = await E.visaoDosRobos(bancoFalso().banco, 'doutor-hernia-parauapebas', { agora: new Date('2026-11-17T15:00:00Z'), aprovados: todos });
  let vistos = 0;
  for (const r of v.robos) for (const m of r.modelosDaTela) {
    vistos++;
    assert.equal(m.opcoes.length, 1, `${r.regra}: sem alternativa`);
  }
  assert.ok(vistos > 10);
});

test('modelo (com uma alternativa DECLARADA no teste): entra se estiver aprovada na caixa e pedir as mesmas variáveis; o resto segue recusado', async () => {
  const { banco, gravacoes } = bancoFalso();
  const base = { slug: 's', papel: ADMIN, por: 'Su', regra: 'consulta-vespera', alternativas: VESPERA_SESSAO };
  const padrao = 'parau_consulta_lembrete_vespera';
  const alt = 'parau_sessao_lembrete_vespera';
  const aprovados = new Map<string, number | null>([[padrao, 2], [alt, 2], ['parau_consulta_confirmacao_dia', 2]]);
  assert.deepEqual(await E.mudarRobo(banco, { ...base, modelo: { padrao, novo: alt }, aprovados }), { ok: true, regra: 'consulta-vespera' });
  assert.deepEqual(gravacoes[0]!.m, { modelos: { [padrao]: alt } });
  const n = gravacoes.length;
  assert.equal((await E.mudarRobo(banco, { ...base, modelo: { padrao, novo: 'parau_consulta_confirmacao_dia' }, aprovados })).ok, false, 'não declarada');
  assert.equal((await E.mudarRobo(banco, { ...base, modelo: { padrao, novo: alt }, aprovados: new Map([[padrao, 2]]) })).ok, false, 'não aprovada na caixa');
  assert.equal((await E.mudarRobo(banco, { ...base, modelo: { padrao, novo: alt }, aprovados: new Map([[padrao, 2], [alt, 3]]) })).ok, false, 'a Meta diz outro número de variáveis');
  assert.equal((await E.mudarRobo(banco, { ...base, modelo: { padrao, novo: alt }, aprovados: null })).ok, false, 'sem a lista da Meta: 409');
  assert.equal((await E.mudarRobo(banco, { ...base, regra: 'lead-quente-parado', modelo: { padrao: 'interna:quente-parado', novo: alt }, aprovados })).ok, false, 'robô interno');
  assert.equal(gravacoes.length, n);
  assert.deepEqual(E.opcoesDeModelo(padrao, aprovados, VESPERA_SESSAO).map((o) => o.modelo), [padrao, alt]);
  assert.equal(E.modeloCompativel(padrao, alt, VESPERA_SESSAO), true);
  // declarada com forma diferente: recusada
  assert.equal(E.modeloCompativel(padrao, 'parau_lead_reengajamento_48h', { [padrao]: ['parau_lead_reengajamento_48h'] }), false);
});

// ── o que o worker lê ───────────────────────────────────────────────────────────────────────────────

test('ajustesDaUnidade: desligados, tempo e modelo; lixo antigo é ignorado', async () => {
  const em = new Date();
  const { banco } = bancoFalso({
    linhas: {
      u: [
        { regra: 'consulta-vespera', ligado: false, tempoMin: 1800, modelos: { parau_consulta_lembrete_vespera: 'parau_sessao_lembrete_vespera' }, por: 'Su', em },
        { regra: 'followup-48h', ligado: true, tempoMin: 99999999, modelos: { parau_lead_reengajamento_48h: 'parau_consulta_pos_atendimento', inventado: 'x' }, por: 'Su', em }, // a troca por modelo de OUTRO robô gravada antes é ignorada
        { regra: 'robo-que-nao-existe-mais', ligado: false, tempoMin: null, modelos: {}, por: 'Su', em },
        { regra: 'alta-conclusao', ligado: true, tempoMin: 5, modelos: {}, por: 'Su', em },
      ],
    },
  });
  const a = await E.ajustesDaUnidade(banco, 'u', VESPERA_SESSAO);
  assert.deepEqual([...a.desligados], ['consulta-vespera']);
  assert.equal(a.regua.tempoMin!.get('consulta-vespera'), 1800);
  assert.equal(a.regua.tempoMin!.has('followup-48h'), false, 'valor fora dos limites volta ao de fábrica');
  assert.equal(a.regua.tempoMin!.has('alta-conclusao'), false, 'robô sem tempo ignora o valor');
  // o irmão de fábrica entra; a troca por modelo de outro robô e o inventado não
  assert.equal(a.regua.modelos!.get('consulta-vespera|parau_consulta_lembrete_vespera'), 'parau_sessao_lembrete_vespera');
  assert.equal(a.regua.modelos!.has('followup-48h|parau_lead_reengajamento_48h'), false);
  assert.equal(a.regua.modelos!.size, 1);
  // unidade sem nada: tudo de fábrica
  const v = await E.ajustesDaUnidade(banco, 'outra');
  assert.equal(v.desligados.size, 0);
});

// ── a lista e os enviados ───────────────────────────────────────────────────────────────────────────

const AGORA = new Date('2026-11-17T15:00:00Z');
const d = (o: Partial<Disp>): Disp => ({ caixa: 3, conversationId: 10, regra: 'consulta-vespera', modo: 'ligado', texto: 'Olá', criadoEm: new Date('2026-11-16T15:00:00Z'), ...o });

test('«Enviados»: só as caixas da unidade, só robôs do catálogo, nada de capi/kapso, sem outra unidade, 7 dias', async () => {
  const { banco, pedidosDeDisparo } = bancoFalso({
    disparos: [
      d({ conversationId: 1 }),
      d({ conversationId: 2, caixa: 99 }), // outra unidade
      d({ conversationId: 3, regra: 'capi-visto:AddToCart' }),
      d({ conversationId: 4, regra: 'kapso-referral' }),
      d({ conversationId: 5, regra: 'regra-que-nao-existe' }),
      d({ conversationId: 6, criadoEm: new Date('2026-11-01T15:00:00Z') }), // fora dos 7 dias
      d({ conversationId: 7, regra: 'consulta-vespera!falta', texto: 'nota' }),
      d({ conversationId: 8, regra: 'sessao-dia', texto: '[template parau_sessao_confirmacao_dia] Bom dia' }),
      d({ conversationId: 9, regra: 'consulta-dia', modo: 'seco', texto: '🧪 [SECO] ...' }),
      d({ conversationId: 11, regra: 'consulta-preparo', texto: '🛑 Régua «consulta-preparo» — NÃO enviei: o paciente tem cartão ativo no Kommo da unidade (lead 5); os robôs de lá cuidam.' }),
    ],
  });
  const nomes: number[] = [];
  const r = await E.enviadosDaUnidade(banco, 'doutor-hernia-parauapebas', async (id) => (nomes.push(id), `Paciente ${id}`), AGORA);
  assert.deepEqual(pedidosDeDisparo[0]!.caixas.sort(), [2, 3], 'pede só as caixas desta unidade');
  assert.deepEqual(r.itens.map((i) => i.conversa).sort((a, b) => a - b), [1, 7, 8, 9, 11]);
  assert.equal(nomes.includes(2) || nomes.includes(3) || nomes.includes(4), false, 'nem busca nome do que não mostra');
  const por = Object.fromEntries(r.itens.map((i) => [i.conversa, i]));
  assert.equal(por[1]!.situacao, 'texto');
  assert.equal(por[1]!.paciente, 'Paciente 1');
  assert.equal(por[1]!.robo, 'Lembrete da véspera (consulta ou sessão)');
  assert.equal(por[7]!.situacao, 'faltou-campo');
  assert.equal(por[8]!.situacao, 'template');
  assert.equal(por[9]!.situacao, 'seco');
  assert.equal(por[11]!.situacao, 'kommo');
  assert.equal(por[11]!.enviado, false);
  assert.equal(por[1]!.enviado, true);
  // unidade que não tem caixa na régua: nada
  const vazio = await E.enviadosDaUnidade(banco, 'outra-unidade', async () => 'x', AGORA);
  assert.equal(vazio.itens.length, 0);
  // nome que falha vira null, não derruba
  const semNome = await E.enviadosDaUnidade(banco, 'doutor-hernia-parauapebas', async () => { throw new Error('x'); }, AGORA);
  assert.equal(semNome.itens[0]!.paciente, null);
});

test('a lista de robôs: contagem de 7 dias por robô (enviados, notas, seco), estado e quem mudou, tempo e modelos na tela', async () => {
  const em = new Date('2026-11-16T10:00:00Z');
  const { banco } = bancoFalso({
    linhas: { 'doutor-hernia-parauapebas': [{ regra: 'followup-48h', ligado: false, tempoMin: 4320, modelos: {}, por: 'Suzanne', em }] },
    disparos: [d({ conversationId: 1 }), d({ conversationId: 2 }), d({ conversationId: 3, caixa: 77 }), d({ conversationId: 4, modo: 'seco' }), d({ conversationId: 5, regra: 'consulta-vespera!falta' })],
  });
  const v = await E.visaoDosRobos(banco, 'doutor-hernia-parauapebas', { agora: AGORA, aprovados: todosAprovados() });
  const r = (x: string) => v.robos.find((y) => y.regra === x)!;
  assert.deepEqual([r('consulta-vespera').enviados7d, r('consulta-vespera').notas7d, r('consulta-vespera').seco7d], [2, 1, 1]);
  assert.equal(r('consulta-vespera').ligado, true);
  assert.equal(r('consulta-vespera').mudou, null);
  assert.equal(r('followup-48h').ligado, false);
  assert.deepEqual(r('followup-48h').mudou, { por: 'Suzanne', em: em.toISOString() });
  assert.equal(r('followup-48h').tempo!.atual.numero, 3);
  assert.equal(r('followup-48h').tempo!.atual.unidade, 'dias');
  assert.equal(r('followup-48h').tempo!.personalizado, true);
  assert.equal(r('followup-48h').tempo!.rotulo, '3 dias depois de virar Perdido');
  assert.equal(r('followup-48h').tempo!.rotuloPadrao, '2 dias depois de virar Perdido');
  assert.equal(r('consulta-dia').tempo!.personalizado, false);
  assert.equal(r('alta-conclusao').tempo, null);
  assert.equal(r('consulta-vespera').modelosDaTela.length, 2);
  assert.equal(r('lead-quente-parado').modelosDaTela.length, 0);
  assert.equal(v.aprovadosLidos, true);
  const sem = await E.visaoDosRobos(banco, 'doutor-hernia-parauapebas', { agora: AGORA, aprovados: null });
  assert.equal(sem.aprovadosLidos, false);
  assert.deepEqual(sem.robos.find((x) => x.regra === 'followup-48h')!.modelosDaTela[0]!.opcoes.map((o) => o.modelo), ['parau_lead_reengajamento_48h']);
});

test('situacaoDoRegistro: o que cada linha da tabela de disparos quer dizer', () => {
  const s = (regra: string, modo: string, texto: string, interna = false) => E.situacaoDoRegistro({ regra, modo, texto }, interna).codigo;
  assert.equal(s('consulta-dia', 'ligado', 'Bom dia'), 'texto');
  assert.equal(s('consulta-dia', 'ligado', '[template parau_x] Bom dia'), 'template');
  assert.equal(s('consulta-dia', 'ligado', '🛑 Régua «consulta-dia» — NÃO enviei: o paciente tem cartão ativo no Kommo'), 'kommo');
  assert.equal(s('consulta-dia!falta', 'seco', 'x'), 'faltou-campo');
  assert.equal(s('consulta-dia!template', 'ligado', 'x'), 'sem-template');
  assert.equal(s('consulta-dia!perdida', 'ligado', 'x'), 'perdida');
  assert.equal(s('consulta-dia', 'seco', '🧪 [SECO]'), 'seco');
  assert.equal(s('lead-quente-parado', 'ligado', '🤖 Régua', true), 'interna');
  assert.equal(E.baseDaRegra('consulta-dia!falta'), 'consulta-dia');
  assert.equal(E.baseDaRegra('consulta-dia'), 'consulta-dia');
  assert.deepEqual(E.caixasDaUnidade('a', { 2: 'a', 3: 'a', 4: 'b' }).sort(), [2, 3]);
});

test('mudarRobo recusa valor que inverta a ordem das sequências (followup, pós-atendimento/decisão, lembretes), também ao voltar ao de fábrica', async () => {
  const em = new Date();
  const { banco, gravacoes } = bancoFalso({ linhas: { s: [{ regra: 'followup-96h', ligado: true, tempoMin: 60 * 60, modelos: {}, por: 'Su', em }] } }); // 96 h mexido para 60 h
  const p = { slug: 's', papel: ADMIN, por: 'Su', aprovados: null };
  // followup-48h para 72 h passaria do vizinho (60 h)
  const r1 = await E.mudarRobo(banco, { ...p, regra: 'followup-48h', tempo: { numero: 72, unidade: 'horas', direcao: 'depois' } });
  assert.equal(!r1.ok && r1.status, 400);
  assert.match(!r1.ok ? r1.erro : '', /ANTES de «followup-96h»/);
  assert.equal((await E.mudarRobo(banco, { ...p, regra: 'followup-48h', tempo: { numero: 36, unidade: 'horas', direcao: 'depois' } })).ok, true);
  // folga: o 48 h a menos de 24 h do 96 h (60 h) também é recusado
  assert.equal((await E.mudarRobo(banco, { ...p, regra: 'followup-48h', tempo: { numero: 37, unidade: 'horas', direcao: 'depois' } })).ok, false);
  // followup-120h para 50 h ficaria antes do 96 h (60 h)
  assert.match(((await E.mudarRobo(banco, { ...p, regra: 'followup-120h', tempo: { numero: 50, unidade: 'horas', direcao: 'depois' } })) as { erro?: string }).erro ?? '', /DEPOIS de «followup-96h»/);
  // voltar o 96 h ao de fábrica (96 h) está certo; mas o 48 h já foi para 59 h, e o 120 h segue acima: ok
  assert.equal((await E.mudarRobo(banco, { ...p, regra: 'followup-96h', tempo: null })).ok, true);
  // decisão: 4 d não pode passar do 7 d; pós-atendimento não pode passar do 4 d
  assert.equal((await E.mudarRobo(banco, { ...p, regra: 'decisao-4d', tempo: { numero: 8, unidade: 'dias', direcao: 'depois' } })).ok, false);
  assert.equal((await E.mudarRobo(banco, { ...p, regra: 'decisao-7d', tempo: { numero: 3, unidade: 'dias', direcao: 'depois' } })).ok, false);
  assert.equal((await E.mudarRobo(banco, { ...p, regra: 'decisao-4d', tempo: { numero: 5, unidade: 'dias', direcao: 'depois' } })).ok, true);
  // pós-atendimento em 20 h; a decisão de 4 d não pode descer para 1 d (24 h) por baixo dele (precisa de 24 h de folga)
  assert.equal((await E.mudarRobo(banco, { ...p, regra: 'pos-atendimento', tempo: { numero: 20, unidade: 'horas', direcao: 'depois' } })).ok, true);
  const baixo = await E.mudarRobo(banco, { ...p, regra: 'decisao-4d', tempo: { numero: 1, unidade: 'dias', direcao: 'depois' } });
  assert.match(!baixo.ok ? baixo.erro : '', /DEPOIS de «pos-atendimento»/);
  // lembretes: «hoje» não pode ficar abaixo do preparo nem acima da véspera
  assert.equal((await E.mudarRobo(banco, { ...p, regra: 'consulta-dia', tempo: { numero: 30, unidade: 'minutos', direcao: 'antes' } })).ok, false, 'preparo é 1 h: o «hoje» tem de ser maior');
  assert.equal((await E.mudarRobo(banco, { ...p, regra: 'consulta-preparo', tempo: { numero: 4, unidade: 'horas', direcao: 'antes' } })).ok, false);
  assert.equal(gravacoes.length >= 3, true);
});
