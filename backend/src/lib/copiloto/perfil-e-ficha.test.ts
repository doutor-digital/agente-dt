import test from 'node:test';
import assert from 'node:assert/strict';
import type { CampoDoCartaoDaConta, KommoPipeline } from '../../services/kommo.service.js';
import { perfilDaUnidade, regrasDaUnidade } from './perfil-da-unidade.js';
import { fichaViva, textoDaFichaViva } from './ficha-viva.js';
import { montarPrompt } from './prompt.js';

const funis: KommoPipeline[] = [
  { id: 1, name: 'COMERCIAL', is_main: true, statuses: [{ id: 10, name: 'Incoming leads' }, { id: 11, name: 'EM QUALIFICAÇÃO' }, { id: 12, name: 'AGENDADO' }, { id: 13, name: 'COMPARECEU' }] },
];
const def = (id: number, name: string, extra: Partial<CampoDoCartaoDaConta> = {}): CampoDoCartaoDaConta => ({ id, name, type: 'text', enums: [], sort: id, ...extra });
const defs: CampoDoCartaoDaConta[] = [
  def(1, '✎ Queixa', { required_statuses: [{ pipeline_id: 1, status_id: 11 }] }),
  def(2, '★ Qualificação (Quente/Morno/Frio)'),
  def(3, '◷ Data da Consulta'),
  def(4, '✎ Observações', { hidden_statuses: [{ pipeline_id: 1, status_id: 11 }] }),
  def(5, 'utm_source', { type: 'tracking_data' }),
  def(6, 'Campo só da API', { is_api_only: true }),
  def(7, '## Cabeçalho'),
];
const estado = (m: Record<string, 'ligado' | 'seco' | 'desligado'>) => (id: string) => m[id] ?? 'desligado';

test('perfilDaUnidade: Sofia só conta se estiver entregando; etapas dela vêm dos ids permitidos; "seco" NÃO move', () => {
  const p = perfilDaUnidade({ kommoSalesbotExecuteEnabled: true, kommoAllowedStatusIds: [10, 11, 999] }, funis, estado({ 'franquia-move': 'ligado', 'franquia-sync': 'ligado' }));
  assert.deepEqual(p, { temSofia: true, etapasDaSofia: ['Incoming leads', 'EM QUALIFICAÇÃO'], moveAutomatico: true, sincronizaFranquia: true });
  const sem = perfilDaUnidade({ kommoSalesbotExecuteEnabled: false, kommoAllowedStatusIds: [10] }, funis, estado({ 'franquia-move': 'seco', 'franquia-sync': 'desligado' }));
  assert.deepEqual(sem, { temSofia: false, etapasDaSofia: [], moveAutomatico: false, sincronizaFranquia: false });
});

test('regrasDaUnidade: com Sofia e movimento automático a atendente confere e NÃO arrasta cartão', () => {
  const t = regrasDaUnidade({ temSofia: true, etapasDaSofia: ['Incoming leads'], moveAutomatico: true, sincronizaFranquia: true });
  assert.match(t, /TEM a Sofia/);
  assert.match(t, /OLHA e CONFERE/);
  assert.match(t, /Diga "confira", não "preencha"/);
  assert.match(t, /O CARTÃO ANDA SOZINHO/);
  assert.match(t, /NÃO arrasta cartão na mão/);
  assert.match(t, /A cada 15 minutos/);
  assert.match(t, /ACEITE/);
});

test('regrasDaUnidade: sem Sofia e sem movimento automático a atendente faz e move à mão', () => {
  const t = regrasDaUnidade({ temSofia: false, etapasDaSofia: [], moveAutomatico: false, sincronizaFranquia: false });
  assert.match(t, /NÃO tem a Sofia/);
  assert.match(t, /movimentação automática pela franquia está DESLIGADA/);
  assert.match(t, /sincronizador da franquia está desligado/);
});

test('fichaViva: só o que aparece no cartão naquela etapa; obrigatório marcado; técnico, só-API e cabeçalho ficam de fora', () => {
  const f = fichaViva('em qualificacao', funis, defs)!;
  assert.equal(f.etapa, 'EM QUALIFICAÇÃO');
  assert.deepEqual(f.visiveis, ['✎ Queixa', '★ Qualificação (Quente/Morno/Frio)', '◷ Data da Consulta']);
  assert.deepEqual(f.obrigatorios, ['✎ Queixa']);
  const outra = fichaViva('AGENDADO', funis, defs)!;
  assert.ok(outra.visiveis.includes('✎ Observações'), 'oculto só em QUALIFICAÇÃO aparece em AGENDADO');
  assert.equal(fichaViva('CONFERIR NA FRANQUIA', funis, defs), null);
  assert.equal(fichaViva(null, funis, defs), null);
});

test('textoDaFichaViva: marca o que chega sozinho e manda usar só a lista', () => {
  const t = textoDaFichaViva({ etapa: 'AGENDADO', visiveis: ['◷ Data da Consulta', '✎ Queixa'], obrigatorios: [], chegamSozinhos: ['◷ Data da Consulta'] });
  assert.match(t, /◷ Data da Consulta \[chega sozinho\]/);
  assert.match(t, /não exige campo/);
  assert.match(t, /Use SÓ esta lista/);
});

test('montarPrompt: o perfil entra no system e a missão antiga some onde a Sofia ou a franquia fazem', () => {
  const ctx = { etapaNome: 'Incoming leads', etapa: 'Incoming leads', valores: { '✎ Queixa': null }, opcoes: {}, ehLista: {} } as never;
  const perfil = { temSofia: true, etapasDaSofia: ['Incoming leads'], moveAutomatico: true, sincronizaFranquia: true };
  const com = montarPrompt({ ctx, conversa: [], pergunta: 'o que faço?', perfil });
  assert.match(com.system, /COMO ESTA UNIDADE FUNCIONA/);
  assert.doesNotMatch(com.user, /Leia a conversa, salve o nome no título/);
  const sem = montarPrompt({ ctx, conversa: [], pergunta: 'o que faço?', perfil: { ...perfil, temSofia: false, moveAutomatico: false } });
  assert.match(sem.user, /O que se faz nesta etapa:/);
});
