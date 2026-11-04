/**
 * O paciente que escreveu antes de o cartão ter unidade (conta dividida) — caso real de 03/11/2026, cartão 5014067:
 * mensagem às 17:14, robô marcou Petrópolis às 17:46, e a mensagem ficou sem resposta (e o lead sem cadastro) para sempre.
 * Sem banco, sem Kommo: as dependências são trocadas.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { _semearParaTeste } from './automacoes-estado.js';
import { _semearCrmParaTeste } from './crm-compartilhado.js';
import { _limparCacheParaTeste, type DepsDoCadastro } from './cadastro-todo-lead.js';
import { CAMPO_UNIDADE } from './unidade-por-canal.js';
import type { MensagemOficial } from '../services/kommo-talks.service.js';
import type { KommoLead } from '../services/kommo.service.js';
import type { AnuncioDeOrigem } from '../agent/anuncio-de-origem.js';
import {
  IDADE_MAXIMA_DA_ESPERA_MS,
  _limparParaTeste,
  atenderCartaoQueGanhouUnidade,
  deixaMarcaDeCalada,
  falasDoPacienteNaConversa,
  pendentesDe,
  retomarCartoesCalados,
  textosDaEspera,
  type DepsDaVarredura,
  type DepsDoAdiado,
  type PedidoDeTurno,
} from './atendimento-adiado.js';

const DE_ANUNCIO_PARA_TESTE: AnuncioDeOrigem = { titulo: null, anuncio: null, campanha: 'DH Petrópolis · Coluna', plataforma: 'Instagram', origem: 'Meta-Instagram' };
const PET = { id: 'u-pet', slug: 'petropolis', name: 'Petrópolis', spineSyncLeads: true } as unknown as Unit;
const LEAD = 5014067;
const TELEFONE_PACIENTE = '5524988887777';
const INTERNO = '5524999990001';

const hhmm = (h: number, m: number) => new Date(Date.UTC(2026, 10, 3, h, m, 0));
const AGORA = hhmm(17, 46).getTime();
/** Depois do prazo da espera (2 h): o caminho em que não há turno e a decisão é definitiva — o que cadastra sem a IA. */
const DEPOIS_DO_PRAZO = hhmm(17, 14).getTime() + 2 * 3600_000 + 60_000;

const msg = (direcao: 'entrada' | 'saida', em: Date, texto: string, extra: Partial<MensagemOficial> = {}): MensagemOficial => ({
  id: `${direcao}-${em.getTime()}`,
  em,
  direcao,
  autor: direcao === 'entrada' ? 'paciente' : 'equipe',
  autorNome: direcao === 'entrada' ? 'Paciente' : 'Equipe',
  texto,
  anexo: null,
  status: null,
  ...extra,
});

const OLA = msg('entrada', hhmm(17, 14), 'Olá, quero agendar uma avaliação');

function mundo(o: {
  msgs?: MensagemOficial[];
  aberto?: boolean;
  jaHouve?: boolean;
  iniciador?: boolean;
  falhaConversa?: boolean;
  agora?: number;
  reivindicacao?: 'incerto';
  turnoFalha?: boolean;
} = {}) {
  const w = { liberadas: [] as string[], turnos: [] as PedidoDeTurno[], sincronizados: [] as Array<{ leadId: number; soLead?: boolean }>, reivindicadas: new Set<string>(), telefoneLido: [] as string[] };
  const cadastro: DepsDoCadastro = {
    situacaoNaFranquia: async () => 'nova',
    telefoneDaConversa: async () => {
      w.telefoneLido.push('banco');
      return null;
    },
    casamentoLigado: () => true,
    unidadesDoTelefone: async () => ['petropolis'],
    anuncioDoLead: async () => DE_ANUNCIO_PARA_TESTE,
    falasDoPaciente: async () => {
      throw new Error('deveria usar as falas do Kommo');
    },
    avaliarPelaIa: async () => ({ decisao: 'duvida', motivo: 'não deveria ser chamada' }),
  };
  const deps: DepsDoAdiado = {
    agora: () => o.agora ?? AGORA,
    conversaOficial: async () => {
      if (o.falhaConversa) throw new Error('kommo fora');
      return o.msgs ?? [OLA];
    },
    jaHouveMensagemDesde: async () => o.jaHouve ?? false,
    horarioAberto: () => o.aberto ?? true,
    liberar: async (chave) => void (w.reivindicadas.delete(chave), w.liberadas.push(chave)),
    reivindicar: async (chave) => {
      if (o.reivindicacao === 'incerto') return 'incerto';
      if (w.reivindicadas.has(chave)) return 'perdeu';
      w.reivindicadas.add(chave);
      return 'ganhou';
    },
    iniciarTurno:
      o.iniciador === false
        ? null
        : async (p) => {
            if (o.turnoFalha) throw new Error('banco fora');
            w.turnos.push(p);
          },
    sincronizar: async (_u, leadId, op) => void w.sincronizados.push({ leadId, soLead: op.soLead }),
    depsDoCadastro: cadastro,
  };
  return { w, deps, cadastro };
}

const entrada = (telefone: string | null = TELEFONE_PACIENTE) => ({ unit: PET, leadId: LEAD, contactId: 77, telefone });
const ligarCadastro = (estado: 'ligado' | 'seco' = 'ligado') => _semearParaTeste([{ slug: 'petropolis', automacao: 'cadastro-todo-lead', estado }]);

beforeEach(() => {
  _semearParaTeste([]);
  _limparCacheParaTeste();
  _limparParaTeste();
  process.env.NUMEROS_INTERNOS = `recepcao:${INTERNO.slice(-11)}`;
  _semearCrmParaTeste([
    { unitId: 'u-pet', contaUnitId: 'u-pet', rotulo: 'Petrópolis', slug: 'petropolis' },
    { unitId: 'u-cax', contaUnitId: 'u-pet', rotulo: 'Caxias', slug: 'caxias' },
  ]);
});

// ── puras ────────────────────────────────────────────────────────────────────────────────────────

test('o portão só deixa marca quando o cartão ainda pode vir a ser desta unidade', () => {
  assert.equal(deixaMarcaDeCalada('sem-unidade'), true);
  assert.equal(deixaMarcaDeCalada('ilegivel'), true);
  assert.equal(deixaMarcaDeCalada('outra'), false, 'cartão de Caxias: nada a retomar');
  assert.equal(deixaMarcaDeCalada('nao-configurada'), false);
});

test('textosDaEspera descarta a fala sem texto (só mídia); falasDoPacienteNaConversa nunca leva a fala da equipe', () => {
  assert.deepEqual(textosDaEspera({ textos: ['  oi ', '', '  ', 'quero marcar'] }), ['oi', 'quero marcar']);
  const f = falasDoPacienteNaConversa([OLA, msg('saida', hhmm(17, 20), 'Bom dia, aqui é a Mariana'), msg('entrada', hhmm(17, 30), 'tem horário?')]);
  assert.deepEqual(f, ['Olá, quero agendar uma avaliação', 'tem horário?']);
});

// ── o caso real ──────────────────────────────────────────────────────────────────────────────────

test('CASO REAL (5014067): mensagem às 17:14, unidade marcada às 17:46 → o turno da IA é disparado UMA vez, com a fala dela', async () => {
  const { w, deps } = mundo();
  const r = await atenderCartaoQueGanhouUnidade(entrada(), deps);
  assert.equal(r.turno, 'iniciado');
  assert.equal(r.esperouMin, 32, 'a espera registrada é a de verdade: 17:14 → 17:46');
  assert.equal(w.turnos.length, 1);
  assert.deepEqual(w.turnos[0]!.textos, ['Olá, quero agendar uma avaliação']);
  assert.equal(w.turnos[0]!.desde.getTime(), hhmm(17, 14).getTime());
  assert.equal(w.turnos[0]!.telefone, TELEFONE_PACIENTE);
  assert.equal(w.sincronizados.length, 0, 'com o turno iniciado, o cadastro vem do fim dele (processAgent), não daqui');

  // próxima varredura, mesma espera: não dispara de novo
  const segunda = await atenderCartaoQueGanhouUnidade(entrada(), deps);
  assert.equal(segunda.turno, 'nao');
  assert.equal(segunda.motivo, 'ja-reivindicado');
  assert.equal(w.turnos.length, 1, 'resposta em dobro é pior que atraso');
});

test('rajada: várias falas sem resposta viram UM turno, na ordem em que o paciente escreveu', async () => {
  const { w, deps } = mundo({ msgs: [msg('entrada', hhmm(17, 14), 'Olá'), msg('entrada', hhmm(17, 15), 'quero agendar'), msg('entrada', hhmm(17, 16), 'coluna')] });
  await atenderCartaoQueGanhouUnidade(entrada(), deps);
  assert.equal(w.turnos.length, 1);
  assert.deepEqual(w.turnos[0]!.textos, ['Olá', 'quero agendar', 'coluna']);
});

test('já respondido (a SDR falou depois): não há turno — e o cadastro roda com as falas lidas do Kommo', async () => {
  ligarCadastro();
  const { w, deps } = mundo({ msgs: [OLA, msg('saida', hhmm(17, 30), 'Oi! Aqui é a Mariana.')] });
  const r = await atenderCartaoQueGanhouUnidade(entrada(), deps);
  assert.equal(r.turno, 'nao');
  assert.equal(r.motivo, 'sem-espera');
  assert.equal(w.turnos.length, 0);
  assert.deepEqual(w.sincronizados, [{ leadId: LEAD, soLead: true }], 'anúncio + casamento ligado + nome: cadastra como LEAD, nunca paciente');
});

test('o paciente escreveu de novo DEPOIS da marcação (um turno normal já guardou a fala): não duplica o turno', async () => {
  const { w, deps } = mundo({ jaHouve: true });
  const r = await atenderCartaoQueGanhouUnidade(entrada(), deps);
  assert.equal(r.motivo, 'ja-atendido');
  assert.equal(w.turnos.length, 0);
  assert.equal(r.cadastro, undefined, 'o turno que já rodou cadastra no fim dele — daqui seria uma segunda leitura');
});

test('reivindicação incerta ou turno que não sobe: nada fica reivindicado e a varredura tenta de novo (adiar)', async () => {
  const incerta = mundo({ reivindicacao: 'incerto' });
  const a = await atenderCartaoQueGanhouUnidade(entrada(), incerta.deps);
  assert.deepEqual([a.turno, a.motivo], ['adiar', 'reivindicacao-incerta']);
  assert.equal(incerta.w.turnos.length, 0);

  const falha = mundo({ turnoFalha: true });
  const b = await atenderCartaoQueGanhouUnidade(entrada(), falha.deps);
  assert.deepEqual([b.turno, b.motivo], ['adiar', 'falha-ao-iniciar']);
  assert.equal(falha.w.liberadas.length, 1, 'a reivindicação é devolvida');
  assert.equal(falha.w.reivindicadas.size, 0);
});

test('fora do horário da unidade: não acorda a IA agora, ADIA (sem cadastrar nem carimbar) — quando a IA abrir dentro do prazo, responde', async () => {
  ligarCadastro();
  const fechado = mundo({ aberto: false });
  const r = await atenderCartaoQueGanhouUnidade(entrada(), fechado.deps);
  assert.equal(r.turno, 'adiar');
  assert.equal(r.motivo, 'fora-do-horario');
  assert.equal(fechado.w.turnos.length, 0);
  assert.equal(fechado.w.sincronizados.length, 0, 'adiado não cadastra: cada varredura repetiria, e o turno cadastra no fim');

  // varredura: não carimba, conta como aguardando (não como erro)
  const v = varredura('Petrópolis', fechado);
  const rv = await retomarCartoesCalados(PET, false, v.deps);
  assert.deepEqual({ ...rv }, { marcas: 1, retomados: 0, aguardando: 1, deOutra: 0, erros: 0 });
  assert.deepEqual(v.w.tratados, []);

  // a IA abre (mesma espera, ainda dentro de 2 h): UMA resposta
  const aberto = mundo({ aberto: true, agora: AGORA + 14 * 60_000 });
  const rv2 = await retomarCartoesCalados(PET, false, varredura('Petrópolis', aberto).deps);
  assert.equal(rv2.retomados, 1);
  assert.equal(aberto.w.turnos.length, 1);

  // a IA só abre depois do prazo: vira "espera velha", decisão definitiva — cadastra e sai da fila
  const tarde = mundo({ aberto: false, agora: hhmm(17, 14).getTime() + IDADE_MAXIMA_DA_ESPERA_MS + 60_000 });
  const vt = varredura('Petrópolis', tarde);
  vt.deps.agora = () => hhmm(17, 14).getTime() + IDADE_MAXIMA_DA_ESPERA_MS + 60_000;
  assert.equal((await retomarCartoesCalados(PET, false, vt.deps)).retomados, 1);
  assert.equal(tarde.w.turnos.length, 0);
  assert.equal(tarde.w.sincronizados.length, 1);
});

test('espera velha (> 2 h) e só mídia: sem turno, com cadastro', async () => {
  ligarCadastro();
  const velha = mundo({ agora: hhmm(17, 14).getTime() + IDADE_MAXIMA_DA_ESPERA_MS + 60_000 });
  assert.equal((await atenderCartaoQueGanhouUnidade(entrada(), velha.deps)).motivo, 'espera-velha');
  assert.equal(velha.w.turnos.length, 0);
  assert.equal(velha.w.sincronizados.length, 1);

  const midia = mundo({ msgs: [msg('entrada', hhmm(17, 14), '')] });
  assert.equal((await atenderCartaoQueGanhouUnidade(entrada(), midia.deps)).motivo, 'so-midia');
  assert.equal(midia.w.turnos.length, 0);
});

test('Kommo fora ao ler a conversa: nada é feito, nada é reivindicado (a varredura seguinte tenta de novo)', async () => {
  const { w, deps } = mundo({ falhaConversa: true });
  const r = await atenderCartaoQueGanhouUnidade(entrada(), deps);
  assert.equal(r.turno, 'erro');
  assert.equal(w.reivindicadas.size, 0);
  assert.equal(w.turnos.length, 0);
  assert.equal(w.sincronizados.length, 0);
});

test('sem o iniciador registrado (boot incompleto): não inventa turno, adia (a marca fica, nada cadastrado ainda)', async () => {
  ligarCadastro();
  const { w, deps } = mundo({ iniciador: false });
  const r = await atenderCartaoQueGanhouUnidade(entrada(), deps);
  assert.equal(r.motivo, 'sem-iniciador');
  assert.equal(r.turno, 'adiar');
  assert.equal(w.sincronizados.length, 0);
});

// ── as regras do cadastro continuam valendo neste caminho ─────────────────────────────────────────

test('número interno: não cadastra', async () => {
  ligarCadastro();
  const { w, deps } = mundo({ agora: DEPOIS_DO_PRAZO });
  await atenderCartaoQueGanhouUnidade(entrada(INTERNO), deps);
  assert.equal(w.sincronizados.length, 0);
});

test('SECO: decide e loga, não cadastra', async () => {
  ligarCadastro('seco');
  const { w, deps } = mundo({ agora: DEPOIS_DO_PRAZO });
  const r = await atenderCartaoQueGanhouUnidade(entrada(), deps);
  assert.equal(r.cadastro, 'decidido');
  assert.equal(w.sincronizados.length, 0, 'em seco quem decide é a regra de 26/09 (não agendou → não cria)');
});

test('chave cadastro-todo-lead DESLIGADA: nada é cadastrado por este caminho', async () => {
  const { w, deps } = mundo({ agora: DEPOIS_DO_PRAZO });
  await atenderCartaoQueGanhouUnidade(entrada(), deps);
  assert.equal(w.sincronizados.length, 0);
});

test('unidade sem espelhamento de leads (spine_sync_leads=false): nunca cadastra', async () => {
  ligarCadastro();
  const { w, deps } = mundo({ agora: DEPOIS_DO_PRAZO });
  const r = await atenderCartaoQueGanhouUnidade({ ...entrada(), unit: { ...PET, spineSyncLeads: false } as unknown as Unit }, deps);
  assert.equal(r.cadastro, 'pulado');
  assert.equal(w.sincronizados.length, 0);
});

test('orgânico (sem anúncio) com "oi": é dúvida — não cadastra', async () => {
  ligarCadastro();
  const { w, deps, cadastro } = mundo({ agora: DEPOIS_DO_PRAZO, msgs: [msg('entrada', hhmm(17, 14), 'oi')] });
  cadastro.anuncioDoLead = async () => null;
  cadastro.avaliarPelaIa = async () => ({ decisao: 'duvida', motivo: 'só um oi' });
  await atenderCartaoQueGanhouUnidade(entrada(), deps);
  assert.equal(w.sincronizados.length, 0);
});

// ── a varredura: marca do portão × cartão que agora tem unidade ───────────────────────────────────

const cartao = (unidade: string | null): KommoLead => ({
  id: LEAD,
  name: 'Lead',
  status_id: 1,
  pipeline_id: 1,
  custom_fields_values: unidade ? [{ field_id: 9, field_name: CAMPO_UNIDADE, values: [{ value: unidade }] }] : [],
  _embedded: { contacts: [{ id: 77, is_main: true }] },
});

function varredura(unidadeNoCartao: string | null, adiado: ReturnType<typeof mundo>, estadoAnterior: { tratadoEm?: Date | null; marcaEm?: Date } = {}) {
  const w = { tratados: [] as number[], atendidos: 0 };
  const deps: DepsDaVarredura = {
    agora: () => AGORA,
    marcasPendentes: async () => {
      const em = estadoAnterior.marcaEm ?? hhmm(17, 14);
      return estadoAnterior.tratadoEm && estadoAnterior.tratadoEm.getTime() >= em.getTime() ? [] : [{ leadId: LEAD, em }];
    },
    marcarTratado: async (_u, id) => void w.tratados.push(id),
    lerCartao: async () => cartao(unidadeNoCartao),
    telefoneDoContato: async () => TELEFONE_PACIENTE,
    atender: async (e) => {
      w.atendidos++;
      return atenderCartaoQueGanhouUnidade(e, adiado.deps);
    },
  };
  return { w, deps };
}

test('varredura: cartão calado às 17:14 que o robô marca Petrópolis → atende, carimba como tratado, e a varredura seguinte não repete', async () => {
  const adiado = mundo();
  const v = varredura('Petrópolis', adiado);
  const r1 = await retomarCartoesCalados(PET, false, v.deps);
  assert.deepEqual({ ...r1 }, { marcas: 1, retomados: 1, aguardando: 0, deOutra: 0, erros: 0 });
  assert.equal(adiado.w.turnos.length, 1);
  assert.deepEqual(v.w.tratados, [LEAD]);

  const v2 = varredura('Petrópolis', adiado, { tratadoEm: new Date(AGORA) });
  const r2 = await retomarCartoesCalados(PET, false, v2.deps);
  assert.equal(r2.retomados, 0);
  assert.equal(v2.w.atendidos, 0, 'tratado depois da marca: nem lê a conversa');
  assert.equal(adiado.w.turnos.length, 1);
});

test('varredura: o paciente calou de novo DEPOIS do carimbo (marca mais nova que o tratado) → volta a ser tratado', async () => {
  const adiado = mundo();
  const v = varredura('Petrópolis', adiado, { tratadoEm: hhmm(17, 0), marcaEm: hhmm(17, 14) });
  assert.equal((await retomarCartoesCalados(PET, false, v.deps)).retomados, 1);
});

test('varredura: cartão que continua sem unidade espera (sem carimbar); o de Caxias é carimbado e NUNCA atendido nem cadastrado', async () => {
  ligarCadastro();
  const sem = mundo();
  const a = varredura(null, sem);
  const rs = await retomarCartoesCalados(PET, false, a.deps);
  assert.equal(rs.aguardando, 1);
  assert.equal(a.w.atendidos, 0);
  assert.deepEqual(a.w.tratados, []);

  const cax = mundo();
  const b = varredura('Caxias', cax);
  const rc = await retomarCartoesCalados(PET, false, b.deps);
  assert.equal(rc.deOutra, 1);
  assert.equal(b.w.atendidos, 0);
  assert.deepEqual(b.w.tratados, [LEAD], 'sai da fila: não é desta unidade');
  assert.equal(cax.w.turnos.length, 0);
  assert.equal(cax.w.sincronizados.length, 0, 'Caxias nunca na franquia de Petrópolis');
});

test('varredura em modo SECO: não atende, não cadastra, não carimba', async () => {
  ligarCadastro();
  const adiado = mundo();
  const v = varredura('Petrópolis', adiado);
  const r = await retomarCartoesCalados(PET, true, v.deps);
  assert.equal(r.retomados, 0);
  assert.equal(v.w.atendidos, 0);
  assert.deepEqual(v.w.tratados, []);
  assert.equal(adiado.w.turnos.length + adiado.w.sincronizados.length, 0);
});

test('varredura: erro ao ler a conversa não carimba (tenta de novo na próxima)', async () => {
  const adiado = mundo({ falhaConversa: true });
  const v = varredura('Petrópolis', adiado);
  const r = await retomarCartoesCalados(PET, false, v.deps);
  assert.equal(r.erros, 1);
  assert.deepEqual(v.w.tratados, []);
});

test('unidade de Kommo único (sem divisão): a varredura não faz nada', async () => {
  _semearCrmParaTeste([]);
  const adiado = mundo();
  const v = varredura('Petrópolis', adiado);
  const r = await retomarCartoesCalados(PET, false, v.deps);
  assert.equal(r.marcas, 0);
  assert.equal(v.w.atendidos, 0);
});

test('pendentesDe: marca tratada não ocupa vaga; marca nova depois do carimbo volta; as mais novas vêm primeiro', () => {
  const l = (leadId: string, regra: string, h: number, m = 0) => ({ leadId, regra, em: hhmm(h, m) });
  const r = pendentesDe([
    l('1', 'sofia_calada_sem_unidade', 10),
    l('1', 'sofia_retomada_ao_ganhar_unidade', 11), // tratado depois da marca
    l('2', 'sofia_calada_sem_unidade', 9),
    l('3', 'sofia_calada_sem_unidade', 12),
    l('3', 'sofia_retomada_ao_ganhar_unidade', 8), // carimbo velho: o paciente calou de novo depois
    l('x', 'sofia_calada_sem_unidade', 12),
  ]);
  assert.deepEqual(r.map((x) => x.leadId), [3, 2]);
});

// ── o incidente de 03→04/11 (cartão 5044975): a marcação veio 49 s depois da mensagem ──────────────

test('INCIDENTE 5044975: mensagem 04:35:35, cartão vazio, robô marca Petrópolis 49 s depois → a IA responde UMA vez, mesmo com varreduras repetidas', async () => {
  const msgNoMadrugada = msg('entrada', new Date(Date.UTC(2026, 10, 4, 4, 35, 35)), 'Boa noite, quero marcar uma avaliação');
  const agora = Date.UTC(2026, 10, 4, 4, 36, 24);
  const adiado = mundo({ msgs: [msgNoMadrugada], agora });
  const marcaEm = new Date(Date.UTC(2026, 10, 4, 4, 35, 36));
  const v = varredura('Petrópolis', adiado, { marcaEm });
  v.deps.agora = () => agora;

  const r1 = await retomarCartoesCalados(PET, false, v.deps);
  assert.equal(r1.retomados, 1);
  assert.equal(adiado.w.turnos.length, 1, 'a fala parada ganha resposta');
  assert.deepEqual(adiado.w.turnos[0]!.textos, ['Boa noite, quero marcar uma avaliação']);

  // a marca não foi carimbada por algum motivo (falha de banco, outra instância): a trava de reivindicação segura o duplo envio
  const r2 = await retomarCartoesCalados(PET, false, varredura('Petrópolis', adiado, { marcaEm }).deps);
  assert.equal(r2.erros, 0);
  assert.equal(adiado.w.turnos.length, 1, 'a mesma espera nunca dispara dois turnos');
});

test('fala com mais de 2 h na hora em que a unidade chega: não responde (e sai da fila), mas o lead é cadastrado', async () => {
  ligarCadastro();
  const velha = msg('entrada', hhmm(17, 14), 'Olá, quero agendar uma avaliação');
  const agora = hhmm(17, 14).getTime() + 2 * 3600_000 + 60_000;
  const adiado = mundo({ msgs: [velha], agora });
  const v = varredura('Petrópolis', adiado);
  v.deps.agora = () => agora;
  const r = await retomarCartoesCalados(PET, false, v.deps);
  assert.equal(r.retomados, 1, 'decisão definitiva: tratada');
  assert.equal(adiado.w.turnos.length, 0, 'IA não acorda para fala de mais de 2 h');
  assert.deepEqual(v.w.tratados, [LEAD], 'não fica na fila para sempre');
  assert.equal(adiado.w.sincronizados.length, 1);

  // e no limite: 1 h 59 min ainda responde
  const quase = mundo({ msgs: [velha], agora: hhmm(17, 14).getTime() + 119 * 60_000 });
  assert.equal((await atenderCartaoQueGanhouUnidade(entrada(), quase.deps)).turno, 'iniciado');
});
