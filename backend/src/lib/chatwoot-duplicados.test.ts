/**
 * Duplicados: chave DDD + 8 últimos (com e sem 9), fica o mais antigo; seco só deixa nota uma vez por par; ligado junta com teto.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verificarCatalogo, automacaoPorId } from './automacoes.js';
import { chaveDoTelefone, cicloDuplicados, gruposDuplicados, MAX_JUNCOES_POR_CICLO, type Contato, type PortasDuplicados } from './chatwoot-duplicados.js';

test('chave: com e sem 9 dão a mesma; DDD diferente não; fora do Brasil ou curto = null', () => {
  assert.equal(chaveDoTelefone('+5594984325883'), '9484325883');
  assert.equal(chaveDoTelefone('559484325883'), '9484325883');
  assert.notEqual(chaveDoTelefone('+5591984325883'), chaveDoTelefone('+5594984325883'));
  assert.equal(chaveDoTelefone('+1234567890123'), null);
  assert.equal(chaveDoTelefone('+5594'), null);
  assert.equal(chaveDoTelefone(null), null);
});

test('grupos: fica o id menor; sem par não entra', () => {
  const g = gruposDuplicados([
    { id: 9, nome: 'Ana', telefone: '559484325883' },
    { id: 3, nome: 'Ana Souza', telefone: '+5594984325883' },
    { id: 4, nome: 'Bia', telefone: '+5594911112222' },
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0]!.fica.id, 3);
  assert.deepEqual(g[0]!.entram.map((c) => c.id), [9]);
});

function portas(contatos: Contato[], notasExistentes: Record<number, string[]> = {}) {
  const feitas: string[] = [];
  const notas = { ...notasExistentes };
  const p: PortasDuplicados = {
    pagina: async (n) => (n === 1 ? contatos : []),
    notas: async (id) => notas[id] ?? [],
    nota: async (id, t) => {
      feitas.push(`nota ${id}: ${t}`);
      (notas[id] ??= []).push(t);
    },
    juntar: async (fica, entra) => {
      feitas.push(`juntar ${fica}<-${entra}`);
    },
  };
  return { p, feitas };
}

const PAR: Contato[] = [
  { id: 3, nome: 'Ana', telefone: '+5594984325883' },
  { id: 9, nome: '', telefone: '+559484325883' },
];

test('seco: só nota, uma vez por par (o ciclo seguinte não repete)', async () => {
  const { p, feitas } = portas(PAR);
  const r = await cicloDuplicados(p, 'seco');
  assert.deepEqual(r, { grupos: 1, notas: 1, juntados: 0, falhas: 0 });
  assert.ok(feitas[0]!.startsWith('nota 3: 🧪 [SECO] Juntaria o contato #9 (+559484325883) neste'));
  await cicloDuplicados(p, 'seco');
  assert.equal(feitas.length, 1);
});

test('ligado: junta no mais antigo e deixa nota', async () => {
  const { p, feitas } = portas(PAR);
  const r = await cicloDuplicados(p, 'ligado');
  assert.equal(r.juntados, 1);
  assert.equal(feitas[0], 'juntar 3<-9');
  assert.ok(feitas[1]!.startsWith('nota 3: 🔗 Juntei o contato #9'));
});

test('ligado: teto de junções por ciclo', async () => {
  const muitos: Contato[] = [];
  for (let i = 0; i < 10; i++) {
    muitos.push({ id: 100 + i, nome: '', telefone: `+55949${String(10000000 + i)}` });
    muitos.push({ id: 200 + i, nome: '', telefone: `+5594${String(10000000 + i)}` });
  }
  const { p } = portas(muitos);
  const r = await cicloDuplicados(p, 'ligado');
  assert.equal(r.grupos, 10);
  assert.equal(r.juntados, MAX_JUNCOES_POR_CICLO);
});

test('catálogo: existe, tem seco, nasce desligado', () => {
  const a = automacaoPorId('chatwoot-duplicados');
  assert.ok(a);
  assert.equal(a!.temSeco, true);
  assert.equal(a!.quandoVazio, 'desligado');
  assert.deepEqual(verificarCatalogo(), []);
});
