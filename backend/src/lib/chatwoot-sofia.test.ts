/**
 * A Sofia real no Chatwoot, com portas falsas (sem banco, sem rede, sem modelo):
 *  - a chave de lead sintética e o que chega às ferramentas reais (lead da conversa, telefone do Chatwoot, sem Kommo);
 *  - SECO: as de escrita são simuladas e NADA é escrito no Chatwoot; as de leitura são as reais, sem sondagem;
 *  - LIGADO: agendar grava data/hora/situação/etapa; handoff = etiqueta + etapa + nota (etapa protegida não muda);
 *  - as que são só do Chatwoot (etiqueta, etapa, qualificação) conferem contra as listas vivas;
 *  - a saída: sem botões, guardrail, Pix e endereço só no ligado.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { Unit } from '@prisma/client';
import {
  atributosDoAgendamento,
  construirAgendaReal,
  etiquetaNormalizada,
  montarFerramentas,
  motivoDeNaoResponder,
  rodarSofiaDoChatwoot,
  type ConversaLida,
  type DepsDasFerramentas,
  type EstadoDaRodada,
  type ModoDaSofia,
  type PortaDoChatwoot,
} from './chatwoot-sofia.js';
import { BASE_LEAD_CHATWOOT, conversaDoLeadChatwoot, ehLeadDoChatwoot, leadDaConversaChatwoot } from './chatwoot-lead.js';
import { desejadoDe, mudancas } from './chatwoot-agenda.js';
import { baixarNoChatwoot, ETIQUETA_PAGOU } from './sinal-pix-worker.js';
import { RastroEmMemoria } from './chatwoot-sofia.js';
import { guardarPixDoTurno } from '../agent/sinal-pix-tool.js';
import { marcarConsultaNoTurno } from './cartao-de-chegada.js';
import type { SandboxAction } from '../controllers/playground.controller.js';

const CONVERSA = 77;
const LEAD = BASE_LEAD_CHATWOOT + CONVERSA;
const FONTES = 'Consulta: R$ 350 no dia, ou R$ 250 com pagamento antecipado.';

const unidade = (over: Record<string, unknown> = {}): Unit =>
  ({
    id: 'u-parau',
    slug: 'doutor-hernia-parauapebas',
    name: 'Doutor Hérnia Parauapebas',
    category: 'saude',
    spineEnabled: true,
    spineToken: 'tok',
    spineAiPaused: false,
    spineBookingRequiresPayment: false,
    acceptsAdvancePayment: true,
    pixKey: '12.345.678/0001-90',
    pixHolder: 'Clinica LTDA',
    sourceProdutos: FONTES,
    systemPrompt: '',
    sinalPixCentavos: 5000,
    clinicAddress: 'Rua A, 10',
    clinicMapUrl: null,
    ...over,
  }) as unknown as Unit;

const LISTAS: Record<string, string[]> = {
  etapa: ['Novo lead', 'Sofia qualifica', 'Esperando humano', 'Agendado', 'Confirmado', 'Compareceu', 'Perdido', 'Frio'],
  qualificacao: ['Quente', 'Morno', 'Frio'],
  motivo_nao_agendamento: ['Preço', 'Não interagiu', 'Sem tempo'],
};

function chatFalso(o: { etiquetasDaConta?: string[]; falhaNota?: boolean } = {}) {
  const gravados: Array<Record<string, unknown>> = [];
  const etiquetas: string[][] = [];
  const notas: string[] = [];
  const chat: PortaDoChatwoot = {
    conversa: async () => null,
    gravarAtributos: async (_id, parcial) => {
      gravados.push(parcial);
    },
    adicionarEtiquetas: async (_id, e) => {
      etiquetas.push(e);
    },
    nota: async (_id, t) => {
      if (o.falhaNota) throw new Error('chatwoot fora');
      notas.push(t);
    },
    publica: async () => ({ usuario: null }),
    valoresDoAtributo: async (c) => LISTAS[c] ?? [],
    etiquetasDaConta: async () => o.etiquetasDaConta ?? ['quente', 'indicacao', 'esperando-humano', 'retomada'],
  };
  return { chat, gravados, etiquetas, notas, escreveu: () => gravados.length + etiquetas.length + notas.length };
}

/** uma ferramenta real de mentira: registra o que recebeu (inclusive o leadId que o grafo injeta) */
function ferramenta(nome: string, recebidos: Array<Record<string, unknown>>, devolve: string | ((a: Record<string, unknown>) => string), schema?: z.ZodObject<any>) {
  return new DynamicStructuredTool({
    name: nome,
    description: nome,
    schema: schema ?? z.object({ data: z.string().optional(), hora: z.string().optional(), formaPagamento: z.string().optional(), diaConfirmado: z.boolean().optional(), idClient: z.number().optional(), leadId: z.number().optional(), confirmado: z.boolean().optional(), horarioEscolhido: z.string().optional(), nome: z.string().optional(), telefone: z.string().optional() }),
    func: async (a: Record<string, unknown>) => {
      recebidos.push(a);
      return typeof devolve === 'function' ? devolve(a) : devolve;
    },
  });
}

function montar(modo: ModoDaSofia, o: { etapa?: string; chat?: ReturnType<typeof chatFalso>; sinal?: boolean; agendarDevolve?: string; grade?: DepsDasFerramentas['grade']; consulta?: DepsDasFerramentas['consulta'] } = {}) {
  const chat = o.chat ?? chatFalso();
  const recebidos: Record<string, Array<Record<string, unknown>>> = { consultar_horarios: [], buscar_paciente: [], cadastrar_paciente: [], agendar_consulta: [], remarcar_consulta: [], cancelar_consulta: [], gerar_sinal_pix: [] };
  const contextos: Array<Record<string, unknown>> = [];
  const deps: DepsDasFerramentas = {
    construirAgenda: (ctx, sinal) => {
      contextos.push(ctx as unknown as Record<string, unknown>);
      return {
        consultar_horarios: ferramenta('consultar_horarios', recebidos.consultar_horarios!, 'Horários CONFIRMADOS: 09:00'),
        buscar_paciente: ferramenta('buscar_paciente', recebidos.buscar_paciente!, 'Nenhum cadastro encontrado'),
        cadastrar_paciente: ferramenta('cadastrar_paciente', recebidos.cadastrar_paciente!, 'Cadastrado. idClient 5555'),
        agendar_consulta: ferramenta('agendar_consulta', recebidos.agendar_consulta!, o.agendarDevolve ?? 'Consulta marcada para terça-feira, 17 de novembro às 09:00.'),
        remarcar_consulta: ferramenta('remarcar_consulta', recebidos.remarcar_consulta!, 'Consulta remarcada'),
        cancelar_consulta: ferramenta('cancelar_consulta', recebidos.cancelar_consulta!, 'Consulta de terça-feira, 17 de novembro às 09:00 cancelada. Confirme ao paciente.'),
        ...(o.sinal === false
          ? {}
          : {
              gerar_sinal_pix: ferramenta('gerar_sinal_pix', recebidos.gerar_sinal_pix!, () => {
                guardarPixDoTurno(ctx.recorder.traceId, '00020126PIXCOPIAECOLA');
                void sinal;
                return 'Pix do sinal gerado';
              }),
            }),
      };
    },
    contaDividida: async () => null,
    grade: o.grade ?? (async () => ({ erro: null, slots: [{ time: '09:00', status: 'livre' }, { time: '10:00', status: 'ocupado', motivo: 'ocupado' }] })),
    consulta: o.consulta ?? (async () => null),
  };
  const acoes: SandboxAction[] = [];
  const estado: EstadoDaRodada = { etapa: o.etapa ?? '', agendou: null, passouParaEquipe: false };
  const recorder = new RastroEmMemoria(`cw-${CONVERSA}-t`, 'u-parau');
  const tools = montarFerramentas({ unit: unidade(), modo, conversa: CONVERSA, telefone: '+5594999990000', chat: chat.chat, recorder, estado, onCall: (a) => acoes.push(a), deps });
  const por = (nome: string) => {
    const t = tools.find((x) => x.name === nome);
    assert.ok(t, `ferramenta ${nome} não montada`);
    return t as unknown as { invoke: (a: unknown) => Promise<string> };
  };
  return { chat, recebidos, contextos, acoes, estado, por, tools, recorder };
}

const AGENDAR = { idClient: 5555, data: '2026-11-17', hora: '09:00', diaConfirmado: true, formaPagamento: 'na_clinica' };

test('chave de lead: faixa reservada acima dos ids do Kommo, ida e volta, e recusa conversa que não cabe', () => {
  assert.equal(leadDaConversaChatwoot(CONVERSA), LEAD);
  assert.ok(LEAD > 100_000_000 && LEAD <= 2_147_483_647);
  assert.equal(conversaDoLeadChatwoot(LEAD), CONVERSA);
  assert.equal(conversaDoLeadChatwoot(28_123_456), null); // cartão do Kommo
  assert.equal(ehLeadDoChatwoot(28_123_456), false);
  assert.equal(ehLeadDoChatwoot(LEAD), true);
  assert.throws(() => leadDaConversaChatwoot(0));
  assert.throws(() => leadDaConversaChatwoot(200_000_000));
});

test('ferramentas reais: sem Kommo, com o telefone do Chatwoot; o lead que chega é o da conversa mesmo que o modelo escreva outro', async () => {
  const m = montar('ligado');
  assert.equal(m.contextos.length, 1);
  const ctx = m.contextos[0]!;
  assert.equal(ctx.kommo, undefined);
  assert.equal(ctx.telefoneDaConversa, '+5594999990000');
  assert.equal(ctx.semSondagem, false);
  assert.equal(ctx.semGravar, false);
  await m.por('buscar_paciente').invoke({ nome: 'Maria da Silva', leadId: 24954279 });
  await m.por('consultar_horarios').invoke({ data: '2026-11-17' });
  assert.equal(m.recebidos.buscar_paciente![0]!.leadId, LEAD, 'o leadId do modelo foi trocado pelo da conversa');
  assert.equal(m.recebidos.consultar_horarios![0]!.leadId, LEAD);
  // o modelo nem vê o leadId no esquema
  const schema = m.tools.find((t) => t.name === 'buscar_paciente')!.schema as unknown as { shape: Record<string, unknown> };
  assert.ok(!('leadId' in schema.shape));
});

test('SECO: leitura real SEM sondagem e sem gravar vínculo', () => {
  const m = montar('seco');
  assert.equal(m.contextos[0]!.semSondagem, true);
  assert.equal(m.contextos[0]!.semGravar, true);
});

test('SECO: agendar/cadastrar/remarcar/cancelar/sinal são simulados — a ferramenta real NÃO roda e nada é escrito no Chatwoot', async () => {
  const m = montar('seco');
  const r1 = await m.por('cadastrar_paciente').invoke({ nome: 'Maria da Silva', telefone: '+5594999990000', horarioEscolhido: '2099-11-17 09:00' });
  assert.match(r1, /^Cadastrado\. idClient 999001/);
  const r2 = await m.por('agendar_consulta').invoke(AGENDAR);
  assert.match(r2, /^Consulta marcada para .* às 09:00\./);
  const r3 = await m.por('gerar_sinal_pix').invoke({});
  assert.match(r3, /Pix do sinal de R\$ 50 gerado/);
  assert.ok(!/asaas\.com|http/i.test(r3), 'o seco não inventa link');
  const r4 = await m.por('cancelar_consulta').invoke({ confirmado: true });
  assert.match(r4, /não tem consulta marcada/);
  for (const nome of ['cadastrar_paciente', 'agendar_consulta', 'gerar_sinal_pix', 'remarcar_consulta', 'cancelar_consulta']) {
    assert.equal(m.recebidos[nome]!.length, 0, `${nome} real rodou no seco`);
  }
  assert.equal(m.chat.escreveu(), 0, 'o seco escreveu no Chatwoot');
  // o que ela GRAVARIA aparece nas ações
  const g = m.acoes.find((a) => a.tool === 'gravar_no_chatwoot');
  assert.ok(g && /SECO/.test(g.result));
  assert.deepEqual(g!.args, { data_consulta: '2026-11-17', hora_consulta: '09:00', situacao_consulta: 'Agendado', qualificacao: 'Quente', etapa: 'Agendado' });
  assert.equal(m.estado.agendou?.hora, '09:00');
});

test('SECO: as portas do agendamento valem também na simulação (dia não confirmado, forma de pagamento, horário ocupado, feriado)', async () => {
  const m = montar('seco');
  assert.match(await m.por('agendar_consulta').invoke({ ...AGENDAR, diaConfirmado: false }), /^Consulta NÃO marcada ainda\. Antes de reservar falta/);
  assert.match(await m.por('agendar_consulta').invoke({ ...AGENDAR, formaPagamento: undefined }), /falta: .*como ele prefere garantir/);
  assert.match(await m.por('agendar_consulta').invoke({ ...AGENDAR, hora: '10:00' }), /não está mais disponível/);
  assert.match(await m.por('agendar_consulta').invoke({ ...AGENDAR, hora: '11:00' }), /não é um horário de atendimento/);
  assert.match(await m.por('agendar_consulta').invoke({ ...AGENDAR, data: '2026-12-25' }), /feriado nacional/);
  assert.equal(m.estado.agendou, null);
  // sinal sem consulta marcada na rodada: recusa, como a real
  assert.match(await m.por('gerar_sinal_pix').invoke({}), /Ainda não há consulta marcada/);
  assert.equal(m.chat.escreveu(), 0);
});

test('SECO: com o sinal, a escolha «sinal» (pix_antecipado) vira o fluxo do sinal e manda gerar o Pix', async () => {
  const m = montar('seco');
  const r = await m.por('agendar_consulta').invoke({ ...AGENDAR, formaPagamento: 'pix_antecipado' });
  assert.match(r, /chame gerar_sinal_pix AGORA/);
});

test('LIGADO: agendar de verdade grava data, hora, situação, qualificação e etapa «Agendado» na conversa', async () => {
  const m = montar('ligado', { etapa: 'Sofia qualifica' });
  const r = await m.por('agendar_consulta').invoke(AGENDAR);
  assert.match(r, /^Consulta marcada para/);
  assert.equal(m.recebidos.agendar_consulta!.length, 1);
  assert.equal(m.recebidos.agendar_consulta![0]!.leadId, LEAD);
  assert.deepEqual(m.chat.gravados, [{ data_consulta: '2026-11-17', hora_consulta: '09:00', situacao_consulta: 'Agendado', qualificacao: 'Quente', etapa: 'Agendado' }]);
  assert.equal(m.estado.etapa, 'Agendado');
  assert.equal(m.estado.agendou?.data, '2026-11-17');
});

test('LIGADO: quem já passou de Agendado (alta, pós-consulta) ganha os campos mas NÃO muda de etapa', async () => {
  for (const etapa of ['Compareceu', 'Pós-consulta', 'Fechou', 'Confirmado']) {
    const m = montar('ligado', { etapa });
    await m.por('agendar_consulta').invoke(AGENDAR);
    assert.equal('etapa' in m.chat.gravados[0]!, false, etapa);
    assert.equal(m.chat.gravados[0]!.data_consulta, '2026-11-17');
  }
});

test('LIGADO: a Sofia passou a conversa para a equipe e a ferramenta ainda assim marcou: os campos entram, a etapa continua «Esperando humano»', async () => {
  const m = montar('ligado', { etapa: 'Sofia qualifica' });
  await m.por('pausar_ia').invoke({ motivo: 'cadastro duplicado' });
  await m.por('agendar_consulta').invoke(AGENDAR);
  const grav = m.chat.gravados.at(-1)!;
  assert.equal(grav.data_consulta, '2026-11-17');
  assert.equal('etapa' in grav, false);
  assert.equal(m.estado.etapa, 'Esperando humano');
});

test('LIGADO: agendamento recusado pela ferramenta não grava nada na conversa', async () => {
  const m = montar('ligado', { agendarDevolve: 'RECUSADO: este paciente já tem consulta em terça. NÃO marque uma segunda.' });
  await m.por('agendar_consulta').invoke(AGENDAR);
  assert.equal(m.chat.escreveu(), 0);
  assert.equal(m.estado.agendou, null);
});

test('LIGADO: se gravar nos atributos falhar, a resposta da ferramenta (consulta marcada) continua valendo', async () => {
  const m = montar('ligado');
  m.chat.chat.gravarAtributos = async () => {
    throw new Error('Chatwoot 500');
  };
  assert.match(await m.por('agendar_consulta').invoke(AGENDAR), /^Consulta marcada para/);
});

test('LIGADO: remarcar e cancelar também atualizam a conversa (a véspera não pode sair para o dia velho nem para consulta desmarcada)', async () => {
  const r = montar('ligado', { etapa: 'Agendado', consulta: async () => ({ quando: '2026-11-18T10:00' }) });
  await r.por('remarcar_consulta').invoke({ idClient: 5555, data: '2026-11-18', hora: '10:00' });
  assert.deepEqual(r.chat.gravados, [{ data_consulta: '2026-11-18', hora_consulta: '10:00', situacao_consulta: 'Agendado' }]);
  // a franquia NÃO mostra o horário novo (remarcação recusada): nada é gravado
  const n = montar('ligado', { etapa: 'Agendado', consulta: async () => ({ quando: '2026-11-17T09:00' }) });
  await n.por('remarcar_consulta').invoke({ idClient: 5555, data: '2026-11-18', hora: '10:00' });
  assert.equal(n.chat.gravados.length, 0);
  const c = montar('ligado', { etapa: 'Agendado' });
  await c.por('cancelar_consulta').invoke({ confirmado: true });
  assert.deepEqual(c.chat.gravados, [{ situacao_consulta: 'Desmarcado' }]);
  assert.equal(c.estado.etapa, 'Agendado', 'etapa não muda');
});

test('SECO: consultar_horarios avisa nas ações que é só a grade (sem a sondagem do ligado)', async () => {
  const m = montar('seco');
  await m.por('consultar_horarios').invoke({ data: '2026-11-17' });
  assert.match(String(m.acoes[0]!.args.observacao), /sem a sondagem/);
  const l = montar('ligado');
  await l.por('consultar_horarios').invoke({ data: '2026-11-17' });
  assert.equal('observacao' in l.acoes[0]!.args, false);
});

test('sem Kommo, os avisos da agenda (cadastro duplicado, agenda sem conferir, vaga presa) viram etiqueta + nota na conversa', async () => {
  const m = montar('ligado', { etapa: 'Sofia qualifica' });
  const aviso = (m.contextos[0] as { avisoSemKommo: (motivo: string, detalhe: string) => Promise<boolean> }).avisoSemKommo;
  assert.equal(await aviso('cadastro_duplicado', 'Cadastro usado pela IA: 55'), true);
  assert.deepEqual(m.chat.etiquetas, [['esperando-humano']]);
  assert.match(m.chat.notas[0]!, /cadastro duplicado — Cadastro usado pela IA: 55/);
});

test('o que a Sofia grava ao agendar é IGUAL ao que a varredura da agenda (chatwoot-agenda) grava: não há briga entre os dois escritores', () => {
  const minha = atributosDoAgendamento({ data: '2026-11-17', hora: '09:00' }, 'Sofia qualifica', ['Quente']);
  const daAgenda = desejadoDe({ dayLocal: '2026-11-17', timeLocal: '09:00:00', statusName: 'Agendado', idStatus: 1, categoryName: 'Consulta' } as never);
  assert.ok(daAgenda);
  // aplicado o que a Sofia gravou, a varredura da agenda só acrescentaria a categoria (que a Sofia não escreve), nunca data/hora/situação
  const depois = mudancas(minha, { ...daAgenda!, categoria_consulta: null });
  assert.deepEqual(depois, {});
});

test('pausar_ia no LIGADO: etiqueta esperando-humano + etapa «Esperando humano» + nota com o motivo', async () => {
  const m = montar('ligado', { etapa: 'Sofia qualifica' });
  const r = await m.por('pausar_ia').invoke({ motivo: 'quer falar com a Dra.' });
  assert.match(r, /passada para a equipe/);
  assert.deepEqual(m.chat.etiquetas, [['esperando-humano']]);
  assert.deepEqual(m.chat.gravados, [{ etapa: 'Esperando humano' }]);
  assert.match(m.chat.notas[0]!, /Sofia passou esta conversa para a equipe: quer falar com a Dra\./);
  assert.equal(m.estado.passouParaEquipe, true);
});

test('pausar_ia com consulta de pé: etiqueta e nota, mas a ETAPA não muda (a régua lê a etapa)', async () => {
  const m = montar('ligado', { etapa: 'Agendado' });
  await m.por('pausar_ia').invoke({ motivo: 'dúvida sobre o exame' });
  assert.deepEqual(m.chat.etiquetas, [['esperando-humano']]);
  assert.deepEqual(m.chat.gravados, []);
  assert.equal(m.chat.notas.length, 1);
});

test('pausar_ia com o Chatwoot fora: não promete (a ferramenta diz que não conseguiu)', async () => {
  const m = montar('ligado', { chat: chatFalso({ falhaNota: true }) });
  assert.match(await m.por('pausar_ia').invoke({ motivo: 'x' }), /NÃO consegui avisar a equipe/);
  assert.equal(m.estado.passouParaEquipe, false, 'só conta como passada quando a equipe foi mesmo avisada');
});

test('pausar_ia no SECO: não escreve nada', async () => {
  const m = montar('seco');
  assert.match(await m.por('pausar_ia').invoke({ motivo: 'x' }), /^\[SECO\]/);
  assert.equal(m.chat.escreveu(), 0);
  assert.equal(m.acoes.at(-1)!.tool, 'pausar_ia');
});

test('Pix do sinal que NÃO sai no ligado: vira aviso à equipe (etiqueta + nota), no lugar da tarefa do Kommo', async () => {
  const capturado: { f?: (motivo: 'sinal_pix_falhou' | 'sinal_pix_sem_registro', detalhe: string) => Promise<boolean> } = {};
  const deps = ferramentasFalsas();
  const construir = deps.construirAgenda;
  deps.construirAgenda = (ctx, sinal) => {
    capturado.f = sinal.avisarEquipe; // a porta que o montador entrega à ferramenta real do sinal
    return construir(ctx, sinal);
  };
  const chat = chatFalso();
  montarFerramentas({ unit: unidade(), modo: 'ligado', conversa: CONVERSA, telefone: null, chat: chat.chat, recorder: new RastroEmMemoria('cw-x', 'u'), estado: { etapa: 'Sofia qualifica', agendou: null, passouParaEquipe: false }, onCall: () => undefined, deps });
  assert.equal(await capturado.f!('sinal_pix_falhou', 'Motivo: o Asaas recusou'), true);
  assert.deepEqual(chat.etiquetas, [['esperando-humano']]);
  assert.match(chat.notas[0]!, /o Pix do sinal não saiu\. Motivo: o Asaas recusou/);
});

test('mover_etapa: só as etapas da Sofia; Perdido exige motivo da lista; etapa protegida não muda; seco não grava', async () => {
  const m = montar('ligado', { etapa: 'Sofia qualifica' });
  assert.match(await m.por('mover_etapa').invoke({ etapa: 'Perdido' }), /exige motivo_nao_agendamento/);
  assert.match(await m.por('mover_etapa').invoke({ etapa: 'Perdido', motivo_nao_agendamento: 'inventado' }), /exige motivo_nao_agendamento/);
  assert.equal(m.chat.escreveu(), 0);
  assert.match(await m.por('mover_etapa').invoke({ etapa: 'Perdido', motivo_nao_agendamento: 'Preço' }), /Etapa → Perdido/);
  assert.deepEqual(m.chat.gravados, [{ etapa: 'Perdido', motivo_nao_agendamento: 'Preço' }]);
  // 'Agendado' / 'Esperando humano' nem passam pelo esquema
  await assert.rejects(() => m.por('mover_etapa').invoke({ etapa: 'Agendado' }));
  // protegida
  const p = montar('ligado', { etapa: 'Agendado' });
  assert.match(await p.por('mover_etapa').invoke({ etapa: 'Frio' }), /RECUSADO: esta conversa está em «Agendado»/);
  assert.equal(p.chat.escreveu(), 0);
  // seco
  const s = montar('seco', { etapa: 'Sofia qualifica' });
  assert.match(await s.por('mover_etapa').invoke({ etapa: 'Frio' }), /^\[SECO\] Etapa → Frio/);
  assert.equal(s.chat.escreveu(), 0);
});

test('registrar_qualificacao e aplicar_tag: conferem a lista viva; etiqueta reservada da régua e inexistente são recusadas', async () => {
  const m = montar('ligado');
  assert.match(await m.por('registrar_qualificacao').invoke({ qualificacao: 'Morno' }), /Qualificação → Morno/);
  assert.deepEqual(m.chat.gravados, [{ qualificacao: 'Morno' }]);
  const r = await m.por('aplicar_tag').invoke({ tags: ['Quente', 'retomada', 'esperando-humano', 'inventada', 'interno'] });
  assert.match(r, /aplicada\(s\): quente/);
  assert.match(r, /RECUSADO \(não é sua\): retomada, esperando-humano, interno/);
  assert.match(r, /Não existe na conta: inventada/);
  assert.deepEqual(m.chat.etiquetas, [['quente']]);
  const s = montar('seco');
  await s.por('aplicar_tag').invoke({ tag: 'quente' });
  assert.equal(s.chat.escreveu(), 0);
  assert.equal(etiquetaNormalizada('  Indicação  Médica '), 'indicacao-medica');
});

test('aplicar_tag: «anuncio» é só do servidor (anúncio comprovado no Kapso); a Sofia é recusada mesmo com acento e a etiqueta existindo', async () => {
  const m = montar('ligado', { chat: chatFalso({ etiquetasDaConta: ['quente', 'anuncio'] }) });
  const r = await m.por('aplicar_tag').invoke({ tags: ['Anúncio', 'quente'] });
  assert.match(r, /RECUSADO \(não é sua\): anuncio/);
  assert.deepEqual(m.chat.etiquetas, [['quente']]);
});

test('quando não responder: espera por humano, em tratamento, grupo', () => {
  const c = (o: Partial<ConversaLida>): ConversaLida => ({ id: 1, nome: '', telefone: '+55', attrs: {}, etiquetas: [], grupo: false, interno: false, ...o });
  assert.equal(motivoDeNaoResponder(c({})), null);
  assert.equal(motivoDeNaoResponder(c({ attrs: { etapa: 'Esperando humano' } })), 'esperando-humano');
  assert.equal(motivoDeNaoResponder(c({ etiquetas: ['esperando-humano'] })), 'esperando-humano');
  assert.equal(motivoDeNaoResponder(c({ attrs: { funil: 'Tratamento' } })), 'em-tratamento');
  assert.equal(motivoDeNaoResponder(c({ grupo: true })), 'grupo');
});

function lida(o: Partial<ConversaLida> = {}): ConversaLida {
  return { id: CONVERSA, nome: 'Maria', telefone: '+5594999990000', attrs: {}, etiquetas: [], grupo: false, interno: false, ...o };
}

/** o modelo de mentira: monta as ferramentas, chama as que o roteiro manda e devolve a resposta */
function modeloDeMentira(roteiro: Array<[string, Record<string, unknown>]>, resposta: string) {
  return async (_unit: Unit, _falas: unknown, opts: any) => {
    const acoes: SandboxAction[] = [];
    const tools = opts.ferramentas({ onCall: (a: SandboxAction) => acoes.push(a), tz: 'America/Belem' }) as DynamicStructuredTool[];
    for (const [nome, args] of roteiro) await (tools.find((t) => t.name === nome) as unknown as { invoke: (a: unknown) => Promise<string> }).invoke(args);
    return { ok: true as const, reply: resposta, actions: acoes, timeline: [], meta: { base: 'vivo' as const, model: 'x', iterations: 1, totalLatencyMs: 1, tokens: null, costUsd: null } };
  };
}

function depsDaRodada(roteiro: Array<[string, Record<string, unknown>]>, resposta: string, ferramentas?: DepsDasFerramentas) {
  return { rodarTeste: modeloDeMentira(roteiro, resposta) as never, ferramentas };
}

function ferramentasFalsas(): DepsDasFerramentas {
  const lixo: Array<Record<string, unknown>> = [];
  return {
    construirAgenda: (ctx) => ({
      consultar_horarios: ferramenta('consultar_horarios', lixo, 'Horários CONFIRMADOS: 09:00'),
      buscar_paciente: ferramenta('buscar_paciente', lixo, 'Nenhum cadastro'),
      cadastrar_paciente: ferramenta('cadastrar_paciente', lixo, 'Cadastrado. idClient 5555'),
      agendar_consulta: ferramenta('agendar_consulta', lixo, () => {
        marcarConsultaNoTurno(ctx.recorder.traceId); // a real faz o mesmo: é o gatilho do endereço depois de marcar
        return 'Consulta marcada para terça-feira, 17 de novembro às 09:00.';
      }),
      remarcar_consulta: ferramenta('remarcar_consulta', lixo, ''),
      cancelar_consulta: ferramenta('cancelar_consulta', lixo, ''),
      gerar_sinal_pix: ferramenta('gerar_sinal_pix', lixo, () => {
        guardarPixDoTurno(ctx.recorder.traceId, '00020126PIXCOPIAECOLA');
        return 'Pix gerado';
      }),
    }),
    contaDividida: async () => null,
    grade: async () => ({ erro: null, slots: [{ time: '09:00', status: 'livre' }] }),
    consulta: async () => null,
  };
}

test('a rodada: tira a linha de botões, passa pelo guardrail e, no LIGADO, devolve o Pix e o endereço para mensagens à parte', async () => {
  const chat = chatFalso();
  const roteiro: Array<[string, Record<string, unknown>]> = [
    ['agendar_consulta', { ...AGENDAR, formaPagamento: 'pix_antecipado' }],
    ['gerar_sinal_pix', {}],
  ];
  const r = await rodarSofiaDoChatwoot(
    { unit: unidade(), falas: [{ role: 'user', content: 'quero marcar' }], conversa: CONVERSA, modo: 'ligado', lida: lida({ attrs: { etapa: 'Novo lead' } }), chat: chat.chat },
    depsDaRodada(roteiro, 'Marcado! A consulta fica R$ 250 com o sinal de R$ 50.\n[[botoes: Sim | Não]]', ferramentasFalsas()),
  );
  assert.ok(r);
  assert.ok(!r!.resposta.includes('[[botoes'));
  assert.ok(r!.resposta.startsWith('Marcado!'));
  assert.equal(r!.pix, '00020126PIXCOPIAECOLA');
  assert.equal(r!.cartao, '📍 Rua A, 10\n\nChega uns 15 minutos antes, tá? Te esperamos! 💙');
  assert.deepEqual(r!.acoes.map((a) => a.tool), ['agendar_consulta', 'gravar_no_chatwoot', 'gerar_sinal_pix']);
  assert.ok(r!.acoes.every((a) => !('leadId' in a.args)), 'o leadId sintético não aparece nas ações');
  // a etapa «Novo lead» foi para «Agendado» pelo agendamento — e a primeira resposta não a puxa de volta para «Sofia qualifica»
  assert.deepEqual(chat.gravados.map((g) => g.etapa), ['Agendado']);
});

test('a rodada no SECO: nada de Pix nem endereço para enviar, nada escrito; só o que ela faria nas ações', async () => {
  const chat = chatFalso();
  const r = await rodarSofiaDoChatwoot(
    { unit: unidade(), falas: [{ role: 'user', content: 'oi' }], conversa: CONVERSA, modo: 'seco', lida: lida(), chat: chat.chat },
    depsDaRodada([], 'Oi! Em que posso ajudar?', ferramentasFalsas()),
  );
  assert.equal(r!.pix, null);
  assert.equal(r!.cartao, null);
  assert.equal(chat.escreveu(), 0);
  // a primeira resposta tira a conversa de «Novo lead»: no seco aparece só como ação
  assert.deepEqual(r!.acoes, [{ tool: 'mover_etapa', args: { etapa: 'Sofia qualifica', automatico: true } }]);
});

test('a primeira resposta põe a conversa em «Sofia qualifica» no LIGADO; quem já está em outra etapa fica; quem foi passado à equipe também', async () => {
  const a = chatFalso();
  await rodarSofiaDoChatwoot({ unit: unidade(), falas: [{ role: 'user', content: 'oi' }], conversa: CONVERSA, modo: 'ligado', lida: lida({ attrs: {} }), chat: a.chat }, depsDaRodada([], 'Oi!', ferramentasFalsas()));
  assert.deepEqual(a.gravados, [{ etapa: 'Sofia qualifica' }]);
  const b = chatFalso();
  await rodarSofiaDoChatwoot({ unit: unidade(), falas: [{ role: 'user', content: 'oi' }], conversa: CONVERSA, modo: 'ligado', lida: lida({ attrs: { etapa: 'Frio' } }), chat: b.chat }, depsDaRodada([], 'Oi!', ferramentasFalsas()));
  assert.equal(b.gravados.length, 0);
  const c = chatFalso();
  const r = await rodarSofiaDoChatwoot({ unit: unidade(), falas: [{ role: 'user', content: 'quero um humano' }], conversa: CONVERSA, modo: 'ligado', lida: lida({ attrs: { etapa: 'Novo lead' } }), chat: c.chat }, depsDaRodada([['pausar_ia', { motivo: 'pediu humano' }]], 'Já chamo a equipe!', ferramentasFalsas()));
  assert.equal(r!.passouParaEquipe, true);
  assert.deepEqual(c.gravados, [{ etapa: 'Esperando humano' }]);
});

test('seco: depois de «agendar» a rodada não mostra «Sofia qualifica» (o ligado gravaria «Agendado»); ligado com a gravação falhando também não puxa a etapa de volta', async () => {
  const seco = chatFalso();
  const rs = await rodarSofiaDoChatwoot(
    { unit: unidade(), falas: [{ role: 'user', content: 'quero marcar' }], conversa: CONVERSA, modo: 'seco', lida: lida({ attrs: { etapa: 'Novo lead' } }), chat: seco.chat },
    depsDaRodada([['agendar_consulta', AGENDAR]], 'Marcado!', ferramentasFalsas()),
  );
  assert.deepEqual(rs!.acoes.map((a) => a.tool), ['agendar_consulta', 'gravar_no_chatwoot']);
  const ligado = chatFalso();
  ligado.chat.gravarAtributos = async () => {
    throw new Error('Chatwoot 500');
  };
  const rl = await rodarSofiaDoChatwoot(
    { unit: unidade(), falas: [{ role: 'user', content: 'quero marcar' }], conversa: CONVERSA, modo: 'ligado', lida: lida({ attrs: { etapa: 'Novo lead' } }), chat: ligado.chat },
    depsDaRodada([['agendar_consulta', AGENDAR]], 'Marcado!', ferramentasFalsas()),
  );
  assert.equal(rl!.acoes.some((a) => a.tool === 'mover_etapa'), false);
});

test('o modelo falha DEPOIS de as ferramentas gravarem: devolve as ações com «semResposta» (quem chama avisa a equipe), nunca texto de depuração', async () => {
  const r = await rodarSofiaDoChatwoot(
    { unit: unidade(), falas: [{ role: 'user', content: 'quero marcar' }], conversa: CONVERSA, modo: 'ligado', lida: lida(), chat: chatFalso().chat },
    {
      ferramentas: ferramentasFalsas(),
      rodarTeste: (async (_u: Unit, _f: unknown, opts: any) => {
        const tools = opts.ferramentas({ onCall: () => undefined, tz: 'x' }) as DynamicStructuredTool[];
        await (tools.find((t) => t.name === 'agendar_consulta') as unknown as { invoke: (a: unknown) => Promise<string> }).invoke(AGENDAR);
        return { ok: false as const, status: 502, error: 'sem_resposta_final' };
      }) as never,
    },
  );
  assert.equal(r!.semResposta, true);
  assert.equal(r!.resposta, '');
  assert.ok(r!.acoes.some((a) => a.tool === 'agendar_consulta'));
});

test('o modelo que falha devolve null (nada é enviado por quem chama)', async () => {
  const r = await rodarSofiaDoChatwoot(
    { unit: unidade(), falas: [{ role: 'user', content: 'oi' }], conversa: CONVERSA, modo: 'ligado', lida: lida(), chat: chatFalso().chat },
    { rodarTeste: (async () => ({ ok: false as const, status: 500, error: 'x' })) as never },
  );
  assert.equal(r, null);
});

test('baixa do sinal de conversa do Chatwoot: pago = etiqueta «pagou-antecipado» + nota; vencido = só a nota; nunca mexe em atributo', async () => {
  const feito: string[] = [];
  const deps = { etiqueta: async (c: number, e: string) => void feito.push(`etiqueta ${c} ${e}`), nota: async (c: number, t: string) => void feito.push(`nota ${c} ${t}`) };
  await baixarNoChatwoot(deps, 77, 'pago', true);
  await baixarNoChatwoot(deps, 78, 'venceu', false);
  assert.deepEqual(feito, [`etiqueta 77 ${ETIQUETA_PAGOU}`, 'nota 77 pago', 'nota 78 venceu']);
});

test('com as ferramentas REAIS montadas (sem Kommo): o conjunto, o sinal só em unidade com sinal, o esquema sem leadId; o seco simula por cima do esquema real', async () => {
  const montarReal = (u: Unit) =>
    montarFerramentas({
      unit: u,
      modo: 'seco',
      conversa: CONVERSA,
      telefone: '+5594999990000',
      chat: chatFalso().chat,
      recorder: new RastroEmMemoria('cw-r', u.id),
      estado: { etapa: '', agendou: null, passouParaEquipe: false },
      onCall: () => undefined,
      // o construtor REAL das ferramentas de agenda; só a grade da franquia é trocada
      deps: { construirAgenda: construirAgendaReal, contaDividida: async () => null, grade: async () => ({ erro: null, slots: [{ time: '09:00', status: 'livre' }] }), consulta: async () => null },
    });
  const com = montarReal(unidade());
  assert.deepEqual(
    com.map((t) => t.name).sort(),
    ['agendar_consulta', 'aplicar_tag', 'buscar_paciente', 'cadastrar_paciente', 'cancelar_consulta', 'consultar_horarios', 'gerar_sinal_pix', 'mover_etapa', 'pausar_ia', 'registrar_qualificacao', 'remarcar_consulta'],
  );
  assert.ok(!montarReal(unidade({ sinalPixCentavos: null })).some((t) => t.name === 'gerar_sinal_pix'));
  for (const t of com) assert.ok(!('leadId' in ((t.schema as unknown as { shape?: Record<string, unknown> }).shape ?? {})), `${t.name} mostra leadId ao modelo`);
  // o esquema REAL do agendar vale também no seco
  const agendar = com.find((t) => t.name === 'agendar_consulta') as unknown as { invoke: (a: unknown) => Promise<string> };
  assert.match(await agendar.invoke({ idClient: 1, data: '2026-11-17', hora: '09:00', diaConfirmado: true, formaPagamento: 'na_clinica' }), /^Consulta marcada para/);
  await assert.rejects(() => agendar.invoke({ idClient: 1, data: '17/11', hora: '9h' }));
});

test('cartão ativo no Kommo: casa pelo telefone, ignora ganho/perdido, olha TODOS os cartões numa leitura só e não cai se um foi apagado', async () => {
  const { cartaoNoKommoDaUnidade } = await import('./chatwoot-cartao-kommo.js');
  const lidos: number[][] = [];
  const kommo = (contatos: Array<{ id: number; telefones: string[]; leadIds: number[] }>, leads: Array<{ id: number; status_id: number }>) =>
    ({
      buscarContatosPorTelefone: async () => contatos,
      listLeadsPorIds: async (ids: number[]) => {
        lidos.push(ids);
        return leads.filter((l) => ids.includes(l.id));
      },
    }) as never;
  const U = unidade() as never;
  const muitos = Array.from({ length: 12 }, (_, i) => 100 + i);
  // o ativo é o 12º: com a leitura em lote ele aparece
  const a = cartaoNoKommoDaUnidade(U, kommo([{ id: 1, telefones: ['+55 94 99999-0000'], leadIds: muitos }], muitos.map((id) => ({ id, status_id: id === 111 ? 77 : 142 }))));
  assert.deepEqual(await a('+5594999990000'), { leadId: 111 });
  assert.deepEqual(lidos[0], muitos);
  // só ganhos/perdidos, ou cartão apagado (não volta na leitura): nenhum
  const b = cartaoNoKommoDaUnidade(U, kommo([{ id: 1, telefones: ['94999990000'], leadIds: [1, 2, 3] }], [{ id: 1, status_id: 143 }, { id: 2, status_id: 142 }]));
  assert.equal(await b('+5594999990000'), null);
  // contato de OUTRO telefone não vale; telefone curto não consulta nada
  const c = cartaoNoKommoDaUnidade(U, kommo([{ id: 1, telefones: ['94911112222'], leadIds: [5] }], [{ id: 5, status_id: 77 }]));
  assert.equal(await c('+5594999990000'), null);
  assert.equal(await c('123'), null);
  // Kommo fora do ar lança (quem chama não responde)
  const d = cartaoNoKommoDaUnidade(U, { buscarContatosPorTelefone: async () => { throw new Error('403'); }, listLeadsPorIds: async () => [] } as never);
  await assert.rejects(() => d('+5594999990000'), /403/);
});
