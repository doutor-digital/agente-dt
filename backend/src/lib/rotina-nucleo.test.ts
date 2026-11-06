/**
 * Núcleo da rotina diária dos robôs (06/11/2026): travas do cartão, marca por PESSOA, aniversário puro, e o único caminho de escrita
 * (`tocar`): teto do dia, teto do papel por DIA, etiqueta inexistente, pessoa com dois cartões, falha ao pôr a etiqueta.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { KommoLead } from '../services/kommo.service.js';
import {
  AGORA,
  DIA,
  H,
  chamadas,
  ctx,
  escritas,
  extrasDoKommo,
  kommo,
  novo,
  poeMarca,
  simulacoes,
  tagsNoKommo,
  tagsPostas,
  tracos,
  zerar,
} from './rotina-teste-util.js';
import { marcasDaUnidade } from './rotina-nucleo.js';
import {
  anoDoAniversario,
  aniversarioHoje,
  aniversarioNoDia,
  cartaoMostraConsulta,
  configBase,
  diaDeNascimentoDaFicha,
  idDaMarca,
  lerMarca,
  marcasDoSilencio,
  motivoMorto,
  motivoMortoNativo,
  nascimentoDoCartao,
  pessoaDoCartao,
  porQueNaoTocar,
  resumoNovo,
  tocar,
  umPorVez,
  vagasDoDia,
  type Toque,
} from './rotina-nucleo.js';

const TZ = 'America/Sao_Paulo';
beforeEach(zerar);

/** Carrega a leitura das marcas do COMEÇO da varredura (a que o `tocar` usa antes de gravar). */
async function marcasDaUnidadeParaOTeste(c: ReturnType<typeof ctx>): Promise<void> {
  await marcasDaUnidade(c);
}

const carta = (tags: string[] = [], campos: Record<string, unknown> = {}): Pick<KommoLead, 'custom_fields_values' | '_embedded'> => ({
  custom_fields_values: Object.entries(campos).map(([nome, value], i) => ({ field_id: 9000 + i, field_name: nome, values: [{ value }] })) as KommoLead['custom_fields_values'],
  _embedded: { tags: tags.map((name, i) => ({ id: i + 1, name })) },
});
const opcoes = { agora: AGORA, tz: TZ, pausarIaFieldId: null as number | null };

// ─── configuração ─────────────────────────────────────────────────────────────────────────────────

test('o teto padrão é 30 por dia e 10 por varredura; a unidade e a rede mudam; teto absurdo é cortado', () => {
  assert.deepEqual(configBase(null, {}), { teto: 30, porVarredura: 10 });
  assert.equal(configBase({ rotina_teto_dia: 12 }, {}).teto, 12);
  assert.equal(configBase({}, { ROTINA_ROBOS_TETO_DIA: '20' }).teto, 20);
  assert.equal(configBase({ rotina_teto_dia: 12 }, { ROTINA_ROBOS_TETO_DIA: '20' }).teto, 12, 'a unidade manda por cima');
  assert.equal(configBase({ rotina_teto_dia: 99999 }, {}).teto, 500);
});

// ─── marca (por PESSOA) ───────────────────────────────────────────────────────────────────────────

test('o id da marca leva a PESSOA e a leitura pega o fim (o id da unidade pode ter hífen)', () => {
  const id = idDaMarca('u-petro-1', 'c777', 'qualificacao', 2, 1_700_000_000);
  assert.equal(id, 'rotina-u-petro-1-c777-qualificacao-2-1700000000');
  assert.deepEqual(lerMarca(id, new Date(AGORA * 1000)), { pessoa: 'c777', chave: 'qualificacao', toque: 2, em: AGORA });
  assert.equal(lerMarca('etiqueta-u-1-boas-vindas:1:2', new Date()), null, 'marca do etiquetas-auto não é daqui');
});

test('a pessoa é o contato principal: dois cartões do mesmo contato são a mesma pessoa; sem contato, o próprio cartão', () => {
  const a = novo({ contato: 4242 });
  const b = novo({ contato: 4242, etapa: [1, 143] });
  const c = novo();
  assert.equal(pessoaDoCartao(a.lead), 'c4242');
  assert.equal(pessoaDoCartao(a.lead), pessoaDoCartao(b.lead));
  assert.notEqual(pessoaDoCartao(a.lead), pessoaDoCartao(c.lead));
  assert.equal(pessoaDoCartao({ id: 9, _embedded: {} }), 'l9');
});

test('a mensagem do paciente zera a régua: marcas de ANTES da âncora não contam, e cada régua tem a sua', () => {
  const marcas = [
    { pessoa: 'c1', chave: 'qualificacao', toque: 1, em: AGORA - 10 * DIA },
    { pessoa: 'c1', chave: 'qualificacao', toque: 2, em: AGORA - 8 * DIA },
    { pessoa: 'c1', chave: 'negociacao', toque: 1, em: AGORA - 3 * DIA },
  ];
  assert.deepEqual(marcasDoSilencio(marcas, 'qualificacao', AGORA - 5 * DIA), [], 'respondeu depois dos dois toques: recomeça do 1º');
  assert.equal(marcasDoSilencio(marcas, 'negociacao', AGORA - 5 * DIA).length, 1);
});

// ─── travas do cartão ─────────────────────────────────────────────────────────────────────────────

test('travas do cartão: etiquetas de não contatar, currículo, fora do escopo e opt-out nunca recebem', () => {
  for (const tag of ['NO_FOLLOW_UP', 'NAO_PERTURBAR', 'BLOQUEADO_WHATSAPP', 'CURRÍCULO', 'Fora do escopo', 'Fluxo · Opt-out WhatsApp']) {
    assert.equal(porQueNaoTocar(carta([tag]), opcoes)?.codigo, 'nao-contatar', tag);
  }
  assert.equal(porQueNaoTocar(carta([], { '✓ Opt-out WhatsApp': 'Sim' }), opcoes)?.codigo, 'opt-out');
  assert.equal(porQueNaoTocar(carta(['LOMBAR']), opcoes), null, 'etiqueta qualquer não trava');
});

test('travas do cartão: consulta futura, ◷ Retomar em de hoje em diante e Pausar IA seguram', () => {
  const futuro = AGORA + 3 * DIA;
  assert.equal(porQueNaoTocar(carta([], { '◷ Data da Consulta': futuro }), opcoes)?.codigo, 'consulta-futura-cartao');
  assert.equal(porQueNaoTocar(carta([], { '◷ Data da Consulta': futuro, '✓ Situação da consulta': 'Desmarcado' }), opcoes), null, 'consulta desmarcada não é de pé');
  assert.equal(porQueNaoTocar(carta([], { '◷ Retomar em': futuro }), opcoes)?.codigo, 'retomar-em');
  assert.equal(porQueNaoTocar(carta([], { '◷ Retomar em': AGORA - 5 * DIA }), opcoes), null, 'retomada que já passou não segura');
  const pausar = { custom_fields_values: [{ field_id: 777, field_name: 'Pausar IA', values: [{ value: true }] }], _embedded: { tags: [] } } as unknown as Pick<KommoLead, 'custom_fields_values' | '_embedded'>;
  assert.equal(porQueNaoTocar(pausar, { ...opcoes, pausarIaFieldId: 777 })?.codigo, 'pausar-ia');
});

test('NÃO COMPARECEU: a consulta que faltou está no cartão e NÃO segura (só a de pé segura)', () => {
  const faltou = carta([], { '◷ Data da Consulta': AGORA - 2 * DIA, '✓ Situação da consulta': 'Não compareceu' });
  assert.equal(porQueNaoTocar(faltou, opcoes), null);
});

test('motivo de perda encerrado só trava onde a régua o confere (ex-lead e aniversário)', () => {
  for (const m of ['Outra cidade', 'Clicou por engano', 'Outra patologia', 'Plano de Saúde', 'Sem interesse']) {
    const c = carta([], { '⊘ Motivo do não agendamento': m });
    assert.equal(motivoMorto(c), m);
    assert.equal(porQueNaoTocar(c, { ...opcoes, conferirMotivoMorto: true })?.codigo, 'motivo-morto', m);
    assert.equal(porQueNaoTocar(c, opcoes), null, 'as réguas por etapa não olham o motivo de PERDIDO');
  }
  assert.equal(motivoMorto(carta([], { '⊘ Motivo do não agendamento': 'Sem condições financeira' })), null, 'trabalhável');
  assert.equal(motivoMorto(carta([], { '⊘ Motivo de não fechamento': 'Sem interesse' })), 'Sem interesse', 'o outro campo ⊘ também');
});

test('«só não contatar» (aniversário): Retomar em, consulta futura e Pausar IA não impedem parabéns', () => {
  const c = carta([], { '◷ Retomar em': AGORA + 5 * DIA, '◷ Data da Consulta': AGORA + 2 * DIA });
  assert.equal(porQueNaoTocar(c, { ...opcoes, soNaoContatar: true }), null);
  assert.equal(porQueNaoTocar(carta(['NAO_PERTURBAR']), { ...opcoes, soNaoContatar: true })?.codigo, 'nao-contatar');
});

test('cartaoMostraConsulta: data, situação, compareceu ou tratamento fechado no cartão', () => {
  assert.equal(cartaoMostraConsulta(carta()), false);
  assert.equal(cartaoMostraConsulta(carta([], { '◷ Data da Consulta': AGORA })), true);
  assert.equal(cartaoMostraConsulta(carta([], { '✓ Situação da consulta': 'Atendido' })), true);
  assert.equal(cartaoMostraConsulta(carta([], { '✓ Compareceu': 'false' })), false);
});

// ─── aniversário (puro) ───────────────────────────────────────────────────────────────────────────

/** Como o Kommo guarda o campo `date`: meia-noite no fuso da conta (Brasília = 03:00 UTC). */
const nasc = (iso: string) => Date.parse(`${iso}T03:00:00Z`) / 1000;

test('aniversário: dia e mês batem no fuso da unidade; ano de nascimento absurdo não vale', () => {
  assert.equal(aniversarioHoje(nasc('1980-11-06'), AGORA, TZ), true);
  assert.equal(aniversarioHoje(nasc('1980-11-07'), AGORA, TZ), false);
  assert.equal(aniversarioHoje(nasc('2026-11-06'), AGORA, TZ), false, 'nasceu hoje: data digitada errada');
  assert.equal(aniversarioHoje(nasc('1850-11-06'), AGORA, TZ), false);
  assert.equal(aniversarioHoje(null, AGORA, TZ), false);
});

test('nascido antes de 1970: o Kommo guarda o epoch NEGATIVO e o aniversário ainda bate (a maioria dos pacientes é dessa faixa)', () => {
  const de1950 = nasc('1950-11-06');
  assert.ok(de1950 < 0);
  assert.equal(aniversarioHoje(de1950, AGORA, TZ), true);
  assert.equal(aniversarioHoje(nasc('1950-11-07'), AGORA, TZ), false);
  assert.equal(nascimentoDoCartao(carta([], { '◷ Data de nascimento': de1950 })), de1950);
  assert.equal(nascimentoDoCartao(carta([], { '◷ Data de nascimento': String(de1950) })), de1950, 'em texto também');
  assert.equal(nascimentoDoCartao(carta()), null);
});

test('aniversário com atraso: o 1º dia útil depois do fim de semana ou feriado cobre os 3 dias anteriores, e só', () => {
  assert.equal(aniversarioHoje(nasc('1980-11-03'), AGORA, TZ, 3), true, 'fez 3 dias atrás (sábado + segunda feriado)');
  assert.equal(aniversarioHoje(nasc('1980-11-02'), AGORA, TZ, 3), false, '4 dias atrás: passou');
  assert.equal(aniversarioHoje(nasc('1980-11-04'), AGORA, TZ), false, 'sem tolerância: só hoje');
  assert.equal(aniversarioHoje(nasc('1980-11-07'), AGORA, TZ, 3), false, 'amanhã não vale');
});

test('o ANO da marca é o do aniversário, não o de hoje: 31/12 cumprimentado em 02/01 leva o ano que acabou', () => {
  const doisDeJaneiro = Date.UTC(2027, 0, 2, 13) / 1000;
  assert.equal(anoDoAniversario('1980-12-31', doisDeJaneiro, TZ, 3), 2026);
  assert.equal(anoDoAniversario('1980-01-02', doisDeJaneiro, TZ, 3), 2027);
  assert.equal(anoDoAniversario('1980-06-15', doisDeJaneiro, TZ, 3), null);
  assert.equal(anoDoAniversario(null, doisDeJaneiro, TZ, 3), null);
});

test('as varreduras de uma MESMA unidade rodam uma por vez (workers separados), e a falha de uma não trava a fila', async () => {
  const ordem: string[] = [];
  const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const a = umPorVez('u-x', async () => { ordem.push('a1'); await pausa(30); ordem.push('a2'); });
  const b = umPorVez('u-x', async () => { ordem.push('b1'); throw new Error('falhou'); });
  const c = umPorVez('u-x', async () => { ordem.push('c1'); });
  const outra = umPorVez('u-y', async () => { ordem.push('y'); });
  await Promise.all([a, outra, c, b.catch(() => undefined)]);
  assert.deepEqual(ordem.filter((x) => x !== 'y'), ['a1', 'a2', 'b1', 'c1']);
  assert.ok(ordem.indexOf('y') < ordem.indexOf('a2'), 'outra unidade não espera');
});

test('a ficha da franquia diz a data em ISO ou dd/mm/aaaa; lixo vira null', () => {
  assert.equal(diaDeNascimentoDaFicha('1980-11-06T00:00:00.000Z'), '1980-11-06');
  assert.equal(diaDeNascimentoDaFicha('06/11/1980'), '1980-11-06');
  assert.equal(diaDeNascimentoDaFicha('ontem'), null);
  assert.equal(diaDeNascimentoDaFicha(null), null);
  assert.equal(aniversarioNoDia('1980-11-06', AGORA, TZ), true);
  assert.equal(aniversarioNoDia(null, AGORA, TZ), false);
});

test('aniversário de 29/02 comemora em 28/02 nos anos sem bissexto', () => {
  const dia28 = Date.UTC(2027, 1, 28, 13) / 1000;
  const dia29 = Date.UTC(2028, 1, 29, 13) / 1000;
  assert.equal(aniversarioHoje(nasc('1996-02-29'), dia28, TZ), true);
  assert.equal(aniversarioHoje(nasc('1996-02-29'), dia29, TZ), true);
  assert.equal(aniversarioHoje(nasc('1996-02-29'), Date.UTC(2028, 1, 28, 13) / 1000, TZ), false, 'ano bissexto: é dia 29');
});

// ─── tocar: o único caminho de escrita ────────────────────────────────────────────────────────────

function toque(c: ReturnType<typeof novo>, extra: Partial<Toque> = {}): Toque {
  return { lead: c.lead, automacao: 'rotina-robos', chave: 'qualificacao', toque: 1, etiqueta: '▶ Retomada', tp: c.paciente as number, etapa: 'EM QUALIFICAÇÃO', motivo: 'teste', aindaVale: () => null, ...extra };
}

test('tocar ligado: grava a marca ANTES, põe a etiqueta, escreve a nota e conta no teto do dia', async () => {
  const a = novo();
  const c = ctx();
  const r = resumoNovo();
  assert.equal(await tocar(c, false, toque(a), r), 'ok');
  assert.deepEqual(tagsPostas(), ['▶ Retomada']);
  assert.ok(tracos.has(idDaMarca(c.unit.id, pessoaDoCartao(a.lead), 'qualificacao', 1, a.paciente as number)));
  assert.ok(chamadas.some((x) => x.startsWith('nota:')));
  assert.equal(await vagasDoDia(c, false), 29);
});

test('a etiqueta do ciclo anterior ainda no cartão: tira antes de pôr (o gatilho é «etiqueta adicionada»)', async () => {
  const a = novo({ tags: ['▶ Retomada'] });
  await tocar(ctx(), false, toque(a), resumoNovo());
  assert.deepEqual(chamadas.filter((x) => /^(removeTag|addTag)/.test(x)).map((x) => x.split(':')[0]), ['removeTag', 'addTag']);
});

test('etiqueta que a conta não tem: não escreve nada (o addTag do Kommo CRIARIA a etiqueta solta) e o papel diz o porquê', async () => {
  const a = novo();
  const r = resumoNovo();
  assert.equal(await tocar(ctx({ tags: ['LOMBAR'] }), false, toque(a), r), 'sem-etiqueta');
  assert.equal(escritas().length, 0);
  assert.equal(tracos.size, 0);
  assert.equal(await tocar(ctx({ tags: ['LOMBAR'] }), true, toque(a), r), 'sem-etiqueta');
  assert.ok(simulacoes.some((s) => s.acao === 'pularia' && /não tem a etiqueta ▶ Retomada/.test(s.motivo ?? '')));
});

test('teto do dia: as marcas de hoje (de qualquer régua) contam, e o resto fica pra amanhã', async () => {
  const cartoes = [novo(), novo(), novo()];
  const c = ctx({ intents: { rotina_teto_dia: 3 } });
  poeMarca(`rotina-${c.unit.id}-c9001-aniv-1-2026`, c.unit.id, 9001, 1);
  poeMarca(`rotina-${c.unit.id}-c9002-exlead-1-1`, c.unit.id, 9002, 2);
  const r = resumoNovo();
  assert.equal(await tocar(c, false, toque(cartoes[0]), r), 'ok');
  assert.equal(await tocar(c, false, toque(cartoes[1]), r), 'teto');
  assert.equal(r.acimaDoTeto, 1);
  assert.equal(tagsPostas().length, 1);
});

test('teto por varredura: não solta tudo de uma vez', async () => {
  const c = ctx({ porVarredura: 2 });
  const r = resumoNovo();
  const cs = [novo(), novo(), novo()];
  const res = [];
  for (const x of cs) res.push(await tocar(c, false, toque(x), r));
  assert.deepEqual(res, ['ok', 'ok', 'teto']);
});

test('a mesma PESSOA em dois cartões não recebe dois modelos no mesmo dia (ligado)', async () => {
  const perdido = novo({ contato: 777, etapa: [1, 143] });
  const qualificacao = novo({ contato: 777 });
  const c = ctx();
  const r = resumoNovo();
  assert.equal(await tocar(c, false, toque(perdido, { chave: 'exlead', etiqueta: '▶ Reativação' }), r), 'ok');
  assert.equal(await tocar(c, false, toque(qualificacao), r), 'segurou');
  assert.deepEqual(tagsPostas(), ['▶ Reativação']);
  // e no dia seguinte a marca de hoje já não vale... mas outra varredura HOJE (nova leitura do banco) também a enxerga
  const c2 = { ...ctx(), unit: c.unit };
  assert.equal(await tocar(c2, false, toque(qualificacao), resumoNovo()), 'segurou');
});

test('a pessoa que o etiquetas-auto tocou hoje também não recebe mais nada hoje', async () => {
  const a = novo({ contato: 888 });
  const outro = novo({ contato: 888, etapa: [1, 142] });
  const c = ctx();
  poeMarca(`etiqueta-${c.unit.id}-boas-vindas:${outro.lead.id}:1`, c.unit.id, outro.lead.id, 1);
  assert.equal(await tocar(c, false, toque(a), resumoNovo()), 'segurou');
  assert.equal(escritas().length, 0);
});

test('SECO não escreve nada (nem etiqueta, nem nota, nem marca): registra «etiquetaria» e o teto simulado vale por DIA, entre varreduras', async () => {
  const cartoes = [novo(), novo(), novo()];
  const c = ctx({ intents: { rotina_teto_dia: 2 } });
  const r = resumoNovo();
  assert.equal(await tocar(c, true, toque(cartoes[0]), r), 'ok');
  assert.equal(await tocar(c, true, toque(cartoes[1]), r), 'ok');
  // outra varredura do mesmo dia (contexto novo): o papel lembra o que já simulou
  const outraVarredura = { ...ctx({ intents: { rotina_teto_dia: 2 } }), unit: c.unit };
  assert.equal(await tocar(outraVarredura, true, toque(cartoes[2]), r), 'teto');
  assert.equal(await tocar(outraVarredura, true, toque(cartoes[0]), r), 'ok', 'o que já estava no papel continua nele, sem gastar outra vaga');
  assert.equal(escritas().length, 0);
  assert.equal(tracos.size, 0);
  assert.equal(simulacoes.filter((s) => s.acao === 'etiquetaria').length >= 2, true);
  assert.ok(simulacoes.some((s) => s.acao === 'pularia' && /teto do dia/.test(s.motivo ?? '')));
});

test('o papel de uma régua não gasta a vaga de uma régua LIGADA', async () => {
  const cs = [novo(), novo(), novo()];
  const c = ctx({ intents: { rotina_teto_dia: 2 } });
  const r = resumoNovo();
  await tocar(c, true, toque(cs[0]), r);
  await tocar(c, true, toque(cs[1]), r);
  assert.equal(await vagasDoDia(c, false), 2, 'de verdade ainda cabem 2');
  assert.equal(await tocar(c, false, toque(cs[2]), r), 'ok');
});

test('SECO: a mesma pessoa em dois cartões aparece uma vez só no papel', async () => {
  const a = novo({ contato: 555 });
  const b = novo({ contato: 555, etapa: [1, 143] });
  const c = ctx();
  const r = resumoNovo();
  assert.equal(await tocar(c, true, toque(a), r), 'ok');
  assert.equal(await tocar(c, true, toque(b), r), 'segurou');
  assert.ok(simulacoes.some((s) => s.acao === 'pularia' && /mesma pessoa/.test(s.motivo ?? '')));
});

// ─── falha ao pôr a etiqueta ──────────────────────────────────────────────────────────────────────

async function comAddTagQuePerdeAResposta(depois: (original: typeof kommo.addTag) => void | Promise<void>, run: () => Promise<void>): Promise<void> {
  const original = kommo.addTag;
  const getLead = kommo.getLead;
  await depois(original);
  try {
    await run();
  } finally {
    (kommo as { addTag: unknown }).addTag = original;
    (kommo as { getLead: unknown }).getLead = getLead;
  }
}

test('addTag falha e o cartão NÃO tem a etiqueta: solta a marca (tenta de novo), não conta, não escreve nota', async () => {
  const a = novo();
  await comAddTagQuePerdeAResposta(
    () => void ((kommo as { addTag: unknown }).addTag = async () => { throw new Error('timeout'); }),
    async () => {
      const c = ctx();
      const r = resumoNovo();
      assert.equal(await tocar(c, false, toque(a), r), 'falhou');
      assert.equal(tracos.size, 0, 'a marca saiu');
      assert.equal(chamadas.filter((x) => x.startsWith('nota')).length, 0);
      assert.equal(r.erros, 1);
      assert.equal(await vagasDoDia(c, false), 30);
    },
  );
});

test('addTag falha mas o Kommo gravou (timeout depois): a marca FICA, conta como enviado e a pessoa não recebe mais nada hoje', async () => {
  const a = novo();
  await comAddTagQuePerdeAResposta(
    () => void ((kommo as { addTag: unknown }).addTag = async (p: { leadId: number; tag?: string }) => { tagsNoKommo.set(p.leadId, [p.tag as string]); throw new Error('timeout'); }),
    async () => {
      const c = ctx();
      assert.equal(await tocar(c, false, toque(a), resumoNovo()), 'ok');
      assert.equal(tracos.size, 1);
      assert.equal(await vagasDoDia(c, false), 29);
    },
  );
});

test('removeTag falha (a etiqueta velha continua lá): o addTag nem rodou — solta a marca, em vez de achar que a etiqueta velha é a nova', async () => {
  const a = novo({ tags: ['▶ Retomada'] });
  const original = kommo.removeTag;
  (kommo as { removeTag: unknown }).removeTag = async () => { throw new Error('429'); };
  try {
    const c = ctx();
    assert.equal(await tocar(c, false, toque(a), resumoNovo()), 'falhou');
    assert.equal(tracos.size, 0, 'a marca saiu: a próxima varredura tenta de novo');
    assert.equal(tagsPostas().length, 0);
    assert.equal(chamadas.filter((x) => x.startsWith('nota')).length, 0);
  } finally {
    (kommo as { removeTag: unknown }).removeTag = original;
  }
});

test('addTag falha E a releitura também falha: INCERTO — a marca fica, NÃO conta como sucesso, NÃO gasta o teto e NÃO escreve a nota', async () => {
  const a = novo();
  const lead = a.lead;
  let leituras = 0;
  await comAddTagQuePerdeAResposta(
    () => {
      (kommo as { addTag: unknown }).addTag = async () => { throw new Error('timeout'); };
      const original = kommo.getLead;
      (kommo as { getLead: unknown }).getLead = async (id: number) => {
        leituras++;
        if (leituras >= 2) throw new Error('Kommo fora'); // a 1ª (antes de escrever) funciona; a releitura depois da falha, não
        return original(id);
      };
    },
    async () => {
      const c = ctx();
      const r = resumoNovo();
      assert.equal(await tocar(c, false, toque({ ...a, lead }), r), 'incerto');
      assert.equal(tracos.size, 1, 'na dúvida a marca fica: o erro cai do lado de não mandar de novo');
      assert.equal(chamadas.filter((x) => x.startsWith('nota')).length, 0, 'nada de «etiqueta posta»');
      assert.equal(r.porToque['1'], undefined, 'não conta como sucesso');
      assert.equal(c.restanteNaVarredura, 10, 'não gasta o teto da varredura');
      assert.equal(r.erros, 1);
    },
  );
});

test('a releitura ANTES de escrever que falha não conta como sucesso: lança, sem marca e sem etiqueta', async () => {
  const a = novo();
  const original = kommo.getLead;
  (kommo as { getLead: unknown }).getLead = async () => { throw new Error('Kommo fora'); };
  try {
    await assert.rejects(tocar(ctx(), false, toque(a), resumoNovo()));
    assert.equal(tracos.size, 0);
    assert.equal(escritas().length, 0);
  } finally {
    (kommo as { getLead: unknown }).getLead = original;
  }
});

test('cartão que mudou entre a leitura e a escrita (virou NO_FOLLOW_UP): não põe', async () => {
  const a = novo();
  tagsNoKommo.set(a.lead.id, ['NO_FOLLOW_UP']);
  const t = toque(a, { aindaVale: (f) => (f._embedded?.tags?.some((x) => x.name === 'NO_FOLLOW_UP') ? 'virou NO_FOLLOW_UP' : null) });
  assert.equal(await tocar(ctx(), false, t, resumoNovo()), 'segurou');
  assert.equal(escritas().length, 0);
  assert.equal(tracos.size, 0);
});

void H;

// ─── motivo de perda NATIVO do Kommo (diálogo «Fechado - perdido») ────────────────────────────────

const NATIVOS = new Map([[5, 'Sem interesse'], [6, 'Plano de Saúde'], [7, 'Sem condições financeira']]);

test('motivo encerrado escolhido no diálogo NATIVO do Kommo (loss_reason_id) também trava, sem o campo ⊘', () => {
  const quente = { ...carta(), loss_reason_id: 5 };
  assert.equal(motivoMortoNativo(quente, NATIVOS), 'Sem interesse');
  assert.equal(motivoMortoNativo({ loss_reason_id: 7 }, NATIVOS), null, 'trabalhável');
  assert.equal(motivoMortoNativo({ loss_reason_id: 999 }, NATIVOS), null, 'id que a conta não lista');
  assert.equal(motivoMortoNativo({ loss_reason_id: null }, NATIVOS), null);
  const o = { ...opcoes, conferirMotivoMorto: true };
  assert.equal(porQueNaoTocar(quente, { ...o, motivosNativos: NATIVOS })?.codigo, 'motivo-morto');
  assert.equal(porQueNaoTocar({ ...carta(), loss_reason_id: 7 }, { ...o, motivosNativos: NATIVOS }), null);
  assert.equal(porQueNaoTocar(quente, opcoes), null, 'as réguas que não conferem o motivo de PERDIDO não olham');
  // a lista não pôde ser lida: com motivo nativo no cartão, na dúvida não manda
  assert.equal(porQueNaoTocar(quente, { ...o, motivosNativos: null })?.codigo, 'motivo-nativo-desconhecido');
  assert.equal(porQueNaoTocar(carta(), { ...o, motivosNativos: null }), null, 'sem motivo nativo no cartão, a lista nem importa');
});

test('tocar (o caminho de escrita de QUALQUER régua) barra o motivo nativo encerrado — inclusive no aniversário — e não lê a lista de quem não tem motivo', async () => {
  extrasDoKommo.motivosNativos = [{ id: 5, name: 'Sem interesse' }, { id: 7, name: 'Sem condições financeira' }];
  const morto = novo({ lossReasonId: 5 });
  const trabalhavel = novo({ lossReasonId: 7 });
  const aberto = novo();
  const r = resumoNovo();
  const c = ctx();
  assert.equal(await tocar(c, false, toque(morto), r), 'segurou');
  assert.equal(r.seguradas['motivo-nativo-morto'], 1);
  assert.equal(await tocar(c, false, toque(trabalhavel), r), 'ok');
  const antes = chamadas.filter((x) => x === 'listLossReasons').length;
  assert.equal(await tocar(c, false, toque(aberto), r), 'ok');
  assert.equal(chamadas.filter((x) => x === 'listLossReasons').length, antes, 'cartão aberto não consulta a lista');
  assert.equal(chamadas.filter((x) => x === 'listLossReasons').length, 1, 'e a lista é lida uma vez por varredura');
  assert.deepEqual(chamadas.filter((x) => x.startsWith('addTag')).length, 2);
});

test('tocar: lista de motivos nativos que não lê + cartão com motivo nativo = fica (no papel aparece o porquê)', async () => {
  extrasDoKommo.motivosNativos = null;
  const x = novo({ lossReasonId: 5 });
  const r = resumoNovo();
  assert.equal(await tocar(ctx(), true, toque(x), r), 'segurou');
  assert.equal(r.seguradas['motivo-nativo-desconhecido'], 1);
  assert.ok(simulacoes.some((s) => s.acao === 'pularia' && /não pôde ser lido/.test(s.motivo ?? '')));
  assert.equal(escritas().length, 0);
});

// ─── corrida com o etiquetas-auto (outro worker) no meio da varredura ─────────────────────────────

/** Faz o `getLead` (a releitura do `tocar`, logo antes de escrever) acontecer DEPOIS de o outro robô gravar a marca dele. */
async function comOutroRoboNoMeio(durante: () => void, run: () => Promise<void>): Promise<void> {
  const original = kommo.getLead;
  (kommo as { getLead: unknown }).getLead = async (id: number) => {
    const lido = await original(id);
    durante();
    return lido;
  };
  try {
    await run();
  } finally {
    (kommo as { getLead: unknown }).getLead = original;
  }
}

test('CORRIDA: o etiquetas-auto põe a ▶ Reativação entre a leitura e a escrita — a rotina vê a marca dele (relida do banco) e NÃO faz remove+add (o robô dispararia de novo)', async () => {
  const x = novo({ etapa: [1, 143], closed: AGORA - 31 * DIA, tags: [] });
  const c = ctx();
  await marcasDaUnidadeParaOTeste(c); // a leitura do COMEÇO da varredura: ainda sem a marca do outro robô
  await comOutroRoboNoMeio(
    () => {
      poeMarca(`etiqueta-${c.unit.id}-reativacao:${x.lead.id}:${AGORA - 31 * DIA}`, c.unit.id, x.lead.id, 0);
      tagsNoKommo.set(x.lead.id, ['▶ Reativação']);
    },
    async () => {
      const r = resumoNovo();
      assert.equal(await tocar(c, false, toque(x, { chave: 'exlead', etiqueta: '▶ Reativação' }), r), 'segurou');
      assert.equal(escritas().length, 0, 'nem removeTag, nem addTag, nem nota');
      assert.equal([...tracos.keys()].filter((k) => k.startsWith('rotina-')).length, 0, 'e não gravou a marca dela');
      assert.equal(r.seguradas['mesma-pessoa-hoje'], 1);
    },
  );
});

test('CORRIDA: outro processo gravou uma marca da rotina para a MESMA pessoa no meio da varredura — segura', async () => {
  const x = novo({ contato: 6006 });
  const c = ctx();
  await marcasDaUnidadeParaOTeste(c);
  await comOutroRoboNoMeio(
    () => poeMarca(`rotina-${c.unit.id}-c6006-negociacao-1-9`, c.unit.id, 77, 0),
    async () => {
      assert.equal(await tocar(c, false, toque(x), resumoNovo()), 'segurou');
      assert.equal(escritas().length, 0);
    },
  );
});

test('a releitura do banco só olha marcas de HOJE: a de ontem não segura', async () => {
  const x = novo({ contato: 6007 });
  const c = ctx();
  poeMarca(`rotina-${c.unit.id}-c6007-negociacao-1-9`, c.unit.id, 77, 30);
  poeMarca(`etiqueta-${c.unit.id}-boas-vindas:${x.lead.id}:1`, c.unit.id, x.lead.id, 30);
  assert.equal(await tocar(c, false, toque(x), resumoNovo()), 'ok');
});

test('se a releitura do banco falha, lança: «não consegui ler» não é «ninguém tocou» (nada é escrito)', async () => {
  const x = novo();
  const c = ctx();
  const original = (await import('./prisma.js')).prisma.executionTrace.findMany;
  await marcasDaUnidadeParaOTeste(c);
  const util = await import('./prisma.js');
  (util.prisma.executionTrace as { findMany: unknown }).findMany = async () => { throw new Error('banco fora'); };
  try {
    await assert.rejects(tocar(c, false, toque(x), resumoNovo()));
    assert.equal(escritas().length, 0);
  } finally {
    (util.prisma.executionTrace as { findMany: unknown }).findMany = original;
  }
});
