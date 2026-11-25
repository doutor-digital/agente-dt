import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { BACKUP_MAX_MODELOS, atalhoDoNome, chaveSolta, importar, lerBackup, modelosDoBackup, planejarImportacao, relatorio, textoParaOCrm, type Portas } from './modelos-kommo-para-respostas.js';
import type { KommoChatTemplate } from '../../services/kommo.service.js';

const CAMPOS: Record<number, string> = { 385924: '◷ Data da Consulta' };
const nomeDoCampo = (id: number) => CAMPOS[id] ?? null;

const modelos: KommoChatTemplate[] = [
  { id: 1, name: '⚡ Lead primeiro contato', type: 'amocrm', content: 'Olá, {{contact.name}}. Aqui é da clínica.' },
  { id: 2, name: '⚡ Consulta prepagamento pendente', type: 'amocrm', content: 'Olá, {{contact.name}}. O horário de {{lead.cf.385924}} segue reservado. {{lead.cf.999}}' },
  { id: 3, name: '⚡ Cancelamento acolhimento', type: 'waba', content: 'modelo da Meta: fica de fora' },
  { id: 4, name: '⚡ Sem texto', type: 'amocrm', content: '   ' },
];

test('atalho: sem emoji, sem acento, minúsculas, hífen', () => {
  assert.equal(atalhoDoNome('⚡ Consulta pós-atendimento (Açaí)'), 'consulta-pos-atendimento-acai');
  assert.equal(atalhoDoNome('⚡ 01 Primeira saudação'), '01-primeira-saudacao');
  assert.equal(atalhoDoNome('⚡'), '');
});

test('texto: contact.name vira first_name; o resto fica', () => {
  assert.equal(textoParaOCrm('Oi, {{contact.name}}! {{ contact.first_name }}'), 'Oi, {{contact.first_name}}! {{contact.first_name}}');
});

test('plano: só texto livre com texto; waba e vazio ficam de fora; campo do cartão vira [Nome]', () => {
  const l = planejarImportacao(modelos, nomeDoCampo, [], 'timbocrm_');
  assert.deepEqual(l.map((x) => x.atalho), ['timbocrm-consulta-prepagamento-pendente', 'timbocrm-lead-primeiro-contato']);
  const pre = l[0]!;
  assert.match(pre.texto, /^Olá, \{\{contact\.first_name\}\}\. O horário de \[◷ Data da Consulta\] segue reservado\. \[campo do cartão\]$/);
  assert.deepEqual(pre.avisos, ['lead.cf.999']);
  assert.ok(l.every((x) => x.situacao === 'criar'));
});

test('plano: casa pelo atalho — igual = já existe; texto diferente = divergente (nunca sobrescreve)', () => {
  const base = planejarImportacao(modelos, nomeDoCampo, [], 'timbocrm');
  const existentes = [
    { short_code: base[1]!.atalho, content: base[1]!.texto },
    { short_code: base[0]!.atalho, content: 'a equipe editou isto' },
  ];
  const l = planejarImportacao(modelos, nomeDoCampo, existentes, 'timbocrm');
  assert.deepEqual(l.map((x) => x.situacao), ['divergente', 'ja-existe']);
});

test('plano: dois modelos com o mesmo atalho ficam os DOIS com o id (não depende da posição)', () => {
  const dois: KommoChatTemplate[] = [
    { id: 10, name: '⚡ Retorno', type: 'amocrm', content: 'a' },
    { id: 11, name: 'Retorno!', type: 'amocrm', content: 'b' },
  ];
  assert.deepEqual(planejarImportacao(dois, nomeDoCampo, [], 'x_').map((x) => x.atalho).sort(), ['x-retorno-10', 'x-retorno-11']);
  // apagou um no Kommo: o que sobrou tem o MESMO texto que já está em x-retorno-11 → «já existe» (igual a /x-retorno-11), não vira um terceiro atalho
  const sobrou = planejarImportacao([dois[1]!], nomeDoCampo, [{ short_code: 'x-retorno-10', content: 'a' }, { short_code: 'x-retorno-11', content: 'b' }], 'x_');
  assert.deepEqual(sobrou.map((x) => [x.atalho, x.situacao, x.igualA]), [['x-retorno', 'ja-existe', 'x-retorno-11']]);
});

test('plano: quebra de linha CRLF do Kommo e espaço no fim não viram «divergente»', () => {
  const m: KommoChatTemplate[] = [{ id: 1, name: '⚡ Dois parágrafos', type: 'amocrm', content: 'Linha um  \r\nLinha dois\r\n' }];
  const l = planejarImportacao(m, nomeDoCampo, [{ short_code: 'x-dois-paragrafos', content: 'Linha um\nLinha dois' }], 'x');
  assert.equal(l[0]!.situacao, 'ja-existe');
});

test('plano: prefixo vazio é recusado (atalho sem o nome da unidade)', () => {
  assert.throws(() => planejarImportacao(modelos, nomeDoCampo, [], '_'), /prefixo/);
});

test('plano: modelo com anexo é avisado (só o texto vai)', () => {
  const m: KommoChatTemplate[] = [{ id: 1, name: 'Com PDF', type: 'amocrm', content: 'texto', attachment: { id: 9 } }];
  const l = planejarImportacao(m, nomeDoCampo, [], 'x');
  assert.equal(l[0]!.temAnexo, true);
});

function portasFalsas(existentes: Array<{ short_code: string; content: string }>) {
  const criados: Array<[string, string]> = [];
  const portas: Portas = {
    modelosDoKommo: async () => modelos,
    nomeDoCampo: async () => nomeDoCampo,
    respostasDoCrm: async () => existentes,
    criarNoCrm: async (a, t) => {
      criados.push([a, t]);
    },
  };
  return { portas, criados };
}

test('--so-conferir (padrão): NÃO escreve nada, nem os que faltam', async () => {
  const { portas, criados } = portasFalsas([]);
  const r = await importar(portas, 'timbocrm_', false);
  assert.equal(criados.length, 0);
  assert.equal(r.criadas.length, 0);
  assert.equal(r.linhas.filter((x) => x.situacao === 'criar').length, 2);
  assert.deepEqual(r.deFora, { waba: 1, semTexto: 1 });
  assert.match(relatorio(r, false).join('\n'), /SÓ CONFERIR: nada foi escrito/);
  assert.match(relatorio(r, false).join('\n'), /ficam de fora: 1 do WhatsApp .* e 1 sem texto/);
});

test('--aplicar: cria só os que faltam e, rodando de novo, não duplica', async () => {
  const existentes: Array<{ short_code: string; content: string }> = [];
  const { portas, criados } = portasFalsas(existentes);
  portas.criarNoCrm = async (a, t) => {
    criados.push([a, t]);
    existentes.push({ short_code: a, content: t });
  };
  const r1 = await importar(portas, 'timbocrm_', true);
  assert.equal(r1.criadas.length, 2);
  const r2 = await importar(portas, 'timbocrm_', true);
  assert.equal(r2.criadas.length, 0);
  assert.equal(criados.length, 2);
  assert.ok(r2.linhas.every((x) => x.situacao === 'ja-existe'));
});

test('--aplicar: uma falha não derruba as outras e fica no relatório', async () => {
  const { portas } = portasFalsas([]);
  portas.criarNoCrm = async (a) => {
    if (a.includes('lead')) throw new Error('422 Short code has already been taken');
  };
  const r = await importar(portas, 'timbocrm_', true);
  assert.equal(r.criadas.length, 1);
  assert.equal(r.falhas.length, 1);
  assert.match(relatorio(r, true).join('\n'), /FALHOU/);
});

// ── o caminho do ARQUIVO (backup em JSON) ──

const BACKUP = JSON.stringify([
  { id: 19130, name: '⚡ 01 Primeira saudação', type: 'amocrm', content: 'Oi, {{contact.name}}! Tudo bem?', attachment: null, buttons: [] },
  { id: 19154, name: '⚡ 12 Atraso', type: 'amocrm', content: '{{contact.name}}, vi que o seu horário era ⟨hora⟩.' },
  { id: 19166, name: '⚡ 18 Encerrar o atendimento', type: 'amocrm', content: 'Combinado, {{contact.name}}.\r\nQualquer coisa me chame.' },
]);

test('arquivo: o backup vira a mesma lista de modelos e passa pelas MESMAS regras (atalho, first_name)', () => {
  const l = planejarImportacao(modelosDoBackup(BACKUP), () => null, [], 'timbocrm_');
  assert.deepEqual(l.map((x) => x.atalho), ['timbocrm-01-primeira-saudacao', 'timbocrm-12-atraso', 'timbocrm-18-encerrar-o-atendimento']);
  assert.match(l[0]!.texto, /^Oi, \{\{contact\.first_name\}\}! Tudo bem\?$/);
  assert.ok(l.every((x) => x.situacao === 'criar'));
});

test('arquivo: os atalhos do backup não colidem com os dos modelos da API (nomes numerados) e, se colidirem, nenhum dos dois é sobrescrito', () => {
  const daApi = planejarImportacao(modelos, nomeDoCampo, [], 'timbocrm_').map((x) => x.atalho);
  const doArquivo = planejarImportacao(modelosDoBackup(BACKUP), () => null, [], 'timbocrm_').map((x) => x.atalho);
  assert.equal(doArquivo.filter((a) => daApi.includes(a)).length, 0);
  // colisão forçada: o atalho já existe no CRM com OUTRO texto → divergente, não sobrescreve
  const l = planejarImportacao(modelosDoBackup(BACKUP), () => null, [{ short_code: 'timbocrm-12-atraso', content: 'texto da API' }], 'timbocrm_');
  assert.equal(l.find((x) => x.atalho === 'timbocrm-12-atraso')!.situacao, 'divergente');
});

test('arquivo: --aplicar cria só os que faltam, não duplica na 2ª rodada e o CRLF não vira divergente', async () => {
  const existentes: Array<{ short_code: string; content: string }> = [];
  const criados: string[] = [];
  const portas: Portas = {
    modelosDoKommo: async () => modelosDoBackup(BACKUP),
    nomeDoCampo: async () => () => null,
    respostasDoCrm: async () => existentes,
    criarNoCrm: async (a, t) => {
      criados.push(a);
      existentes.push({ short_code: a, content: t.replace(/\r?\n/g, '\r\n') });
    },
  };
  assert.equal((await importar(portas, 'timbocrm_', false)).criadas.length, 0);
  assert.equal((await importar(portas, 'timbocrm_', true)).criadas.length, 3);
  const r2 = await importar(portas, 'timbocrm_', true);
  assert.equal(r2.criadas.length, 0);
  assert.equal(criados.length, 3);
  assert.ok(r2.linhas.every((x) => x.situacao === 'ja-existe'));
});

test('arquivo: formato inesperado LANÇA (nunca vira lista vazia)', () => {
  assert.throws(() => modelosDoBackup('não é json'), /JSON/);
  assert.throws(() => modelosDoBackup('{}'), /lista/);
  assert.throws(() => modelosDoBackup('[]'), /lista/);
  assert.throws(() => modelosDoBackup('[{"name":"sem id"}]'), /modelo 1/);
});

// ── revisão do sênior no #462 ──

const um = (content: string, name = '⚡ Teste', id = 1): KommoChatTemplate => ({ id, name, content, type: 'amocrm' });
const planoDe = (content: string) => planejarImportacao([um(content)], nomeDoCampo, [], 'timbocrm_')[0]!;

test('marcador cru: vazio, quebrado, com chave dentro, triplo e maior que 80 caracteres BLOQUEIAM o modelo (nunca vão crus ao CRM)', () => {
  for (const ruim of ['Vazio {{}}', 'Quebrado {{contact.name}', 'Com chave {{a{b}}}', 'Triplo {{{contact.name}}}', `Longo {{${'x'.repeat(90)}}}`, 'Sobra }} no fim']) {
    const l = planoDe(ruim);
    assert.equal(l.situacao, 'bloqueado', ruim);
    assert.ok(l.avisos.some((a) => /fora do padrão/.test(a)), ruim);
  }
  for (const bom of ['Oi {{contact.name}}!', 'Oi {{ CONTACT.NAME }}', 'Dia {{lead.cf.385924}}', 'Campo sem nome {{lead.cf.999}}', 'Outro {{profile.name}}']) {
    assert.equal(planoDe(bom).situacao, 'criar', bom);
  }
  assert.equal(chaveSolta('Oi {{contact.first_name}}, tudo bem?'), false);
});

test('bloqueado NÃO é criado no --aplicar', async () => {
  const criados: string[] = [];
  const portas: Portas = {
    modelosDoKommo: async () => [um('Quebrado {{contact.name}', '⚡ Ruim', 1), um('Bom', '⚡ Bom', 2)],
    nomeDoCampo: async () => () => null,
    respostasDoCrm: async () => [],
    criarNoCrm: async (a) => {
      criados.push(a);
    },
  };
  const r = await importar(portas, 'timbocrm_', true);
  assert.deepEqual(criados, ['timbocrm-bom']);
  assert.match(relatorio(r, true).join('\n'), /1 bloqueados/);
});

test('atalho repetido no plano PARA a rodada inteira e diz quais (nada é escrito)', async () => {
  // «Retorno 10» dá timbocrm-retorno-10; os dois «Retorno» (ids 10 e 11) ganham -10 e -11 → o primeiro bate com «Retorno 10»
  const lista = [um('a', '⚡ Retorno 10', 5), um('b', '⚡ Retorno', 10), um('c', '⚡ Retorno', 11)];
  assert.throws(() => planejarImportacao(lista, nomeDoCampo, [], 'timbocrm_'), /atalho repetido.*\/timbocrm-retorno-10/);
  const criados: string[] = [];
  const portas: Portas = { modelosDoKommo: async () => lista, nomeDoCampo: async () => () => null, respostasDoCrm: async () => [], criarNoCrm: async (a) => void criados.push(a) };
  await assert.rejects(importar(portas, 'timbocrm_', true), /atalho repetido/);
  assert.equal(criados.length, 0);
});

test('o MESMO texto vindo da Kommo e do backup não vira dois atalhos (existente no CRM ou na própria rodada)', () => {
  const doBackup = [um('Oi, {{contact.name}}! Tudo bem?', '⚡ 01 Primeira saudação', 19130)];
  const l = planejarImportacao(doBackup, nomeDoCampo, [{ short_code: 'timbocrm-saudacao-inicial', content: 'Oi, {{contact.first_name}}! Tudo bem?' }], 'timbocrm_');
  assert.deepEqual([l[0]!.situacao, l[0]!.igualA], ['ja-existe', 'timbocrm-saudacao-inicial']);
  const dois = planejarImportacao([um('Texto igual', '⚡ A', 1), um('Texto igual', '⚡ B', 2)], nomeDoCampo, [], 'timbocrm_');
  assert.deepEqual(dois.map((x) => [x.atalho, x.situacao]), [['timbocrm-a', 'criar'], ['timbocrm-b', 'ja-existe']]);
  assert.equal(dois[1]!.igualA, 'timbocrm-a');
});

test('unidade SEM antecipado: os modelos «Financeiro …» ficam de fora (e aparecem no relatório); com antecipado entram', async () => {
  const lista = [um('Parcela vence', '⚡ Financeiro vencimento 3d', 1), um('Oi', '⚡ Lead primeiro contato', 2)];
  const sem = planejarImportacao(lista, nomeDoCampo, [], 'timbocrm_', { semAntecipado: true });
  assert.deepEqual(sem.map((x) => [x.atalho, x.situacao]), [['timbocrm-financeiro-vencimento-3d', 'de-fora'], ['timbocrm-lead-primeiro-contato', 'criar']]);
  assert.equal(sem[0]!.motivo, 'sem pagamento antecipado');
  assert.equal(planejarImportacao(lista, nomeDoCampo, [], 'timbocrm_')[0]!.situacao, 'criar');
  const criados: string[] = [];
  const portas: Portas = { modelosDoKommo: async () => lista, nomeDoCampo: async () => () => null, respostasDoCrm: async () => [], criarNoCrm: async (a) => void criados.push(a) };
  const r = await importar(portas, 'timbocrm_', true, { semAntecipado: true });
  assert.deepEqual(criados, ['timbocrm-lead-primeiro-contato']);
  assert.match(relatorio(r, true).join('\n'), /1 de fora \(sem pagamento antecipado\)/);
});

test('o relatório conta quantos modelos têm algo para completar ([Campo] e ⟨hora⟩)', async () => {
  const lista = [um('Dia {{lead.cf.385924}}', '⚡ A', 1), um('Seu horário era ⟨hora⟩', '⚡ B', 2), um('Sem nada', '⚡ C', 3)];
  const portas: Portas = { modelosDoKommo: async () => lista, nomeDoCampo: async () => nomeDoCampo, respostasDoCrm: async () => [], criarNoCrm: async () => {} };
  const r = await importar(portas, 'timbocrm_', false);
  assert.deepEqual(r.linhas.map((x) => x.completar), [['[◷ Data da Consulta]'], ['⟨hora⟩'], []]);
  assert.match(relatorio(r, false).join('\n'), /2 modelo\(s\) a criar têm algo para a atendente completar/);
});

test('nits: sem \\r no texto do CRM e acento decomposto não vira espaço no atalho', () => {
  assert.equal(textoParaOCrm('a\r\nb\rc'), 'a\nb\nc');
  assert.equal(atalhoDoNome('Sau\u0301de Cafe\u0301'), 'saude-cafe');
  assert.equal(atalhoDoNome('Avaliação'), 'avaliacao');
});

test('arquivo: JSON validado — tamanho, quantidade, id repetido e conteúdo que não é texto', () => {
  assert.throws(() => modelosDoBackup(JSON.stringify([{ id: 1, name: 'x', content: 'y'.repeat(1_000_001) }])), /passa de/);
  assert.throws(() => modelosDoBackup(JSON.stringify(Array.from({ length: BACKUP_MAX_MODELOS + 1 }, (_, i) => ({ id: i + 1, name: 'n' })))), /máximo/);
  assert.throws(() => modelosDoBackup(JSON.stringify([{ id: 1, name: 'a' }, { id: 1, name: 'b' }])), /duas vezes/);
  assert.throws(() => modelosDoBackup(JSON.stringify([{ id: 1, name: 'a', content: 42 }])), /não é texto/);
  assert.throws(() => modelosDoBackup(JSON.stringify([{ id: 'um', name: 'a' }])), /modelo 1/);
});

test('mesmo texto sob o atalho de OUTRA unidade da conta não impede criar o da nossa', () => {
  const l = planejarImportacao([um('Oi {{contact.name}}, tudo bem?', '⚡ Saudação', 1)], nomeDoCampo, [{ short_code: 'outra-saudacao', content: 'Oi {{contact.first_name}}, tudo bem?' }], 'timbocrm_');
  assert.deepEqual([l[0]!.atalho, l[0]!.situacao], ['timbocrm-saudacao', 'criar']);
});

test('lerBackup: lê a entrada em pedaços e para no limite de tamanho', async () => {
  assert.equal(await lerBackup(Readable.from([Buffer.from('[{"id":1,'), Buffer.from('"name":"a"}]')])), '[{"id":1,"name":"a"}]');
  await assert.rejects(lerBackup(Readable.from([Buffer.alloc(600_000), Buffer.alloc(600_000)])), /passa de/);
});
