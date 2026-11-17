/**
 * O miolo do preenchimento retroativo com portas de mentira: o seco não grava nada e não vaza nome/telefone; a ordem de gravação (marcas ANTES
 * do campo, reafirmadas DEPOIS); uma conversa por telefone; o que mudou no meio do caminho não é sobrescrito; Kommo caído para; teto; desfazer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Vistos } from './chatwoot-regua.js';
import type { LeadDoKommo } from './chatwoot-campos-retroativos.js';
import { desfazerCampos, lerArgumentos, rodarCampos, type PortasDosCampos } from './chatwoot-campos-retroativos-run.js';

const AGORA = new Date('2026-11-17T20:00:00Z');
const MOTIVOS = ['Sem interesse', 'Outra cidade', 'Não interagiu'];

function raw(id: number, o: { fone?: string; attrs?: Record<string, unknown>; labels?: string[]; atividade?: number; status?: string; nome?: string } = {}) {
  return {
    id,
    status: o.status ?? 'resolved',
    created_at: 1_790_000_000,
    last_activity_at: o.atividade ?? 1_790_100_000,
    labels: o.labels ?? [],
    custom_attributes: o.attrs ?? {},
    meta: { sender: { name: o.nome ?? 'Maria Aparecida da Silva', phone_number: o.fone ?? `+55949999${String(1000 + id)}` } },
    last_non_activity_message: null,
  };
}
const lead = (etapa: string, o: Partial<LeadDoKommo> = {}): LeadDoKommo => ({ id: o.id ?? 1, funil: o.funil ?? 'COMERCIAL', etapa, statusId: o.statusId ?? 100, atualizadoEm: 1_790_000_000, motivoPerda: o.motivoPerda ?? null });

function mundo(convs: any[], kommoPorTelefone: (t: string) => LeadDoKommo[] | Error) {
  const lojas = new Map(convs.map((c) => [c.id, structuredClone(c)] as const));
  const chamadas: string[] = [];
  const vistos = new Map<string, { valor: string; inicial: boolean }>();
  const capi = new Set<string>();
  const kommoConsultado: string[] = [];
  const p: PortasDosCampos = {
    async conversas() {
      return { lista: [...lojas.values()].map((c) => structuredClone(c)), truncado: false };
    },
    async fresca(id) {
      const c = lojas.get(id);
      return c ? structuredClone(c) : null;
    },
    async leadsDoKommo(t) {
      kommoConsultado.push(t);
      const r = kommoPorTelefone(t);
      if (r instanceof Error) throw r;
      return r;
    },
    async qualificacoes() {
      return [];
    },
    async vistosDaCaixa() {
      return new Map<number, Vistos>();
    },
    async vistosDe(id) {
      const m: Vistos = new Map([...vistos].filter(([k]) => k.startsWith(`${id}|`)).map(([k, v]) => [k.split('|')[1]!, { valor: v.valor, desde: AGORA, inicial: v.inicial }] as const));
      return m;
    },
    async motivosValidos() {
      return MOTIVOS;
    },
    async marcarVisto(id, campo, valor) {
      chamadas.push(`visto:${id}:${campo}`);
      const k = `${id}|${campo}`;
      const antes = vistos.get(k);
      vistos.set(k, { valor, inicial: true });
      return !antes ? 'criou' : antes.valor === valor && antes.inicial ? 'igual' : 'atualizou';
    },
    async marcarCapi(id, evento) {
      chamadas.push(`capi:${id}:${evento}`);
      const k = `${id}|${evento}`;
      if (capi.has(k)) return 'ja-existia';
      capi.add(k);
      return 'criou';
    },
    async apagarVisto(id, campo) {
      chamadas.push(`apagar-visto:${id}:${campo}`);
      vistos.delete(`${id}|${campo}`);
    },
    async apagarCapi(id, evento) {
      chamadas.push(`apagar-capi:${id}:${evento}`);
      capi.delete(`${id}|${evento}`);
    },
    async gravarAtributos(id, attrs) {
      chamadas.push(`attrs:${id}`);
      lojas.get(id)!.custom_attributes = structuredClone(attrs);
    },
    async gravarEtiquetas(id, etiquetas) {
      chamadas.push(`etiquetas:${id}`);
      lojas.get(id)!.labels = [...etiquetas];
    },
    async pausa() {},
  };
  return { p, lojas, chamadas, vistos, capi, kommoConsultado };
}
const opcoes = (o: Partial<Parameters<typeof rodarCampos>[0]> = {}) => ({ soConferir: false, caixa: 3, max: 150, so: null, ...o });
const agora = () => AGORA;

test('--so-conferir: não grava NADA (nem marca), mostra id + campo + regra, e a saída não tem nome nem telefone', async () => {
  const m = mundo([raw(1), raw(2), raw(3, { attrs: { etapa: 'Agendado', qualificacao: 'Quente', funil: 'Comercial' } })], (t) => (t.endsWith('1001') ? [lead('AGENDADO')] : t.endsWith('1002') ? [lead('PERDIDO', { statusId: 143, motivoPerda: 'Sem interesse' })] : []));
  const linhas: string[] = [];
  const r = await rodarCampos(opcoes({ soConferir: true }), m.p, (l) => linhas.push(l), agora);
  assert.deepEqual(m.chamadas, []);
  assert.equal(r.gravadas, 0);
  assert.equal(r.conversas, 3);
  assert.equal(r.comCampoVazio, 2, 'a 3 está completa: nem pergunta ao Kommo');
  assert.equal(m.kommoConsultado.length, 2);
  assert.deepEqual(r.porRegra, { 'etapa-kommo': 2, 'motivo-kommo': 1 });
  const texto = linhas.join('\n');
  assert.match(texto, /poria  conversa 1  etapa: \(vazio\) → Agendado  \[etapa-kommo: Kommo AGENDADO\]/);
  assert.match(texto, /conversa 2  motivo_nao_agendamento: \(vazio\) → Sem interesse/);
  assert.doesNotMatch(texto, /Maria|Silva|Aparecida|\+55|5594|9999/i);
  assert.equal(r.semCartao, 0);
});

test('gravar: as marcas da régua e da Meta vão ANTES do campo e são reafirmadas DEPOIS; sai a linha REG para desfazer', async () => {
  const m = mundo([raw(7)], () => [lead('AGENDADO')]);
  const linhas: string[] = [];
  const r = await rodarCampos(opcoes(), m.p, (l) => linhas.push(l), agora);
  assert.deepEqual(m.chamadas, ['visto:7:etapa', 'capi:7:AddToCart', 'attrs:7', 'visto:7:etapa']);
  assert.equal(r.gravadas, 1);
  assert.equal(m.lojas.get(7)!.custom_attributes.etapa, 'Agendado');
  assert.deepEqual(m.vistos.get('7|etapa'), { valor: 'Agendado', inicial: true });
  const reg = linhas.find((l) => l.startsWith('REG '))!;
  assert.deepEqual(JSON.parse(reg.slice(4)), { conversa: 7, antes: { etapa: null }, depois: { etapa: 'Agendado' }, etiqueta: null, visto: [{ campo: 'etapa', como: 'criou' }], capi: [{ evento: 'AddToCart', como: 'criou' }], em: AGORA.toISOString() });
});

test('EM ESPERA: só a etiqueta conferir-etapa, a lista inteira é remontada (nada se perde); conferir-etapa já posta não é tocada nem consulta o Kommo', async () => {
  const m = mundo([raw(1, { labels: ['anuncio', 'historico'] }), raw(2, { labels: ['conferir-etapa'] })], () => [lead('EM ESPERA')]);
  const r = await rodarCampos(opcoes(), m.p, () => {}, agora);
  assert.deepEqual(m.lojas.get(1)!.labels, ['anuncio', 'historico', 'conferir-etapa']);
  assert.deepEqual(m.lojas.get(2)!.labels, ['conferir-etapa']);
  assert.equal(r.jaMarcadasParaConferir, 1);
  assert.equal(m.kommoConsultado.length, 1);
  assert.deepEqual(m.chamadas, ['etiquetas:1']);
});

test('uma conversa por telefone: a mais recente recebe; se a irmã já tem etapa, ninguém recebe', async () => {
  const fone = '+5594988887777';
  const m = mundo([raw(1, { fone, atividade: 100 }), raw(2, { fone, atividade: 200 }), raw(3, { fone: '+5594977776666', atividade: 1 }), raw(4, { fone: '+5594977776666', attrs: { etapa: 'Perdido' } })], () => [lead('AGENDADO')]);
  const r = await rodarCampos(opcoes(), m.p, () => {}, agora);
  assert.equal(m.lojas.get(2)!.custom_attributes.etapa, 'Agendado');
  assert.equal(m.lojas.get(1)!.custom_attributes.etapa, undefined);
  assert.equal(m.lojas.get(3)!.custom_attributes.etapa, undefined, 'a irmã já tem etapa: o funil não duplica a pessoa');
  assert.equal(r.irmas, 2);
});

test('alguém preencheu no meio do caminho: relê, decide de novo e não sobrescreve nem marca nada', async () => {
  const m = mundo([raw(5)], () => [lead('AGENDADO')]);
  const original = m.p.fresca;
  let n = 0;
  m.p.fresca = async (id) => {
    const c = await original(id);
    if (++n === 1 && c) c.custom_attributes = { etapa: 'Perdido', motivo_nao_agendamento: 'Sem interesse' }; // a 1ª releitura (do passo de gravar) já a vê preenchida
    return c;
  };
  const linhas: string[] = [];
  const r = await rodarCampos(opcoes(), m.p, (l) => linhas.push(l), agora);
  assert.equal(r.gravadas, 0);
  assert.deepEqual(m.chamadas, []);
  assert.match(linhas.join('\n'), /nada   conversa 5: mudou desde a leitura/);
});

test('Kommo caído 5 vezes seguidas: para de decidir e não grava nada', async () => {
  const convs = Array.from({ length: 8 }, (_, i) => raw(i + 1));
  const m = mundo(convs, () => new Error('403'));
  const r = await rodarCampos(opcoes(), m.p, () => {}, agora);
  assert.equal(r.erros, 5);
  assert.match(r.parouPor ?? '', /Kommo falhou 5 vezes/);
  assert.deepEqual(m.chamadas, []);
});

test('--max: grava só até o teto e diz que parou', async () => {
  const m = mundo([raw(1), raw(2), raw(3)], () => [lead('AGENDADO')]);
  const r = await rodarCampos(opcoes({ max: 2 }), m.p, () => {}, agora);
  assert.equal(r.gravadas, 2);
  assert.match(r.parouPor ?? '', /teto de 2/);
});

test('--conversas: só as pedidas', async () => {
  const m = mundo([raw(1), raw(2), raw(3)], () => [lead('AGENDADO')]);
  await rodarCampos(opcoes({ so: [2] }), m.p, () => {}, agora);
  assert.deepEqual([...m.lojas.keys()].filter((id) => m.lojas.get(id)!.custom_attributes.etapa), [2]);
});

test('--desfazer: devolve ao que era, só o que ainda é o que a gente gravou; apaga as marcas que criou', async () => {
  const m = mundo([raw(1, { labels: ['x'] }), raw(2)], (t) => (t.endsWith('1001') ? [lead('EM ESPERA')] : [lead('AGENDADO')]));
  const linhas: string[] = [];
  await rodarCampos(opcoes(), m.p, (l) => linhas.push(l), agora);
  assert.equal(m.lojas.get(2)!.custom_attributes.etapa, 'Agendado');
  assert.deepEqual(m.lojas.get(1)!.labels, ['x', 'conferir-etapa']);
  // depois do preenchimento, a equipe mudou a etapa da conversa 2: o desfazer respeita
  m.lojas.get(2)!.custom_attributes.etapa = 'Compareceu';
  m.chamadas.length = 0;
  const r = await desfazerCampos(linhas, m.p, () => {});
  assert.deepEqual(r, { desfeitas: 2, puladas: 0 });
  assert.deepEqual(m.lojas.get(1)!.labels, ['x']);
  assert.equal(m.lojas.get(2)!.custom_attributes.etapa, 'Compareceu', 'decisão da equipe não é desfeita');
  assert.ok(m.chamadas.includes('apagar-visto:2:etapa') && m.chamadas.includes('apagar-capi:2:AddToCart'));
});

test('opções estritas: erro de digitação não cai num padrão calado', () => {
  assert.deepEqual(lerArgumentos(['--so-conferir', '--caixa=3', '--max=20', '--conversas=1,2']), { soConferir: true, caixa: 3, max: 20, so: [1, 2], desfazer: false });
  assert.equal(lerArgumentos([]).max, 150);
  for (const ruim of ['--so-conferr', '--max=0', '--caixa=x', '--conversas=1;2', 'foo']) assert.throws(() => lerArgumentos([ruim]), /inválid/);
});
