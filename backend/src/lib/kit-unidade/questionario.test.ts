import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  CAMPOS_IMPORTANTES,
  CAMPOS_SENSIVEIS,
  caminhosDoEsquema,
  configChatwootDoQuestionario,
  lerQuestionario,
  questionarioMascarado,
  VARIAVEIS_DE_SEGREDO,
  type Questionario,
} from './questionario.js';
import { esquemaJson } from './schema-json.js';
import { SEMENTE_PARAUAPEBAS, problemasDaConfig } from '../chatwoot-unidades.js';
import { textosDaUnidade } from '../chatwoot-modelos.js';
import { TEXTOS_PARAU } from '../chatwoot-regua-textos.js';
import { lerYamlOuJson } from './yaml-minimo.js';

const OPS = join(dirname(fileURLToPath(import.meta.url)), '../../../../ops/kit-unidade');
const exemploTexto = readFileSync(join(OPS, 'questionario.exemplo.yaml'), 'utf8');

function exemplo(): Questionario {
  const r = lerQuestionario(exemploTexto);
  assert.ok(r.ok, r.ok ? '' : r.erros.join('; '));
  return r.q;
}
const comMudanca = (f: (o: any) => void) => {
  const o = lerYamlOuJson(exemploTexto) as any;
  f(o);
  return lerQuestionario(JSON.stringify(o));
};
const erros = (r: ReturnType<typeof lerQuestionario>) => (r.ok ? [] : r.erros).join(' | ');

test('o exemplo (Parauapebas) é válido e dá a MESMA configuração e os MESMOS textos que a semente do código', () => {
  const q = exemplo();
  const c = configChatwootDoQuestionario(q, { gerenteId: 4, usuarioCelularId: 7, caixas: SEMENTE_PARAUAPEBAS.caixas });
  assert.equal(c.slug, SEMENTE_PARAUAPEBAS.slug);
  assert.equal(c.prefixoModelos, SEMENTE_PARAUAPEBAS.prefixoModelos);
  assert.equal(c.envSufixo, SEMENTE_PARAUAPEBAS.envSufixo);
  assert.equal(c.kapsoPhoneNumberId, SEMENTE_PARAUAPEBAS.kapsoPhoneNumberId);
  assert.equal(c.wabaId, SEMENTE_PARAUAPEBAS.wabaId);
  assert.equal(c.metaAgendamentosDia, SEMENTE_PARAUAPEBAS.metaAgendamentosDia);
  assert.equal(c.gerenteId, SEMENTE_PARAUAPEBAS.gerenteId);
  assert.equal(c.usuarioCelularId, SEMENTE_PARAUAPEBAS.usuarioCelularId);
  assert.deepEqual(problemasDaConfig(c), []);
  // os dados que entram nos modelos geram exatamente os textos que estão no ar
  assert.deepEqual(textosDaUnidade(c.dadosModelos).textos, { ...TEXTOS_PARAU });
});

test('o exemplo não traz segredo: só nomes de variável, e-mails de mentira e nenhum token', () => {
  assert.doesNotMatch(exemploTexto, /EAA[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{10,}|Bearer |password|senha:/i);
  const q = exemplo();
  for (const a of q.chatwoot.atendentes) assert.match(a.email, /@example\.com$/);
  for (const v of [q.franquia.token_env, q.meta.token_env, q.meta.conta_env, q.meta.dataset_id_env]) assert.match(v, /^[A-Z][A-Z0-9_]+$/);
});

test('o JSON Schema do repositório é EXATAMENTE o gerado do esquema (nada à mão, nada atrasado)', () => {
  const noDisco = JSON.parse(readFileSync(join(OPS, 'questionario.schema.json'), 'utf8'));
  assert.deepEqual(noDisco, JSON.parse(JSON.stringify(esquemaJson())));
});

test('todo campo marcado como sensível/importante/variável existe de fato no esquema', () => {
  const caminhos = new Set(caminhosDoEsquema());
  for (const k of [...Object.keys(CAMPOS_SENSIVEIS), ...Object.keys(CAMPOS_IMPORTANTES), ...VARIAVEIS_DE_SEGREDO]) assert.ok(caminhos.has(k), `«${k}» não existe no esquema`);
  const js = JSON.stringify(esquemaJson());
  assert.equal((js.match(/"x-sensivel":true/g) ?? []).length, Object.keys(CAMPOS_SENSIVEIS).length);
});

test('a máscara cobre todos os campos sensíveis e não toca no resto', () => {
  const q = exemplo();
  const m = JSON.stringify(questionarioMascarado(q));
  for (const proibido of ['pix@example.com', 'gerente@example.com', 'secretaria@example.com', '2146287749563217', '1212928641906230', '+5594984420153', 'act_1234567890', '1122334455667788', 'Clínica Exemplo Ltda', 'celular-parauapebas@example.com']) {
    assert.ok(!m.includes(proibido), `vazou: ${proibido}`);
  }
  assert.ok(m.includes('Rua C, 455-A'));
  assert.ok(m.includes('META_ADS_TOKEN_PARAUAPEBAS'));
});

test('regras entre campos: 1 gerente, e-mail repetido, preços, sufixo da Meta, horário', () => {
  assert.match(erros(comMudanca((o) => (o.chatwoot.atendentes[1].funcao = 'gerente'))), /exatamente 1 gerente \(há 2\)/);
  assert.match(erros(comMudanca((o) => (o.chatwoot.atendentes[0].funcao = 'sdr'))), /exatamente 1 gerente \(há 0\)/);
  assert.match(erros(comMudanca((o) => (o.chatwoot.atendentes[1].email = 'GERENTE@example.com'))), /e-mail repetido/);
  assert.match(erros(comMudanca((o) => (o.valores.consulta_antecipada = 400))), /menor que o do dia/);
  assert.match(erros(comMudanca((o) => (o.valores.sinal_pix = 250))), /sinal tem de ser menor/);
  assert.match(erros(comMudanca((o) => { delete o.valores.consulta_antecipada; })), /exige o valor antecipado/);
  assert.match(erros(comMudanca((o) => (o.meta.dataset_id_env = 'META_DATASET_ID_OUTRA'))), /META_DATASET_ID_PARAUAPEBAS/);
  assert.match(erros(comMudanca((o) => (o.meta.token_env = 'TOKEN_QUALQUER'))), /META_ADS_TOKEN_<SUFIXO>/);
  assert.match(erros(comMudanca((o) => (o.horarios.fim = '07:00'))), /depois do início/);
  assert.match(erros(comMudanca((o) => delete o.horarios.almoco_fim)), /almoço/);
  assert.match(erros(comMudanca((o) => (o.chatwoot.usuario_celular_email = 'sdr@example.com'))), /não pode ser uma atendente/);
});

test('segredo no lugar do nome da variável é recusado, e campo desconhecido também', () => {
  assert.match(erros(comMudanca((o) => (o.meta.token_env = 'EAAGm0PX4ZCpsBAKZB9xyz'))), /NOME da variável/);
  assert.match(erros(comMudanca((o) => (o.franquia.token_env = 'meu-token-secreto-123'))), /NOME da variável/);
  assert.match(erros(comMudanca((o) => (o.meta.token = 'abc'))), /Unrecognized key/);
  assert.match(erros(comMudanca((o) => (o.unidade.slug = 'Slug Ruim'))), /kebab-case/);
  assert.match(erros(comMudanca((o) => (o.whatsapp.prefixo_modelos = 'Parau'))), /prefixo|minúsculas/);
  assert.match(erros(comMudanca((o) => (o.unidade.mapa_url = 'http://inseguro'))), /https/);
});

test('arquivo ilegível vira erro legível, não exceção', () => {
  assert.match(erros(lerQuestionario('a: 1\n\tb: 2\n')), /não consegui ler/);
  assert.match(erros(lerQuestionario('versao: 2\n')), /versao/);
});
