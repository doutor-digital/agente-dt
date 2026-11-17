/**
 * Preenchimento retroativo dos campos do CRM (lote 2): as 6 regras, "só campo vazio", e — o centro — que o preenchimento não faz NADA chegar
 * ao paciente: (a) a próxima rodada da régua não manda nada (e, sem as marcas, mandaria: o teste prova que enxerga o defeito), (b) a Meta não
 * recebe evento de conversão, (c) os avisos do Chatwoot que a gravação dispara (`conversation_updated`) só mexem em etiqueta/pausa, nunca falam.
 * Datas: 2026-11-17 é terça; Belém é UTC-3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  atualizarVistos,
  decidirRegua,
  type ConversaRegua,
  type DadosDaUnidade,
  type MensagemResumo,
  type Vistos,
} from './chatwoot-regua.js';
import { cicloDoCapi, type ArmazemCapi, type DepsDoCapi, type LinhaCapi, type PortaDaMeta } from './chatwoot-capi.js';
import { ETIQUETA_PAUSA, eventoDePausa, eventoDeReativacao } from './chatwoot-pausa.js';
import { eventoDeResolucao } from './chatwoot-resolver.js';
import { eventoDeEtiqueta } from './chatwoot-etiquetas.js';
import {
  decidirCampos,
  ETIQUETA_CONFERIR_ETAPA,
  motivoDoChatwoot,
  vistosComMarcas,
  type EntradaDaConversa,
  type FatoDeQualificacao,
  type LeadDoKommo,
} from './chatwoot-campos-retroativos.js';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const AGORA = new Date('2026-11-17T20:00:00Z');
const Z = (s: string) => new Date(s);
const U: DadosDaUnidade = { nome: 'Doutor Hérnia Parauapebas', pixKey: 'pix@parau.com', valorAntecipado: 250 };
const MOTIVOS = ['Não interagiu', 'Não deu continuidade', 'Sem interesse', 'Outra cidade', 'Vai se organizar', 'Plano de saúde', 'Viajando', 'Sem condições', 'Achou caro'];

function conv(o: { id?: number; attrs?: Record<string, unknown>; etiquetas?: string[]; ultima?: MensagemResumo | null } = {}): ConversaRegua {
  return {
    id: o.id ?? 10,
    nome: 'maria da silva',
    etiquetas: o.etiquetas ?? [],
    attrs: o.attrs ?? {},
    criadaEm: Z('2026-10-01T12:00:00Z'),
    atendente: 'Ana',
    ultima: o.ultima === undefined ? { saida: false, privada: false, autorId: null, autorTipo: 'contact', criadaEm: Z('2026-11-05T12:00:00Z') } : o.ultima,
    telefone: '+5594999990000',
  };
}
const lead = (etapa: string, o: Partial<LeadDoKommo> = {}): LeadDoKommo => ({
  id: o.id ?? 1,
  funil: o.funil ?? 'COMERCIAL',
  etapa,
  statusId: o.statusId ?? 100,
  atualizadoEm: o.atualizadoEm ?? 1_790_000_000,
  motivoPerda: o.motivoPerda ?? null,
});
const perdido = (motivo: string | null, id = 1) => lead('PERDIDO', { id, statusId: 143, motivoPerda: motivo });
function entrada(c: ConversaRegua, leads: LeadDoKommo[], o: Partial<EntradaDaConversa> = {}): EntradaDaConversa {
  return { conv: c, status: 'resolved', leads, qualificacoes: [], vistos: new Map(), motivosValidos: MOTIVOS, ...o };
}
const campos = (p: { alteracoes: Array<{ campo: string; depois: string }> }) => Object.fromEntries(p.alteracoes.map((a) => [a.campo, a.depois]));

// ── as regras ──────────────────────────────────────────────────────────────────────────────────────

test('regra 2: etapa vem do cartão COMERCIAL do Kommo (de/para do João)', () => {
  const casos: Array<[string, string]> = [
    ['AGENDADO', 'Agendado'],
    ['COMPARECEU', 'Compareceu'],
    ['EM NEGOCIAÇÃO', 'Pós-consulta'],
    ['EM QUALIFICAÇÃO', 'Sofia qualifica'],
  ];
  for (const [kommo, chatwoot] of casos) {
    const p = decidirCampos(entrada(conv(), [lead(kommo)]), AGORA);
    assert.deepEqual(campos(p), { etapa: chatwoot }, kommo);
    assert.equal(p.alteracoes[0]!.regra, 'etapa-kommo');
  }
});

test('regra 2: PERDIDO leva o motivo de perda (regra 3); EM ESPERA só ganha a etiqueta; o que não tem regra fica vazio', () => {
  const p = decidirCampos(entrada(conv(), [perdido('Mora em outra cidade')]), AGORA);
  assert.deepEqual(campos(p), { etapa: 'Perdido', motivo_nao_agendamento: 'Outra cidade' });
  assert.deepEqual(
    p.alteracoes.map((a) => a.regra),
    ['etapa-kommo', 'motivo-kommo'],
  );

  const espera = decidirCampos(entrada(conv(), [lead('EM ESPERA')]), AGORA);
  assert.deepEqual(espera.alteracoes, []);
  assert.equal(espera.etiquetaNova, ETIQUETA_CONFERIR_ETAPA);

  for (const nome of ['NÃO COMPARECEU', 'RETORNO PÓS-TRATAMENTO', 'Incoming leads']) {
    const sem = decidirCampos(entrada(conv(), [lead(nome)]), AGORA);
    assert.deepEqual(sem.alteracoes, [], nome);
    assert.equal(sem.semRegra, `Kommo ${nome}`);
  }
  const ganho = decidirCampos(entrada(conv(), [lead('GANHO / CONCLUIDO', { statusId: 142 })]), AGORA);
  assert.deepEqual(ganho.alteracoes, []);
});

test('regra 3: Perdido SEM motivo mapeável não é gravado (Perdido exige motivo) e vai para a equipe; motivo já escrito é respeitado', () => {
  for (const motivo of [null, 'Orçamento insuficiente', 'Assinou contrato']) {
    const p = decidirCampos(entrada(conv(), [perdido(motivo)]), AGORA);
    assert.deepEqual(p.alteracoes, [], String(motivo));
    assert.equal(p.bloqueios[0]?.codigo, 'perdido-sem-motivo');
  }
  const jaTem = decidirCampos(entrada(conv({ attrs: { motivo_nao_agendamento: 'Sem interesse' } }), [perdido(null)]), AGORA);
  assert.deepEqual(campos(jaTem), { etapa: 'Perdido' });
  // o de/para só devolve valor que a conta tem na lista
  assert.equal(motivoDoChatwoot('Mora em outra cidade', ['Sem interesse']), null);
  assert.equal(motivoDoChatwoot('Vai viajar', MOTIVOS), 'Viajando');
  assert.equal(motivoDoChatwoot('Financeiramente vulnerável', MOTIVOS), 'Sem condições');
});

test('regra 2: Perdido no Kommo mas com consulta DE PÉ na agenda é conflito: não grava Perdido, a equipe decide', () => {
  const dePe = conv({ attrs: { data_consulta: '2026-11-20', hora_consulta: '09:00', situacao_consulta: 'Confirmado', categoria_consulta: 'Avaliação' } });
  const p = decidirCampos(entrada(dePe, [perdido('Sem interesse')]), AGORA);
  assert.deepEqual(p.alteracoes, []);
  assert.equal(p.bloqueios[0]?.codigo, 'perdido-com-consulta');
  // consulta já passada não impede
  const passada = conv({ attrs: { data_consulta: '2026-11-01', situacao_consulta: 'Agendado' } });
  assert.deepEqual(campos(decidirCampos(entrada(passada, [perdido('Sem interesse')]), AGORA)), { etapa: 'Perdido', motivo_nao_agendamento: 'Sem interesse' });
});

test('regra 4: cartão no funil TRATAMENTO → funil Tratamento + etapa_tratamento; não leva etapa comercial', () => {
  const p = decidirCampos(entrada(conv(), [lead('EM TRATAMENTO', { funil: 'TRATAMENTO' }), perdido('Sem interesse', 2)]), AGORA);
  assert.deepEqual(campos(p), { funil: 'Tratamento', etapa_tratamento: 'Em tratamento' });
  assert.ok(p.alteracoes.every((a) => a.regra === 'tratamento-kommo'));
  const alta = decidirCampos(entrada(conv(), [lead('ALTA', { funil: 'TRATAMENTO', statusId: 142 })]), AGORA);
  assert.deepEqual(campos(alta), { funil: 'Tratamento', etapa_tratamento: 'Alta' });
  // TRATAMENTO CANCELADO e entrada não têm regra: a conversa não vira «tratamento» por palpite
  const cancelado = decidirCampos(entrada(conv(), [lead('TRATAMENTO CANCELADO', { funil: 'TRATAMENTO', statusId: 143 })]), AGORA);
  assert.deepEqual(cancelado.alteracoes, []);
});

test('regra 5: agenda com Avaliação ATENDIDA → Compareceu (vale sozinha e vale mais que cartão atrasado; cartão adiantado/perdido ganha dela)', () => {
  const atendida = { situacao_consulta: 'Atendido', categoria_consulta: 'Avaliação', data_consulta: '2026-09-01', hora_consulta: '09:00' };
  const sozinha = decidirCampos(entrada(conv({ attrs: atendida }), []), AGORA);
  assert.deepEqual(campos(sozinha), { etapa: 'Compareceu' });
  assert.equal(sozinha.alteracoes[0]!.regra, 'compareceu-agenda');
  assert.equal(decidirCampos(entrada(conv({ attrs: atendida }), [lead('AGENDADO')]), AGORA).alteracoes[0]!.regra, 'compareceu-agenda');
  assert.equal(decidirCampos(entrada(conv({ attrs: atendida }), [lead('EM NEGOCIAÇÃO')]), AGORA).alteracoes[0]!.depois, 'Pós-consulta');
  assert.equal(decidirCampos(entrada(conv({ attrs: atendida }), [perdido('Sem interesse')]), AGORA).alteracoes[0]!.depois, 'Perdido');
  // sessão ou retorno não é avaliação
  const sessao = decidirCampos(entrada(conv({ attrs: { ...atendida, categoria_consulta: 'Sessão' } }), []), AGORA);
  assert.deepEqual(sessao.alteracoes, []);
});

test('regra 6: qualificação da Sofia só se for dos últimos 30 dias; vale a mais nova; valor fora de Quente/Morno/Frio não vale', () => {
  const fato = (valor: string, dias: number): FatoDeQualificacao => ({ leadId: 1, valor, observadoEm: new Date(AGORA.getTime() - dias * 86_400_000) });
  assert.deepEqual(campos(decidirCampos(entrada(conv(), [], { qualificacoes: [fato('Morno', 5)] }), AGORA)), { qualificacao: 'Morno' });
  assert.deepEqual(campos(decidirCampos(entrada(conv(), [], { qualificacoes: [fato('Frio', 40)] }), AGORA)), {});
  assert.deepEqual(campos(decidirCampos(entrada(conv(), [], { qualificacoes: [fato('Frio', 20), fato('Morno', 3), fato('Quente', 29.9)] }), AGORA)), { qualificacao: 'Morno' });
  for (const lixo of ['não', 'não qualificado', 'Desqualificado', '1788270240']) assert.deepEqual(campos(decidirCampos(entrada(conv(), [], { qualificacoes: [fato(lixo, 1)] }), AGORA)), {}, lixo);
  assert.deepEqual(campos(decidirCampos(entrada(conv(), [], { qualificacoes: [fato('frio', 2)] }), AGORA)), { qualificacao: 'Frio' });
  // evento do futuro (relógio errado) não vale
  assert.deepEqual(campos(decidirCampos(entrada(conv(), [], { qualificacoes: [fato('Frio', -2)] }), AGORA)), {});
});

test('só preenche campo VAZIO: nada que já existe é sobrescrito; conferir-etapa e cartões ambíguos não são tocados', () => {
  const cheia = conv({ attrs: { etapa: 'Agendado', qualificacao: 'Quente', funil: 'Comercial' } });
  assert.deepEqual(decidirCampos(entrada(cheia, [perdido('Sem interesse'), lead('EM TRATAMENTO', { funil: 'TRATAMENTO' })], { qualificacoes: [{ leadId: 1, valor: 'Frio', observadoEm: AGORA }] }), AGORA).alteracoes, []);
  // etapa já escrita e funil vazio, com cartão em tratamento: grava só o funil/etapa_tratamento (campos vazios), nunca troca a etapa
  const meia = decidirCampos(entrada(conv({ attrs: { etapa: 'Pós-consulta' } }), [lead('ALTA', { funil: 'TRATAMENTO', statusId: 142 })]), AGORA);
  assert.deepEqual(campos(meia), { funil: 'Tratamento', etapa_tratamento: 'Alta' });

  const marcada = decidirCampos(entrada(conv({ etiquetas: [ETIQUETA_CONFERIR_ETAPA] }), [lead('AGENDADO')]), AGORA);
  assert.deepEqual(marcada.alteracoes, []);
  assert.equal(marcada.bloqueios[0]?.codigo, 'tem-conferir-etapa');

  // dois cartões abertos que dão etapas diferentes: não se decide por palpite
  const ambiguo = decidirCampos(entrada(conv(), [lead('AGENDADO', { id: 1 }), lead('EM QUALIFICAÇÃO', { id: 2 })]), AGORA);
  assert.deepEqual(ambiguo.alteracoes, []);
  assert.equal(ambiguo.bloqueios[0]?.codigo, 'kommo-ambiguo');
  // um aberto + um perdido antigo: vale o aberto
  assert.deepEqual(campos(decidirCampos(entrada(conv(), [perdido('Sem interesse', 1), lead('AGENDADO', { id: 2 })]), AGORA)), { etapa: 'Agendado' });
});

// ── (a) a régua não manda nada depois do preenchimento ──────────────────────────────────────────────

/** Tudo o que a régua mandaria a esta conversa em 14 dias (rodadas de 30 min), com a memória dada e sem nada «feito». */
function reguaMandaria(c: ConversaRegua, vistos: Vistos, desde = AGORA): string[] {
  const achadas = new Set<string>();
  for (let t = desde.getTime(); t < desde.getTime() + 14 * 86_400_000; t += 30 * 60_000) {
    for (const d of decidirRegua(c, { vistos, feitos: new Set() }, new Date(t), U).disparos) achadas.add(d.regra);
  }
  return [...achadas].sort();
}
/** A conversa depois de gravar e a memória da régua como o worker a teria na rodada seguinte (a conversa JÁ era conhecida e NÃO é do histórico). */
function proximaRodada(c: ConversaRegua, vistosAntes: Vistos, plano: ReturnType<typeof decidirCampos>, comMarcas: boolean) {
  const depois: ConversaRegua = { ...c, attrs: { ...c.attrs, ...campos(plano) } };
  const base = vistosComMarcas(vistosAntes, [], AGORA);
  const memoria = comMarcas ? vistosComMarcas(base, plano.marcasVisto, AGORA) : base;
  const r = atualizarVistos(depois, memoria, new Date(AGORA.getTime() + 60_000), { primeiraVez: false, desde: Z('2026-11-13T13:00:00Z') });
  return { depois, vistos: r.vistos, mudancas: r.mudancas };
}
const conhecida: Vistos = new Map([['_visto', { valor: '1', desde: Z('2026-11-14T12:00:00Z'), inicial: false }]]);

test('(a) PERDIDO: com a marca, a régua não manda o reengajamento de 48/96/120 h; SEM a marca mandaria (o teste enxerga o defeito)', () => {
  const c = conv();
  const plano = decidirCampos(entrada(c, [perdido('Sem interesse')], { vistos: conhecida }), AGORA);
  assert.deepEqual(campos(plano), { etapa: 'Perdido', motivo_nao_agendamento: 'Sem interesse' });
  assert.deepEqual(plano.marcasVisto, [{ campo: 'etapa', valor: 'Perdido' }]);

  const sem = proximaRodada(c, conhecida, plano, false);
  const sairia = reguaMandaria(sem.depois, sem.vistos);
  assert.ok(sairia.includes('followup-48h') && sairia.includes('followup-96h'), `sem a marca sairia: ${sairia}`);

  const com = proximaRodada(c, conhecida, plano, true);
  assert.deepEqual(com.mudancas.filter((m) => 'campo' in m && m.campo === 'etapa'), [], 'a memória já tem a etapa: a régua não vê «entrou agora»');
  assert.deepEqual(reguaMandaria(com.depois, com.vistos), []);
});

test('(a) ALTA e EM TRATAMENTO: sem a marca sairia a mensagem de conclusão/NPS; com a marca, nada', () => {
  const c = conv();
  const plano = decidirCampos(entrada(c, [lead('ALTA', { funil: 'TRATAMENTO', statusId: 142 })], { vistos: conhecida }), AGORA);
  assert.deepEqual(plano.marcasVisto, [{ campo: 'etapa_tratamento', valor: 'Alta' }]);
  assert.deepEqual(reguaMandaria(proximaRodada(c, conhecida, plano, false).depois, proximaRodada(c, conhecida, plano, false).vistos), ['alta-conclusao', 'alta-nps']);
  const com = proximaRodada(c, conhecida, plano, true);
  assert.deepEqual(reguaMandaria(com.depois, com.vistos), []);
});

test('(a) COMPARECEU / PÓS-CONSULTA de quem foi atendido: consulta recente acordaria pós-atendimento/decisão (não grava); consulta antiga, já vencida, grava e a régua segue calada', () => {
  const base = { situacao_consulta: 'Atendido', categoria_consulta: 'Avaliação', hora_consulta: '09:00' };
  for (const kommo of ['COMPARECEU', 'EM NEGOCIAÇÃO']) {
    const recente = decidirCampos(entrada(conv({ attrs: { ...base, data_consulta: '2026-11-16' } }), [lead(kommo)], { vistos: conhecida }), AGORA);
    assert.deepEqual(recente.alteracoes, [], kommo);
    assert.equal(recente.bloqueios[0]?.codigo, 'regua-acordaria', kommo);

    const c = conv({ attrs: { ...base, data_consulta: '2026-08-10' } });
    const antiga = decidirCampos(entrada(c, [lead(kommo)], { vistos: conhecida }), AGORA);
    assert.equal(antiga.alteracoes.length, 1, kommo);
    const com = proximaRodada(c, conhecida, antiga, true);
    assert.deepEqual(reguaMandaria(com.depois, com.vistos), [], kommo);
  }
});

test('(a) a etapa que ACORDARIA uma regra de data (Agendado + consulta futura → véspera/dia/preparo) NÃO é gravada: vai para a equipe', () => {
  const c = conv({ attrs: { data_consulta: '2026-11-19', hora_consulta: '15:00', situacao_consulta: 'Agendado', categoria_consulta: 'Avaliação' } });
  const plano = decidirCampos(entrada(c, [lead('AGENDADO')], { vistos: conhecida }), AGORA);
  assert.deepEqual(plano.alteracoes, []);
  assert.equal(plano.bloqueios[0]?.codigo, 'regua-acordaria');
  assert.match(plano.bloqueios[0]!.detalhe, /consulta-vespera/);
  assert.deepEqual(plano.marcasVisto, []);
  assert.deepEqual(plano.marcasCapi, []);
});

test('(a) lead QUENTE em «Sofia qualifica» com a última fala nossa há pouco: a qualificação (que acordaria o aviso à gerente) fica de fora', () => {
  const ultima: MensagemResumo = { saida: true, privada: false, autorId: 2, autorTipo: 'user', criadaEm: new Date(AGORA.getTime() - 4 * 3600_000) };
  const c = conv({ attrs: { etapa: 'Sofia qualifica' }, ultima });
  const q: FatoDeQualificacao[] = [{ leadId: 1, valor: 'Quente', observadoEm: new Date(AGORA.getTime() - 86_400_000) }];
  const plano = decidirCampos(entrada(c, [], { qualificacoes: q, vistos: conhecida }), AGORA);
  assert.deepEqual(plano.alteracoes, []);
  assert.equal(plano.bloqueios[0]?.codigo, 'regua-acordaria');
  // a mesma qualificação numa conversa parada há dias não acorda nada (passou do prazo): grava
  const velha = conv({ attrs: { etapa: 'Sofia qualifica' } });
  assert.deepEqual(campos(decidirCampos(entrada(velha, [], { qualificacoes: q, vistos: conhecida }), AGORA)), { qualificacao: 'Quente' });
});

test('(a) a etapa Agendado de quem NÃO tem consulta (cartão do Kommo) é gravada, e a régua segue calada', () => {
  const c = conv();
  const plano = decidirCampos(entrada(c, [lead('AGENDADO')], { vistos: conhecida }), AGORA);
  assert.deepEqual(campos(plano), { etapa: 'Agendado' });
  const com = proximaRodada(c, conhecida, plano, true);
  assert.deepEqual(reguaMandaria(com.depois, com.vistos), []);
  // contra-prova: sem a marca, o pré-pagamento sairia se a conversa pedisse pagamento antecipado
  const c2 = conv({ attrs: { pagamento_antecipado: 'true', situacao_consulta: 'Agendado' } });
  const p2 = decidirCampos(entrada(c2, [lead('AGENDADO')], { vistos: conhecida }), AGORA);
  const sem = proximaRodada(c2, conhecida, p2, false);
  assert.ok(reguaMandaria(sem.depois, sem.vistos).includes('prepagamento'));
  assert.deepEqual(reguaMandaria(proximaRodada(c2, conhecida, p2, true).depois, proximaRodada(c2, conhecida, p2, true).vistos), []);
});

// ── (b) a Meta não recebe evento de conversão ───────────────────────────────────────────────────────

function capiFalso(c: ConversaRegua, linhasIniciais: LinhaCapi[]) {
  const linhas: Array<LinhaCapi & { caixa: number }> = linhasIniciais.map((l) => ({ ...l, caixa: 3 }));
  const armazem: ArmazemCapi = {
    async linhas() {
      return linhas.map((l) => ({ ...l }));
    },
    async registrar(l) {
      if (linhas.some((x) => x.conversationId === l.conversationId && x.regra === l.regra && x.chave === l.chave)) return false;
      linhas.push({ ...l });
      return true;
    },
    async desfazer() {},
    async marcar() {},
  };
  const enviados: Array<Record<string, any>> = [];
  const meta: PortaDaMeta = {
    async dataset() {
      return 'DS-1';
    },
    async enviar(_d, _t, evento) {
      enviados.push(evento as Record<string, any>);
      return { tipo: 'ok' };
    },
  };
  const bruta = { id: c.id, created_at: 1_790_000_000, labels: c.etiquetas, custom_attributes: c.attrs, meta: { sender: { name: c.nome, phone_number: c.telefone } }, last_non_activity_message: null };
  const deps: DepsDoCapi = {
    armazem,
    meta,
    chat: { pagina: async (_x, pagina) => (pagina === 1 ? [bruta] : []), clique: async () => ({ ctwaClid: 'AfdAnuncio', anuncio: '120253955239410514' }) },
    config: () => ({ token: 'TOKEN', datasetId: null, valorDoFechamento: 3500 }),
    pausa: async () => undefined,
  };
  return { deps, enviados, linhas };
}

test('(b) CAPI: etapa Agendado/Compareceu gravada pelo retroativo NÃO vira evento para a Meta; sem as marcas viraria', async () => {
  const partida: LinhaCapi = { conversationId: -3, regra: 'capi-partida', chave: 'v1', modo: 'ligado', texto: '', criadoEm: Z('2026-11-14T00:00:00Z') };
  for (const [kommo, evento] of [
    ['AGENDADO', 'AddToCart'],
    ['COMPARECEU', 'InitiateCheckout'],
  ] as const) {
    const c = conv();
    const plano = decidirCampos(entrada(c, [lead(kommo)], { vistos: conhecida }), AGORA);
    assert.deepEqual(plano.marcasCapi, [evento], kommo);
    const depois: ConversaRegua = { ...c, attrs: { ...c.attrs, ...campos(plano) } };

    const sem = capiFalso(depois, [partida]);
    await cicloDoCapi(sem.deps, 3, 'doutor-hernia-parauapebas', 'WABA', 'ligado', new Date(AGORA.getTime() + 60_000));
    assert.equal(sem.enviados.length, 1, `${kommo}: sem a marca o evento sairia`);
    assert.equal(sem.enviados[0]!.event_name, evento);

    const marcas = plano.marcasCapi.map((ev): LinhaCapi => ({ conversationId: c.id, regra: `capi-visto:${ev}`, chave: 'v1', modo: 'inicial', texto: '', criadoEm: AGORA }));
    const com = capiFalso(depois, [partida, ...marcas]);
    for (const minuto of [1, 11, 21]) await cicloDoCapi(com.deps, 3, 'doutor-hernia-parauapebas', 'WABA', 'ligado', new Date(AGORA.getTime() + minuto * 60_000));
    assert.equal(com.enviados.length, 0, `${kommo}: com a marca a Meta não recebe nada (3 rodadas)`);
  }
});

test('(b) etapas que não são conversão (Perdido, Pós-consulta, Sofia qualifica) não pedem marca nenhuma', () => {
  for (const kommo of ['EM NEGOCIAÇÃO', 'EM QUALIFICAÇÃO']) assert.deepEqual(decidirCampos(entrada(conv(), [lead(kommo)]), AGORA).marcasCapi, [], kommo);
  assert.deepEqual(decidirCampos(entrada(conv(), [perdido('Sem interesse')]), AGORA).marcasCapi, []);
});

// ── (c) o que o aviso `conversation_updated` do Chatwoot faz depois da gravação ─────────────────────

test('(c) conversation_updated depois do preenchimento: só tira falta-etapa (desejado); não pausa, não manda, não age como botão de Perdido', async () => {
  const c = conv({ etiquetas: ['falta-etapa'] });
  const plano = decidirCampos(entrada(c, [perdido('Sem interesse')]), AGORA);
  const depois = { ...c.attrs, ...campos(plano) };
  const aviso = { event: 'conversation_updated', id: 10, inbox_id: 3, status: 'resolved', labels: ['falta-etapa'], custom_attributes: depois };
  const caixas = { 3: 'doutor-hernia-parauapebas' };
  // webhook de resolução: etapa + motivo completos → tira a etiqueta
  assert.equal(eventoDeResolucao(aviso, caixas)?.acao, 'tirar');
  // pausa só nasce de mensagem de saída de gente; reativação só de conversa resolvida E pausada; botão de Perdido só de etiqueta perdido-*
  assert.equal(eventoDePausa(aviso, caixas), null);
  assert.equal(eventoDeReativacao(aviso, caixas), null);
  assert.equal(eventoDeEtiqueta(aviso, caixas), null);
  // histórico unificado fica de fora do resolver
  assert.equal(eventoDeResolucao({ ...aviso, labels: ['historico'] }, caixas), null);
  // a Sofia só responde a message_created de paciente: o aviso de conversa atualizada não é mensagem
  const { mensagemDoPaciente } = await import('./chatwoot-ia.js');
  assert.equal(mensagemDoPaciente(aviso, caixas), null);
});

test('(c) conversa RESOLVIDA com a IA pausada: gravar reativaria a Sofia (nota + tira a pausa) → o plano não grava e manda para a equipe', () => {
  const c = conv({ etiquetas: [ETIQUETA_PAUSA] });
  const aviso = { event: 'conversation_updated', id: 10, inbox_id: 3, status: 'resolved', labels: [ETIQUETA_PAUSA] };
  assert.deepEqual(eventoDeReativacao(aviso, { 3: 'doutor-hernia-parauapebas' }), { conversa: 10 }, 'este é o efeito que se evita');
  const resolvida = decidirCampos(entrada(c, [lead('AGENDADO')], { status: 'resolved' }), AGORA);
  assert.deepEqual(resolvida.alteracoes, []);
  assert.equal(resolvida.bloqueios[0]?.codigo, 'ia-pausada-resolvida');
  // aberta e pausada: o aviso não reativa (só conversa resolvida), então grava
  assert.deepEqual(campos(decidirCampos(entrada(c, [lead('AGENDADO')], { status: 'open' }), AGORA)), { etapa: 'Agendado' });
});

test('as marcas vão para a memória da régua como «inicial» e a memória antiga da mesma conversa é preservada', () => {
  const antes: Vistos = new Map([
    ['_visto', { valor: '1', desde: Z('2026-11-14T12:00:00Z'), inicial: false }],
    ['etapa', { valor: 'Novo lead', desde: Z('2026-11-14T12:00:00Z'), inicial: false }],
  ]);
  const depois = vistosComMarcas(antes, [{ campo: 'etapa', valor: 'Agendado' }], AGORA);
  assert.deepEqual(depois.get('etapa'), { valor: 'Agendado', desde: AGORA, inicial: true });
  assert.equal(depois.get('_visto')?.inicial, false);
  assert.equal(antes.get('etapa')?.valor, 'Novo lead', 'não mexe na memória original');
});
