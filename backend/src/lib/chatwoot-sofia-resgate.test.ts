/**
 * Lead em «Perdido» que volta a escrever: a Sofia atende como RESGATE (sabe que ele foi dado como perdido, não recomeça do zero) e a conversa
 * sai de «Perdido» para «Resgate». Motivos que ficam com a equipe, desligar por env e quem não está em «Perdido» seguem EXATAMENTE como antes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { ETAPA_RESGATE, falouDeLuto, gravarEtapaDoResgate, MARCA_DO_RESGATE, preambuloDoChatwoot, recusouDeVez, resgateDaConversa, rodarSofiaDoChatwoot as rodarSofiaReal, type ConversaLida, type PortaDoChatwoot } from './chatwoot-sofia.js';

/** a chave `chatwoot-sofia-resgate` LIGADA (os testes de «só no papel» e «desligada» passam a sua) */
const rodarSofiaDoChatwoot = (p: Parameters<typeof rodarSofiaReal>[0], d: Parameters<typeof rodarSofiaReal>[1]) => rodarSofiaReal(p, { resgate: 'ligado', ...d });

const unidade = { id: 'u', slug: 'doutor-hernia-parauapebas', name: 'Doutor Hérnia Parauapebas', category: 'saude', sourceProdutos: 'Consulta: R$ 350 no dia, ou R$ 250 com pagamento antecipado.', systemPrompt: '' } as unknown as Unit;
const lida = (attrs: Record<string, unknown>): ConversaLida => ({ id: 5, nome: 'Maria', telefone: '+5594999990000', attrs, etiquetas: [], grupo: false, interno: false });

function chat(etapas = ['Novo lead', 'Sofia qualifica', 'Resgate', 'Perdido', 'Frio']) {
  const gravados: Array<Record<string, unknown>> = [];
  const c: PortaDoChatwoot = {
    conversa: async () => null,
    gravarAtributos: async (_i, a) => void gravados.push(a),
    adicionarEtiquetas: async () => {},
    nota: async () => {},
    publica: async () => ({ usuario: null }),
    valoresDoAtributo: async (k) => (k === 'etapa' ? etapas : []),
    etiquetasDaConta: async () => [],
  };
  return { c, gravados };
}

function rodar(attrs: Record<string, unknown>, modo: 'seco' | 'ligado', ch = chat()) {
  const preambulos: string[] = [];
  const deps = {
    rodarTeste: (async (_u: Unit, _f: unknown, opts: any) => {
      preambulos.push(opts.preambulo);
      return { ok: true as const, reply: 'Oi, que bom te ver por aqui!', actions: [], timeline: [], meta: { base: 'vivo' as const, model: 'x', iterations: 1, totalLatencyMs: 1, tokens: null, costUsd: null } };
    }) as never,
  };
  return rodarSofiaDoChatwoot({ unit: unidade, falas: [{ role: 'user', content: 'oi, voltei' }], conversa: 5, modo, lida: lida(attrs), chat: ch.c }, deps).then((r) => ({ r: r!, preambulos, ch }));
}

test('resgateDaConversa: só quem está em «Perdido»; motivos que ficam com a equipe e o env CHATWOOT_SOFIA_RESGATE=0 desligam', () => {
  assert.deepEqual(resgateDaConversa({ etapa: 'Perdido', motivo_nao_agendamento: 'Não interagiu' }), { motivo: 'Não interagiu', mover: true, devolver: false });
  assert.deepEqual(resgateDaConversa({ etapa: 'Perdido' }), { motivo: '', mover: true, devolver: false });
  // já em «Resgate» E posta lá pela Sofia: o prompt segue valendo nas próximas mensagens, mas não há etapa a mover
  assert.deepEqual(resgateDaConversa({ etapa: 'Resgate', [MARCA_DO_RESGATE]: 'sim', motivo_nao_agendamento: 'Não interagiu' }), { motivo: 'Não interagiu', mover: false, devolver: true });
  for (const etapa of ['', 'Novo lead', 'Sofia qualifica', 'Frio', 'Agendado']) assert.equal(resgateDaConversa({ etapa, motivo_nao_agendamento: 'Não interagiu' }), null, etapa);
  assert.equal(resgateDaConversa({ etapa: 'Perdido', motivo_nao_agendamento: 'Não interagiu' }, { CHATWOOT_SOFIA_RESGATE: '0' }), null);
});

test('«Resgate» é etapa de TRABALHO da equipe: a conversa que a equipe pôs lá à mão (sem a marca da Sofia) NÃO ganha o «foi dada como Perdido»', async () => {
  assert.equal(resgateDaConversa({ etapa: 'Resgate', motivo_nao_agendamento: 'Não interagiu' }), null);
  assert.equal(resgateDaConversa({ etapa: 'Resgate', [MARCA_DO_RESGATE]: 'nao', motivo_nao_agendamento: 'Não interagiu' }), null, 'a Sofia devolveu a «Perdido» e a equipe pôs em «Resgate» depois');
  const { r, preambulos, ch } = await rodar({ etapa: 'Resgate', motivo_nao_agendamento: 'Não interagiu' }, 'ligado');
  assert.doesNotMatch(preambulos[0]!, /RESGATE/);
  assert.ok(!r.resgatar && !r.devolverAPerdido);
  assert.equal(ch.gravados.length, 0);
});

// UM teste por motivo: a lista de motivos mortos que a casa já usa (`motivos-mortos.ts`, os 5 do João de 06/11 + os de risco) e os que são da equipe
const MORTOS_DA_CASA = ['Outra cidade', 'Mora em outra cidade', 'Clicou por engano', 'Outra patologia', 'Plano de Saúde', 'Sem interesse', 'Bandeira vermelha', 'Financeiramente vulnerável', 'Assinou contrato', 'Caso enviado para a franquia', 'Informação para terceiro'];
const DA_EQUIPE_NO_CRM = ['Cancelamento de tratamento', 'Currículo', 'Fornecedor/propaganda', 'Não perturbar', 'Lead morto'];
for (const motivo of [...MORTOS_DA_CASA, ...DA_EQUIPE_NO_CRM]) {
  test(`motivo «${motivo}»: caso encerrado ou da equipe — NÃO é resgate (sem prompt, sem mexer na etapa)`, async () => {
    assert.equal(resgateDaConversa({ etapa: 'Perdido', motivo_nao_agendamento: motivo }), null);
    const { r, preambulos, ch } = await rodar({ etapa: 'Perdido', motivo_nao_agendamento: motivo }, 'ligado');
    assert.doesNotMatch(preambulos[0]!, /RESGATE/);
    assert.ok(!r.resgatar);
    assert.equal(ch.gravados.length, 0);
  });
}

test('motivo que SEGUE em resgate: o que a régua e a SDR marcam e não é caso encerrado; grafias da conta que variam continuam fora', () => {
  for (const m of ['Não interagiu', 'Não deu continuidade', 'Vai se organizar', 'Achou caro', 'Sem condições', 'Viajando', 'Decidir com a família', 'Solicitado exames']) {
    assert.notEqual(resgateDaConversa({ etapa: 'Perdido', motivo_nao_agendamento: m }), null, m);
  }
  // grafias da conta que variam: espaço duplo, crase, complemento
  for (const m of ['Bandeira  vermelha', 'Caso enviado à franquia', 'Currículo / vaga', 'bandeira vermelha (urgência)', 'Plano de saúde (Unimed)', 'OUTRA CIDADE']) assert.equal(resgateDaConversa({ etapa: 'Perdido', motivo_nao_agendamento: m }), null, m);
});

test('recusouDeVez: «não quero mais», «pare de me mandar», «não tenho interesse» recusam; objeção («agora não», «tá caro») e «voltei» não', () => {
  const u = (content: string): Array<{ role: 'user' | 'assistant'; content: string }> => [{ role: 'assistant', content: 'Oi!' }, { role: 'user', content }];
  for (const f of ['não quero mais', 'Não quero', 'pare de me mandar mensagem', 'não tenho interesse', 'já resolvi, pode encerrar']) assert.equal(recusouDeVez(u(f)), true, f);
  for (const f of ['oi, voltei', 'agora não, tá caro', 'quero marcar', 'vou ver e te falo']) assert.equal(recusouDeVez(u(f)), false, f);
});

test('LIGADO: o lead «Perdido» que voltou é atendido como resgate (prompt) e a conversa passa para «Resgate»', async () => {
  const { r, preambulos, ch } = await rodar({ etapa: 'Perdido', motivo_nao_agendamento: 'Não interagiu' }, 'ligado');
  assert.match(preambulos[0]!, /RESGATE: esta conversa foi dada como «Perdido» \(motivo registrado: Não interagiu\)/);
  // no ligado quem envia a resposta grava a etapa, DEPOIS de ela sair: a rodada só sinaliza (nada gravado aqui)
  assert.equal(r.resgatar, true);
  assert.deepEqual(ch.gravados, []);
  assert.deepEqual(r.acoes, []);
});

test('SECO: o mesmo prompt de resgate, a etapa só aparece como ação (nada gravado)', async () => {
  const { r, preambulos, ch } = await rodar({ etapa: 'Perdido', motivo_nao_agendamento: 'Não interagiu' }, 'seco');
  assert.match(preambulos[0]!, /RESGATE/);
  assert.equal(ch.gravados.length, 0);
  assert.equal(r.acoes[0]!.tool, 'mover_etapa');
  assert.ok(!r.resgatar);
});

test('conta sem a etapa «Resgate»: o prompt de resgate vale e a etapa não é inventada', async () => {
  const { r, ch } = await rodar({ etapa: 'Perdido', motivo_nao_agendamento: 'Não interagiu' }, 'ligado', chat(['Novo lead', 'Perdido']));
  assert.equal(ch.gravados.length, 0);
  assert.deepEqual(r.acoes, []);
  assert.ok(!r.resgatar);
});

test('motivo que fica com a equipe: a Sofia segue como sempre (sem resgate, sem mexer na etapa)', async () => {
  const { r, preambulos, ch } = await rodar({ etapa: 'Perdido', motivo_nao_agendamento: 'Bandeira vermelha' }, 'ligado');
  assert.doesNotMatch(preambulos[0]!, /RESGATE/);
  assert.equal(ch.gravados.length, 0);
  assert.deepEqual(r.acoes, []);
  assert.ok(!r.resgatar);
});

test('quem NÃO está em «Perdido» fica byte a byte como antes: o preâmbulo não ganha nada, «Novo lead» vai para «Sofia qualifica»', async () => {
  const base = { modo: 'ligado' as const, unitNome: 'Doutor Hérnia Parauapebas', telefone: '+5594999990000' };
  assert.equal(preambuloDoChatwoot(base), preambuloDoChatwoot({ ...base, resgate: null }));
  assert.doesNotMatch(preambuloDoChatwoot(base), /RESGATE/);
  const { r, ch } = await rodar({ etapa: 'Novo lead' }, 'ligado');
  assert.ok(!r.resgatar);
  assert.deepEqual(ch.gravados, [{ etapa: 'Sofia qualifica' }]);
  assert.deepEqual(r.acoes, [{ tool: 'mover_etapa', args: { etapa: 'Sofia qualifica', automatico: true } }]);
});

test('o modelo mexeu na etapa para «Frio»: o resgate automático NÃO passa por cima', async () => {
  const ch = chat();
  const r = await rodarSofiaDoChatwoot(
    { unit: unidade, falas: [{ role: 'user', content: 'não quero mais' }], conversa: 5, modo: 'ligado', lida: lida({ etapa: 'Perdido', motivo_nao_agendamento: 'Não interagiu' }), chat: ch.c },
    {
      rodarTeste: (async (_u: Unit, _f: unknown, opts: any) => {
        const tools = opts.ferramentas({ onCall: () => undefined, tz: 'America/Belem' }) as Array<{ name: string; invoke: (x: unknown) => Promise<string> }>;
        await tools.find((t) => t.name === 'mover_etapa')!.invoke({ etapa: 'Frio' });
        return { ok: true as const, reply: 'Tudo bem, fico à disposição!', actions: [], timeline: [], meta: { base: 'vivo' as const, model: 'x', iterations: 1, totalLatencyMs: 1, tokens: null, costUsd: null } };
      }) as never,
      ferramentas: { construirAgenda: () => ({}) as never, contaDividida: async () => null, grade: async () => ({ erro: null, slots: [] }), consulta: async () => null },
    },
  );
  assert.ok(!r!.resgatar);
  assert.deepEqual(ch.gravados, [{ etapa: 'Frio' }]);
});

test('já em «Resgate» posta pela Sofia: o «VOLTOU a escrever… reconheça» NÃO se repete nas próximas rodadas (só na 1ª, em «Perdido») e não há etapa a mover', async () => {
  const { r, preambulos, ch } = await rodar({ etapa: 'Resgate', [MARCA_DO_RESGATE]: 'sim', motivo_nao_agendamento: 'Não interagiu' }, 'ligado');
  assert.doesNotMatch(preambulos[0]!, /RESGATE|VOLTOU/);
  const primeira = await rodar({ etapa: 'Perdido', motivo_nao_agendamento: 'Não interagiu' }, 'ligado');
  assert.match(primeira.preambulos[0]!, /RESGATE.*VOLTOU/);
  assert.ok(!r.resgatar);
  assert.equal(ch.gravados.length, 0);
});

// ── recusa: fica em «Perdido» (ou volta para ele) ──────────────────────────────────────────────────

test('«não quero mais» (a Sofia só respondeu, sem mover_etapa): NÃO vai para «Resgate» — fica em «Perdido»', async () => {
  const ch = chat();
  const r = await rodarSofiaDoChatwoot(
    { unit: unidade, falas: [{ role: 'assistant', content: 'Oi!' }, { role: 'user', content: 'não quero mais' }], conversa: 5, modo: 'ligado', lida: lida({ etapa: 'Perdido', motivo_nao_agendamento: 'Não interagiu' }), chat: ch.c },
    { rodarTeste: (async () => ({ ok: true as const, reply: 'Tudo bem, fico à disposição!', actions: [], timeline: [], meta: { base: 'vivo' as const, model: 'x', iterations: 1, totalLatencyMs: 1, tokens: null, costUsd: null } })) as never },
  );
  assert.ok(!r!.resgatar);
  assert.ok(!r!.devolverAPerdido);
  assert.deepEqual(r!.acoes, []);
  assert.deepEqual(ch.gravados, []);
  // e a mesma conversa, quando o paciente NÃO recusa, vai para «Resgate»
  const { r: ok } = await rodar({ etapa: 'Perdido', motivo_nao_agendamento: 'Não interagiu' }, 'ligado');
  assert.equal(ok.resgatar, true);
});

test('quem a Sofia pôs em «Resgate» e agora recusa de vez («pare de me mandar»): volta para «Perdido»; sem a marca da Sofia, não mexe; no seco só anota', async () => {
  const rodarRecusa = (attrs: Record<string, unknown>, modo: 'seco' | 'ligado') =>
    rodarSofiaDoChatwoot(
      { unit: unidade, falas: [{ role: 'assistant', content: 'Oi!' }, { role: 'user', content: 'pare de me mandar mensagem' }], conversa: 5, modo, lida: lida(attrs), chat: chat().c },
      { rodarTeste: (async () => ({ ok: true as const, reply: 'Combinado, não escrevo mais.', actions: [], timeline: [], meta: { base: 'vivo' as const, model: 'x', iterations: 1, totalLatencyMs: 1, tokens: null, costUsd: null } })) as never },
    );
  const base = { etapa: 'Resgate', motivo_nao_agendamento: 'Não interagiu' };
  assert.equal((await rodarRecusa({ ...base, [MARCA_DO_RESGATE]: 'sim' }, 'ligado'))!.devolverAPerdido, true);
  assert.ok(!(await rodarRecusa(base, 'ligado'))!.devolverAPerdido, 'Resgate que a equipe pôs: a Sofia não mexe');
  const seco = (await rodarRecusa({ ...base, [MARCA_DO_RESGATE]: 'sim' }, 'seco'))!;
  assert.ok(!seco.devolverAPerdido);
  assert.deepEqual(seco.acoes, [{ tool: 'mover_etapa', args: { etapa: 'Perdido', de: 'Resgate', automatico: true } }]);
});

test('o modelo marcou «Perdido» DE NOVO (a etapa não muda, mas a decisão é dele): o resgate automático NÃO passa por cima — a guarda `etapaMexida`', async () => {
  const gravados: Array<Record<string, unknown>> = [];
  const c: PortaDoChatwoot = { ...chat().c, gravarAtributos: async (_i, a) => void gravados.push(a), valoresDoAtributo: async (k) => (k === 'etapa' ? ['Novo lead', 'Sofia qualifica', 'Resgate', 'Perdido', 'Frio'] : k === 'motivo_nao_agendamento' ? ['Não interagiu', 'Sem interesse'] : []) };
  const r = await rodarSofiaDoChatwoot(
    { unit: unidade, falas: [{ role: 'user', content: 'oi, voltei' }], conversa: 5, modo: 'ligado', lida: lida({ etapa: 'Perdido', motivo_nao_agendamento: 'Não interagiu' }), chat: c },
    {
      rodarTeste: (async (_u: Unit, _f: unknown, opts: any) => {
        const tools = opts.ferramentas({ onCall: () => undefined, tz: 'America/Belem' }) as Array<{ name: string; invoke: (x: unknown) => Promise<string> }>;
        const out = await tools.find((t) => t.name === 'mover_etapa')!.invoke({ etapa: 'Perdido', motivo_nao_agendamento: 'Não interagiu' });
        assert.match(out, /Etapa → Perdido/);
        return { ok: true as const, reply: 'Entendi, fico à disposição.', actions: [], timeline: [], meta: { base: 'vivo' as const, model: 'x', iterations: 1, totalLatencyMs: 1, tokens: null, costUsd: null } };
      }) as never,
      ferramentas: { construirAgenda: () => ({}) as never, contaDividida: async () => null, grade: async () => ({ erro: null, slots: [] }), consulta: async () => null },
    },
  );
  assert.ok(!r!.resgatar, 'a Sofia decidiu «Perdido» nesta rodada: o resgate não desfaz');
  assert.deepEqual(gravados, [{ etapa: 'Perdido', motivo_nao_agendamento: 'Não interagiu' }]);
});

// ── quem grava é quem envia ────────────────────────────────────────────────────────────────────────
import { novaMemoriaDaIa, rodarSofia, type PortasDaIa } from './chatwoot-ia.js';

function portas(o: { resposta?: string; resgatar?: boolean; devolver?: boolean; etapaDepois?: string; publicaFalha?: boolean; gravarFalha?: boolean }) {
  const etapas: string[] = [];
  const opcoesDeGravar: Array<{ semFollowUp?: boolean } | undefined> = [];
  const publicas: string[] = [];
  const notas: string[] = [];
  let leituras = 0;
  const p: PortasDaIa = {
    estado: () => 'ligado',
    unidade: async () => unidade,
    mensagens: async () => [{ message_type: 0, content: 'oi, voltei', private: false }],
    nota: async (_c, t) => void notas.push(t),
    publica: async (_c, t) => {
      if (o.publicaFalha) throw new Error('chatwoot 500');
      publicas.push(t);
      return { usuario: 3 };
    },
    agendaReal: async () => [],
    passarParaEquipe: async () => {},
    transcrever: async () => '',
    conversa: async () => lida({ etapa: leituras++ > 0 && o.etapaDepois ? o.etapaDepois : 'Perdido', motivo_nao_agendamento: 'Não interagiu' }),
    cartaoNoKommo: async () => null,
    sofia: async () => ({ resposta: o.resposta ?? 'Oi, que bom te ver por aqui!', acoes: [], pix: null, cartao: null, passouParaEquipe: false, resgatar: o.resgatar ?? !o.devolver, devolverAPerdido: o.devolver ?? false }),
    agendar: (fn) => fn,
    cancelar: () => {},
    hoje: () => '2026-11-26',
    gravarEtapa: async (_c, e, opcoes) => {
      opcoesDeGravar.push(opcoes);
      if (o.gravarFalha) throw new Error('chatwoot 500');
      etapas.push(e);
    },
  };
  return { p, etapas, publicas, notas, opcoesDeGravar };
}
const M = { conversa: 5, caixa: 2, slug: 'doutor-hernia-parauapebas', audios: [] as string[] };

test('LIGADO: a conversa vai para «Resgate» DEPOIS de a resposta sair, e a nota mostra a mudança', async () => {
  const a = portas({});
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'enviada');
  assert.deepEqual(a.publicas, ['Oi, que bom te ver por aqui!']);
  assert.deepEqual(a.etapas, ['Resgate']);
  assert.match(a.notas.join('\n'), /mover_etapa — etapa: Resgate · de: Perdido · automatico: true/);
});

test('LIGADO: resposta que não saiu (Chatwoot recusou, vazia) ou conversa que a equipe mexeu enquanto ela pensava NÃO tira ninguém de «Perdido»', async () => {
  const falha = portas({ publicaFalha: true });
  await assert.rejects(() => rodarSofia(M, falha.p, novaMemoriaDaIa()));
  assert.deepEqual(falha.etapas, []);
  const vazia = portas({ resposta: '' });
  assert.equal(await rodarSofia(M, vazia.p, novaMemoriaDaIa()), 'sem-texto');
  assert.deepEqual(vazia.etapas, []);
  const equipe = portas({ etapaDepois: 'Esperando humano' });
  assert.equal(await rodarSofia(M, equipe.p, novaMemoriaDaIa()), 'mudou');
  assert.deepEqual(equipe.etapas, []);
});

test('LIGADO: etapa mudou para outra coisa (a equipe pôs «Frio») entre a leitura e o envio: não grava «Resgate»; falha ao gravar não derruba a resposta', async () => {
  const frio = portas({ etapaDepois: 'Frio' });
  assert.equal(await rodarSofia(M, frio.p, novaMemoriaDaIa()), 'enviada');
  assert.deepEqual(frio.etapas, []);
  const quebra = portas({ gravarFalha: true });
  assert.equal(await rodarSofia(M, quebra.p, novaMemoriaDaIa()), 'enviada');
  assert.deepEqual(quebra.publicas, ['Oi, que bom te ver por aqui!']);
});

test('LIGADO: quem a Sofia pôs em «Resgate» e recusou volta para «Perdido» DEPOIS de a resposta sair; se a equipe já mexeu, não grava', async () => {
  const a = portas({ devolver: true, etapaDepois: 'Resgate' });
  assert.equal(await rodarSofia(M, a.p, novaMemoriaDaIa()), 'enviada');
  assert.deepEqual(a.etapas, ['Perdido']);
  assert.deepEqual(a.opcoesDeGravar, [{ semFollowUp: true }], 'volta para «Perdido» COM sem-follow-up');
  assert.match(a.notas.join('\n'), /mover_etapa — etapa: Perdido · de: Resgate · automatico: true/);
  const mexeu = portas({ devolver: true, etapaDepois: 'Frio' });
  assert.equal(await rodarSofia(M, mexeu.p, novaMemoriaDaIa()), 'enviada');
  assert.deepEqual(mexeu.etapas, []);
});

// ── review do /code-review high (rodada 2) ─────────────────────────────────────────────────────────

test('«Resgate» da Sofia SEM motivo registrado: a recusa também devolve a «Perdido» (o motivo vazio não segura a volta)', async () => {
  const r = await rodarSofiaDoChatwoot(
    { unit: unidade, falas: [{ role: 'assistant', content: 'Oi!' }, { role: 'user', content: 'pare de me mandar mensagem' }], conversa: 5, modo: 'ligado', lida: lida({ etapa: 'Resgate', [MARCA_DO_RESGATE]: 'sim' }), chat: chat().c },
    { rodarTeste: (async () => ({ ok: true as const, reply: 'Combinado.', actions: [], timeline: [], meta: { base: 'vivo' as const, model: 'x', iterations: 1, totalLatencyMs: 1, tokens: null, costUsd: null } })) as never },
  );
  assert.equal(r!.devolverAPerdido, true);
});

test('luto/óbito NÃO é recusa e não anda a etapa: nem vai para «Resgate», nem volta a «Perdido»', async () => {
  const falas = [{ role: 'assistant' as const, content: 'Oi!' }, { role: 'user' as const, content: 'não vou poder, minha mãe faleceu' }];
  assert.equal(falouDeLuto(falas), true);
  assert.equal(recusouDeVez(falas), false);
  const modeloOk = { rodarTeste: (async () => ({ ok: true as const, reply: 'Sinto muito.', actions: [], timeline: [], meta: { base: 'vivo' as const, model: 'x', iterations: 1, totalLatencyMs: 1, tokens: null, costUsd: null } })) as never };
  const perdido = await rodarSofiaDoChatwoot({ unit: unidade, falas, conversa: 5, modo: 'ligado', lida: lida({ etapa: 'Perdido', motivo_nao_agendamento: 'Não interagiu' }), chat: chat().c }, modeloOk);
  assert.ok(!perdido!.resgatar);
  const resgate = await rodarSofiaDoChatwoot({ unit: unidade, falas, conversa: 5, modo: 'ligado', lida: lida({ etapa: 'Resgate', [MARCA_DO_RESGATE]: 'sim', motivo_nao_agendamento: 'Não interagiu' }), chat: chat().c }, modeloOk);
  assert.ok(!resgate!.devolverAPerdido);
});

test('«não» seco em «Resgate» (resposta a uma pergunta da Sofia) NÃO devolve a «Perdido»; em «Perdido» o «não» seco segura o resgate (lado seguro)', async () => {
  const falas = [{ role: 'assistant' as const, content: 'Você chegou a fazer fisioterapia?' }, { role: 'user' as const, content: 'não' }];
  assert.equal(recusouDeVez(falas), true, 'quem acabou de voltar de «Perdido» e diz «não»: não vira resgate');
  assert.equal(recusouDeVez(falas, true), false, 'mas em «Resgate» o «não» seco não desfaz a conversa');
  assert.equal(recusouDeVez([{ role: 'assistant', content: 'Oi' }, { role: 'user', content: 'não quero mais' }], true), true);
  assert.equal(recusouDeVez([{ role: 'assistant', content: 'Oi' }, { role: 'user', content: 'pare de me mandar' }], true), true);
});

// ── senior rodada 2 (#477) ─────────────────────────────────────────────────────────────────────────

test('«pare de me mandar» volta a «Perdido» COM a etiqueta sem-follow-up ANTES da etapa (a régua não manda as de 48/96/120 h); ida para «Resgate» não põe etiqueta', async () => {
  const ordem: string[] = [];
  const c: PortaDoChatwoot = { ...chat().c, adicionarEtiquetas: async (_i, e) => void ordem.push(`etiqueta:${e.join(',')}`), gravarAtributos: async (_i, a) => void ordem.push(`atributos:${JSON.stringify(a)}`) };
  await gravarEtapaDoResgate(c, 5, 'Perdido', { semFollowUp: true });
  assert.deepEqual(ordem, ['etiqueta:sem-follow-up', `atributos:${JSON.stringify({ etapa: 'Perdido', [MARCA_DO_RESGATE]: 'nao' })}`]);
  ordem.length = 0;
  await gravarEtapaDoResgate(c, 5, 'Resgate');
  assert.deepEqual(ordem, [`atributos:${JSON.stringify({ etapa: 'Resgate', [MARCA_DO_RESGATE]: 'sim' })}`]);
});

test('a CHAVE da unidade: desligada = a Sofia de sempre; «só no papel» (o padrão) = nem prompt novo nem etapa mexida (só anota); ligada = o resgate', async () => {
  const mudanca = { etapa: 'Perdido', motivo_nao_agendamento: 'Não interagiu' };
  for (const chave of ['desligado', 'seco'] as const) {
    const ch = chat();
    const preambulos: string[] = [];
    const r = await rodarSofiaReal(
      { unit: unidade, falas: [{ role: 'user', content: 'oi, voltei' }], conversa: 5, modo: 'ligado', lida: lida(mudanca), chat: ch.c },
      { resgate: chave, rodarTeste: (async (_u: Unit, _f: unknown, opts: any) => (preambulos.push(opts.preambulo), { ok: true as const, reply: 'Oi!', actions: [], timeline: [], meta: { base: 'vivo' as const, model: 'x', iterations: 1, totalLatencyMs: 1, tokens: null, costUsd: null } })) as never },
    );
    assert.doesNotMatch(preambulos[0]!, /RESGATE/, chave);
    assert.ok(!r!.resgatar && !r!.devolverAPerdido, chave);
    assert.deepEqual(ch.gravados, [], chave);
    assert.deepEqual(r!.acoes, [], chave);
  }
  const ligada = await rodar(mudanca, 'ligado');
  assert.match(ligada.preambulos[0]!, /RESGATE/);
  assert.equal(ligada.r.resgatar, true);
  // sem a chave nos testes (nem env): o padrão do catálogo é «só no papel»
  const padrao = await rodarSofiaReal(
    { unit: unidade, falas: [{ role: 'user', content: 'oi, voltei' }], conversa: 5, modo: 'ligado', lida: lida(mudanca), chat: chat().c },
    { rodarTeste: (async () => ({ ok: true as const, reply: 'Oi!', actions: [], timeline: [], meta: { base: 'vivo' as const, model: 'x', iterations: 1, totalLatencyMs: 1, tokens: null, costUsd: null } })) as never },
  );
  assert.ok(!padrao!.resgatar);
});

test('marca velha: a conversa que NÃO está mais em «Resgate» mas ainda diz «sim» é limpa na próxima rodada; em «Resgate» a marca fica', async () => {
  const gravados: Array<Record<string, unknown>> = [];
  const c: PortaDoChatwoot = { ...chat().c, gravarAtributos: async (_i, a) => void gravados.push(a) };
  const falas = [{ role: 'user' as const, content: 'oi' }];
  const modeloOk = { rodarTeste: (async () => ({ ok: true as const, reply: 'Oi!', actions: [], timeline: [], meta: { base: 'vivo' as const, model: 'x', iterations: 1, totalLatencyMs: 1, tokens: null, costUsd: null } })) as never };
  await rodarSofiaDoChatwoot({ unit: unidade, falas, conversa: 5, modo: 'ligado', lida: lida({ etapa: 'Agendado', [MARCA_DO_RESGATE]: 'sim' }), chat: c }, modeloOk);
  assert.deepEqual(gravados, [{ [MARCA_DO_RESGATE]: 'nao' }]);
  gravados.length = 0;
  await rodarSofiaDoChatwoot({ unit: unidade, falas, conversa: 5, modo: 'ligado', lida: lida({ etapa: 'Resgate', [MARCA_DO_RESGATE]: 'sim', motivo_nao_agendamento: 'Não interagiu' }), chat: c }, modeloOk);
  assert.deepEqual(gravados, []);
  // quem a equipe pôs em «Resgate» depois (marca «nao» ou sem marca) não ganha o prompt
  assert.equal(resgateDaConversa({ etapa: 'Resgate', [MARCA_DO_RESGATE]: 'nao' }), null);
});

// a porta REAL (com um Chatwoot de mentira): toda gravação de etapa limpa a marca, inclusive marcar consulta
test('porta real: marcar consulta («Agendado»), «Sofia qualifica» e qualquer outra etapa gravada limpam a marca «sim» na MESMA gravação; campo comum e a própria marca não', async () => {
  const { portaDoChatwoot } = await import('./chatwoot-porta.js');
  const { criarContextoChatwoot } = await import('../mcp-remoto/chatwoot.js');
  let atuais: Record<string, unknown> = { etapa: 'Resgate', [MARCA_DO_RESGATE]: 'sim', queixa: 'x' };
  const gravado: Array<Record<string, unknown>> = [];
  const fetchFalso = (async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST' && String(url).endsWith('/custom_attributes')) {
      const attrs = JSON.parse(init.body!).custom_attributes as Record<string, unknown>;
      gravado.push(attrs);
      atuais = attrs;
      return { ok: true, status: 200, text: async () => '{}' };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ id: 5, labels: [], meta: { sender: { name: 'M', phone_number: '+5594999990000' } }, custom_attributes: atuais }) };
  }) as unknown as typeof fetch;
  const porta = portaDoChatwoot(criarContextoChatwoot({ url: 'https://crm.exemplo', conta: 1, token: 'segredo-de-teste' }, { fetch: fetchFalso }));
  await porta.gravarAtributos(5, { qualificacao: 'Quente' });
  assert.equal(gravado.at(-1)![MARCA_DO_RESGATE], 'sim', 'campo comum não mexe na marca');
  await porta.gravarAtributos(5, { data_consulta: '2026-12-01', hora_consulta: '09:00', situacao_consulta: 'Agendado', etapa: 'Agendado' });
  assert.equal(gravado.at(-1)![MARCA_DO_RESGATE], 'nao', 'marcou consulta: a etapa saiu de «Resgate», a marca sai junto');
  assert.equal(gravado.at(-1)!.etapa, 'Agendado');
  atuais = { etapa: 'Resgate', [MARCA_DO_RESGATE]: 'sim' };
  await porta.gravarAtributos(5, { etapa: 'Resgate', [MARCA_DO_RESGATE]: 'sim' });
  assert.equal(gravado.at(-1)![MARCA_DO_RESGATE], 'sim', 'quem grava a marca junto decide: o resgate da Sofia a mantém');
  await porta.gravarAtributos(5, { etapa: 'Sofia qualifica' });
  assert.equal(gravado.at(-1)![MARCA_DO_RESGATE], 'nao');
  atuais = { etapa: 'Perdido' };
  await porta.gravarAtributos(5, { etapa: 'Frio' });
  assert.ok(!(MARCA_DO_RESGATE in gravado.at(-1)!), 'sem marca na conversa nada é acrescentado (Parauapebas igual a hoje)');
  // regravar a MESMA etapa (o modelo chama mover_etapa «Resgate» de novo, outro robô) não tira a marca
  atuais = { etapa: 'Resgate', [MARCA_DO_RESGATE]: 'sim' };
  await porta.gravarAtributos(5, { etapa: 'Resgate' });
  assert.equal(gravado.at(-1)![MARCA_DO_RESGATE], 'sim', 'mesma etapa: a marca fica');
});

test('sem-follow-up: se a gravação da etapa falha, a etiqueta que acabou de entrar sai (a conversa segue em «Resgate»)', async () => {
  const etiquetas: string[] = [];
  const c: PortaDoChatwoot = {
    ...chat().c,
    adicionarEtiquetas: async (_i, e) => void etiquetas.push(...e),
    removerEtiquetas: async (_i, e) => void e.forEach((x) => etiquetas.splice(etiquetas.indexOf(x), 1)),
    gravarAtributos: async () => {
      throw new Error('chatwoot 500');
    },
  };
  await assert.rejects(() => gravarEtapaDoResgate(c, 5, 'Perdido', { semFollowUp: true }), /chatwoot 500/);
  assert.deepEqual(etiquetas, [], 'a etiqueta voltou');
});

test('«só no papel» anota o que faria (e a ida e a volta têm linhas diferentes na tela), e o padrão do catálogo para esta chave é «só no papel»', async () => {
  const { estadoDaAutomacao } = await import('./automacoes-estado.js');
  assert.equal(estadoDaAutomacao('doutor-hernia-parauapebas', 'chatwoot-sofia-resgate', undefined), 'seco');
  const anotadas: Array<{ alvo: string; valor: unknown; deEtapa?: string | null }> = [];
  const simular = ((_u: unknown, id: string, sim: { alvo: string; valor: unknown; deEtapa?: string | null }) => void (assert.equal(id, 'chatwoot-sofia-resgate'), anotadas.push(sim))) as never;
  const modeloOk = (async () => ({ ok: true as const, reply: 'Oi!', actions: [], timeline: [], meta: { base: 'vivo' as const, model: 'x', iterations: 1, totalLatencyMs: 1, tokens: null, costUsd: null } })) as never;
  const ida = await rodarSofiaReal({ unit: unidade, falas: [{ role: 'user', content: 'oi, voltei' }], conversa: 5, modo: 'ligado', lida: lida({ etapa: 'Perdido', motivo_nao_agendamento: 'Não interagiu' }), chat: chat().c }, { resgate: 'seco', simular, rodarTeste: modeloOk });
  assert.ok(!ida!.resgatar);
  const volta = await rodarSofiaReal({ unit: unidade, falas: [{ role: 'assistant', content: 'Oi' }, { role: 'user', content: 'pare de me mandar' }], conversa: 5, modo: 'ligado', lida: lida({ etapa: 'Resgate', [MARCA_DO_RESGATE]: 'sim', motivo_nao_agendamento: 'Não interagiu' }), chat: chat().c }, { resgate: 'seco', simular, rodarTeste: modeloOk });
  assert.ok(!volta!.devolverAPerdido);
  assert.deepEqual(anotadas.map((a) => [a.alvo, a.deEtapa]), [['etapa → Resgate', 'Perdido'], ['etapa → Perdido', 'Resgate']]);
});
