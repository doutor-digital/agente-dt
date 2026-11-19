/**
 * Retroativo do «Sofia atendendo»: abre o que está em «Pendentes» e etiqueta só quem a Sofia ainda atende. `--so-conferir` não grava NADA.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';

const R = await import('./chatwoot-sofia-atendendo-retroativo.js');
const { ETIQUETA_SOFIA_ATENDENDO: ETQ } = await import('./chatwoot-sofia-atendendo.js');

const AGORA = new Date('2026-11-19T15:00:00Z');
const seg = (horasAtras: number) => AGORA.getTime() / 1000 - horasAtras * 3600;

function mundo(conversas: Record<number, { status: string; labels: string[]; attrs?: Record<string, unknown> }>, ultima: Record<number, number>, sofiaLigada = true) {
  const gravou: string[] = [];
  const portas: import('./chatwoot-sofia-atendendo-retroativo.js').PortasDoAcerto = {
    sofiaLigada,
    async pendentes() {
      return { lista: Object.keys(conversas).map((id) => ({ id: Number(id), ultimaAtividade: ultima[Number(id)] ?? null })), truncado: false };
    },
    atendimento: {
      async conversa(id) {
        const c = conversas[id];
        if (!c) return null;
        return { status: c.status, lida: { id, nome: 'X', telefone: '+559499', attrs: { ...(c.attrs ?? {}) }, etiquetas: [...c.labels], grupo: false, interno: c.labels.includes('interno') } };
      },
      async etiquetas(id, lista) {
        gravou.push(`labels ${id} ${lista.join(',')}`);
        conversas[id]!.labels = lista;
      },
      async abrir(id) {
        gravou.push(`abrir ${id}`);
        conversas[id]!.status = 'open';
      },
      async garantirEtiqueta() {
        gravou.push('criar-etiqueta');
      },
    },
  };
  return { portas, gravou };
}

test('argumentos: padrão caixa 3 / 24 h; só as opções conhecidas', () => {
  assert.deepEqual(R.lerArgumentosDoAcerto([]), { soConferir: false, caixa: 3, etiquetarHoras: 24 });
  assert.deepEqual(R.lerArgumentosDoAcerto(['--so-conferir', '--caixa=7', '--etiquetar-horas=6']), { soConferir: true, caixa: 7, etiquetarHoras: 6 });
  assert.throws(() => R.lerArgumentosDoAcerto(['--tudo']), /opção inválida/);
  assert.throws(() => R.lerArgumentosDoAcerto(['--caixa=0']), /maior que zero/);
});

test('--so-conferir lista o que faria e NÃO grava nada', async () => {
  const m = mundo({ 1: { status: 'pending', labels: [] }, 2: { status: 'pending', labels: [] } }, { 1: seg(1), 2: seg(80) });
  const linhas: string[] = [];
  const r = await R.acertarPendentes({ soConferir: true, caixa: 3, etiquetarHoras: 24 }, m.portas, AGORA, (l) => linhas.push(l));
  assert.deepEqual(m.gravou, []);
  assert.deepEqual(r, { pendentes: 2, abertas: 2, etiquetadas: 1, semEtiqueta: 1, falhou: 0, truncado: false });
  assert.match(linhas[0]!, /conversa 1: abrir \+ etiqueta/);
  assert.match(linhas[1]!, /conversa 2: abrir \(sem etiqueta: parada há mais de 24 h\)/);
});

test('aplicar: abre TODAS as pendentes; etiqueta só as recentes em que a Sofia pode atender; mantém as outras etiquetas', async () => {
  const m = mundo(
    {
      1: { status: 'pending', labels: ['anuncio'] },
      2: { status: 'pending', labels: [] }, // velha: abre, sem etiqueta
      3: { status: 'pending', labels: ['ia-pausada'] }, // a equipe assumiu: abre, sem etiqueta
      4: { status: 'pending', labels: ['esperando-humano'] },
      5: { status: 'pending', labels: [], attrs: { funil: 'Tratamento' } },
      6: { status: 'pending', labels: [ETQ] }, // já tem
    },
    { 1: seg(2), 2: seg(200), 3: seg(2), 4: seg(2), 5: seg(2), 6: seg(2) },
  );
  const r = await R.acertarPendentes({ soConferir: false, caixa: 3, etiquetarHoras: 24 }, m.portas, AGORA);
  assert.deepEqual(r, { pendentes: 6, abertas: 6, etiquetadas: 1, semEtiqueta: 5, falhou: 0, truncado: false });
  assert.deepEqual(m.gravou.filter((g) => g.startsWith('labels')), [`labels 1 anuncio,${ETQ}`]);
  assert.equal(m.gravou.filter((g) => g.startsWith('abrir')).length, 6);
});

test('Sofia não ligada na unidade: abre, mas nenhuma leva a etiqueta; repetir não regrava', async () => {
  const m = mundo({ 1: { status: 'pending', labels: [] } }, { 1: seg(1) }, false);
  const r = await R.acertarPendentes({ soConferir: false, caixa: 3, etiquetarHoras: 24 }, m.portas, AGORA);
  assert.equal(r.etiquetadas, 0);
  assert.deepEqual(m.gravou, ['abrir 1']);
  const m2 = mundo({ 1: { status: 'open', labels: [ETQ] } }, { 1: seg(1) });
  const r2 = await R.acertarPendentes({ soConferir: false, caixa: 3, etiquetarHoras: 24 }, m2.portas, AGORA);
  assert.deepEqual(m2.gravou, []);
  assert.equal(r2.abertas, 0);
});

test('uma conversa que falha não derruba as outras (e entra na conta)', async () => {
  const m = mundo({ 1: { status: 'pending', labels: [] }, 2: { status: 'pending', labels: [] } }, { 1: seg(1), 2: seg(1) });
  const abrir = m.portas.atendimento.abrir;
  m.portas.atendimento.abrir = async (id) => {
    if (id === 1) throw new Error('Chatwoot 403');
    return abrir(id);
  };
  const linhas: string[] = [];
  const r = await R.acertarPendentes({ soConferir: false, caixa: 3, etiquetarHoras: 24 }, m.portas, AGORA, (l) => linhas.push(l));
  assert.equal(r.falhou, 1);
  assert.ok(linhas.some((l) => /conversa 1: FALHOU — Chatwoot 403/.test(l)));
  assert.ok(m.gravou.includes('abrir 2'));
});
