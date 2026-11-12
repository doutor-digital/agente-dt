/**
 * IA no Chatwoot: só mensagem do paciente em caixa do mapa; áudio vira nota de transcrição; a Sofia roda 60 s depois da ÚLTIMA fala,
 * só se a equipe não respondeu, com teto por dia. SECO deixa nota (resposta + ações) e não escreve nada; LIGADO manda a mensagem
 * pública. Não responde paciente com cartão ativo no Kommo, conversa já passada à equipe nem sem telefone. Desligado não faz nada.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import type { Estado } from './automacoes-estado.js';
import type { ConversaLida, ResultadoDaSofia } from './chatwoot-sofia.js';
import {
  aoChegar,
  assinaturaDaConversa,
  chaveDoEvento,
  chaveDoEventoConfere,
  ESPERA_SOFIA_MS,
  falasDaConversa,
  mensagemDoPaciente,
  notaDaSofia,
  notaDaTranscricao,
  notaDoLigado,
  novaMemoriaDaIa,
  REPETE_SE_OCUPADA_MS,
  rodarSofia,
  TETO_SOFIA_POR_DIA,
  type Fala,
  type PortasDaIa,
} from './chatwoot-ia.js';

const evento = (o: Record<string, unknown> = {}) => ({
  event: 'message_created',
  message_type: 'incoming',
  private: false,
  content: 'oi',
  conversation: { id: 12, inbox_id: 2 },
  sender: { identifier: '559481854046@s.whatsapp.net' },
  attachments: [],
  ...o,
});

test('chave do evento: 32 caracteres, só a certa', () => {
  const k = chaveDoEvento('tok');
  assert.equal(k.length, 32);
  assert.equal(chaveDoEventoConfere('tok', k), true);
  assert.equal(chaveDoEventoConfere('outro', k), false);
  assert.equal(chaveDoEventoConfere(undefined, k), false);
});

test('mensagem do paciente: só incoming, pública, de caixa do mapa, fora de grupo; pega os áudios', () => {
  assert.deepEqual(mensagemDoPaciente(evento()), { conversa: 12, caixa: 2, slug: 'doutor-hernia-parauapebas', audios: [] });
  assert.equal(mensagemDoPaciente(evento({ message_type: 'outgoing' })), null);
  assert.equal(mensagemDoPaciente(evento({ private: true })), null);
  assert.equal(mensagemDoPaciente(evento({ conversation: { id: 12, inbox_id: 1 } })), null);
  assert.equal(mensagemDoPaciente(evento({ event: 'conversation_updated' })), null);
  assert.equal(mensagemDoPaciente(evento({ sender: { identifier: '1203630@g.us' } })), null);
  const a = mensagemDoPaciente(evento({ attachments: [{ file_type: 'audio', data_url: 'https://x/a.ogg' }, { file_type: 'image', data_url: 'https://x/i.jpg' }] }));
  assert.deepEqual(a!.audios, ['https://x/a.ogg']);
});

const msg = (tipo: number, content: string, o: Record<string, unknown> = {}) => ({ message_type: tipo, content, private: false, ...o });

test('falas: só públicas, junta o mesmo lado, áudio usa a transcrição da nota, termina no paciente', () => {
  const m = [
    msg(1, 'Olá! Aqui é da Doutor Hérnia.'),
    msg(0, 'oi'),
    msg(0, 'tenho dor na lombar'),
    msg(1, 'nota interna', { private: true }),
    msg(0, '', { attachments: [{ file_type: 'audio' }] }),
    msg(1, notaDaTranscricao('faz seis meses que dói'), { private: true }),
    msg(2, 'Atribuído a Fulana'),
  ];
  assert.deepEqual(falasDaConversa(m), [{ role: 'user', content: 'oi\ntenho dor na lombar\nfaz seis meses que dói' }]);
  // a equipe respondeu por último: não roda
  assert.equal(falasDaConversa([...m, msg(1, 'Entendi, me conta mais')]), null);
  // áudio sem transcrição
  assert.deepEqual(falasDaConversa([msg(0, '', { attachments: [{ file_type: 'audio' }] })]), [{ role: 'user', content: '[áudio]' }]);
  assert.equal(falasDaConversa([]), null);
});

test('falas: corta no máximo e começa sempre pelo paciente', () => {
  const m: any[] = [];
  for (let i = 0; i < 10; i++) m.push(msg(0, `p${i}`), msg(1, `n${i}`));
  m.push(msg(0, 'última'));
  const f = falasDaConversa(m, 4)!;
  assert.equal(f[0]!.role, 'user');
  assert.equal(f.at(-1)!.content, 'última');
  assert.ok(f.length <= 4);
});

test('nota da Sofia: resposta e ações em português curto', () => {
  const n = notaDaSofia('Oi! Onde dói?', [{ tool: 'atualizar_campos', args: { queixa: 'lombar', vazio: '' } }]);
  assert.ok(n.startsWith('🧪 [SECO] Sofia responderia:\n\nOi! Onde dói?'));
  assert.match(n, /Ações que ela tomaria:\n• atualizar_campos — queixa: lombar$/);
  assert.equal(notaDaSofia('ok', []), '🧪 [SECO] Sofia responderia:\n\nok');
});

const lidaPadrao = (o: Partial<ConversaLida> = {}): ConversaLida => ({ id: 12, nome: 'Maria da Silva', telefone: '+5594999990000', attrs: {}, etiquetas: [], grupo: false, ...o });
const respostaPadrao = (o: Partial<ResultadoDaSofia> = {}): ResultadoDaSofia => ({ resposta: 'A consulta é R$ 350.', acoes: [], pix: null, cartao: null, passouParaEquipe: false, ...o });

function portas(
  o: {
    estado?: Estado;
    mensagens?: any[];
    /** as leituras seguintes (a conversa mudando enquanto a Sofia pensa) */
    depois?: any[];
    falhaTranscricao?: boolean;
    lida?: Partial<ConversaLida> | null;
    cartao?: { leadId: number } | 'lanca' | null;
    sofia?: Partial<ResultadoDaSofia>;
  } = {},
) {
  const notas: Array<{ conversa: number; texto: string }> = [];
  const publicas: Array<{ conversa: number; texto: string }> = [];
  const agendados: Array<{ fn: () => void; ms: number; cancelado: boolean }> = [];
  const sofias: Array<{ falas: Fala[]; modo: string }> = [];
  const kommo: string[] = [];
  let leituras = 0;
  const p: PortasDaIa = {
    estado: () => o.estado ?? 'seco',
    unidade: async () => ({ slug: 'doutor-hernia-parauapebas' }) as Unit,
    mensagens: async () => (leituras++ > 0 && o.depois ? o.depois : (o.mensagens ?? [msg(0, 'oi, quanto custa?')])),
    nota: async (conversa, texto) => {
      notas.push({ conversa, texto });
    },
    publica: async (conversa, texto) => {
      publicas.push({ conversa, texto });
    },
    transcrever: async () => {
      if (o.falhaTranscricao) throw new Error('sem chave');
      return 'dor no joelho';
    },
    conversa: async () => (o.lida === null ? null : lidaPadrao(o.lida)),
    cartaoNoKommo: async (_u, telefone) => {
      kommo.push(telefone);
      if (o.cartao === 'lanca') throw new Error('Kommo 403');
      return o.cartao ?? null;
    },
    sofia: async (_u, falas, pedido) => {
      sofias.push({ falas, modo: pedido.modo });
      return respostaPadrao(o.sofia);
    },
    agendar: (fn, ms) => {
      const a = { fn, ms, cancelado: false };
      agendados.push(a);
      return a;
    },
    cancelar: (t) => {
      (t as { cancelado: boolean }).cancelado = true;
    },
    hoje: () => '2026-11-12',
  };
  return { p, notas, publicas, agendados, sofias, kommo };
}

const M = { conversa: 12, caixa: 2, slug: 'doutor-hernia-parauapebas', audios: [] as string[] };

test('desligado: nada (nem transcrição, nem Sofia)', async () => {
  const { p, notas, agendados } = portas({ estado: 'desligado' });
  await aoChegar({ ...M, audios: ['https://x/a.ogg'] }, p, novaMemoriaDaIa());
  assert.equal(notas.length, 0);
  assert.equal(agendados.length, 0);
});

test('áudio vira nota de transcrição na hora; falha de transcrição não derruba a Sofia', async () => {
  const a = portas();
  await aoChegar({ ...M, audios: ['https://x/a.ogg'] }, a.p, novaMemoriaDaIa());
  assert.equal(a.notas[0]!.texto, notaDaTranscricao('dor no joelho'));
  assert.equal(a.agendados.length, 1);
  const b = portas({ falhaTranscricao: true });
  await aoChegar({ ...M, audios: ['https://x/a.ogg'] }, b.p, novaMemoriaDaIa());
  assert.equal(b.notas.length, 0);
  assert.equal(b.agendados.length, 1);
});

test('Sofia: 60 s depois da ÚLTIMA fala (cada fala nova reagenda); deixa a nota', async () => {
  const { p, notas, agendados, sofias } = portas();
  const mem = novaMemoriaDaIa();
  await aoChegar(M, p, mem);
  await aoChegar(M, p, mem);
  assert.equal(agendados.length, 2);
  assert.equal(agendados[0]!.cancelado, true);
  assert.equal(agendados[1]!.ms, ESPERA_SOFIA_MS);
  agendados[1]!.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(sofias.length, 1);
  assert.equal(notas.at(-1)!.texto, '🧪 [SECO] Sofia responderia:\n\nA consulta é R$ 350.');
});

test('SECO: roda a Sofia em modo seco e NÃO escreve nada além da nota privada (nenhuma mensagem pública)', async () => {
  const a = portas({ sofia: { acoes: [{ tool: 'agendar_consulta', args: { data: '2026-11-17', hora: '09:00' } }] } });
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'nota');
  assert.equal(a.publicas.length, 0);
  assert.equal(a.sofias[0]!.modo, 'seco');
  assert.equal(a.notas.length, 1);
  assert.match(a.notas[0]!.texto, /^🧪 \[SECO\] Sofia responderia:/);
  assert.match(a.notas[0]!.texto, /• agendar_consulta — data: 2026-11-17 · hora: 09:00$/);
});

test('LIGADO: manda a resposta como mensagem PÚBLICA, o Pix e o endereço em mensagens à parte, e deixa nota do que fez', async () => {
  const a = portas({
    estado: 'ligado',
    sofia: { resposta: 'Marquei para terça às 9h.', pix: '00020126PIXCOPIAECOLA', cartao: '📍 Rua A, 10', acoes: [{ tool: 'agendar_consulta', args: { data: '2026-11-17', hora: '09:00' } }] },
  });
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'enviada');
  assert.deepEqual(
    a.publicas.map((x) => x.texto),
    ['Marquei para terça às 9h.', '00020126PIXCOPIAECOLA', '📍 Rua A, 10'],
  );
  assert.equal(a.sofias[0]!.modo, 'ligado');
  // a única nota é a das ações, sem o «[SECO]»
  assert.equal(a.notas.length, 1);
  assert.ok(a.notas[0]!.texto.startsWith('🤖 Sofia respondeu por aqui e agiu:'));
  assert.ok(!a.notas[0]!.texto.includes('SECO'));
  // sem ação, sem nota
  assert.equal(notaDoLigado([]), null);
});

test('LIGADO: se o paciente escreveu de novo enquanto a Sofia pensava, a resposta é descartada (a próxima rodada responde)', async () => {
  const a = portas({ estado: 'ligado', depois: [msg(0, 'oi, quanto custa?'), msg(0, 'e tem desconto?')] });
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'mudou');
  assert.equal(a.publicas.length, 0);
  // e se a equipe respondeu nesse meio-tempo
  const b = portas({ estado: 'ligado', depois: [msg(0, 'oi, quanto custa?'), msg(1, 'Oi! Já te respondo')] });
  assert.equal(await rodarSofia(M, b.p, novaMemoriaDaIa()), 'mudou');
  assert.equal(b.publicas.length, 0);
});

test('cartão ATIVO no Kommo: a Sofia não responde (nem roda), só deixa UMA nota por cartão; nunca mensagem pública', async () => {
  for (const estado of ['seco', 'ligado'] as const) {
    const a = portas({ estado, cartao: { leadId: 28123456 } });
    const mem = novaMemoriaDaIa();
    assert.equal(await rodarSofia(M, a.p, mem), 'cartao-no-kommo');
    assert.equal(await rodarSofia(M, a.p, mem), 'cartao-no-kommo');
    assert.equal(a.sofias.length, 0);
    assert.equal(a.publicas.length, 0);
    assert.equal(a.notas.length, 1);
    assert.match(a.notas[0]!.texto, /cartão ATIVO no Kommo \(lead 28123456\)/);
    assert.deepEqual(a.kommo, ['+5594999990000', '+5594999990000']);
  }
});

test('Kommo que não responde: melhor calar que falar em dobro (não roda, não escreve)', async () => {
  const a = portas({ estado: 'ligado', cartao: 'lanca' });
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'kommo-indisponivel');
  assert.equal(a.sofias.length, 0);
  assert.equal(a.publicas.length + a.notas.length, 0);
});

test('conversa já passada à equipe, paciente em tratamento, grupo e sem telefone: a Sofia fica calada', async () => {
  const casos: Array<[Partial<ConversaLida>, string]> = [
    [{ attrs: { etapa: 'Esperando humano' } }, 'calada'],
    [{ etiquetas: ['esperando-humano'] }, 'calada'],
    [{ attrs: { funil: 'Tratamento' } }, 'calada'],
    [{ attrs: { etapa_tratamento: 'Em tratamento' } }, 'calada'],
    [{ grupo: true }, 'calada'],
    [{ telefone: null }, 'sem-telefone'],
  ];
  for (const [lida, esperado] of casos) {
    const a = portas({ estado: 'ligado', lida });
    assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), esperado, JSON.stringify(lida));
    assert.equal(a.sofias.length, 0);
    assert.equal(a.publicas.length, 0);
  }
  assert.equal(await rodarSofia(M, portas({ lida: null }).p, novaMemoriaDaIa()), 'falhou');
});

test('equipe respondeu depois do paciente: não roda, não escreve (seco e ligado)', async () => {
  for (const estado of ['seco', 'ligado'] as const) {
    const a = portas({ estado, mensagens: [msg(0, 'oi'), msg(1, 'Olá! Sou a Ana')] });
    assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'equipe-respondeu');
    assert.equal(a.sofias.length + a.publicas.length + a.notas.length, 0);
  }
});

test('LIGADO: a Sofia já gravou (consulta, Pix) e a resposta não pode sair → a equipe é avisada, nunca silêncio', async () => {
  const acoes = [{ tool: 'agendar_consulta', args: { data: '2026-11-17', hora: '09:00' } }, { tool: 'gerar_sinal_pix', args: {} }];
  // 1) a conversa mudou enquanto ela pensava
  const a = portas({ estado: 'ligado', depois: [msg(0, 'oi, quanto custa?'), msg(0, 'ok')], sofia: { acoes, pix: 'PIX' } });
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'mudou');
  assert.equal(a.publicas.length, 0);
  assert.match(a.notas[0]!.texto, /^⚠ A Sofia agiu mas a resposta ao paciente NÃO saiu \(a conversa mudou enquanto ela pensava\)/);
  assert.match(a.notas[0]!.texto, /• agendar_consulta/);
  // 2) o modelo não escreveu a resposta (texto vazio): o Pix gerado não vai sozinho, sem contexto
  const b = portas({ estado: 'ligado', sofia: { resposta: '', acoes, pix: 'PIX' } });
  assert.equal(await rodarSofia(M, b.p, novaMemoriaDaIa()), 'sem-texto');
  assert.equal(b.publicas.length, 0);
  assert.match(b.notas[0]!.texto, /o modelo não escreveu a resposta/);
  // 3) o Chatwoot recusa a mensagem: nota para a equipe e o erro sobe (vira log)
  const c = portas({ estado: 'ligado', sofia: { acoes } });
  c.p.publica = async () => {
    throw new Error('Chatwoot 500');
  };
  await assert.rejects(() => rodarSofia(M, c.p, novaMemoriaDaIa()), /Chatwoot 500/);
  assert.match(c.notas[0]!.texto, /o Chatwoot recusou a mensagem/);
  // sem ferramenta que gravou, a conversa que mudou não gera alerta (a próxima rodada responde)
  const d = portas({ estado: 'ligado', depois: [msg(0, 'oi, quanto custa?'), msg(0, 'ok')] });
  assert.equal(await rodarSofia(M, d.p, novaMemoriaDaIa()), 'mudou');
  assert.equal(d.notas.length, 0);
});

test('assinatura da conversa: conta as públicas e olha o id da última (nota privada e atividade não contam)', () => {
  const base = [msg(0, 'oi', { id: 1 }), msg(1, 'Olá', { id: 2 })];
  assert.equal(assinaturaDaConversa(base), '2|2');
  assert.equal(assinaturaDaConversa([...base, msg(1, 'nota', { id: 3, private: true }), msg(2, 'atribuído', { id: 4 })]), '2|2');
  assert.notEqual(assinaturaDaConversa([...base, msg(0, 'ok', { id: 5 })]), assinaturaDaConversa(base));
  // mesmo tamanho e mesmo texto, outro id: mudou
  assert.notEqual(assinaturaDaConversa([msg(0, 'oi', { id: 1 }), msg(1, 'Olá', { id: 9 })]), assinaturaDaConversa(base));
});

test('uma rodada por conversa por vez: se a anterior ainda roda, a nova espera e tenta de novo', async () => {
  const a = portas({ estado: 'ligado' });
  const mem = novaMemoriaDaIa();
  mem.emAndamento.add(12);
  assert.equal(await rodarSofia(M, a.p, mem), 'ocupada');
  assert.equal(a.sofias.length, 0);
  // pelo temporizador: ocupada → agenda de novo
  await aoChegar(M, a.p, mem);
  a.agendados.at(-1)!.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(a.agendados.at(-1)!.ms, REPETE_SE_OCUPADA_MS);
  // acabou a anterior: roda
  mem.emAndamento.delete(12);
  assert.equal(await rodarSofia(M, a.p, mem), 'enviada');
  assert.equal(mem.emAndamento.size, 0, 'libera a conversa no fim');
});

test('Sofia que falha (modelo fora do ar) não deixa nada e não manda nada', async () => {
  const a = portas({ estado: 'ligado' });
  a.p.sofia = async () => null;
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'falhou');
  assert.equal(a.publicas.length + a.notas.length, 0);
});

test('Sofia: não roda se a equipe respondeu por último; teto por dia', async () => {
  const a = portas({ mensagens: [msg(0, 'oi'), msg(1, 'Olá!')] });
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'equipe-respondeu');
  assert.equal(a.sofias.length, 0);
  const b = portas();
  const mem = novaMemoriaDaIa();
  mem.rodadas.set('doutor-hernia-parauapebas|2026-11-12', TETO_SOFIA_POR_DIA);
  assert.equal(await rodarSofia(M, b.p, mem), 'teto');
  assert.equal(b.sofias.length, 0);
  mem.rodadas.set('doutor-hernia-parauapebas|2026-11-12', TETO_SOFIA_POR_DIA - 1);
  assert.equal(await rodarSofia(M, b.p, mem), 'nota');
});
