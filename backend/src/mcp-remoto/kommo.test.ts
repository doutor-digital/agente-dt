import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { criarContextoKommo, type FonteKommo, grupoDoLead, kommoBuscarTelefone, kommoLead, kommoLeads, origemDoLead, registrarFerramentasKommo } from './kommo.js';
import { fonteFalsa, leadFalso, unidadeKommo } from './kommo-falso.js';

const leads = [
  leadFalso(1, '2026-09-01T12:00:00Z', { custom_fields_values: [{ field_id: 5, field_name: '⚑ Origem', values: [{ value: 'Instagram' }] }] }),
  leadFalso(2, '2026-09-02T12:00:00Z', { status_id: 142, _embedded: { tags: [{ id: 1, name: 'ORIGEM_GOOGLE' }] } }),
  leadFalso(3, '2026-09-03T12:00:00Z', { status_id: 143 }),
  // 22:30 de SP no dia 30/09 = 01:30 UTC de 01/10: é de setembro
  leadFalso(4, '2026-10-01T01:30:00Z', { status_id: 12, ...({ responsible_user_id: 7 } as object) }),
  leadFalso(5, '2026-10-01T12:00:00Z'),
];

test('origem: campo "⚑ Origem" em qualquer grafia, senão etiqueta ORIGEM_*', () => {
  assert.equal(origemDoLead(leads[0]!), 'Instagram');
  assert.equal(origemDoLead(leads[1]!), 'GOOGLE');
  assert.equal(origemDoLead(leads[2]!), '(sem origem)');
});

test('kommo_leads: período no fuso da unidade, situação, etapa com nome, responsável', async () => {
  const chamadas: Array<[number, number]> = [];
  const ctx = criarContextoKommo(new Map([['doutor-hernia-serra', unidadeKommo('doutor-hernia-serra', fonteFalsa(leads, chamadas))]]));
  const r = (await kommoLeads(ctx, { unidade: 'serra', inicio: '2026-09-01', fim: '2026-09-30', agruparPor: 'etapa' })) as Record<string, any>;
  const s = r.porUnidade['doutor-hernia-serra'];
  assert.equal(s.total, 4); // o das 22h30 do dia 30 entra; o de 01/10 meio-dia não
  assert.deepEqual(s.porSituacao, { aberto: 2, ganho: 1, perdido: 1 });
  assert.equal(s.agrupado['Comercial › Agendado'], 1);
  assert.equal(s.itens.find((l: any) => l.id === 4).responsavel, 'Júlia SDR');
  assert.equal(new Date(chamadas[0]![0] * 1000).toISOString(), '2026-09-01T03:00:00.000Z');
});

test('kommo_leads em várias unidades: a que falha fica fora da rede, com o nome', async () => {
  const quebrada: FonteKommo = { ...fonteFalsa([]), leadsNaJanela: async () => { throw new Error('401 do Kommo'); } };
  const ctx = criarContextoKommo(
    new Map([
      ['doutor-hernia-serra', unidadeKommo('doutor-hernia-serra', fonteFalsa(leads))],
      ['doutor-hernia-canaa', unidadeKommo('doutor-hernia-canaa', quebrada)],
    ]),
  );
  const r = (await kommoLeads(ctx, { unidade: 'todas', inicio: '2026-09-01', fim: '2026-09-30', agruparPor: 'origem' })) as Record<string, any>;
  assert.equal(r.rede.total, 4);
  assert.deepEqual(r.rede.unidadesForaDoTotal, ['doutor-hernia-canaa']);
  assert.match(r.porUnidade['doutor-hernia-canaa'].erro, /401/);
  assert.deepEqual(r.porUnidade['doutor-hernia-serra'].itens, []); // várias unidades: só totais por padrão
});

test('kommo_lead e kommo_buscar_telefone exigem UMA unidade', async () => {
  const ctx = criarContextoKommo(new Map([['doutor-hernia-serra', unidadeKommo('doutor-hernia-serra', fonteFalsa(leads))]]));
  const r = await kommoLead(ctx, { unidade: 'serra', leadId: 2 });
  assert.equal(r.lead.situacao, 'ganho');
  await assert.rejects(kommoLead(ctx, { unidade: 'todas', leadId: 2 }), ErroDeEntrada);
  await assert.rejects(kommoBuscarTelefone(ctx, { unidade: 'serra', telefone: '123' }), /8 dígitos/);
});

test('ferramentas registradas, só leitura, e erro de pedido volta legível', async () => {
  const ctx = criarContextoKommo(new Map([['doutor-hernia-serra', unidadeKommo('doutor-hernia-serra', fonteFalsa(leads))]]));
  const server = new McpServer({ name: 't', version: '0' });
  const auditoria: string[] = [];
  registrarFerramentasKommo(server, ctx, (r) => auditoria.push(`${r.ferramenta}:${r.ok}`));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const c = new Client({ name: 't', version: '0' });
  await Promise.all([server.connect(a), c.connect(b)]);
  const { tools } = await c.listTools();
  assert.deepEqual(tools.map((x) => x.name).sort(), ['kommo_buscar_telefone', 'kommo_funis', 'kommo_lead', 'kommo_leads']);
  assert.ok(tools.every((x) => x.annotations?.readOnlyHint));
  const r = await c.callTool({ name: 'kommo_leads', arguments: { unidade: 'xpto', inicio: '2026-09-01', fim: '2026-09-30' } });
  assert.equal(r.isError, true);
  assert.deepEqual(auditoria, ['kommo_leads:false']);
  await c.close();
});

test('kommo_leads: "todas" com mais de 4 contas é recusado (fila da Sofia); campos do cartão só com comCampos', async () => {
  const contas = new Map(['a', 'b', 'c', 'd', 'e'].map((x) => [`doutor-hernia-${x}`, unidadeKommo(`doutor-hernia-${x}`, fonteFalsa(leads))]));
  const ctx = criarContextoKommo(contas);
  await assert.rejects(kommoLeads(ctx, { unidade: 'todas', inicio: '2026-09-01', fim: '2026-09-30' }), /até 4 unidades/);
  const um = (await kommoLeads(ctx, { unidade: 'a', inicio: '2026-09-01', fim: '2026-09-30', agruparPor: 'Origem' })) as Record<string, any>;
  const item = um.porUnidade['doutor-hernia-a'].itens[0];
  assert.equal('campos' in item, false);
  // agrupar por um campo do cartão funciona mesmo sem devolver os campos na resposta
  assert.equal(um.porUnidade['doutor-hernia-a'].agrupado.Instagram, 1);
  const com = (await kommoLeads(ctx, { unidade: 'a', inicio: '2026-09-01', fim: '2026-09-30', comCampos: true })) as Record<string, any>;
  assert.ok('campos' in com.porUnidade['doutor-hernia-a'].itens[0]);
});

test('origem é o campo chamado EXATAMENTE "Origem" — não "Origem – URL" do rastreio (bug de Marabá)', () => {
  const comRastreio = leadFalso(9, '2026-09-10T12:00:00Z', {
    custom_fields_values: [
      { field_id: 1, field_name: 'Origem – URL', values: [{ value: 'https://fb.me/abc123' }] },
      { field_id: 2, field_name: 'Origem – Campanha', values: [{ value: 'LEADS | WPP' }] },
      { field_id: 3, field_name: '⚑ Origem', values: [{ value: 'Meta-Facebook' }] },
    ],
  });
  assert.equal(origemDoLead(comRastreio), 'Meta-Facebook');
  assert.equal(grupoDoLead(comRastreio, 'campanha'), 'LEADS | WPP');
  assert.equal(grupoDoLead(comRastreio, 'anuncio'), '(sem anuncio)');
  assert.equal(grupoDoLead(leadFalso(10, '2026-09-10T12:00:00Z'), 'campanha'), '(sem campanha)');
});

test('atalhos com os nomes REAIS das contas (cartão de Açailândia, 06/10): ⌂ ID do anúncio, ⌂ URL de origem do clique', () => {
  const real = leadFalso(11, '2026-10-06T12:00:00Z', {
    custom_fields_values: [
      { field_id: 2450006, field_name: '⌂ ID do anúncio', values: [{ value: '120234623594490436' }] },
      { field_id: 2450016, field_name: '⌂ URL de origem do clique', values: [{ value: 'https://www.instagram.com/p/DRznmViDIB-/' }] },
      { field_id: 2449998, field_name: '⚑ Origem', values: [{ value: 'Meta-Instagram' }] },
      { field_id: 2450002, field_name: '⌂ Plataforma de origem', values: [{ value: 'instagram' }] },
    ],
  });
  assert.equal(origemDoLead(real), 'Meta-Instagram'); // o "contém origem" antigo pegava a URL, que vem antes
  assert.equal(grupoDoLead(real, 'anuncio'), '120234623594490436');
  assert.equal(grupoDoLead(real, 'plataforma'), 'instagram');
  assert.equal(grupoDoLead(real, 'campanha'), '(sem campanha)'); // anúncio de post: Meta não devolve campanha
});
