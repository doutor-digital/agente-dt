import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { canonico, configGravavel, montarPlano, textoDoPlano, type EstadoAtual } from './plano.js';
import { configChatwootDoQuestionario, lerQuestionario, type Questionario } from './questionario.js';
import { AUTOMACOES } from '../automacoes.js';
import { ATRIBUTOS_DE_CONTATO, ATRIBUTOS_DE_CONVERSA, ETIQUETAS_DO_CODIGO, PASTAS_PADRAO, MENSAGENS_PRONTAS } from './catalogo.js';
import { camposDaSofia, camposDaUnidade, fonteProdutos, renderizarMolde, textoDosDias } from './molde-sofia.js';
import { precosDaConsulta } from '../../agent/prompt-composer.js';
import { lerYamlOuJson } from './yaml-minimo.js';

const OPS = join(dirname(fileURLToPath(import.meta.url)), '../../../../ops/kit-unidade');
const TEXTO = readFileSync(join(OPS, 'questionario.exemplo.yaml'), 'utf8');
const MOLDE = readFileSync(join(OPS, 'molde-sofia/bloco-conversa.md'), 'utf8');

function q(f: (o: any) => void = () => {}): Questionario {
  const o = lerYamlOuJson(TEXTO) as any;
  f(o);
  const r = lerQuestionario(JSON.stringify(o));
  assert.ok(r.ok, r.ok ? '' : r.erros.join('; '));
  return r.q;
}
const passo = (p: ReturnType<typeof montarPlano>, id: string) => p.passos.find((x) => x.id === id)!;

/** Tudo já existe e igual ao questionário. */
function estadoCompleto(qq: Questionario): EstadoAtual {
  const campos = camposDaUnidade(qq);
  const { campos: sofia } = camposDaSofia(qq, MOLDE);
  const emails = qq.chatwoot.atendentes.map((a) => a.email.toLowerCase());
  return {
    banco: {
      unidade: { id: 'u1', campos },
      configChatwoot: configGravavel(configChatwootDoQuestionario(qq)),
      caixasRegistradas: [3],
      automacoes: Object.fromEntries(AUTOMACOES.filter((a) => a.id.startsWith('chatwoot-')).map((a) => [a.id, 'seco'])),
      sofia,
    },
    chatwoot: {
      etiquetas: [...ETIQUETAS_DO_CODIGO],
      atributosConversa: [...ATRIBUTOS_DE_CONVERSA],
      atributosContato: [...ATRIBUTOS_DE_CONTATO],
      caixas: [{ id: 3, nome: qq.chatwoot.caixa_nome, robo: true }],
      times: [qq.chatwoot.time_nome],
      agentes: Object.fromEntries([...emails, qq.chatwoot.usuario_celular_email!.toLowerCase()].map((e, i) => [e, { id: 10 + i, nome: e }])),
      pastas: Object.fromEntries(emails.map((e) => [e, [...PASTAS_PADRAO]])),
      mensagensProntas: MENSAGENS_PRONTAS.map((m) => `parau-${m.codigo}`),
      automacoesDaConta: 8,
    },
    kapso: { modelos: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`x${i}`, 'APPROVED'])) },
    meta: { datasetCapi: true },
    vps: { hostNoProxy: true },
    segredos: { [qq.franquia.token_env]: true, [qq.meta.token_env]: true, [qq.meta.conta_env]: true, [qq.meta.dataset_id_env]: true },
  };
}

test('seco sem consultar nada: o plano completo, na ordem, e cada passo diz se executa ou é esqueleto', () => {
  const p = montarPlano(q(), {}, { molde: MOLDE });
  assert.deepEqual(
    p.passos.map((x) => x.id),
    ['unidade', 'config-chatwoot', 'automacoes-seco', 'etiquetas', 'atributos', 'automacoes-conta', 'caixa', 'time', 'atendentes', 'usuario-celular', 'registrar-caixa', 'pastas', 'mensagens-prontas', 'numero', 'modelos', 'dataset-capi', 'sofia', 'robo-sofia', 'subdominio', 'segredos', 'franquia'],
  );
  // a ordem pedida: banco+automações → caixa/time/convites/pastas/estrutura → modelos → prompt → subdomínio
  const ordem = (id: string) => p.passos.findIndex((x) => x.id === id);
  assert.ok(ordem('config-chatwoot') < ordem('caixa') && ordem('caixa') < ordem('atendentes') && ordem('atendentes') < ordem('pastas') && ordem('pastas') < ordem('modelos') && ordem('modelos') < ordem('sofia') && ordem('sofia') < ordem('subdominio'));
  // toda dependência vem antes
  for (const s of p.passos) for (const d of s.depende) assert.ok(ordem(d) < ordem(s.id), `${s.id} depende de ${d}, que vem depois`);
  assert.deepEqual(p.passos.filter((x) => x.execucao === 'sim').map((x) => x.id), ['unidade', 'config-chatwoot', 'automacoes-seco', 'sofia']);
  assert.ok(p.passos.filter((x) => x.sistema !== 'banco' && x.execucao === 'esqueleto').length >= 8);
  // sem consultar, avisa
  assert.ok(passo(p, 'unidade').avisos.some((a) => /não consultado/.test(a)));
  const texto = textoDoPlano(p);
  assert.match(texto, /SECO: nada foi gravado/);
  assert.match(texto, /33 a enviar/);
});

test('as automações em seco são só as do Chatwoot que TÊM modo seco, e nenhuma é «ligado»', () => {
  const p = montarPlano(q(), {}, { molde: MOLDE });
  const ids = passo(p, 'automacoes-seco').itens.map((i) => i.split(' ')[0]);
  const esperado = AUTOMACOES.filter((a) => a.id.startsWith('chatwoot-') && a.temSeco).map((a) => a.id);
  assert.deepEqual(ids, esperado);
  assert.ok(ids.length >= 6);
  assert.ok(passo(p, 'automacoes-seco').itens.every((i) => i.endsWith('→ seco')));
});

test('idempotente: com tudo já no lugar, nenhum passo manda criar ou alterar', () => {
  const qq = q();
  const p = montarPlano(qq, estadoCompleto(qq), { molde: MOLDE });
  const mexem = p.passos.filter((x) => x.acao === 'criar' || x.acao === 'alterar').map((x) => `${x.id}:${x.acao}`);
  // «modelos»: o estado de teste tem outros nomes de modelo → todos a enviar; os demais não
  assert.deepEqual(mexem.filter((x) => !x.startsWith('modelos')), []);
  assert.equal(passo(p, 'segredos').acao, 'nada');
  assert.equal(passo(p, 'subdominio').acao, 'nada');
});

test('só o que falta: uma etiqueta e um atributo ausentes viram exatamente isso', () => {
  const qq = q();
  const e = estadoCompleto(qq);
  e.chatwoot!.etiquetas = e.chatwoot!.etiquetas.filter((x) => x !== 'urgente');
  e.chatwoot!.atributosConversa = e.chatwoot!.atributosConversa.filter((x) => x !== 'programa');
  e.chatwoot!.times = [];
  const p = montarPlano(qq, e, { molde: MOLDE });
  assert.deepEqual(passo(p, 'etiquetas').itens, ['1 etiqueta(s): urgente']);
  assert.deepEqual(passo(p, 'atributos').itens, ['1 de conversa: programa']);
  assert.equal(passo(p, 'time').acao, 'criar');
  assert.equal(passo(p, 'caixa').acao, 'nada');
});

test('unidade que já existe: campo VAZIO é preenchido (ALTERAR dizendo qual); campo já preenchido e diferente FICA (aviso) e só --sobrescrever troca', () => {
  const qq = q();
  const e = estadoCompleto(qq);
  // diferente mas preenchido: fica como está
  e.banco!.unidade!.campos = { ...e.banco!.unidade!.campos, clinicAddress: 'Outro lugar', spineSlotMinutes: 20 };
  const p = montarPlano(qq, e, { molde: MOLDE });
  assert.equal(passo(p, 'unidade').acao, 'nada');
  assert.ok(passo(p, 'unidade').avisos.some((a) => /clinicAddress, spineSlotMinutes/.test(a) && /--sobrescrever/.test(a)));
  // com --sobrescrever: troca, dizendo quais
  const so = montarPlano(qq, e, { molde: MOLDE, sobrescrever: true });
  assert.equal(passo(so, 'unidade').acao, 'alterar');
  assert.match(passo(so, 'unidade').itens[0]!, /clinicAddress, spineSlotMinutes/);
  // vazio: preenche sem flag nenhuma
  const e2 = estadoCompleto(qq);
  e2.banco!.unidade!.campos = { ...e2.banco!.unidade!.campos, clinicAddress: null, spineLunchStart: '' };
  const p2 = montarPlano(qq, e2, { molde: MOLDE });
  assert.equal(passo(p2, 'unidade').acao, 'alterar');
  assert.match(passo(p2, 'unidade').itens[0]!, /clinicAddress/);
  // unidade ATIVA: bloqueada sem a flag
  const e3 = estadoCompleto(qq);
  e3.banco!.unidade!.campos = { ...e3.banco!.unidade!.campos, isActive: true };
  assert.equal(passo(montarPlano(qq, e3, { molde: MOLDE }), 'unidade').acao, 'bloqueado');
  assert.ok(passo(montarPlano(qq, e3, { molde: MOLDE }), 'unidade').avisos.some((a) => /ATIVA/.test(a)));
  assert.notEqual(passo(montarPlano(qq, e3, { molde: MOLDE, sobrescrever: true }), 'unidade').acao, 'bloqueado');
});

test('o seco mostra os 33 modelos prontos para a Meta, sem nada que a Meta recuse, e marca os de categoria não conferida', () => {
  const p = montarPlano(q((o) => { o.unidade.endereco = 'Av. Nova, 100 — Centro, Cidade Nova/PA'; o.unidade.mapa_url = 'https://maps.example/nova'; o.unidade.nome = 'Doutor Hérnia Cidade Nova'; o.unidade.cidade = 'Cidade Nova'; o.whatsapp.prefixo_modelos = 'novo_'; }), {}, { molde: MOLDE });
  const m = passo(p, 'modelos');
  assert.ok(!m.avisos.some((a) => /a Meta recusaria|dado da unidade faltando/.test(a)), m.avisos.join(' | '));
  assert.ok(m.avisos.some((a) => /9 modelo\(s\) com categoria\/botões NÃO conferidos/.test(a)));
});

// ── a Sofia da unidade ───────────────────────────────────────────────────────────────────────────

test('molde da Sofia: sai preenchido com os preços e a cidade da unidade, sem marcador sobrando, e mantém as chaves do roteiro', () => {
  const r = renderizarMolde(MOLDE, q());
  assert.deepEqual(r.faltando, []);
  assert.doesNotMatch(r.texto, /\{\{/);
  assert.doesNotMatch(r.texto, /<!--/);
  assert.match(r.texto, /Doutor Hérnia Parauapebas 😊/);
  assert.match(r.texto, /Tabela: R\$ 350, pago no dia\. Com sinal para garantir a vaga: R\$ 250 \(R\$ 50 de sinal agora \+ R\$ 200 no dia\)/);
  assert.match(r.texto, /\{nome\}/);
  assert.match(r.texto, /\{horário 1\}/);
  // preços de outra unidade → outro texto
  const outro = renderizarMolde(MOLDE, q((o) => { o.valores.consulta_no_dia = 400; o.valores.consulta_antecipada = 300; o.valores.sinal_pix = 80; })).texto;
  assert.match(outro, /R\$ 400, pago no dia\. Com sinal para garantir a vaga: R\$ 300 \(R\$ 80 de sinal agora \+ R\$ 220 no dia\)/);
  assert.doesNotMatch(outro, /R\$ 350|R\$ 250/);
});

test('a fonte de produtos é lida de volta pelo código que lê preço (precosDaConsulta), com e sem sinal', () => {
  const com = q();
  assert.deepEqual(precosDaConsulta({ sourceProdutos: fonteProdutos(com), systemPrompt: '', acceptsAdvancePayment: true, spineBookingRequiresPayment: false } as never), { antecipado: 250, noDia: 350 });
  const sem = q((o) => { delete o.valores.sinal_pix; o.valores.consulta_no_dia = 300; o.valores.consulta_antecipada = 220; });
  assert.deepEqual(precosDaConsulta({ sourceProdutos: fonteProdutos(sem), systemPrompt: '', acceptsAdvancePayment: true, spineBookingRequiresPayment: false } as never), { antecipado: 220, noDia: 300 });
  const soNoDia = q((o) => { delete o.valores.sinal_pix; delete o.valores.consulta_antecipada; o.valores.aceita_antecipado = false; });
  assert.match(fonteProdutos(soNoDia), /R\$ 350 no dia, pagos na clínica/);
});

test('sem sinal o molde da Sofia 2.0 NÃO se aplica: não grava systemPrompt e avisa', () => {
  const sem = q((o) => { delete o.valores.sinal_pix; });
  const { campos, avisos } = camposDaSofia(sem, MOLDE);
  assert.ok(!('systemPrompt' in campos));
  assert.ok(avisos.some((a) => /sem sinal por Pix/.test(a)));
  const faltaMolde = camposDaSofia(q(), null);
  assert.ok(!('systemPrompt' in faltaMolde.campos));
  assert.ok(faltaMolde.avisos.some((a) => /não encontrado/.test(a)));
});

test('campos da unidade: sem segredo, em centavos no sinal, agenda do questionário', () => {
  const c = camposDaUnidade(q());
  assert.equal(c.sinalPixCentavos, 5000);
  assert.deepEqual(c.spineAgendaDays, [1, 2, 3, 4, 5]);
  assert.equal(c.spineAgendaStart, '08:00');
  assert.equal(c.spineTimezone, 'America/Belem');
  assert.ok(!Object.keys(c).some((k) => /token|secret|password|key$/i.test(k) && k !== 'pixKey'), 'nenhum campo de segredo');
  assert.equal(textoDosDias([1, 2, 3, 4, 5]), 'segunda a sexta');
  assert.equal(textoDosDias([1, 3, 5]), 'segunda, quarta e sexta');
  assert.equal(textoDosDias([6]), 'sábado');
});

test('o relatório final lista o que falta, e o plano nunca imprime o valor de um segredo do ambiente', () => {
  process.env.META_ADS_TOKEN_PARAUAPEBAS = 'EAAG-SEGREDO-NAO-PODE-VAZAR-123456';
  try {
    const qq = q();
    const p = montarPlano(qq, { segredos: { [qq.meta.token_env]: !!process.env[qq.meta.token_env] } }, { molde: MOLDE });
    const tudo = textoDoPlano(p) + JSON.stringify(p);
    assert.ok(!tudo.includes('SEGREDO-NAO-PODE-VAZAR'));
    assert.match(tudo, /META_ADS_TOKEN_PARAUAPEBAS: presente/);
    assert.ok(p.relatorio.some((r) => /^NÚMERO/.test(r)));
    assert.ok(p.relatorio.some((r) => /^MODELOS: 33/.test(r)));
    assert.ok(p.relatorio.some((r) => /^AUTOMAÇÕES: ficam em SECO/.test(r)));
    assert.ok(p.relatorio.some((r) => /^UNIDADE: nasce inativa/.test(r)));
  } finally {
    delete process.env.META_ADS_TOKEN_PARAUAPEBAS;
  }
});

test('idempotência não depende da ORDEM das chaves do JSON (o jsonb do Postgres devolve em outra ordem)', () => {
  const qq = q();
  const e = estadoCompleto(qq);
  const g = e.banco!.configChatwoot!;
  e.banco!.configChatwoot = { ...g, dadosModelos: Object.fromEntries(Object.entries(g.dadosModelos).reverse()) };
  assert.equal(passo(montarPlano(qq, e, { molde: MOLDE }), 'config-chatwoot').acao, 'nada');
  assert.equal(canonico({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: 3 } }), canonico({ a: { c: 3, d: [2, { x: 2, y: 1 }] }, b: 1 }));
  // mudança de verdade: o que já está preenchido FICA (aviso); só --sobrescrever troca
  e.banco!.configChatwoot = { ...g, dadosModelos: { ...g.dadosModelos, mapa: 'https://outro' } };
  assert.equal(passo(montarPlano(qq, e, { molde: MOLDE }), 'config-chatwoot').acao, 'nada');
  assert.ok(passo(montarPlano(qq, e, { molde: MOLDE }), 'config-chatwoot').avisos.some((a) => /dadosModelos\.mapa/.test(a)));
  assert.equal(passo(montarPlano(qq, e, { molde: MOLDE, sobrescrever: true }), 'config-chatwoot').acao, 'alterar');
  // campo vazio (número do Kapso, WABA) é preenchido sem flag
  e.banco!.configChatwoot = { ...g, kapsoPhoneNumberId: null, wabaId: null };
  assert.equal(passo(montarPlano(qq, e, { molde: MOLDE }), 'config-chatwoot').acao, 'alterar');
});

test('campo opcional que o questionário não preencheu é OMITIDO do update (nunca apaga o que a unidade já tem)', () => {
  const sem = q((o) => { delete o.valores.chave_pix; delete o.valores.favorecido; delete o.valores.sinal_pix; delete o.horarios.almoco_inicio; delete o.horarios.almoco_fim; });
  const c = camposDaUnidade(sem);
  for (const k of ['pixKey', 'pixHolder', 'sinalPixCentavos', 'spineLunchStart', 'spineLunchEnd']) assert.ok(!(k in c), `${k} não pode ir no update`);
  assert.ok(!('category' in c), 'a categoria só vale na criação');
  assert.ok(Object.values(c).every((v) => v !== null && v !== undefined));
});

test('ids em dígitos sem aspas no YAML valem (viram texto), de qualquer tamanho', () => {
  for (const id of ['1212928641906230', '12345678901234567890']) {
    const r = lerQuestionario(TEXTO.replace('kapso_phone_number_id: "1212928641906230"', `kapso_phone_number_id: ${id}`));
    assert.ok(r.ok, r.ok ? '' : r.erros.join('; '));
    if (r.ok) assert.equal(r.q.whatsapp.kapso_phone_number_id, id);
  }
});
