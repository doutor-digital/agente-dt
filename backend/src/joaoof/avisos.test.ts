import { test } from 'node:test';
import assert from 'node:assert/strict';
import { avisarUrgente, chaveDoResumo, entregar, ESPERA_ANTES_DE_REENVIAR_S, MAX_URGENTES_POR_DIA, textoDoUrgente, type DepsEntrega } from './avisos.js';
import { repoEmMemoria, type Demanda } from './repo.js';
import type { ModoJoaoof } from './config.js';

function montar(modo: ModoJoaoof, enviarOk = true) {
  let agoraMs = new Date('2026-11-27T15:00:00Z').getTime();
  const repo = repoEmMemoria(() => new Date(agoraMs));
  const enviados: string[] = [];
  let ok = enviarOk;
  const deps: DepsEntrega = {
    repo,
    modo: () => modo,
    agora: () => new Date(agoraMs),
    enviar: async (t) => {
      if (ok) enviados.push(t);
      return ok;
    },
  };
  return { repo, deps, enviados, falhar: () => (ok = false), voltar: () => (ok = true), andar: (seg: number) => (agoraMs += seg * 1000) };
}

const urgente = async (repo: ReturnType<typeof repoEmMemoria>, titulo = 'Sofia parou em Parauapebas'): Promise<Demanda> =>
  repo.criarDemanda({ titulo, prioridade: 'urgente', categoria: 'problema_ia', unidadeSlug: 'doutor-hernia-parauapebas', solicitante: 'Heloisa', motivo: 'IA parada', trecho: 'a sofia nao responde ninguem' });

test('desligado: não manda e não registra nada', async () => {
  const { deps, enviados, repo } = montar('desligado');
  assert.equal(await entregar(deps, { tipo: 'resumo', chave: 'k', texto: 'oi' }), 'desligado');
  assert.equal(enviados.length, 0);
  assert.equal(repo._avisos.length, 0);
});

test('seco: registra o que mandaria (seco=true), NÃO chama o Telegram e não repete', async () => {
  const { deps, enviados, repo } = montar('seco');
  assert.equal(await entregar(deps, { tipo: 'resumo', chave: 'k', texto: 'oi' }), 'seco');
  assert.equal(await entregar(deps, { tipo: 'resumo', chave: 'k', texto: 'oi' }), 'repetido');
  assert.equal(enviados.length, 0);
  assert.equal(repo._avisos.length, 1);
  assert.equal(repo._avisos[0]!.seco, true);
  assert.equal(repo._avisos[0]!.chave, 'seco:k');
});

test('o que foi decidido em seco NÃO bloqueia o envio real depois', async () => {
  const seco = montar('seco');
  await entregar(seco.deps, { tipo: 'resumo', chave: 'k', texto: 'oi' });
  const real = { ...seco.deps, modo: () => 'ligado' as const };
  assert.equal(await entregar(real, { tipo: 'resumo', chave: 'k', texto: 'oi' }), 'enviado');
});

test('ligado: manda uma vez; o mesmo assunto não sai de novo', async () => {
  const { deps, enviados } = montar('ligado');
  assert.equal(await entregar(deps, { tipo: 'urgente', chave: 'd:1', texto: 'a' }), 'enviado');
  assert.equal(await entregar(deps, { tipo: 'urgente', chave: 'd:1', texto: 'a' }), 'repetido');
  assert.equal(enviados.length, 1);
});

test('ligado: se o Telegram falha, tenta de novo DEPOIS da reserva envelhecer (não perde o aviso, não duplica)', async () => {
  const { deps, enviados, falhar, voltar, andar } = montar('ligado');
  falhar();
  assert.equal(await entregar(deps, { tipo: 'resumo', chave: 'k', texto: 'oi' }), 'falhou');
  voltar();
  // logo em seguida a reserva ainda é recente: pode ser OUTRA instância enviando agora — não reenvia
  assert.equal(await entregar(deps, { tipo: 'resumo', chave: 'k', texto: 'oi' }), 'repetido');
  andar(ESPERA_ANTES_DE_REENVIAR_S + 1);
  assert.equal(await entregar(deps, { tipo: 'resumo', chave: 'k', texto: 'oi' }), 'enviado');
  assert.deepEqual(enviados, ['oi']);
});

test('duas instâncias ao mesmo tempo: só UMA envia o mesmo urgente (a outra vê reserva recente e fica quieta)', async () => {
  const { deps, enviados } = montar('ligado');
  // a primeira reserva e está «enviando» (demora); a segunda chega no meio
  let solta!: () => void;
  const segura = new Promise<void>((r) => (solta = r));
  const lenta = { ...deps, enviar: async (t: string) => (await segura, enviados.push(t), true) };
  const a = entregar(lenta, { tipo: 'urgente', chave: 'd:42', texto: 'x' });
  await new Promise((r) => setImmediate(r));
  assert.equal(await entregar(deps, { tipo: 'urgente', chave: 'd:42', texto: 'x' }), 'repetido');
  solta();
  assert.equal(await a, 'enviado');
  assert.equal(enviados.length, 1);
});

test('urgente: um aviso por assunto, marca avisadaEm, e o texto traz o motivo e o trecho', async () => {
  const { deps, repo, enviados } = montar('ligado');
  const d = await urgente(repo);
  assert.equal(await avisarUrgente(deps, d, []), 'enviado');
  assert.equal(await avisarUrgente(deps, (await repo.buscarDemanda(d.numero))!, []), 'repetido');
  assert.equal(enviados.length, 1);
  assert.match(enviados[0]!, /🚨 URGENTE #1 · Parauapebas — Heloisa/);
  assert.match(enviados[0]!, /Por quê: IA parada/);
  assert.ok((await repo.buscarDemanda(1))!.avisadaEm);
});

test('urgente: só prioridade urgente e demanda aberta geram aviso', async () => {
  const { deps, repo } = montar('ligado');
  const alta = await repo.criarDemanda({ titulo: 'Pedido comum de arte', prioridade: 'alta' });
  assert.equal(await avisarUrgente(deps, alta, []), 'repetido');
  const feita = await urgente(repo, 'Já resolvido há pouco');
  await repo.atualizarDemanda(feita.numero, { status: 'feita' });
  assert.equal(await avisarUrgente(deps, (await repo.buscarDemanda(feita.numero))!, []), 'repetido');
});

test(`urgente: passou de ${MAX_URGENTES_POR_DIA} no dia, o resto espera o resumo (não vira rajada)`, async () => {
  const { deps, repo, enviados } = montar('ligado');
  const resultados: string[] = [];
  for (let i = 0; i < MAX_URGENTES_POR_DIA + 2; i++) {
    const d = await urgente(repo, `Urgência numero ${i} com texto próprio diferente ${'x'.repeat(i)}`);
    resultados.push(String(await avisarUrgente(deps, d, [])));
  }
  assert.equal(enviados.length, MAX_URGENTES_POR_DIA);
  assert.deepEqual(resultados.slice(-2), ['adiado', 'adiado']);
});

test('textoDoUrgente e chaveDoResumo', () => {
  assert.equal(chaveDoResumo(new Date('2026-11-27T11:00:00Z'), 8), '2026-11-27/08');
  const t = textoDoUrgente({ numero: 7, titulo: 'Titulo', unidadeSlug: null, solicitante: '', motivo: '', trecho: '' } as Demanda, []);
  assert.match(t, /#7 · geral/);
});

test('«marcado como enviado ANTES de enviar»: se ler/gravar falhar depois do envio, o resumo NÃO sai em dobro; se o envio falha, a marca volta', async () => {
  const { deps, repo, enviados } = montar('ligado');
  const original = repo.marcarAvisoEnviado.bind(repo);
  repo.marcarAvisoEnviado = async () => {
    throw new Error('banco caiu depois de enviar');
  };
  // o envio acontece; a marca já estava gravada como enviada desde a reserva → nada de reenviar
  assert.equal(await entregar(deps, { tipo: 'resumo', chave: 'k', texto: 'oi' }), 'enviado');
  assert.equal((await repo.buscarAviso('resumo', 'k'))!.enviado, true);
  assert.equal(await entregar(deps, { tipo: 'resumo', chave: 'k', texto: 'oi' }), 'repetido');
  assert.equal(enviados.length, 1);
  repo.marcarAvisoEnviado = original;
});

test('urgência que o próprio João subiu (campo prioridade dele) não vira 🚨 para ele', async () => {
  const { deps, repo, enviados } = montar('ligado');
  const d = await urgente(repo, 'Demanda que o João mesmo marcou como urgente');
  await repo.atualizarDemanda(d.numero, { prioridade: 'urgente' }, true);
  assert.equal(await avisarUrgente(deps, (await repo.buscarDemanda(d.numero))!, []), 'repetido');
  assert.equal(enviados.length, 0);
});

test('enviar que LANÇA exceção desfaz a marca de enviado (o aviso não fica «enviado» sem ter saído)', async () => {
  const { deps, repo } = montar('ligado');
  const lanca = { ...deps, enviar: async () => { throw new Error('canal mal configurado'); } };
  assert.equal(await entregar(lanca, { tipo: 'urgente', chave: 'd:9', texto: 'x' }), 'falhou');
  assert.equal((await repo.buscarAviso('urgente', 'd:9'))!.enviado, false);
});

test('URGENTE é «pelo menos uma vez»: se gravar a marca falha DEPOIS do envio, o 🚨 é retomado e sai de novo (repetido é melhor que perdido); o resumo continua «no máximo uma»', async () => {
  const { deps, repo, enviados, andar } = montar('ligado');
  const d = await urgente(repo, 'Paciente com dor forte sem retorno há dois dias');
  const original = repo.marcarAvisoEnviado.bind(repo);
  repo.marcarAvisoEnviado = async () => {
    throw new Error('banco caiu depois de enviar');
  };
  assert.equal(await avisarUrgente(deps, d, []), 'enviado');
  assert.equal(enviados.length, 1);
  assert.equal((await repo.buscarAviso('urgente', `d:${d.id}`))!.enviado, false, 'a marca NÃO foi gravada: o aviso segue retomável');
  assert.equal(await avisarUrgente(deps, d, []), 'repetido', 'logo em seguida: a reserva é recente (outra instância pode estar enviando)');
  andar(ESPERA_ANTES_DE_REENVIAR_S + 1);
  repo.marcarAvisoEnviado = original;
  assert.equal(await avisarUrgente(deps, d, []), 'enviado');
  assert.equal(enviados.length, 2, 'saiu de novo (melhor do que perdido)');
  assert.equal(await avisarUrgente(deps, (await repo.buscarDemanda(d.numero))!, []), 'repetido');
  assert.equal(enviados.length, 2);
});

test('urgente: queda do processo ENTRE o registro e o envio não perde o aviso (a linha nasce «não enviada»)', async () => {
  const { deps, repo, andar, enviados } = montar('ligado');
  const d = await urgente(repo, 'Dono de Açailândia ameaçando sair da rede');
  const morre = { ...deps, enviar: async () => { throw new Error('processo morreu'); } };
  assert.equal(await avisarUrgente(morre, d, []), 'falhou');
  assert.equal((await repo.buscarAviso('urgente', `d:${d.id}`))!.enviado, false);
  andar(ESPERA_ANTES_DE_REENVIAR_S + 1);
  assert.equal(await avisarUrgente(deps, d, []), 'enviado');
  assert.equal(enviados.length, 1);
});

test('o texto do aviso é MASCARADO ao gravar (a resposta ao João pode repetir telefone de paciente)', async () => {
  const { deps, repo } = montar('ligado');
  await entregar(deps, { tipo: 'resposta', chave: 'u1', texto: 'liguei para 94 99217-1305, CPF 123.456.789-09' });
  assert.doesNotMatch(repo._avisos[0]!.texto, /\d{8}/);
});

test('o teto diário vale também para urgentes RETOMADAS depois de uma queda do Telegram (não saem 10 🚨 de uma vez)', async () => {
  const { deps, repo, enviados, falhar, voltar, andar } = montar('ligado');
  const ds: Demanda[] = [];
  falhar();
  for (let i = 0; i < MAX_URGENTES_POR_DIA + 4; i++) {
    const d = await urgente(repo, `Urgência retomável numero ${i} com texto diferente ${'x'.repeat(i)}`);
    ds.push(d);
    await avisarUrgente(deps, d, []); // Telegram fora: cada uma vira linha não enviada
  }
  voltar();
  andar(ESPERA_ANTES_DE_REENVIAR_S + 1);
  const resultados: string[] = [];
  for (const d of ds) resultados.push(String(await avisarUrgente(deps, d, [])));
  assert.equal(enviados.length, MAX_URGENTES_POR_DIA);
  assert.equal(resultados.filter((r) => r === 'adiado').length, 4);
});

test('o 🚨 saiu mas a demanda ficou sem avisadaEm (queda entre as gravações): completa e não fica candidata para sempre', async () => {
  const { deps, repo } = montar('ligado');
  const d = await urgente(repo, 'Paciente com dor forte sem retorno há dois dias');
  await repo.registrarAviso({ tipo: 'urgente', chave: `d:${d.id}`, texto: 'x', enviado: true, seco: false });
  assert.equal(await avisarUrgente(deps, d, []), 'repetido');
  assert.ok((await repo.buscarDemanda(d.numero))!.avisadaEm);
});
