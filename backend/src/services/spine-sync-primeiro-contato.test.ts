/**
 * Cadastro de TODO lead no 1º contato (chave `cadastro-lead-primeiro-contato`, 27/11/2026) no caminho REAL do sincronizador.
 * Só a franquia, o Kommo e o banco são falsos; `syncLeadToSpine` é o de produção.
 *
 * O que não pode escapar:
 *  - nunca lead sem nome nem com nome lixo (provisório padronizado), e nunca PACIENTE;
 *  - origem SEMPRE "IA SOFIA" (e sem ela na franquia o lead não sai);
 *  - telefone que já está na franquia (secretária cadastrou primeiro) NÃO vira segundo cadastro;
 *  - a busca que falha NÃO libera a criação, e a próxima mensagem tenta de novo;
 *  - duas mensagens/cartões do mesmo telefone ao mesmo tempo criam UM lead só.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Unit } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { SpineService } from './spine.service.js';
import { KommoClient } from './kommo.service.js';
import { _semearParaTeste } from '../lib/automacoes-estado.js';
import { limparCacheEsquema } from '../lib/kommo-schema.js';
import { syncLeadToSpine, type DepsDoPrimeiroContato } from './spine-sync.service.js';
import { MOTIVO_SEM_CASAMENTO } from '../lib/cadastro-todo-lead.js';
import { _limparRecentesParaTeste, type JaCadastrado } from '../lib/franquia-ja-cadastrado.js';
import type { ConferenciaDaOrigem } from '../lib/franquia-origem-ia.js';

const feitos: string[] = [];
const leadsCriados: Array<Record<string, unknown>> = [];
const vinculos: Array<Record<string, unknown>> = [];

const spine = SpineService as unknown as Record<string, unknown>;
spine.createLead = async (_u: unknown, payload: Record<string, unknown>) => {
  feitos.push('createLead');
  leadsCriados.push(payload);
  return { ok: true, data: { idLead: 777 } };
};
spine.createClient = async () => {
  feitos.push('createClient');
  return { ok: true, data: { idClient: 888 } };
};
spine.searchClients = async () => ({ ok: true, data: { clients: [] } });

let titulo = 'Maria Souza Lima';
let nomeDoContato: string | null = 'Maria Souza Lima';
let telefoneDoContato: string | null = '+55 11 98888-7777';
let campoOrigem: string | null = 'Instagram';

const kommo = KommoClient.prototype as unknown as Record<string, unknown>;
kommo.getLead = async (id: number) => ({
  id, name: titulo, status_id: 1, pipeline_id: 1,
  custom_fields_values: campoOrigem ? [{ field_id: 2440801, values: [{ value: campoOrigem }] }] : [],
  _embedded: { contacts: [{ id: 5 }] },
});
kommo.getContactBasico = async () => ({ nome: nomeDoContato, telefone: telefoneDoContato });
kommo.getContactPhone = async () => telefoneDoContato;
kommo.listLeadCustomFields = async () => ({ _embedded: { custom_fields: [] } });
kommo.listPipelines = async () => [];
kommo.listLeadsPorTelefone = async () => [];

Object.defineProperty(prisma, 'spineLeadLink', {
  value: {
    findUnique: async () => null,
    findFirst: async () => null,
    upsert: async (a: Record<string, unknown>) => { vinculos.push(a); return {}; },
    update: async () => ({}),
  },
  configurable: true,
});

function unidade(extra: Partial<Unit> = {}): Unit {
  return {
    id: 'u-bebedouro',
    slug: 'doutor-hernia-bebedouro',
    name: 'Bebedouro',
    spineEnabled: true,
    spineToken: 'tok',
    spineBaseUrl: 'https://franquia.teste',
    spineSyncLeads: true,
    spineSyncPatients: true,
    spineIaSourceLeads: false, // de propósito: o 1º contato NÃO depende desta configuração antiga
    spineIaSourceId: 10002,
    spineDefaultSourceId: 20,
    spineTimezone: 'America/Sao_Paulo',
    kommoAccessToken: 'tok',
    kommoSubdomain: 'teste',
    ...extra,
  } as unknown as Unit;
}

const OK_ORIGEM = async (): Promise<ConferenciaDaOrigem> => ({ situacao: 'ok', idSource: 10002, nome: 'IA SOFIA' });
const instantaneo = async <T>(_k: string, fn: () => Promise<T>) => fn();

function deps(o: { achado?: JaCadastrado | (() => Promise<JaCadastrado>); origem?: () => Promise<ConferenciaDaOrigem> } = {}): DepsDoPrimeiroContato & { buscas: number } {
  const d = {
    buscas: 0,
    jaCadastrado: {
      // `verificarJaCadastrado` é o de produção; aqui só o índice e os recentes são falsos.
      async indice() {
        d.buscas++;
        const a = typeof o.achado === 'function' ? await o.achado() : (o.achado ?? { tipo: 'nao' as const });
        if (a.tipo === 'indeterminado') throw new Error(a.motivo);
        if (a.tipo === 'achou') return { entradas: [{ chave: '88887777', origem: a.origem, id: a.id, criado: null }], fresco: true, idadeHoras: 1 };
        return { entradas: [], fresco: true, idadeHoras: 1 };
      },
      agendarIndice() {},
      async recentes() { return new Map(); },
    },
    origem: o.origem ?? OK_ORIGEM,
    espacar: instantaneo as DepsDoPrimeiroContato['espacar'],
  };
  return d as DepsDoPrimeiroContato & { buscas: number };
}

const casamento = (estado: 'ligado' | 'seco' | 'desligado' | null) =>
  _semearParaTeste(estado ? [{ slug: 'doutor-hernia-bebedouro', automacao: 'casamento-jornada', estado }] : []);

beforeEach(() => {
  feitos.length = 0;
  leadsCriados.length = 0;
  vinculos.length = 0;
  titulo = 'Maria Souza Lima';
  nomeDoContato = 'Maria Souza Lima';
  telefoneDoContato = '+55 11 98888-7777';
  campoOrigem = 'Instagram';
  limparCacheEsquema();
  _limparRecentesParaTeste();
  casamento('desligado'); // o 1º contato NÃO exige o casamento (a busca do telefone faz esse papel)
});

const PC = (d: DepsDoPrimeiroContato, telefone: string | null = '5511988887777') => ({ soLead: true, primeiroContato: true, telefone, deps: d });

test('1º contato: cria o LEAD (e só ele) com a origem IA SOFIA, mesmo com spine_ia_source_leads desligado e o casamento desligado', async () => {
  const r = await syncLeadToSpine(unidade(), 10, PC(deps()));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(feitos, ['createLead'], 'nunca cria paciente');
  assert.equal(leadsCriados[0].idSource, 10002);
  assert.equal(leadsCriados[0].name, 'Maria Souza Lima');
  // a origem de marketing não se perde: vai na descrição
  assert.match(String(leadsCriados[0].description), /Origem de marketing: Instagram/);
});

test('SEM NOME: título "Lead 123" e perfil do WhatsApp "Ocupado" (lixo) → "Paciente WhatsApp (final 7777)"', async () => {
  titulo = 'Lead 22261987';
  nomeDoContato = 'Ocupado';
  const r = await syncLeadToSpine(unidade(), 11, PC(deps()));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(leadsCriados[0].name, 'Paciente WhatsApp (final 7777)');
  assert.deepEqual(feitos, ['createLead']);
});

test('sem nome no cartão mas o perfil do WhatsApp passa no filtro: usa o perfil, não o provisório', async () => {
  titulo = 'Lead 22261987';
  nomeDoContato = 'Rosa Maria❤️';
  await syncLeadToSpine(unidade(), 12, PC(deps()));
  assert.equal(leadsCriados[0].name, 'Rosa Maria');
});

test('o nome do cartão (o que o paciente disse) vence o perfil do WhatsApp', async () => {
  titulo = 'Carlos Eduardo Lima';
  nomeDoContato = 'Cadu';
  await syncLeadToSpine(unidade(), 13, PC(deps()));
  assert.equal(leadsCriados[0].name, 'Carlos Eduardo Lima');
});

test('sem nome e o contato do Kommo sem telefone: usa o telefone da conversa para o provisório e para o cadastro', async () => {
  titulo = 'Lead 5';
  nomeDoContato = null;
  telefoneDoContato = null;
  const r = await syncLeadToSpine(unidade(), 14, PC(deps(), '5511977776666'));
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(leadsCriados[0].name, 'Paciente WhatsApp (final 6666)');
  assert.equal(leadsCriados[0].whatsapp, '+5511977776666');
});

test('sem nome E sem telefone em lugar nenhum: não cria (nunca sem nome, nunca com nome lixo)', async () => {
  titulo = 'Lead 5';
  nomeDoContato = null;
  telefoneDoContato = null;
  const r = await syncLeadToSpine(unidade(), 15, PC(deps(), null));
  assert.equal(r.ok, false);
  assert.deepEqual(feitos, []);
});

test('SECRETÁRIA CADASTROU PRIMEIRO (lead): NÃO cria, grava o vínculo com o id do lead e o motivo', async () => {
  const r = await syncLeadToSpine(unidade(), 20, PC(deps({ achado: { tipo: 'achou', origem: 'lead', id: 4321, por: 'indice' } })));
  assert.equal(r.ok, true);
  assert.equal(r.jaExistia, true);
  assert.deepEqual(feitos, []);
  const v = vinculos[0] as { create: Record<string, unknown> };
  assert.equal(v.create.spineIdLead, 4321);
  assert.match(String(v.create.motivo), /lead já existe na franquia \(idLead 4321/);
});

test('SECRETÁRIA CADASTROU PRIMEIRO (paciente): NÃO cria, e o id do paciente fica só no MOTIVO (telefone não prova que é a mesma pessoa)', async () => {
  const r = await syncLeadToSpine(unidade(), 21, PC(deps({ achado: { tipo: 'achou', origem: 'paciente', id: 9001, por: 'indice' } })));
  assert.equal(r.ok, true);
  assert.deepEqual(feitos, []);
  const v = vinculos[0] as { create: Record<string, unknown> };
  assert.equal(v.create.spineIdClient, undefined, 'não carimba idClient por telefone');
  assert.equal(v.create.spineIdLead, undefined);
  assert.match(String(v.create.motivo), /^paciente já existe na franquia \(idClient 9001/);
});

test('A BUSCA FALHOU: NÃO cria e pede nova tentativa na próxima mensagem (retentar)', async () => {
  const r = await syncLeadToSpine(unidade(), 22, PC(deps({ achado: { tipo: 'indeterminado', motivo: 'timeout' } })));
  assert.equal(r.ok, false);
  assert.equal(r.retentar, true);
  assert.deepEqual(feitos, []);
  assert.equal(vinculos.length, 0, 'nada gravado: a próxima tentativa recomeça limpa');
});

test('depois que a busca volta a funcionar, a MESMA conversa cria o lead', async () => {
  let ligada = false;
  const d = deps({ achado: async () => (ligada ? { tipo: 'nao' as const } : { tipo: 'indeterminado' as const, motivo: 'fora' }) });
  assert.equal((await syncLeadToSpine(unidade(), 23, PC(d))).ok, false);
  ligada = true;
  assert.equal((await syncLeadToSpine(unidade(), 23, PC(d))).ok, true);
  assert.deepEqual(feitos, ['createLead']);
});

test('ORIGEM IA SOFIA faltando na franquia: o lead NÃO sai (e nem busca o telefone)', async () => {
  const d = deps({ origem: async () => ({ situacao: 'faltando', motivo: 'a origem 10002 NÃO existe na lista de origens desta franquia' }) });
  const r = await syncLeadToSpine(unidade(), 24, PC(d));
  assert.equal(r.ok, false);
  assert.match(r.motivo ?? '', /origem IA SOFIA/);
  assert.deepEqual(feitos, []);
  assert.equal(d.buscas, 0);
});

test('unidade sem spine_ia_source_id: nunca cai na origem padrão — não cria', async () => {
  const d = deps({ origem: async () => ({ situacao: 'faltando', motivo: 'sem spine_ia_source_id' }) });
  const r = await syncLeadToSpine(unidade({ spineIaSourceId: null } as Partial<Unit>), 25, PC(d));
  assert.equal(r.ok, false);
  assert.deepEqual(feitos, []);
});

test('lista de origens ilegível (403): segue com o id configurado — não é prova de que falta', async () => {
  const d = deps({ origem: async () => ({ situacao: 'nao-deu-para-conferir', idSource: 10002, motivo: '403' }) });
  const r = await syncLeadToSpine(unidade(), 26, PC(d));
  assert.equal(r.ok, true);
  assert.equal(leadsCriados[0].idSource, 10002);
});

test('DUAS mensagens do mesmo telefone ao mesmo tempo: UM lead só (a outra espera a próxima mensagem)', async () => {
  let solta!: () => void;
  const trava = new Promise<void>((r) => { solta = r; });
  const d = deps({ achado: async () => { await trava; return { tipo: 'nao' as const }; } });
  const a = syncLeadToSpine(unidade(), 30, PC(d));
  await new Promise((r) => setTimeout(r, 20));
  const b = await syncLeadToSpine(unidade(), 31, PC(d)); // outro cartão, mesmo telefone
  assert.equal(b.ok, false);
  assert.equal(b.retentar, true);
  solta();
  assert.equal((await a).ok, true);
  assert.deepEqual(feitos, ['createLead']);
});

test('SEM a chave (soLead sozinho, como era): continua exigindo o casamento, com nome do cartão e sem busca nova', async () => {
  const r = await syncLeadToSpine(unidade(), 40, { soLead: true });
  assert.equal(r.ok, false);
  assert.equal(r.motivo, MOTIVO_SEM_CASAMENTO);
  assert.deepEqual(feitos, []);
});

test('SEM a chave e SEM nome: continua não cadastrando (nada de nome provisório fora do 1º contato)', async () => {
  casamento('ligado');
  titulo = 'Lead 22261987';
  nomeDoContato = 'Ocupado';
  const r = await syncLeadToSpine(unidade(), 41, { soLead: true });
  assert.equal(r.ok, false);
  assert.deepEqual(feitos, []);
});

test('SEM a chave, quem agenda (sem soLead): o lead ainda vira paciente na mesma chamada, como sempre', async () => {
  casamento('ligado');
  const r = await syncLeadToSpine(unidade(), 42);
  assert.equal(r.ok, true);
  assert.deepEqual(feitos, ['createLead', 'createClient']);
  assert.equal(leadsCriados[0].idSource, 23, 'origem de marketing (Instagram) como era, com spine_ia_source_leads desligado');
});

test('2º cartão do MESMO número minutos depois: acha o lead que acabamos de criar e NÃO cria outro', async () => {
  // o índice e os recentes (falsos) continuam sem saber do lead; quem sabe é a memória do que acabamos de criar
  const d = deps({ achado: { tipo: 'nao' } });
  assert.equal((await syncLeadToSpine(unidade(), 50, PC(d))).ok, true);
  const segundo = await syncLeadToSpine(unidade(), 51, PC(d));
  assert.equal(segundo.ok, true);
  assert.equal(segundo.jaExistia, true);
  assert.equal(segundo.spineIdLead, 777);
  assert.deepEqual(feitos, ['createLead'], 'um lead só');
});

test('lead achado: o vínculo que já existia como "falhou" passa a "ok" (senão o agendamento duplicaria o lead)', async () => {
  const d = deps({ achado: { tipo: 'achou', origem: 'lead', id: 4321, por: 'indice' } });
  await syncLeadToSpine(unidade(), 53, PC(d));
  const v = vinculos[0] as { update: Record<string, unknown> };
  assert.equal(v.update.status, 'ok');
  assert.equal(v.update.spineIdLead, 4321);
});

test('sem telefone nenhum, não pede retentar (causa permanente: vale a espera de 10 min)', async () => {
  titulo = 'Maria Souza Lima';
  telefoneDoContato = null;
  const r = await syncLeadToSpine(unidade(), 52, PC(deps(), null));
  assert.equal(r.ok, false);
  assert.equal(r.retentar, undefined);
});
