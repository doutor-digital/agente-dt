/**
 * MIGRAÇÃO DAS ETAPAS DE UMA CONTA para os nomes da Kommo (Timbó, conta 3, 25/11/2026): a DECISÃO, pura (sem rede nem banco). Quem lê e grava o banco do Chatwoot é
 * `ops/etapas-conta/rodar-na-vps.sh` (psql, SEM callbacks: nada de webhook, régua, notificação); quem escolhe o que trocar é este módulo, testado.
 *
 * Três coisas mudam e as três têm DESFAZER pelo registro (valor de antes de cada linha):
 *  1. a LISTA dos atributos `etapa` e `etapa_tratamento` da conta (a ordem e os nomes da Kommo);
 *  2. a etapa de cada CONVERSA: o nome do molde vira o nome da conta, e as importadas da Kommo que ficaram sem etapa (EM ESPERA, CONFERIR NA FRANQUIA, RETORNO
 *     PÓS-TRATAMENTO) ou em Agendado por falta (NÃO COMPARECEU) vão para a etapa certa — SÓ se a conversa ainda está como a importação a deixou (a que a equipe já mexeu só
 *     é renomeada, nunca reclassificada). «Esperando humano» vira a qualificação + a etiqueta `esperando-humano`;
 *  3. as PASTAS (filtros salvos) que filtram por etapa: os valores passam para os nomes da conta.
 * Etiquetas NUNCA são tiradas (`conferir-etapa` fica: tirar é apagar; a equipe tira quando conferir).
 */
import { papelDaEtapa, papelDaEtapaDoTratamento, nomeParaGravar, nomeDoTratamentoParaGravar, listaDeEtapas, listaDeEtapasDoTratamento, type MapaDeEtapas } from './chatwoot-etapas.js';

const semAcento = (t: string): string => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();

/** Uma conversa como o `psql` a entrega: só id, etapas, etiquetas e a 1ª linha da nota da importação («Na Kommo: COMERCIAL › EM ESPERA …»). Nada de nome, telefone ou texto de paciente. */
export interface ConversaParaMigrar {
  id: number;
  etapa: string | null;
  etapa_tratamento: string | null;
  funil: string | null;
  /** `situacao_consulta` (a NÃO COMPARECEU com consulta futura nasce Agendado + Remarcado: continua Agendado) */
  situacao?: string | null;
  etiquetas: string[];
  /** o id do cartão na Kommo, se a conversa foi criada pela importação */
  kommo: string | null;
  /** «Na Kommo: <funil> › <etapa>…» (o texto até o fim da linha) */
  nota: string | null;
}

export interface TrocaDeConversa {
  id: number;
  /** valor de antes (para o UPDATE só valer se ninguém mexeu, e para o desfazer); null = o atributo não existia */
  etapaAntes: string | null;
  etapaDepois: string | null;
  tratamentoAntes: string | null;
  tratamentoDepois: string | null;
  /** etiqueta a PÔR (nunca tirar) */
  poeEtiqueta: string | null;
  motivo: string;
}

export interface PlanoDasConversas {
  trocas: TrocaDeConversa[];
  /** «de → para»: quantas conversas em cada troca (para a conferência em seco; sem id) */
  contagem: Record<string, number>;
  /** conversas que ficam como estão e o porquê (sem destino na conta, nome desconhecido…) */
  intactas: Record<string, number>;
}

/** O que a importação gravou (nomes do molde) para cada etapa da Kommo: a conversa só é reclassificada se ainda tem um destes valores. */
function queOImportadorGravou(etapaKommo: string): readonly string[] | null {
  switch (semAcento(etapaKommo)) {
    case 'INCOMING LEADS':
    case 'LEADS DE ENTRADA':
      return ['Novo lead'];
    case 'EM QUALIFICACAO':
      return ['Sofia qualifica', 'Esperando humano'];
    case 'AGENDADO':
      return ['Agendado', 'Confirmado'];
    case 'NAO COMPARECEU':
      return ['Agendado'];
    case 'COMPARECEU':
      return ['Compareceu'];
    case 'EM NEGOCIACAO':
      return ['Pós-consulta'];
    case 'GANHO / CONCLUIDO':
      return ['Fechou'];
    case 'PERDIDO':
      return ['Perdido'];
    case 'EM ESPERA':
    case 'CONFERIR NA FRANQUIA':
    case 'RETORNO POS-TRATAMENTO':
      return ['']; // sem etapa + etiqueta conferir-etapa
    default:
      return null;
  }
}

/** «Na Kommo: COMERCIAL › EM ESPERA — esta etapa…» → { funil: 'COMERCIAL', etapa: 'EM ESPERA' } */
export function etapaDaNota(nota: string | null | undefined): { funil: string; etapa: string } | null {
  const m = /Na Kommo:\s*([^›\n]+?)\s*›\s*([^—\n]+?)\s*(?:—|$|\n)/.exec(String(nota ?? ''));
  return m ? { funil: m[1]!.trim(), etapa: m[2]!.trim() } : null;
}

const ETIQUETA_ESPERANDO_HUMANO = 'esperando-humano';

export function decidirConversa(l: ConversaParaMigrar, mapa: MapaDeEtapas): { troca: TrocaDeConversa | null; intacta?: string } {
  const etapa = (l.etapa ?? '').trim();
  const trat = (l.etapa_tratamento ?? '').trim();
  let etapaDepois: string | null = null;
  let tratamentoDepois: string | null = null;
  let poeEtiqueta: string | null = null;
  const motivos: string[] = [];
  let intacta: string | undefined;

  // — funil de Tratamento: renomeia pelo papel
  if (trat) {
    const nome = nomeDoTratamentoParaGravar(mapa, papelDaEtapaDoTratamento(mapa, trat));
    if (nome && nome !== trat) {
      tratamentoDepois = nome;
      motivos.push('tratamento renomeado');
    } else if (!nome) intacta = 'etapa-do-tratamento-sem-destino';
  }

  // — funil Comercial
  const daNota = l.kommo ? etapaDaNota(l.nota) : null;
  const esperado = daNota && semAcento(daNota.funil) === 'COMERCIAL' ? queOImportadorGravou(daNota.etapa) : null;
  if (esperado && esperado.includes(etapa)) {
    // ainda como a importação deixou: a etapa é a que o cartão tem na Kommo
    const kommo = daNota!.etapa;
    const entrada = ['INCOMING LEADS', 'LEADS DE ENTRADA'].includes(semAcento(kommo));
    let papel = entrada ? 'Novo lead' : papelDaEtapa(mapa, kommo);
    // NÃO COMPARECEU na Kommo, mas a consulta foi REMARCADA (a importação a deixou Agendado + Remarcado, de pé): continua Agendado
    const situ = (l.situacao ?? '').trim();
    if (papel === 'Faltou' && situ !== '' && situ !== 'Não compareceu') papel = 'Agendado';
    const nome = nomeParaGravar(mapa, papel);
    const eraHumano = etapa === 'Esperando humano';
    if (nome && nome !== etapa) {
      etapaDepois = nome;
      motivos.push(etapa === '' ? 'importada sem etapa → etapa da Kommo' : 'etapa da Kommo');
    } else if (!nome) intacta = 'etapa-da-kommo-sem-destino-na-conta';
    if (eraHumano && !l.etiquetas.includes(ETIQUETA_ESPERANDO_HUMANO)) poeEtiqueta = ETIQUETA_ESPERANDO_HUMANO;
  } else if (etapa) {
    // a equipe já mexeu (ou não veio da Kommo): só renomeia pelo papel
    const papel = papelDaEtapa(mapa, etapa);
    const nome = nomeParaGravar(mapa, papel);
    if (nome && nome !== etapa) {
      etapaDepois = nome;
      motivos.push('renomeada');
      if (papel === 'Esperando humano' && !l.etiquetas.includes(ETIQUETA_ESPERANDO_HUMANO)) poeEtiqueta = ETIQUETA_ESPERANDO_HUMANO;
    } else if (!nome) intacta = 'etapa-sem-destino-na-conta';
  }

  if (etapaDepois === null && tratamentoDepois === null && poeEtiqueta === null) return { troca: null, ...(intacta ? { intacta } : {}) };
  return {
    troca: {
      id: l.id,
      etapaAntes: l.etapa,
      etapaDepois,
      tratamentoAntes: l.etapa_tratamento,
      tratamentoDepois,
      poeEtiqueta,
      motivo: motivos.join('; ') || 'etiqueta',
    },
    ...(intacta ? { intacta } : {}),
  };
}

export function planoDasConversas(lista: readonly ConversaParaMigrar[], mapa: MapaDeEtapas): PlanoDasConversas {
  const trocas: TrocaDeConversa[] = [];
  const contagem: Record<string, number> = {};
  const intactas: Record<string, number> = {};
  for (const l of lista) {
    const { troca, intacta } = decidirConversa(l, mapa);
    if (intacta) intactas[intacta] = (intactas[intacta] ?? 0) + 1;
    if (!troca) continue;
    trocas.push(troca);
    if (troca.etapaDepois !== null) {
      const k = `etapa: ${troca.etapaAntes?.trim() || '(vazia)'} → ${troca.etapaDepois}`;
      contagem[k] = (contagem[k] ?? 0) + 1;
    }
    if (troca.tratamentoDepois !== null) {
      const k = `etapa_tratamento: ${troca.tratamentoAntes} → ${troca.tratamentoDepois}`;
      contagem[k] = (contagem[k] ?? 0) + 1;
    }
    if (troca.poeEtiqueta) contagem[`+ etiqueta ${troca.poeEtiqueta}`] = (contagem[`+ etiqueta ${troca.poeEtiqueta}`] ?? 0) + 1;
  }
  return { trocas, contagem, intactas };
}

// ── as listas dos atributos ──────────────────────────────────────────────────────────────────────

export function listasDosAtributos(mapa: MapaDeEtapas): { etapa: string[]; etapa_tratamento: string[] } {
  return { etapa: listaDeEtapas(mapa), etapa_tratamento: listaDeEtapasDoTratamento(mapa) };
}

// ── as pastas (filtros salvos) ───────────────────────────────────────────────────────────────────

interface ItemDoFiltro {
  values?: unknown;
  attribute_key?: unknown;
  filter_operator?: unknown;
  query_operator?: unknown;
  [k: string]: unknown;
}
export interface PastaParaMigrar {
  id: number;
  name: string;
  query: { payload?: ItemDoFiltro[] } & Record<string, unknown>;
}
export interface TrocaDePasta {
  id: number;
  nome: string;
  queryAntes: unknown;
  queryDepois: unknown;
}

/** As pastas cujo filtro é «a própria etapa» (sem etapa na Kommo, a pasta usava outra coisa): o nome da pasta diz qual etapa ela é. */
const PASTA_DA_ETAPA: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/^C3\s*·\s*EM ESPERA$/i, 'EM ESPERA', 'Em espera'],
  [/^C4\s*·\s*CONFERIR NA FRANQUIA$/i, 'CONFERIR NA FRANQUIA', 'Conferir na franquia'],
  [/^C6\s*·\s*N[ÃA]O COMPARECEU$/i, 'NÃO COMPARECEU', 'Faltou'],
];

export function decidirPasta(p: PastaParaMigrar, mapa: MapaDeEtapas): TrocaDePasta | null {
  const itens = Array.isArray(p.query?.payload) ? p.query.payload : [];
  const dona = PASTA_DA_ETAPA.find(([re]) => re.test(p.name.trim()));
  let mudou = false;
  let novos: ItemDoFiltro[];
  if (dona) {
    // a pasta passa a filtrar pela etapa de verdade (só vale se a conta tem a etapa)
    if (!mapa.comercial.some((e) => e.papel === dona[2] && e.nome === dona[1])) return null;
    const jaEhPelaEtapa = itens.length === 1 && itens[0]!.attribute_key === 'etapa' && Array.isArray(itens[0]!.values) && (itens[0]!.values as unknown[]).length === 1 && (itens[0]!.values as unknown[])[0] === dona[1];
    if (jaEhPelaEtapa) return null;
    novos = [{ values: [dona[1]], attribute_key: 'etapa', query_operator: null, attribute_model: 'customer_attributes', filter_operator: 'equal_to', custom_attribute_type: 'conversation_attribute' }];
    mudou = true;
  } else {
    novos = itens.map((it) => {
      const chave = it.attribute_key;
      if ((chave !== 'etapa' && chave !== 'etapa_tratamento') || !Array.isArray(it.values)) return it;
      const trad = (v: unknown): string | null => {
        if (typeof v !== 'string') return null;
        const nome = chave === 'etapa' ? nomeParaGravar(mapa, papelDaEtapa(mapa, v)) : nomeDoTratamentoParaGravar(mapa, papelDaEtapaDoTratamento(mapa, v));
        return nome ?? v;
      };
      const valores = [...new Set((it.values as unknown[]).map(trad).filter((x): x is string => x !== null))];
      if (JSON.stringify(valores) !== JSON.stringify(it.values)) mudou = true;
      return { ...it, values: valores };
    });
  }
  return mudou ? { id: p.id, nome: p.name, queryAntes: p.query, queryDepois: { ...p.query, payload: novos } } : null;
}

export function planoDasPastas(pastas: readonly PastaParaMigrar[], mapa: MapaDeEtapas): TrocaDePasta[] {
  return pastas.map((p) => decidirPasta(p, mapa)).filter((t): t is TrocaDePasta => t !== null);
}

// ── o SQL (e o registro para desfazer) ───────────────────────────────────────────────────────────

const aspas = (t: string): string => `'${t.replace(/'/g, "''")}'`;
const json = (v: unknown): string => `${aspas(JSON.stringify(v))}::jsonb`;
const inteiro = (n: number): number => {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`número inválido no SQL: ${String(n)}`);
  return n;
};

export interface EntradaDoSql {
  conta: number;
  /** a lista do atributo ANTES (para o desfazer); null = não existe na conta (aí não se troca) */
  listasAntes: { etapa: string[] | null; etapa_tratamento: string[] | null };
  listas: { etapa: string[]; etapa_tratamento: string[] };
  trocas: readonly TrocaDeConversa[];
  pastas: readonly TrocaDePasta[];
}

/**
 * O SQL da migração, numa transação só (se uma linha falha, nada muda), e o REGISTRO (uma linha JSON por troca, com o valor de ANTES) que o desfazer lê. Cada UPDATE de conversa só vale
 * se o valor ainda é o que o plano viu (a equipe mexeu no meio: aquela linha fica como está). Sem callbacks: nada de webhook, régua nem notificação; `updated_at` NÃO muda (a ordem da lista
 * de conversas e o «parada há» ficam como estão).
 */
/** A conversa está na etapa que a troca pôs (a troca valeu): condição para pôr a etiqueta junto. */
function condicaoDaTroca(t: TrocaDeConversa): string {
  const partes: string[] = [];
  if (t.etapaDepois !== null) partes.push(`custom_attributes->>'etapa' = ${aspas(t.etapaDepois)}`);
  if (t.tratamentoDepois !== null) partes.push(`custom_attributes->>'etapa_tratamento' = ${aspas(t.tratamentoDepois)}`);
  return partes.length ? partes.join(' AND ') : 'true';
}

export function sqlDaMigracao(e: EntradaDoSql): { sql: string; registro: string[] } {
  const conta = inteiro(e.conta);
  const sql: string[] = ['BEGIN;'];
  const reg: string[] = [];
  for (const chave of ['etapa', 'etapa_tratamento'] as const) {
    const antes = e.listasAntes[chave];
    if (antes === null) continue;
    sql.push(`UPDATE custom_attribute_definitions SET attribute_values = ${json(e.listas[chave])} WHERE account_id = ${conta} AND attribute_key = ${aspas(chave)} AND attribute_model = 0;`);
    reg.push(JSON.stringify({ tipo: 'lista', conta, chave, antes, depois: e.listas[chave] }));
  }
  for (const t of e.trocas) {
    const id = inteiro(t.id);
    const campo = (chave: 'etapa' | 'etapa_tratamento', antes: string | null, depois: string | null): void => {
      if (depois === null) return;
      sql.push(
        `UPDATE conversations SET custom_attributes = jsonb_set(coalesce(custom_attributes, '{}'::jsonb), ${aspas(`{${chave}}`)}, to_jsonb(${aspas(depois)}::text)) WHERE id = ${id} AND account_id = ${conta} AND coalesce(custom_attributes->>${aspas(chave)}, '') = ${aspas(antes ?? '')};`,
      );
    };
    campo('etapa', t.etapaAntes, t.etapaDepois);
    campo('etapa_tratamento', t.tratamentoAntes, t.tratamentoDepois);
    if (t.poeEtiqueta) {
      sql.push(
        // a etiqueta só entra se a troca da etapa VALEU (a conversa está na etapa nova), e nos DOIS lugares que o Chatwoot lê: `taggings` e o cache `cached_label_list` (formato «a, b»)
        `INSERT INTO taggings (tag_id, taggable_type, taggable_id, context, created_at) SELECT g.id, 'Conversation', ${id}, 'labels', now() FROM tags g WHERE g.name = ${aspas(t.poeEtiqueta)} ` +
          `AND EXISTS (SELECT 1 FROM conversations c WHERE c.id = ${id} AND c.account_id = ${conta} AND ${condicaoDaTroca(t)}) ` +
          `AND NOT EXISTS (SELECT 1 FROM taggings x WHERE x.tag_id = g.id AND x.taggable_type = 'Conversation' AND x.taggable_id = ${id} AND x.context = 'labels');`,
      );
      sql.push(
        `UPDATE conversations SET cached_label_list = CASE WHEN coalesce(cached_label_list, '') = '' THEN ${aspas(t.poeEtiqueta)} ELSE cached_label_list || ', ' || ${aspas(t.poeEtiqueta)} END ` +
          `WHERE id = ${id} AND account_id = ${conta} AND ${condicaoDaTroca(t)} AND NOT (${aspas(t.poeEtiqueta)} = ANY (string_to_array(coalesce(cached_label_list, ''), ', ')));`,
      );
    }
    reg.push(JSON.stringify({ tipo: 'conversa', conta, id, etapaAntes: t.etapaAntes, etapaDepois: t.etapaDepois, tratamentoAntes: t.tratamentoAntes, tratamentoDepois: t.tratamentoDepois, poeEtiqueta: t.poeEtiqueta }));
  }
  for (const p of e.pastas) {
    sql.push(`UPDATE custom_filters SET query = ${json(p.queryDepois)} WHERE id = ${inteiro(p.id)} AND account_id = ${conta};`);
    reg.push(JSON.stringify({ tipo: 'pasta', conta, id: p.id, nome: p.nome, queryAntes: p.queryAntes, queryDepois: p.queryDepois }));
  }
  sql.push('COMMIT;');
  return { sql: sql.join('\n') + '\n', registro: reg };
}

/**
 * O SQL do desfazer, a partir das linhas do registro: devolve cada valor ao de ANTES, SÓ onde ainda está o que a migração pôs (o que a equipe mexeu depois não é desfeito).
 * Desfazer a etiqueta que a migração PÔS apaga essa linha (e só ela): por isso o runner só aplica com a confirmação explícita.
 */
export function sqlDoDesfazer(linhas: readonly string[]): string {
  const sql: string[] = ['BEGIN;'];
  for (const l of linhas) {
    let r: Record<string, any>;
    try {
      r = JSON.parse(l);
    } catch {
      continue;
    }
    if (r.tipo === 'lista') {
      // só se a lista ainda é a que a migração pôs (a administradora pode ter mexido depois)
      sql.push(`UPDATE custom_attribute_definitions SET attribute_values = ${json(r.antes)} WHERE account_id = ${inteiro(r.conta)} AND attribute_key = ${aspas(String(r.chave))} AND attribute_model = 0 AND attribute_values = ${json(r.depois)};`);
    } else if (r.tipo === 'conversa') {
      const id = inteiro(r.id);
      const conta = inteiro(r.conta);
      for (const [chave, antes, depois] of [['etapa', r.etapaAntes, r.etapaDepois], ['etapa_tratamento', r.tratamentoAntes, r.tratamentoDepois]] as const) {
        if (depois === null || depois === undefined) continue;
        const novo = antes === null || antes === undefined ? `custom_attributes - ${aspas(chave)}` : `jsonb_set(coalesce(custom_attributes, '{}'::jsonb), ${aspas(`{${chave}}`)}, to_jsonb(${aspas(String(antes))}::text))`;
        sql.push(`UPDATE conversations SET custom_attributes = ${novo} WHERE id = ${id} AND account_id = ${conta} AND custom_attributes->>${aspas(chave)} = ${aspas(String(depois))};`);
      }
      if (r.poeEtiqueta) {
        sql.push(`DELETE FROM taggings WHERE taggable_type = 'Conversation' AND taggable_id = ${id} AND context = 'labels' AND tag_id = (SELECT id FROM tags WHERE name = ${aspas(String(r.poeEtiqueta))});`);
        sql.push(`UPDATE conversations SET cached_label_list = array_to_string(array_remove(string_to_array(coalesce(cached_label_list, ''), ', '), ${aspas(String(r.poeEtiqueta))}), ', ') WHERE id = ${id} AND account_id = ${conta};`);
      }
    } else if (r.tipo === 'pasta') {
      sql.push(`UPDATE custom_filters SET query = ${json(r.queryAntes)} WHERE id = ${inteiro(r.id)} AND account_id = ${inteiro(r.conta)} AND query = ${json(r.queryDepois)};`);
    }
  }
  sql.push('COMMIT;');
  return sql.join('\n') + '\n';
}
