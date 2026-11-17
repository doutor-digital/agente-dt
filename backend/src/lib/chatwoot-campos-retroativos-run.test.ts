/**
 * O miolo do preenchimento retroativo com portas de mentira: o seco não grava nada e não vaza nome/telefone; a ordem de gravação (marcas ANTES
 * do campo, reafirmadas DEPOIS e GUARDADAS por minutos); uma conversa por telefone; o que mudou no meio do caminho não é sobrescrito; Kommo caído
 * para; teto; listagem cortada não grava; falha no meio não deixa marca órfã; desfazer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Vistos } from './chatwoot-regua.js';
import type { LeadDoKommo } from './chatwoot-campos-retroativos.js';
import { desfazerCampos, lerArgumentos, rodarCampos, type ComoMarcou, type OpcoesDosCampos, type PortasDosCampos, type VistoAnterior } from './chatwoot-campos-retroativos-run.js';

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

type Linha = { valor: string; inicial: boolean; desde: string };

function mundo(convs: any[], kommoPorTelefone: (t: string) => LeadDoKommo[] | Error, o: { truncado?: boolean } = {}) {
  const lojas = new Map(convs.map((c) => [c.id, structuredClone(c)] as const));
  const chamadas: string[] = [];
  const vistos = new Map<string, Linha>();
  const capi = new Map<string, string>(); // `${id}|${evento}` → modo
  const kommoConsultado: string[] = [];
  const falhas = { atributos: false, etiquetas: false };
  const p: PortasDosCampos = {
    async conversas() {
      return { lista: [...lojas.values()].map((c) => structuredClone(c)), truncado: !!o.truncado };
    },
    async fresca(id) {
      const c = lojas.get(id);
      if (!c) return null;
      const copia = structuredClone(c);
      delete copia.last_non_activity_message; // a leitura de UMA conversa não traz o campo da listagem
      return copia;
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
      return new Map([...vistos].filter(([k]) => k.startsWith(`${id}|`)).map(([k, v]) => [k.split('|')[1]!, { valor: v.valor, desde: AGORA, inicial: v.inicial }] as const));
    },
    async motivosValidos() {
      return MOTIVOS;
    },
    async ajustesDaRegua() {
      return undefined;
    },
    async marcarVisto(id, campo, valor, agora) {
      const k = `${id}|${campo}`;
      const antes = vistos.get(k);
      if (antes && antes.valor === valor && antes.inicial) return { como: 'igual' as const };
      chamadas.push(`visto:${id}:${campo}`);
      vistos.set(k, { valor, inicial: true, desde: agora.toISOString() });
      return antes ? { como: 'atualizou' as const, antes: { ...antes } as VistoAnterior } : { como: 'criou' as const };
    },
    async marcarCapi(id, evento) {
      const k = `${id}|${evento}`;
      const modo = capi.get(k);
      if (modo === 'inicial') return 'igual';
      chamadas.push(`capi:${id}:${evento}`);
      capi.set(k, 'inicial');
      return (modo ? 'atualizou' : 'criou') as ComoMarcou;
    },
    async apagarVisto(id, campo) {
      chamadas.push(`apagar-visto:${id}:${campo}`);
      vistos.delete(`${id}|${campo}`);
    },
    async restaurarVisto(id, campo, antes) {
      chamadas.push(`restaurar-visto:${id}:${campo}`);
      vistos.set(`${id}|${campo}`, { ...antes });
    },
    async apagarCapi(id, evento) {
      chamadas.push(`apagar-capi:${id}:${evento}`);
      capi.delete(`${id}|${evento}`);
    },
    async restaurarCapi(id, evento) {
      chamadas.push(`restaurar-capi:${id}:${evento}`);
      capi.set(`${id}|${evento}`, 'novo');
    },
    async gravarAtributos(id, attrs) {
      if (falhas.atributos) throw new Error('Chatwoot 500');
      chamadas.push(`attrs:${id}`);
      lojas.get(id)!.custom_attributes = structuredClone(attrs);
    },
    async gravarEtiquetas(id, etiquetas) {
      if (falhas.etiquetas) throw new Error('Chatwoot 500');
      chamadas.push(`etiquetas:${id}`);
      lojas.get(id)!.labels = [...etiquetas];
      lojas.get(id)!.last_activity_at += 100; // o Chatwoot cria uma mensagem de atividade «adicionou a etiqueta» (medido em produção); atributo não cria
    },
    async pausa() {},
  };
  return { p, lojas, chamadas, vistos, capi, kommoConsultado, falhas };
}
const opcoes = (o: Partial<OpcoesDosCampos> = {}): OpcoesDosCampos => ({ soConferir: false, caixa: 3, max: 150, so: null, guardaMin: 0, ...o });
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
  assert.deepEqual(m.chamadas, ['visto:7:etapa', 'capi:7:AddToCart', 'attrs:7']);
  assert.equal(r.gravadas, 1);
  assert.equal(m.lojas.get(7)!.custom_attributes.etapa, 'Agendado');
  assert.equal(m.vistos.get('7|etapa')?.inicial, true);
  assert.equal(r.atividadeMexeu, 0, 'gravar só atributo não mexe na última atividade');
  const reg = linhas.find((l) => l.startsWith('REG '))!;
  assert.deepEqual(JSON.parse(reg.slice(4)), { conversa: 7, antes: { etapa: null }, depois: { etapa: 'Agendado' }, etiqueta: null, visto: [{ campo: 'etapa', como: 'criou' }], capi: [{ evento: 'AddToCart', como: 'criou' }], em: AGORA.toISOString() });
});

test('a GUARDA: uma marca que o ciclo da régua apagou (listagem velha) é reafirmada em seguida, e a execução conta quantas vezes foi', async () => {
  const m = mundo([raw(7)], () => [lead('AGENDADO')]);
  let voltas = 0;
  const pausa = m.p.pausa;
  m.p.pausa = async (ms) => {
    await pausa(ms);
    // o ciclo da régua, na 3ª pausa de 30 s da guarda, salva a memória lida com a conversa velha e apaga a marca
    if (ms === 30_000 && ++voltas === 3) m.vistos.delete('7|etapa');
  };
  const linhas: string[] = [];
  const r = await rodarCampos(opcoes({ guardaMin: 2 }), m.p, (l) => linhas.push(l), agora);
  assert.equal(voltas, 4, '2 minutos = 4 voltas de 30 s');
  assert.equal(r.marcasReafirmadas, 1);
  assert.equal(m.vistos.get('7|etapa')?.inicial, true, 'a marca voltou antes do próximo ciclo');
  assert.match(linhas.join('\n'), /conversa 7: a marca da régua de etapa tinha sumido ou mudado — reafirmei/);
  assert.match(linhas.join('\n'), /guarda terminada: 1 reafirmação/);
});

test('falha ao gravar o campo: as marcas que ESTA execução pôs são desfeitas (nada de marca órfã que cale a Meta para sempre) e não sai REG', async () => {
  const m = mundo([raw(7)], () => [lead('AGENDADO')]);
  m.falhas.atributos = true;
  const linhas: string[] = [];
  const r = await rodarCampos(opcoes(), m.p, (l) => linhas.push(l), agora);
  assert.equal(r.falhas, 1);
  assert.equal(r.gravadas, 0);
  assert.equal(m.vistos.size, 0);
  assert.equal(m.capi.size, 0);
  assert.equal(linhas.some((l) => l.startsWith('REG ')), false);
});

test('falha DEPOIS de gravar o campo (etiqueta): o registro sai mesmo assim, para o --desfazer enxergar', async () => {
  const m = mundo([raw(7, { labels: ['x'] })], () => [lead('PERDIDO', { statusId: 143, motivoPerda: 'Sem interesse' })]);
  // o campo grava; depois a conferência falha
  const original = m.p.fresca;
  let n = 0;
  m.p.fresca = async (id) => {
    if (++n === 2) throw new Error('Chatwoot caiu'); // a 1ª releitura é a do passo de gravar; a 2ª é a conferência final
    return original(id);
  };
  const linhas: string[] = [];
  const r = await rodarCampos(opcoes(), m.p, (l) => linhas.push(l), agora);
  assert.equal(r.falhas, 1);
  const reg = linhas.find((l) => l.startsWith('REG '));
  assert.ok(reg, 'o campo foi gravado: o registro existe');
  assert.deepEqual(JSON.parse(reg!.slice(4)).depois, { etapa: 'Perdido', motivo_nao_agendamento: 'Sem interesse' });
  assert.equal(m.lojas.get(7)!.custom_attributes.etapa, 'Perdido');
  assert.equal(m.vistos.get('7|etapa')?.inicial, true, 'as marcas ficam: o campo existe');
});

test('a releitura de uma conversa não traz a última mensagem: a decisão usa a da listagem (senão o aviso de lead quente escaparia da trava)', async () => {
  // o paciente escreveu há 4 h: se a qualificação virar Quente em «Sofia qualifica», a régua avisaria a gerente («lead quente parado há 3 h»)
  const ultima = { message_type: 0, private: false, created_at: Math.floor(AGORA.getTime() / 1000) - 4 * 3600, sender: { id: 24, type: 'contact' } };
  const viva = { ...raw(9, { status: 'open' }), last_non_activity_message: ultima };
  const m = mundo([viva], () => [lead('EM QUALIFICAÇÃO', { id: 1 })]);
  m.p.qualificacoes = async () => [{ leadId: 1, valor: 'Quente', observadoEm: new Date(AGORA.getTime() - 86_400_000) }];
  const seco = await rodarCampos(opcoes({ soConferir: true }), m.p, () => {}, agora);
  assert.deepEqual(seco.porRegra, { 'etapa-kommo': 1 }, 'na listagem: só a etapa; a qualificação Quente fica de fora');
  const r = await rodarCampos(opcoes(), m.p, () => {}, agora);
  assert.equal(r.gravadas, 1);
  assert.equal(m.lojas.get(9)!.custom_attributes.etapa, 'Sofia qualifica');
  assert.equal(m.lojas.get(9)!.custom_attributes.qualificacao, undefined, 'a releitura (sem a última mensagem) não pode liberar o que a listagem segurou');
});

test('listagem cortada: confere, mas NÃO grava (sem ver as irmãs do telefone o funil duplicaria)', async () => {
  const m = mundo([raw(1)], () => [lead('AGENDADO')], { truncado: true });
  const seco = await rodarCampos(opcoes({ soConferir: true }), m.p, () => {}, agora);
  assert.equal(seco.porRegra['etapa-kommo'], 1);
  const r = await rodarCampos(opcoes(), m.p, () => {}, agora);
  assert.match(r.parouPor ?? '', /listagem da caixa foi cortada/);
  assert.deepEqual(m.chamadas, []);
});

test('EM ESPERA: só a etiqueta conferir-etapa, a lista inteira é remontada (nada se perde); conferir-etapa já posta não é tocada nem consulta o Kommo', async () => {
  const m = mundo([raw(1, { labels: ['anuncio', 'historico'] }), raw(2, { labels: ['conferir-etapa'] })], () => [lead('EM ESPERA')]);
  const r = await rodarCampos(opcoes(), m.p, () => {}, agora);
  assert.deepEqual(m.lojas.get(1)!.labels, ['anuncio', 'historico', 'conferir-etapa']);
  assert.deepEqual(m.lojas.get(2)!.labels, ['conferir-etapa']);
  assert.equal(r.jaMarcadasParaConferir, 1);
  assert.equal(m.kommoConsultado.length, 1);
  assert.deepEqual(m.chamadas, ['etiquetas:1']);
  assert.equal(r.arquivoQueAcorda, 1, 'a conversa 1 é arquivo (histórico parado): o relatório avisa que ela acorda');
  assert.equal(r.atividadeMexeu, 1, 'etiqueta mexe na última atividade (medido: as 6 conferir-etapa de hoje acordaram)');
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

test('Kommo caído 5 vezes seguidas: para de decidir, não grava nada e o log não leva o telefone que vem na mensagem do erro', async () => {
  const convs = Array.from({ length: 8 }, (_, i) => raw(i + 1));
  const erro = Object.assign(new Error('buscarContatosPorTelefone(88871001): Request failed with status code 403'), { status: 403 });
  const m = mundo(convs, () => erro);
  const linhas: string[] = [];
  const r = await rodarCampos(opcoes(), m.p, (l) => linhas.push(l), agora);
  assert.equal(r.erros, 5);
  assert.match(r.parouPor ?? '', /Kommo falhou 5 vezes/);
  assert.deepEqual(m.chamadas, []);
  assert.match(linhas[0]!, /\(HTTP 403\)/);
  assert.doesNotMatch(linhas.join('\n'), /8887|buscarContatos|Request failed/);
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

test('--desfazer: devolve ao que era, só o que ainda é o que a gente gravou; apaga as marcas que criou e RESTAURA a que já existia', async () => {
  const m = mundo([raw(1, { labels: ['x'] }), raw(2), raw(3)], (t) => (t.endsWith('1001') ? [lead('EM ESPERA')] : [lead('AGENDADO')]));
  // a conversa 3 tinha uma linha antiga da régua (etapa «Novo lead») e um capi-visto «novo» pendente
  m.vistos.set('3|etapa', { valor: 'Novo lead', inicial: false, desde: '2026-11-14T12:00:00.000Z' });
  m.capi.set('3|AddToCart', 'novo');
  const linhas: string[] = [];
  await rodarCampos(opcoes(), m.p, (l) => linhas.push(l), agora);
  assert.equal(m.lojas.get(2)!.custom_attributes.etapa, 'Agendado');
  assert.deepEqual(m.lojas.get(1)!.labels, ['x', 'conferir-etapa']);
  assert.equal(m.capi.get('3|AddToCart'), 'inicial', 'o evento pendente não vai mais para a Meta');
  // depois do preenchimento, a equipe mudou a etapa da conversa 2: o desfazer respeita
  m.lojas.get(2)!.custom_attributes.etapa = 'Compareceu';
  m.chamadas.length = 0;
  const r = await desfazerCampos([...linhas, 'REG {"conversa": 9}', 'lixo'], m.p, () => {});
  assert.deepEqual(r, { desfeitas: 3, puladas: 1 });
  assert.deepEqual(m.lojas.get(1)!.labels, ['x']);
  assert.equal(m.lojas.get(2)!.custom_attributes.etapa, 'Compareceu', 'decisão da equipe não é desfeita');
  assert.ok(m.chamadas.includes('apagar-visto:2:etapa') && m.chamadas.includes('apagar-capi:2:AddToCart'));
  assert.deepEqual(m.vistos.get('3|etapa'), { valor: 'Novo lead', inicial: false, desde: '2026-11-14T12:00:00.000Z' }, 'a linha antiga da régua volta como era');
  assert.equal(m.capi.get('3|AddToCart'), 'novo');
});

test('opções estritas: erro de digitação não cai num padrão calado', () => {
  assert.deepEqual(lerArgumentos(['--so-conferir', '--caixa=3', '--max=20', '--conversas=1,2', '--guarda=5']), { soConferir: true, caixa: 3, max: 20, so: [1, 2], guardaMin: 5, desfazer: false });
  assert.equal(lerArgumentos([]).max, 150);
  assert.equal(lerArgumentos([]).guardaMin, 12, 'a guarda padrão passa de um ciclo inteiro da régua (10 min)');
  for (const ruim of ['--so-conferr', '--max=0', '--caixa=x', '--conversas=1;2', '--guarda=61', 'foo']) assert.throws(() => lerArgumentos([ruim]), /inválid/);
});
