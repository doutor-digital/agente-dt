import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criarConvite, hashDoCodigo, registrarEnvio } from './convites.js';
import { bancoConvitesFalso } from './convites-falso.js';
import { validarFormulario } from './formulario.js';
import { respostasValidas } from './formulario-exemplo.js';
import { escolherFormulario, importarFormulario, type BancoFormularios, type FormularioRecebido } from './formulario-importar.js';
import { lerQuestionario } from './questionario.js';
import { executar, gravarPrivado } from '../../scripts/do-formulario.js';

const temporarios: string[] = [];
after(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

const DADOS_PESSOAIS = ['gerente@clinica.example', 'recepcao@clinica.example', 'celular@clinica.example', 'pix-teste@clinica.example', '99999', '3333-4444', 'Clínica Teste Ltda'];
const COMPLETOS = ['--set', 'whatsapp.kapso_phone_number_id=1212928641906230', '--set', 'whatsapp.waba_id=2146287749563217', '--set', 'franquia.id_company=131', '--set', 'meta.ad_account=act_1234567890', '--set', 'meta.business_manager_id=1122334455667788'];

/** Banco de formulários sobre o banco de convites em memória (como o de verdade: o mesmo registro). */
async function cenario(opcoes: { colisoes?: string[] } = {}) {
  const convites = bancoConvitesFalso();
  const c = await criarConvite(convites, { rotulo: 'Dra. Teste', criadoPor: 'joao' });
  const v = validarFormulario(respostasValidas());
  assert.ok(v.ok);
  if (v.ok) await registrarEnvio(convites, c.codigo, v.respostas);
  const importados: string[] = [];
  const banco: BancoFormularios = {
    async acharEnviados({ hash, ref }) {
      return convites.linhas
        .filter((l) => l.enviadoEm && (l.codigoHash === hash || l.id === ref || l.slugSugerido === ref))
        .map((l): FormularioRecebido => ({ id: l.id, enviadoEm: l.enviadoEm, importadoEm: l.importadoEm, slugSugerido: l.slugSugerido, respostas: l.respostas }));
    },
    async colisoes() {
      return opcoes.colisoes ?? [];
    },
    async marcarImportado(id) {
      importados.push(id);
    },
  };
  return { banco, convites, codigo: c.codigo, id: c.id, importados };
}

test('acha o formulário pelo ID, pelo SLUG sugerido ou pelo CÓDIGO do link — e nunca um convite ainda não preenchido', async () => {
  const s = await cenario();
  for (const ref of [s.id, 'doutor-hernia-serra', s.codigo]) {
    const r = await importarFormulario(s.banco, ref, {});
    assert.ok(r.ok, `${ref}: ${r.linhas.join(' | ')}`);
  }
  const aberto = await criarConvite(s.convites, { rotulo: 'ainda não preencheu', criadoPor: 'j' });
  const nao = await importarFormulario(s.banco, aberto.codigo, {});
  assert.equal(nao.ok, false);
  assert.match(nao.linhas[0]!, /Não achei formulário RECEBIDO/);
  assert.equal(hashDoCodigo(aberto.codigo).length, 64);
});

test('slug repetido (dois formulários da mesma cidade): recusa e lista os ids, não adivinha', () => {
  const f = (id: string): FormularioRecebido => ({ id, enviadoEm: new Date(), importadoEm: null, slugSugerido: 'doutor-hernia-serra', respostas: {} });
  const e = escolherFormulario('doutor-hernia-serra', [f('a1'), f('b2')]);
  assert.equal(e.ok, false);
  if (!e.ok) assert.match(e.erro, /a1, b2/);
});

test('colisão com outra unidade (subdomínio, sufixo ou prefixo): nada é gerado e a mensagem diz como trocar', async () => {
  const s = await cenario({ colisoes: ['o sufixo das chaves «SERRA» já é da unidade doutor-hernia-serra-sp'] });
  const r = await importarFormulario(s.banco, s.id, {});
  assert.equal(r.ok, false);
  assert.equal(r.yaml, undefined);
  assert.match(r.linhas.join('\n'), /COLISÃO: o sufixo das chaves «SERRA»/);
  assert.match(r.linhas.join('\n'), /--set/);
});

test('executar --so-conferir: lê, mostra o que falta e a linha de máquina, NÃO grava nem marca importado', async () => {
  const s = await cenario();
  let gravou = false;
  const r = await executar([s.id, '--so-conferir'], s.banco, () => (gravou = true));
  assert.equal(r.codigo, 0);
  assert.equal(gravou, false);
  assert.equal(s.importados.length, 0);
  const saida = r.linhas.join('\n');
  assert.match(saida, /FALTA COMPLETAR/);
  assert.match(saida, /PENDENTE whatsapp\.waba_id/);
  assert.match(saida, /^KIT_RESUMO slug=doutor-hernia-serra subdominio=drherniaserra sufixo=SERRA modo=real valido=nao$/m);
  assert.match(saida, /SÓ CONFERIR/);
});

test('executar --saida: grava o arquivo 600 numa pasta 700, o arquivo é lido pelo kit, e NENHUM dado pessoal aparece na saída', async () => {
  const s = await cenario();
  const pasta = join(mkdtempSync(join(tmpdir(), 'formulario-')), 'saida');
  temporarios.push(join(pasta, '..'));
  const r = await executar([s.id, '--saida', pasta, ...COMPLETOS], s.banco, gravarPrivado);
  assert.equal(r.codigo, 0, r.linhas.join('\n'));
  const saida = r.linhas.join('\n');
  for (const d of DADOS_PESSOAIS) assert.ok(!saida.includes(d), `vazou na saída: ${d}`);
  assert.match(saida, /Questionário COMPLETO/);
  assert.match(saida, /valido=sim/);
  assert.equal(statSync(pasta).mode & 0o777, 0o700);
  const arquivo = join(pasta, 'doutor-hernia-serra.yaml');
  assert.equal(statSync(arquivo).mode & 0o777, 0o600);
  const conteudo = readFileSync(arquivo, 'utf8');
  assert.ok(conteudo.includes('gerente@clinica.example'), 'o arquivo TEM os dados (é o questionário privado)');
  const lido = lerQuestionario(conteudo);
  assert.ok(lido.ok, JSON.stringify(lido));
  assert.deepEqual(s.importados, [s.id]);
});

test('executar: argumentos ruins e --set fora da lista são recusados antes de ler o banco', async () => {
  const s = await cenario();
  const nada = () => assert.fail('não pode gravar');
  for (const args of [[], [s.id], [s.id, '--saida'], [s.id, '--so-conferir', '--set', 'sofia.tom=casual'], [s.id, '--so-conferir', '--x'], ['a', 'b', '--so-conferir']]) {
    const r = await executar(args as string[], s.banco, nada);
    assert.ok(r.codigo !== 0, args.join(' '));
  }
});

test('gravarPrivado recusa slug estranho (nada de caminho com ..)', () => {
  assert.throws(() => gravarPrivado(tmpdir(), '../x', 'a'), /slug inválido/);
});
