import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validarFormulario } from './formulario.js';
import { respostasValidas } from './formulario-exemplo.js';
import { AJUSTES_PERMITIDOS, fusoDaUf, lerAjustes, paraYaml, prefixoDeModelos, questionarioDoFormulario } from './formulario-para-questionario.js';
import { lerQuestionario, validarQuestionario } from './questionario.js';

const respostas = (mudar: (r: ReturnType<typeof respostasValidas>) => void = () => {}) => {
  const r = respostasValidas();
  mudar(r);
  const v = validarFormulario(r);
  assert.ok(v.ok, JSON.stringify(v));
  return v.ok ? v.respostas : (undefined as never);
};
const COMPLETOS = { 'whatsapp.kapso_phone_number_id': '1212928641906230', 'whatsapp.waba_id': '2146287749563217', 'franquia.id_company': '131', 'meta.ad_account': 'act_1234567890', 'meta.business_manager_id': '1122334455667788' } as const;

test('formulário + o que só o João sabe = questionário que PASSA na validação do kit, e o YAML volta igual pelo leitor do kit', () => {
  const g = questionarioDoFormulario(respostas(), COMPLETOS);
  assert.deepEqual(g.pendencias, []);
  assert.equal(g.valido, true);
  assert.equal(g.slug, 'doutor-hernia-serra');
  assert.equal(g.subdominio, 'drherniaserra');
  assert.equal(g.sufixo, 'SERRA');
  // o YAML gerado é lido pelo MESMO leitor do kit e dá o mesmo objeto
  const yaml = paraYaml(g.objeto, 'cabeçalho\nsegunda linha');
  const lido = lerQuestionario(yaml);
  assert.ok(lido.ok, JSON.stringify(lido));
  if (!lido.ok) return;
  assert.equal(lido.q.unidade.nome, 'Doutor Hérnia Serra');
  assert.equal(lido.q.unidade.fuso, 'America/Sao_Paulo', 'ES não herda o fuso de Belém');
  assert.equal(lido.q.chatwoot.atendentes.length, 2);
  assert.equal(lido.q.chatwoot.atendentes[0]!.email, 'gerente@clinica.example');
  assert.equal(lido.q.valores.consulta_antecipada, 250);
  assert.equal(lido.q.valores.sinal_pix, 50);
  assert.equal(lido.q.valores.aceita_antecipado, true);
  assert.equal(lido.q.whatsapp.numero_oficial, '+5527999990000');
  assert.equal(lido.q.meta.token_env, 'META_ADS_TOKEN_SERRA');
  assert.equal(lido.q.meta.conta_env, 'META_ADS_CONTA_SERRA');
  assert.equal(lido.q.meta.dataset_id_env, 'META_DATASET_ID_SERRA');
  assert.equal(lido.q.franquia.token_env, 'FRANQUIA_TOKEN_SERRA');
  assert.deepEqual(lido.q.horarios.dias, [1, 2, 3, 4, 5]);
  assert.equal(lido.q.whatsapp.prefixo_modelos, 'serra_');
});

test('sem os ids do Kapso/WhatsApp Business o arquivo sai mesmo assim, com PENDÊNCIAS no vocabulário do kit (e nada inventado)', () => {
  const g = questionarioDoFormulario(respostas());
  assert.equal(g.valido, false);
  const campos = g.pendencias.map((p) => p.split(':')[0]);
  for (const c of ['whatsapp.kapso_phone_number_id', 'whatsapp.waba_id', 'franquia.id_company', 'meta.ad_account', 'meta.business_manager_id']) assert.ok(campos.includes(c), `${c} deveria estar pendente: ${campos}`);
  assert.equal((g.objeto.whatsapp as Record<string, unknown>).waba_id, undefined, 'nada de palpite');
  assert.equal((g.objeto.franquia as Record<string, unknown>).id_company, undefined);
});

test('o que o dono SOUBE entra: código da franquia e conta de anúncios vindos do formulário', () => {
  const g = questionarioDoFormulario(respostas((r) => { r.franquia_id_company = '131'; r.meta = { ad_account: 'act_999999', business_manager_id: '12345678' }; }), { 'whatsapp.kapso_phone_number_id': '1212928641906230', 'whatsapp.waba_id': '2146287749563217' });
  assert.deepEqual(g.pendencias, []);
});

test('--set manda: troca slug, subdomínio, sufixo (e as 3 variáveis da Meta + a da franquia acompanham)', () => {
  const g = questionarioDoFormulario(respostas(), { ...COMPLETOS, 'unidade.slug': 'doutor-hernia-serra-es', 'chatwoot.subdominio': 'drherniaserraes', sufixo: 'SERRAES', 'whatsapp.prefixo_modelos': 'serra2_' });
  assert.deepEqual(g.pendencias, []);
  const o = g.objeto as Record<string, Record<string, unknown>>;
  assert.equal(o.unidade!.slug, 'doutor-hernia-serra-es');
  assert.equal(o.chatwoot!.subdominio, 'drherniaserraes');
  assert.equal(o.meta!.token_env, 'META_ADS_TOKEN_SERRAES');
  assert.equal(o.meta!.dataset_id_env, 'META_DATASET_ID_SERRAES');
  assert.equal(o.franquia!.token_env, 'FRANQUIA_TOKEN_SERRAES');
  assert.equal(o.whatsapp!.prefixo_modelos, 'serra2_');
});

test('sem desconto antecipado: aceita_antecipado=false e sem sinal; sem almoço: sem os campos de almoço', () => {
  const g = questionarioDoFormulario(respostas((r) => { r.valores.consulta_antecipada = ''; r.valores.sinal_pix = ''; r.horarios.almoco_inicio = ''; r.horarios.almoco_fim = ''; }), COMPLETOS);
  assert.deepEqual(g.pendencias, []);
  const o = g.objeto as Record<string, Record<string, unknown>>;
  assert.equal(o.valores!.aceita_antecipado, false);
  assert.ok(!('sinal_pix' in o.valores!) && !('consulta_antecipada' in o.valores!));
  assert.ok(!('almoco_inicio' in o.horarios!));
});

test('--set: só a lista fechada, sem valor vazio e sem caractere de shell', () => {
  assert.deepEqual(lerAjustes(['whatsapp.waba_id=2146287749563217', 'sufixo=SERRA']), { ok: true, ajustes: { 'whatsapp.waba_id': '2146287749563217', sufixo: 'SERRA' } });
  for (const ruim of ['franquia.id_company=abc', 'franquia.id_company=1e3', 'unidade.slug=Foo_Bar', 'sufixo=abc', 'whatsapp.waba_id=12', 'meta.ad_account=1234567', 'sofia.tom=casual', 'valores.chave_pix=x', 'franquia.token_env=X', 'whatsapp.waba_id', 'whatsapp.waba_id=', 'whatsapp.waba_id=1 2', 'whatsapp.waba_id=1;rm', 'whatsapp.waba_id=$(x)', '=1']) {
    assert.equal(lerAjustes([ruim]).ok, false, ruim);
  }
  assert.ok(AJUSTES_PERMITIDOS.every((k) => !/token|senha|secret|pix|email/i.test(k)), 'nenhum campo de segredo ou dado pessoal por --set');
});

test('o YAML nunca perde caractere especial nem vira outra coisa (aspas, dois-pontos, #, acentos, true/null)', () => {
  const g = questionarioDoFormulario(
    respostas((r) => {
      r.clinica.nome = 'Clínica "Sol & Mar": #1 em hérnia';
      r.clinica.endereco = 'Rua A, 10 — sala: 2 # fundos, Centro, Serra/ES, 29160-000';
      r.profissionais = [{ nome: 'Dr. null', funcao: 'medico' }, { nome: 'true', funcao: 'fisioterapeuta' }];
    }),
    COMPLETOS,
  );
  assert.deepEqual(g.pendencias, []);
  const lido = lerQuestionario(paraYaml(g.objeto));
  assert.ok(lido.ok, JSON.stringify(lido));
  if (!lido.ok) return;
  assert.equal(lido.q.unidade.nome, 'Clínica "Sol & Mar": #1 em hérnia');
  assert.equal(lido.q.unidade.endereco, 'Rua A, 10 — sala: 2 # fundos, Centro, Serra/ES, 29160-000');
  assert.deepEqual(lido.q.profissionais.map((p) => p.nome), ['Dr. null', 'true']);
});

test('fuso por estado e prefixo de modelos válido', () => {
  assert.equal(fusoDaUf('PA'), 'America/Belem');
  assert.equal(fusoDaUf('AM'), 'America/Manaus');
  assert.equal(fusoDaUf('AC'), 'America/Rio_Branco');
  assert.equal(fusoDaUf('SP'), 'America/Sao_Paulo');
  assert.equal(prefixoDeModelos('Parauapebas'), 'parau_');
  assert.equal(prefixoDeModelos('São Paulo'), 'saopa_');
  assert.match(prefixoDeModelos('Ìí'), /^[a-z][a-z0-9]{1,15}_$/);
  assert.equal(validarQuestionario({}).ok, false);
});

test('o YAML gerado não leva segredo: só NOMES de variáveis', () => {
  const g = questionarioDoFormulario(respostas(), COMPLETOS);
  const yaml = paraYaml(g.objeto);
  assert.doesNotMatch(yaml, /EAA[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{10,}|senha|password/i);
  assert.match(yaml, /token_env: META_ADS_TOKEN_SERRA/);
});
