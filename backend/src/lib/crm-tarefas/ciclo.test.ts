/**
 * O ciclo do robô das tarefas, com banco e mundo DE MENTIRA (em memória). O que se prova aqui:
 *  - SECO nunca escreve: nem no paciente, nem no CRM, nem no WhatsApp da menina — só anota «mandaria…», uma vez;
 *  - a mensagem sai UMA vez só (duas réplicas ao mesmo tempo, reinício, ciclo repetido);
 *  - janela de 24 h: texto se aberta, modelo se fechada, e sem modelo não sai e a menina é avisada;
 *  - SAIR, etiqueta sem-follow-up, contato interno, caixa do histórico, horário (8h–20h) e atraso grande barram ou seguram;
 *  - leitura do CRM que falha adia (nunca vira «não pediu SAIR»); resposta incerta nunca é reenviada.
 */
process.env.KOMMO_SUBDOMAIN ??= 'teste';
process.env.KOMMO_ACCESS_TOKEN ??= 'token-de-teste-123';
process.env.OPENAI_API_KEY ??= 'sk-teste-1234567890';
process.env.DATABASE_URL ??= 'postgresql://x:y@127.0.0.1:1/z';

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { CrmTarefa } from '@prisma/client';
import { prisma } from '../prisma.js';

// o logger grava no banco: sem banco no teste, a gravação do log é de mentira (sem isso cada aviso vira um erro de conexão na tela)
Object.defineProperty(prisma, 'systemLog', { value: { create: async () => ({}) }, configurable: true });

const U = await import('../chatwoot-unidades.js');
const C = await import('./ciclo.js');
const R = await import('./regras.js');
type Armazem = import('./ciclo.js').Armazem;
type MundoDoCiclo = import('./ciclo.js').MundoDoCiclo;
type DaUnidade = import('./ciclo.js').DaUnidade;

const PARAU = U.SEMENTE_PARAUAPEBAS.slug;
const FUSO = 'America/Sao_Paulo';
/** terça 18/11/2026, 15:00 em São Paulo (dentro de 8h–20h) */
const AGORA = R.localParaUtc('2026-11-18T15:00', FUSO)!;
const CTX = { conta: { url: 'https://crm.exemplo.test', conta: 1, token: 'tk-secreto-nao-sai' } } as never;

let linhas: CrmTarefa[] = [];
let n = 0;
function tarefa(o: Partial<CrmTarefa> = {}): CrmTarefa {
  const t: CrmTarefa = {
    id: `t${++n}-aaaaaaaa`, unitId: 'u1', conta: 1, caixa: 3, conversaId: 40, contatoId: 55, contatoNome: 'Maria Silva',
    tipo: 'mensagem', quando: AGORA, responsavelId: 7, responsavelNome: 'Ana Souza', texto: 'Oi, Maria! Passando para lembrar da sua avaliação.',
    modeloNome: null, modeloIdioma: null, modeloTexto: null, modeloVariaveis: [], estado: 'pendente', motivo: null, confirmadaEm: null, tentativaEm: null,
    enviadaEm: null, mensagemId: null, lembreteEm: null, lembreteResumo: null, simuladoEm: null, simulado: null, resultado: null, resultadoEm: null, resultadoPor: null,
    tentativas: 0, criadoPor: 'ana@clinica.com', criadoEm: new Date(AGORA.getTime() - 86_400_000), atualizadoEm: AGORA, ...o,
  };
  linhas.push(t);
  return t;
}

/** Banco em memória com a MESMA semântica das condições do banco de verdade (`updateMany` com o estado esperado). */
function armazemFalso(zaps: Record<number, string> = { 7: '5594999990000' }): Armazem {
  const acha = (id: string) => linhas.find((l) => l.id === id);
  return {
    async soltarPresas(agora) {
      let k = 0;
      for (const l of linhas) if (l.estado === 'enviando' && l.tentativaEm && l.tentativaEm.getTime() < agora.getTime() - R.PRESA_ENVIANDO_MS) ((l.estado = 'falhou'), (l.motivo = 'não sei se saiu'), k++);
      return k;
    },
    async unidadesComVencidas(agora) {
      return [...new Set(linhas.filter((l) => l.estado === 'pendente' && l.quando <= agora).map((l) => l.unitId))];
    },
    async vencidas(unitId, agora, soNaoSimuladas, limite) {
      return linhas
        .filter((l) => l.unitId === unitId && l.estado === 'pendente' && l.quando <= agora && (l.tipo === 'mensagem' || l.lembreteEm === null) && (!soNaoSimuladas || l.simuladoEm === null))
        .sort((a, b) => a.quando.getTime() - b.quando.getTime())
        .slice(0, limite)
        .map((l) => ({ ...l })); // o banco devolve CÓPIAS: uma edição depois da leitura não muda o que o robô leu
    },
    async pegar(id, agora, versao) {
      const l = acha(id);
      if (!l || l.estado !== 'pendente' || l.atualizadoEm.getTime() !== versao.getTime()) return false;
      l.estado = 'enviando';
      l.tentativaEm = agora;
      return true;
    },
    async pegarLembrete(id, agora) {
      const l = acha(id);
      if (!l || l.estado !== 'pendente' || l.lembreteEm !== null) return false;
      l.lembreteEm = agora;
      return true;
    },
    async desfazerLembrete(id) {
      const l = acha(id);
      if (l && l.estado === 'pendente') l.lembreteEm = null;
    },
    async anotarSimulado(id, texto, agora) {
      const l = acha(id);
      if (!l || l.estado !== 'pendente' || l.simuladoEm !== null) return false;
      l.simuladoEm = agora;
      l.simulado = texto;
      return true;
    },
    async atualizar(id, daqui, dados) {
      const l = acha(id);
      if (!l || !daqui.includes(l.estado)) return false;
      Object.assign(l, dados);
      return true;
    },
    async numeroDaMenina(_conta, agenteId) {
      return zaps[agenteId] ?? null;
    },
  };
}

interface Registro {
  mandou: Array<{ conversaId: number; content: string; modelo?: { nome: string; idioma: string; variaveis: string[] } }>;
  notas: Array<{ conversaId: number; texto: string }>;
  zaps: Array<{ numero: string; texto: string }>;
  leituras: string[];
}
let reg: Registro;
let agoraDoTeste = AGORA;
let modo: 'seco' | 'ligado' | 'desligado' = 'ligado';
/** o que o CRM de mentira responde */
/** o que acontece DURANTE a leitura da conversa (a menina edita a tarefa no meio do ciclo) */
let aoLerConversa: (() => void) | null = null;
let crm: {
  conversa: unknown;
  ultima: Date | null;
  sair: Date | null;
  oficial: boolean;
  modeloOk: boolean | 'transitorio';
  erroNaConversa: (Error & { status?: number }) | null;
  erroNoSair: Error | null;
  erroAoMandar: (Error & { status?: number }) | null;
  idDaMensagem: number | null;
};
const conversaCrua = (extra: Record<string, unknown> = {}) => ({ id: 40, inbox_id: 3, labels: [], meta: { sender: { id: 55, name: 'Maria Silva', phone_number: '+5594999990000' } }, custom_attributes: {}, created_at: 1760000000, ...extra });
const erroHttp = (status: number, msg = 'erro'): Error & { status: number } => Object.assign(new Error(msg), { status });

beforeEach(() => {
  linhas = [];
  agoraDoTeste = AGORA;
  aoLerConversa = null;
  modo = 'ligado';
  U.aplicarConfigs([U.SEMENTE_PARAUAPEBAS]);
  reg = { mandou: [], notas: [], zaps: [], leituras: [] };
  crm = { conversa: conversaCrua(), ultima: new Date(AGORA.getTime() - 2 * 3_600_000), sair: null, oficial: true, modeloOk: true, erroNaConversa: null, erroNoSair: null, erroAoMandar: null, idDaMensagem: 901 };
});

function mundo(): MundoDoCiclo {
  const unidade: DaUnidade = { slug: PARAU, nome: 'Doutor Hérnia Parauapebas', fuso: FUSO, modo, ctx: CTX, linkDaConta: 'https://crm.exemplo.test/app/accounts/1' };
  return {
    async unidade() {
      return { ...unidade, modo };
    },
    async conversa() {
      reg.leituras.push('conversa');
      aoLerConversa?.();
      if (crm.erroNaConversa) throw crm.erroNaConversa;
      return crm.conversa;
    },
    async ultimaDoPaciente() {
      reg.leituras.push('ultima');
      return crm.ultima;
    },
    async pediuSair() {
      reg.leituras.push('sair');
      if (crm.erroNoSair) throw crm.erroNoSair;
      return crm.sair;
    },
    async caixaOficial() {
      return crm.oficial ? { ok: true as const, nome: 'WhatsApp', provedor: 'whatsapp_cloud' } : { ok: false as const, motivo: 'a caixa não é WhatsApp oficial' };
    },
    async conferirModelo() {
      if (crm.modeloOk === 'transitorio') return { ok: false as const, transitorio: true as const, motivo: 'CRM lento' };
      return crm.modeloOk ? { ok: true as const } : { ok: false as const, motivo: 'o modelo foi pausado pela Meta' };
    },
    async mandar(_ctx, conversaId, a) {
      if (crm.erroAoMandar) throw crm.erroAoMandar;
      reg.mandou.push({ conversaId, content: a.content, modelo: a.modelo });
      return { id: crm.idDaMensagem };
    },
    async nota(_ctx, conversaId, texto) {
      reg.notas.push({ conversaId, texto });
    },
    async zap(numero, texto) {
      reg.zaps.push({ numero, texto });
      return true;
    },
    agora: () => agoraDoTeste,
    pausa: async () => undefined,
    env: {} as NodeJS.ProcessEnv,
  };
}
const ciclo = (zaps?: Record<number, string>) => C.rodarCiclo({ armazem: armazemFalso(zaps), mundo: mundo() });
const nada = () => assert.deepEqual([reg.mandou.length, reg.notas.length, reg.zaps.length], [0, 0, 0], 'nada foi escrito em lugar nenhum');

// ── SECO ──────────────────────────────────────────────────────────────────────────────────────────────────────

test('SECO: a mensagem vencida NÃO é enviada, não escreve no CRM nem no WhatsApp da menina; só anota «mandaria…» e não repete no ciclo seguinte', async () => {
  modo = 'seco';
  const t = tarefa();
  const r1 = await ciclo();
  nada();
  assert.equal(r1.simuladas, 1);
  assert.equal(t.estado, 'pendente', 'o estado não muda em seco');
  assert.equal(t.simuladoEm?.getTime(), AGORA.getTime());
  assert.match(t.simulado!, /mandaria agora como texto livre/);
  const leiturasAntes = reg.leituras.length;
  const r2 = await ciclo();
  assert.equal(r2.simuladas, 0, 'a decisão não se repete a cada minuto');
  assert.equal(reg.leituras.length, leiturasAntes, 'nem lê o CRM de novo');
  nada();
});

test('SECO: o lembrete da ligação não vai para o CRM nem para o WhatsApp; anota quem seria avisada (com ou sem número)', async () => {
  modo = 'seco';
  const com = tarefa({ tipo: 'ligacao', texto: 'confirmar consulta' });
  const sem = tarefa({ tipo: 'ligacao', responsavelId: 8, responsavelNome: 'Bia' });
  await ciclo();
  nada();
  assert.match(com.simulado!, /nota com menção a Ana Souza no CRM e WhatsApp para ela/);
  assert.match(sem.simulado!, /sem WhatsApp cadastrado/);
  assert.equal(com.lembreteEm, null, 'em seco o lembrete não é dado como enviado');
});

test('SECO: o que seria barrado (SAIR) fica anotado como «NÃO mandaria», sem gravar o estado nem avisar ninguém', async () => {
  modo = 'seco';
  crm.sair = new Date(AGORA.getTime() - 86_400_000);
  const t = tarefa();
  await ciclo();
  nada();
  assert.equal(t.estado, 'pendente');
  assert.match(t.simulado!, /NÃO mandaria: o paciente pediu para sair/);
});

test('SECO: o atraso grande vira «pediria a confirmação», sem mudar o estado nem avisar', async () => {
  modo = 'seco';
  const t = tarefa({ quando: new Date(AGORA.getTime() - 3 * 3_600_000) });
  await ciclo();
  nada();
  assert.equal(t.estado, 'pendente');
  assert.match(t.simulado!, /pediria a confirmação/);
});

test('DESLIGADO: o robô ignora a tarefa por completo (nem lê o CRM); a tela continua podendo usá-la', async () => {
  modo = 'desligado';
  const t = tarefa();
  const r = await ciclo();
  nada();
  assert.equal(r.desligadas, 1);
  assert.deepEqual(reg.leituras, []);
  assert.equal(t.estado, 'pendente');
});

// ── LIGADO: ligação e lembrete ───────────────────────────────────────────────────────────────────────────────

test('LIGADO: o lembrete da ligação vai para o CRM (nota com menção) E para o WhatsApp da menina — uma vez só, mesmo em ciclos e réplicas repetidos', async () => {
  const t = tarefa({ tipo: 'ligacao', texto: 'confirmar consulta' });
  const [a, b] = await Promise.all([ciclo(), ciclo()]);
  assert.equal(a.lembretes + b.lembretes, 1, 'duas réplicas ao mesmo tempo: só uma lembra');
  await ciclo();
  assert.equal(reg.notas.length, 1);
  assert.equal(reg.zaps.length, 1);
  assert.match(reg.notas[0]!.texto, /^🔔 \[@Ana\]\(mention:\/\/user\/7\/Ana\) Hora de ligar para Maria Silva/);
  assert.equal(reg.zaps[0]!.numero, '5594999990000');
  assert.match(reg.zaps[0]!.texto, /Hora de ligar para Maria Silva/);
  assert.match(reg.zaps[0]!.texto, /https:\/\/crm\.exemplo\.test\/app\/accounts\/1\/conversations\/40/, 'o WhatsApp leva o link da conversa');
  assert.ok(!JSON.stringify(reg).includes('tk-secreto-nao-sai'), 'token nunca sai');
  assert.equal(t.estado, 'pendente', 'a ligação segue aberta até a menina registrar o resultado');
  assert.equal(t.lembreteResumo, 'CRM: ok · WhatsApp: ok');
});

test('LIGADO: menina sem WhatsApp cadastrado recebe só o lembrete no CRM, e o resumo diz que faltou o número', async () => {
  const t = tarefa({ tipo: 'lembrete', texto: 'ver documentos' });
  await ciclo({});
  assert.equal(reg.notas.length, 1);
  assert.equal(reg.zaps.length, 0);
  assert.equal(t.lembreteResumo, 'CRM: ok · WhatsApp: sem número cadastrado');
});

test('LIGADO: lembrete atrasado em mais de 3 h NÃO acorda ninguém (a tarefa segue na tela como atrasada)', async () => {
  const t = tarefa({ tipo: 'ligacao', quando: new Date(AGORA.getTime() - 4 * 3_600_000) });
  await ciclo();
  nada();
  assert.match(t.lembreteResumo!, /não avisei/);
  assert.equal(t.estado, 'pendente');
});

// ── LIGADO: mensagem ao paciente ─────────────────────────────────────────────────────────────────────────────

test('LIGADO: janela de 24 h aberta → sai o TEXTO LIVRE, uma vez só (duas réplicas ao mesmo tempo), e a menina é avisada «saiu» no WhatsApp', async () => {
  const t = tarefa();
  const [a, b] = await Promise.all([ciclo(), ciclo()]);
  assert.equal(a.mandadas + b.mandadas, 1, 'NÃO manda duas vezes');
  await ciclo();
  assert.equal(reg.mandou.length, 1);
  assert.deepEqual(reg.mandou[0], { conversaId: 40, content: 'Oi, Maria! Passando para lembrar da sua avaliação.', modelo: undefined });
  assert.equal(t.estado, 'feita');
  assert.equal(t.mensagemId, 901);
  assert.equal(reg.zaps.length, 1);
  assert.match(reg.zaps[0]!.texto, /Saiu a mensagem para Maria Silva/);
  assert.equal(reg.notas.length, 0, 'mensagem que saiu já aparece na conversa: sem nota extra');
});

test('LIGADO: janela FECHADA com modelo → sai o MODELO (com as variáveis preenchidas); a conferência do modelo roda antes', async () => {
  crm.ultima = new Date(AGORA.getTime() - 30 * 3_600_000);
  const t = tarefa({ texto: 'texto livre que não pode sair', modeloNome: 'parau_retorno', modeloIdioma: 'pt_BR', modeloTexto: 'Oi {{1}}, aqui é a {{2}}.', modeloVariaveis: ['primeiroNome', 'unidade'] });
  await ciclo();
  assert.equal(reg.mandou.length, 1);
  assert.equal(reg.mandou[0]!.content, 'Oi Maria, aqui é a Doutor Hérnia Parauapebas.');
  assert.deepEqual(reg.mandou[0]!.modelo, { nome: 'parau_retorno', idioma: 'pt_BR', variaveis: ['Maria', 'Doutor Hérnia Parauapebas'] });
  assert.equal(t.estado, 'feita');
  assert.match(t.motivo!, /modelo parau_retorno \(janela de 24 h fechada\)/);
});

test('LIGADO: janela fechada SEM modelo → NÃO sai, fica «não saiu» e a menina é avisada no CRM e no WhatsApp', async () => {
  crm.ultima = null;
  const t = tarefa();
  await ciclo();
  assert.equal(reg.mandou.length, 0);
  assert.equal(t.estado, 'barrada');
  assert.match(t.motivo!, /janela de 24 h do WhatsApp fechou e a tarefa não tem modelo/);
  assert.equal(reg.notas.length, 1);
  assert.match(reg.notas[0]!.texto, /NÃO saiu/);
  assert.equal(reg.zaps.length, 1);
});

test('LIGADO: modelo que a Meta pausou/mudou não sai (barrada); CRM lento na conferência do modelo só adia', async () => {
  crm.ultima = null;
  const t = tarefa({ modeloNome: 'parau_x', modeloIdioma: 'pt_BR', modeloTexto: 'Oi {{1}}', modeloVariaveis: ['primeiroNome'] });
  crm.modeloOk = 'transitorio';
  await ciclo();
  assert.equal(reg.mandou.length, 0);
  assert.equal(t.estado, 'pendente', 'adiou');
  assert.equal(t.tentativas, 1);
  crm.modeloOk = false;
  await ciclo();
  assert.equal(t.estado, 'barrada');
  assert.match(t.motivo!, /o modelo não vale mais: o modelo foi pausado pela Meta/);
  assert.equal(reg.mandou.length, 0);
});

test('LIGADO: nome do contato que não serve para a saudação do modelo (virou «Lead 12» depois) → não sai', async () => {
  crm.ultima = null;
  crm.conversa = conversaCrua({ meta: { sender: { id: 55, name: 'Lead 12', phone_number: '+5594999990000' } } });
  const t = tarefa({ modeloNome: 'parau_x', modeloIdioma: 'pt_BR', modeloTexto: 'Oi {{1}}', modeloVariaveis: ['primeiroNome'] });
  await ciclo();
  assert.equal(reg.mandou.length, 0);
  assert.equal(t.estado, 'barrada');
  assert.match(t.motivo!, /nome do contato não serve/);
});

test('LIGADO: quem pediu SAIR não recebe — barrada, avisa a menina, nunca chama o envio', async () => {
  crm.sair = new Date(AGORA.getTime() - 3 * 86_400_000);
  const t = tarefa();
  await ciclo();
  assert.equal(reg.mandou.length, 0);
  assert.equal(t.estado, 'barrada');
  assert.match(t.motivo!, /pediu para sair \(SAIR\)/);
  assert.equal(reg.notas.length + reg.zaps.length, 2);
});

test('LIGADO: etiqueta sem-follow-up, contato interno, outra caixa, caixa do histórico e contato trocado barram', async () => {
  const casos: Array<[string, Record<string, unknown>, RegExp, Partial<CrmTarefa>?]> = [
    ['sem-follow-up', { labels: ['Sem-Follow-Up'] }, /sem-follow-up/],
    ['interno', { labels: ['interno'] }, /contato interno/],
    ['outra caixa', { inbox_id: 9 }, /saiu da caixa da unidade/],
    ['histórico', { inbox_id: 4 }, /saiu da caixa da unidade/, { caixa: 4 }],
    ['contato trocado', { meta: { sender: { id: 99, name: 'Outra Pessoa', phone_number: '+5594911112222' } } }, /contato da conversa mudou/],
  ];
  for (const [nome, extra, motivo, tarefaExtra] of casos) {
    linhas = [];
    reg = { mandou: [], notas: [], zaps: [], leituras: [] };
    crm.conversa = conversaCrua(extra);
    const t = tarefa(tarefaExtra);
    await ciclo();
    assert.equal(reg.mandou.length, 0, nome);
    assert.equal(t.estado, 'barrada', nome);
    assert.match(t.motivo!, motivo, nome);
  }
});

test('LIGADO: conversa apagada no CRM (404) → falhou com o motivo; erro de leitura do CRM ADIA e, na 3ª vez, desiste — nunca vira «não pediu SAIR»', async () => {
  crm.erroNaConversa = erroHttp(404);
  const apagada = tarefa();
  await ciclo();
  assert.equal(apagada.estado, 'falhou');
  assert.match(apagada.motivo!, /não existe mais/);

  linhas = [];
  crm.erroNaConversa = null;
  crm.erroNoSair = new Error('CRM fora do ar');
  const t = tarefa();
  await ciclo();
  assert.equal(t.estado, 'pendente');
  assert.equal(t.tentativas, 1);
  await ciclo();
  assert.equal(t.tentativas, 2);
  await ciclo();
  assert.equal(t.estado, 'falhou');
  assert.match(t.motivo!, /não consegui ler o CRM depois de 3 tentativas/);
  assert.equal(reg.mandou.length, 0, 'sem saber se pediu SAIR, nunca manda');
});

test('LIGADO: atraso de mais de 2 h NÃO sai sozinho — fica «Aguardando» e a menina é avisada; confirmando na tela, sai', async () => {
  const t = tarefa({ quando: new Date(AGORA.getTime() - 3 * 3_600_000) });
  const r = await ciclo();
  assert.equal(r.aguardando, 1);
  assert.equal(reg.mandou.length, 0);
  assert.equal(t.estado, 'aguardando');
  assert.match(t.motivo!, /passou de 2 h do horário combinado/);
  assert.equal(reg.notas.length, 1);
  // ela confirma (o que `POST /confirmar` faz): o atraso passa a contar daí
  Object.assign(t, { estado: 'pendente', motivo: null, confirmadaEm: AGORA, simuladoEm: null, simulado: null });
  await ciclo();
  assert.equal(reg.mandou.length, 1);
  assert.equal(t.estado, 'feita');
});

test('LIGADO: o atraso menor que o limite ainda sai sozinho (servidor reiniciou há pouco)', async () => {
  const t = tarefa({ quando: new Date(AGORA.getTime() - 90 * 60_000) });
  await ciclo();
  assert.equal(reg.mandou.length, 1);
  assert.equal(t.estado, 'feita');
});

test('LIGADO: fora do horário (22h30) a mensagem ESPERA — nada gravado, nada lido; às 8h ela sai sem cair no «atrasada demais»', async () => {
  const quando = R.localParaUtc('2026-11-18T22:30', FUSO)!;
  const t = tarefa({ quando });
  agoraDoTeste = R.localParaUtc('2026-11-18T23:00', FUSO)!;
  const r = await ciclo();
  assert.equal(r.adiadas, 1);
  nada();
  assert.deepEqual(reg.leituras, []);
  assert.equal(t.estado, 'pendente');
  // madrugada: ainda fechado
  agoraDoTeste = R.localParaUtc('2026-11-19T03:00', FUSO)!;
  await ciclo();
  nada();
  // 8h05: abriu. O atraso conta das 8h, não das 22h30
  agoraDoTeste = R.localParaUtc('2026-11-19T08:05', FUSO)!;
  crm.ultima = new Date(agoraDoTeste.getTime() - 3_600_000);
  await ciclo();
  assert.equal(reg.mandou.length, 1);
  assert.equal(t.estado, 'feita');
});

test('LIGADO: tarefa marcada para o futuro não é tocada; ligação já lembrada não volta a lembrar', async () => {
  tarefa({ quando: new Date(AGORA.getTime() + 3_600_000) });
  tarefa({ tipo: 'ligacao', lembreteEm: new Date(AGORA.getTime() - 60_000) });
  const r = await ciclo();
  nada();
  assert.equal(r.vistas, 0);
});

test('LIGADO: o CRM recusou (4xx) → falhou com o motivo e avisa; resposta sem confirmação (5xx/timeout) → «não sei se saiu» e NUNCA reenvia sozinho', async () => {
  crm.erroAoMandar = erroHttp(422, 'Chatwoot 422: janela fechada');
  const recusada = tarefa();
  await ciclo();
  assert.equal(recusada.estado, 'falhou');
  assert.match(recusada.motivo!, /o CRM recusou a mensagem/);
  assert.equal(reg.notas.length, 1);

  linhas = [];
  reg = { mandou: [], notas: [], zaps: [], leituras: [] };
  crm.erroAoMandar = erroHttp(502, 'bad gateway');
  const incerta = tarefa();
  await ciclo();
  assert.equal(incerta.estado, 'falhou');
  assert.match(incerta.motivo!, /não sei se saiu/);
  crm.erroAoMandar = null;
  await ciclo();
  await ciclo();
  assert.equal(reg.mandou.length, 0, 'depois de incerta, nunca é reenviada pelo robô');

  linhas = [];
  crm.idDaMensagem = null;
  const semId = tarefa();
  await ciclo();
  assert.equal(semId.estado, 'falhou');
  assert.match(semId.motivo!, /não devolveu o id da mensagem/);
});

test('LIGADO: o Chatwoot ocupado (429) devolve a tarefa à fila sem culpa e encerra a rodada', async () => {
  crm.erroAoMandar = erroHttp(429);
  const a = tarefa();
  const b = tarefa({ conversaId: 41 });
  await ciclo();
  assert.equal(a.estado, 'pendente');
  assert.equal(b.estado, 'pendente', 'a rodada parou: a segunda nem foi tentada');
  assert.equal(reg.mandou.length, 0);
  crm.erroAoMandar = null;
  await ciclo();
  assert.equal(reg.mandou.length, 2);
});

test('tarefa presa em «enviando» há mais de 10 min vira «não sei se saiu» e não é reenviada', async () => {
  const t = tarefa({ estado: 'enviando', tentativaEm: new Date(AGORA.getTime() - 11 * 60_000) });
  const r = await ciclo();
  assert.equal(r.presas, 1);
  assert.equal(t.estado, 'falhou');
  assert.equal(reg.mandou.length, 0);
  const recente = tarefa({ estado: 'enviando', tentativaEm: new Date(AGORA.getTime() - 60_000) });
  await ciclo();
  assert.equal(recente.estado, 'enviando', 'ainda está dentro do prazo: o robô que pegou pode estar terminando');
});

test('a tarefa de uma CONTA nunca age na conta de outra unidade; teto de envios por ciclo', async () => {
  const fora = tarefa({ conta: 2 });
  await ciclo();
  nada();
  assert.equal(fora.estado, 'pendente');
  linhas = [];
  for (let i = 0; i < C.MAX_ENVIOS_POR_CICLO + 5; i++) tarefa({ conversaId: 100 + i });
  await ciclo();
  assert.equal(reg.mandou.length, C.MAX_ENVIOS_POR_CICLO, 'se um defeito soltar tudo, vaza só o teto por ciclo');
  await ciclo();
  assert.equal(reg.mandou.length, C.MAX_ENVIOS_POR_CICLO + 5);
});

test('caixa que NÃO é WhatsApp oficial (celular/API): só texto livre, sem janela de 24 h', async () => {
  crm.oficial = false;
  crm.ultima = null;
  const t = tarefa();
  await ciclo();
  assert.equal(reg.mandou.length, 1);
  assert.equal(reg.mandou[0]!.modelo, undefined);
  assert.equal(t.estado, 'feita');
});

test('a menina EDITA a tarefa no meio do ciclo (entre a leitura e o envio): o robô larga e manda a versão nova no ciclo seguinte, nunca a velha', async () => {
  const t = tarefa({ texto: 'texto velho' });
  aoLerConversa = () => {
    t.texto = 'texto NOVO';
    t.atualizadoEm = new Date(AGORA.getTime() + 1000);
    aoLerConversa = null;
  };
  await ciclo();
  assert.equal(reg.mandou.length, 0, 'a versão lida já não vale: não manda');
  assert.equal(t.estado, 'pendente');
  await ciclo();
  assert.deepEqual(reg.mandou.map((m) => m.content), ['texto NOVO']);
});

test('confirmar o atraso FORA do horário (20h30) vale a partir das 8h do dia seguinte: sai às 8h, não volta a «Aguardando»', async () => {
  const quando = R.localParaUtc('2026-11-18T17:00', FUSO)!;
  const t = tarefa({ quando, estado: 'aguardando', confirmadaEm: R.localParaUtc('2026-11-18T20:30', FUSO)! });
  Object.assign(t, { estado: 'pendente' }); // o que o «Enviar mesmo assim» faz
  agoraDoTeste = R.localParaUtc('2026-11-19T08:01', FUSO)!;
  crm.ultima = new Date(agoraDoTeste.getTime() - 3_600_000);
  await ciclo();
  assert.equal(reg.mandou.length, 1);
  assert.equal(t.estado, 'feita');
});

test('o teto por ciclo vale também para os AVISOS de «não saiu»: um defeito que barra tudo não vira dezenas de WhatsApps', async () => {
  crm.sair = new Date(AGORA.getTime() - 86_400_000);
  for (let i = 0; i < C.MAX_ENVIOS_POR_CICLO + 10; i++) tarefa({ conversaId: 200 + i });
  await ciclo();
  assert.equal(reg.zaps.length, C.MAX_ENVIOS_POR_CICLO);
  assert.equal(reg.notas.length, C.MAX_ENVIOS_POR_CICLO);
});
