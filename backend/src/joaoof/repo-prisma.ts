/** O repositório do Joaoof no Postgres do agente (tabelas `joaoof_*`). Ver `repo.ts` para o contrato. */
import { Prisma, type JoaoofDemanda, type JoaoofMemoria } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { agoraUtcSql } from '../lib/sql-tempo.js';
import { cortar, mascarar, trechoCurto } from './privacidade.js';
import {
  CATEGORIAS,
  PRIORIDADES,
  STATUS,
  TIPOS_MEMORIA,
  camposMexidos,
  palavrasDaBusca,
  type AtualizaDemanda,
  type Demanda,
  type JoaoofRepo,
  type Memoria,
} from './repo.js';

const dia = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const emSet = <T extends string>(lista: readonly T[], v: string, padrao: T): T => (lista as readonly string[]).includes(v) ? (v as T) : padrao;

function paraDemanda(d: JoaoofDemanda): Demanda {
  return {
    id: d.id,
    numero: d.numero,
    unidadeSlug: d.unidadeSlug,
    solicitante: d.solicitante,
    titulo: d.titulo,
    descricao: d.descricao,
    trecho: d.trecho,
    categoria: emSet(CATEGORIAS, d.categoria, 'outro'),
    prioridade: emSet(PRIORIDADES, d.prioridade, 'normal'),
    status: emSet(STATUS, d.status, 'aberta'),
    responsavel: d.responsavel,
    prazo: dia(d.prazo),
    prazoTexto: d.prazoTexto,
    fonte: d.fonte,
    fonteRefs: d.fonteRefs,
    camposDoJoao: d.camposDoJoao,
    repeticoes: d.repeticoes,
    motivo: d.motivo,
    notaJoao: d.notaJoao,
    vistaEm: d.vistaEm,
    avisadaEm: d.avisadaEm,
    resolvidaEm: d.resolvidaEm,
    criadoEm: d.criadoEm,
    atualizadoEm: d.atualizadoEm,
  };
}

function paraMemoria(m: JoaoofMemoria): Memoria {
  return { id: m.id, tipo: emSet(TIPOS_MEMORIA, m.tipo, 'fato'), assunto: m.assunto, texto: m.texto, unidadeSlug: m.unidadeSlug, origem: m.origem, usos: m.usos, ativa: m.ativa, criadoEm: m.criadoEm, atualizadoEm: m.atualizadoEm };
}

/** minúsculas e sem acento, sem a extensão `unaccent` (que não está instalada em produção) */
const semAcentoSql = (coluna: Prisma.Sql) => Prisma.sql`translate(lower(${coluna}), 'áàâãäéèêëíìîïóòôõöúùûüç', 'aaaaaeeeeiiiiooooouuuuc')`;
/** o mesmo `translate` do SQL, em JS, para a comparação ser idêntica dos dois lados */
const semAcentoJs = (t: string) => t.toLowerCase().replace(/[áàâãä]/g, 'a').replace(/[éèêë]/g, 'e').replace(/[íìîï]/g, 'i').replace(/[óòôõö]/g, 'o').replace(/[úùûü]/g, 'u').replace(/ç/g, 'c');
const padroes = (palavras: string[]) => palavras.map((p) => `%${p.replace(/[\\%_]/g, '\\$&')}%`);

const doDia = (s: string | null | undefined): Date | null => (s ? new Date(`${s}T00:00:00.000Z`) : null);

export const repoPrisma: JoaoofRepo = {
  async criarDemanda(d) {
    const linha = await prisma.joaoofDemanda.create({
      data: {
        unidadeSlug: d.unidadeSlug ?? null,
        // todo texto livre passa pela máscara AQUI (vale para qualquer chamador): nada de telefone/CPF no banco
        solicitante: trechoCurto(d.solicitante ?? '', 120),
        titulo: trechoCurto(d.titulo, 200),
        descricao: trechoCurto(d.descricao ?? '', 1000),
        trecho: trechoCurto(d.trecho ?? ''),
        categoria: d.categoria ?? 'outro',
        prioridade: d.prioridade ?? 'normal',
        responsavel: d.responsavel ?? 'joao',
        prazo: doDia(d.prazo),
        prazoTexto: trechoCurto(d.prazoTexto ?? '', 120),
        fonte: d.fonte ?? 'grupo',
        fonteRefs: d.fonteRefs ?? [],
        motivo: trechoCurto(d.motivo ?? '', 300),
      },
    });
    return paraDemanda(linha);
  },

  async atualizarDemanda(numero, patch: AtualizaDemanda, porJoao = false) {
    return prisma.$transaction(async (tx) => {
      const atual = await tx.joaoofDemanda.findUnique({ where: { numero } });
      if (!atual) return null;
      const agora = new Date();
      const data: Prisma.JoaoofDemandaUpdateInput = {};
      if (porJoao) data.camposDoJoao = [...new Set([...atual.camposDoJoao, ...camposMexidos(patch)])];
      if (patch.titulo !== undefined) data.titulo = trechoCurto(patch.titulo, 200);
      if (patch.descricao !== undefined) data.descricao = trechoCurto(patch.descricao, 1000);
      if (patch.categoria !== undefined) data.categoria = patch.categoria;
      if (patch.prioridade !== undefined) data.prioridade = patch.prioridade;
      if (patch.responsavel !== undefined) data.responsavel = patch.responsavel;
      if (patch.prazo !== undefined) data.prazo = doDia(patch.prazo);
      if (patch.prazoTexto !== undefined) data.prazoTexto = trechoCurto(patch.prazoTexto, 120);
      if (patch.motivo !== undefined) data.motivo = trechoCurto(patch.motivo, 300);
      if (patch.notaJoao !== undefined) data.notaJoao = trechoCurto(patch.notaJoao, 500);
      if (patch.avisadaEm !== undefined) data.avisadaEm = patch.avisadaEm;
      if (patch.status !== undefined) {
        data.status = patch.status;
        data.resolvidaEm = patch.status === 'feita' || patch.status === 'descartada' ? agora : null;
      }
      if (patch.repeticao) {
        const novas = patch.repeticao.fonteRefs.filter((r) => !atual.fonteRefs.includes(r));
        // o limite protege o tamanho da linha; 500 referências cobrem meses de repetição (cortar cedo faria uma mensagem antiga contar de novo)
        data.fonteRefs = [...atual.fonteRefs, ...novas].slice(-500);
        // só soma com PROVA: ao menos uma mensagem nova (lote lido duas vezes, ou referência que não existe, não soma)
        if (novas.length > 0) data.repeticoes = atual.repeticoes + 1;
        if (patch.repeticao.trecho && !atual.trecho) data.trecho = trechoCurto(patch.repeticao.trecho);
        data.vistaEm = agora;
      }
      const linha = await tx.joaoofDemanda.update({ where: { numero }, data });
      return paraDemanda(linha);
    });
  },

  async buscarDemanda(numero) {
    const l = await prisma.joaoofDemanda.findUnique({ where: { numero } });
    return l ? paraDemanda(l) : null;
  },

  async listarDemandas(f = {}) {
    const palavras = f.texto ? palavrasDaBusca(f.texto) : [];
    const condicoes: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (f.status?.length) condicoes.push(Prisma.sql`status = ANY(${f.status}::text[])`);
    if (f.unidadeSlug) condicoes.push(Prisma.sql`unidade_slug = ${f.unidadeSlug}`);
    // `resolvida_em` é timestamp UTC (Prisma): o instante vai como timestamp UTC também (um Date cru seria lido como hora local e deslocaria 3 h)
    if (f.resolvidaDesde) condicoes.push(Prisma.sql`resolvida_em >= (${f.resolvidaDesde.toISOString()}::timestamptz AT TIME ZONE 'UTC')`);
    // sem acento dos dois lados («relatorio» acha «Relatório»): a comparação do Prisma (`contains`) é sensível a acento
    if (palavras.length) condicoes.push(Prisma.sql`${semAcentoSql(Prisma.sql`titulo || ' ' || descricao || ' ' || solicitante || ' ' || trecho`)} LIKE ANY(${padroes(palavras)}::text[])`);
    // ordem E limite no banco: com centenas de demandas, o corte não pode levar embora justamente as urgentes mais novas
    const ids = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM joaoof_demandas
       WHERE ${Prisma.join(condicoes, ' AND ')}
       ORDER BY CASE prioridade WHEN 'urgente' THEN 0 WHEN 'alta' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, criado_em ASC
       LIMIT ${Math.min(f.limite ?? 50, 300)}`);
    if (ids.length === 0) return [];
    const linhas = await prisma.joaoofDemanda.findMany({ where: { id: { in: ids.map((i) => i.id) } } });
    const porId = new Map(linhas.map((l) => [l.id, l]));
    return ids.map((i) => porId.get(i.id)).filter((l): l is JoaoofDemanda => Boolean(l)).map(paraDemanda);
  },

  async guardarMemoria(m) {
    const assunto = trechoCurto(m.assunto, 160);
    const texto = trechoCurto(m.texto, 1200);
    const unidadeSlug = m.unidadeSlug ?? null;
    // mesma memória = mesmo (tipo, unidade, assunto) SEM acento e sem caixa dos dois lados (o `mode: insensitive` do Prisma ignora a caixa mas NÃO o acento, e duplicava)
    const achada = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM joaoof_memorias
       WHERE ativa = true AND tipo = ${m.tipo} AND unidade_slug IS NOT DISTINCT FROM ${unidadeSlug}::text
         AND ${semAcentoSql(Prisma.sql`assunto`)} = ${semAcentoJs(assunto)}
       LIMIT 1`);
    const existente = achada[0];
    if (existente) return paraMemoria(await prisma.joaoofMemoria.update({ where: { id: existente.id }, data: { texto } }));
    return paraMemoria(await prisma.joaoofMemoria.create({ data: { tipo: m.tipo, assunto, texto, unidadeSlug, origem: m.origem ?? 'telegram' } }));
  },

  /**
   * Busca textual SEM extensão: `to_tsvector('portuguese')` (vem com o Postgres; pgvector e unaccent não estão instalados em produção).
   * Sem resultado, cai em ILIKE por palavra (acento e radical que o dicionário não casa). O vetor fica para depois.
   */
  async buscarMemoria(consulta, opcoes = {}) {
    const limite = Math.min(opcoes.limite ?? 5, 20);
    const unidade = opcoes.unidadeSlug ?? null;
    let linhas = await prisma.$queryRaw<JoaoofMemoria[]>(Prisma.sql`
      SELECT id, tipo, assunto, texto, unidade_slug AS "unidadeSlug", origem, usos, ativa, criado_em AS "criadoEm", atualizado_em AS "atualizadoEm"
        FROM joaoof_memorias
       WHERE ativa = true
         AND (${unidade}::text IS NULL OR unidade_slug IS NULL OR unidade_slug = ${unidade})
         AND to_tsvector('portuguese', assunto || ' ' || texto) @@ websearch_to_tsquery('portuguese', ${consulta})
       ORDER BY ts_rank(to_tsvector('portuguese', assunto || ' ' || texto), websearch_to_tsquery('portuguese', ${consulta})) DESC, atualizado_em DESC
       LIMIT ${limite}`);
    if (linhas.length === 0) {
      const palavras = palavrasDaBusca(consulta).slice(0, 6);
      if (palavras.length) {
        linhas = await prisma.$queryRaw<JoaoofMemoria[]>(Prisma.sql`
          SELECT id, tipo, assunto, texto, unidade_slug AS "unidadeSlug", origem, usos, ativa, criado_em AS "criadoEm", atualizado_em AS "atualizadoEm"
            FROM joaoof_memorias
           WHERE ativa = true
             AND (${unidade}::text IS NULL OR unidade_slug IS NULL OR unidade_slug = ${unidade})
             AND ${semAcentoSql(Prisma.sql`assunto || ' ' || texto`)} LIKE ANY(${padroes(palavras)}::text[])
           ORDER BY atualizado_em DESC
           LIMIT ${limite}`);
      }
    }
    // SQL cru: `updateMany` do Prisma regravaria `atualizado_em` (@updatedAt) e a recência, que desempata a busca, perderia o sentido
    if (linhas.length) await prisma.$executeRaw`UPDATE joaoof_memorias SET usos = usos + 1 WHERE id = ANY(${linhas.map((l) => l.id)}::text[])`;
    return linhas.map(paraMemoria);
  },

  async lerMemoria(id) {
    const m = await prisma.joaoofMemoria.findFirst({ where: { id, ativa: true } });
    return m ? paraMemoria(m) : null;
  },

  async esquecerMemoria(id) {
    const r = await prisma.joaoofMemoria.updateMany({ where: { id, ativa: true }, data: { ativa: false } });
    return r.count > 0;
  },

  async unidades() {
    const l = await prisma.joaoofUnidade.findMany({ where: { ativa: true }, orderBy: { slug: 'asc' } });
    return l.map((u) => ({ slug: u.slug, nome: u.nome, grupoJid: u.grupoJid, notas: u.notas, ativa: u.ativa }));
  },

  async registrarAviso(a) {
    // o índice único (tipo, chave) decide a corrida entre dois processos: quem perde recebe false
    const n = await prisma.$executeRaw`
      INSERT INTO joaoof_avisos (id, tipo, chave, demanda_id, texto, enviado, seco, reservado_em, criado_em)
      VALUES (${`av_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`}, ${a.tipo}, ${a.chave}, ${a.demandaId ?? null}, ${cortar(mascarar(a.texto), 4000)}, ${a.enviado}, ${a.seco}, ${agoraUtcSql}, ${agoraUtcSql})
      ON CONFLICT (tipo, chave) DO NOTHING`;
    return n > 0;
  },

  async marcarAvisoEnviado(tipo, chave, enviado) {
    await prisma.joaoofAviso.updateMany({ where: { tipo, chave }, data: { enviado } });
  },

  async reivindicarReenvio(tipo, chave, minSegundos) {
    // atômico: só uma instância ganha a reserva velha (UPDATE condicional) — a outra recebe 0 linhas e NÃO envia
    const n = await prisma.$executeRaw`
      UPDATE joaoof_avisos SET reservado_em = ${agoraUtcSql}
       WHERE tipo = ${tipo} AND chave = ${chave} AND enviado = false AND seco = false
         AND reservado_em < ${agoraUtcSql} - make_interval(secs => ${minSegundos})`;
    return n > 0;
  },

  async buscarAviso(tipo, chave) {
    const a = await prisma.joaoofAviso.findUnique({ where: { tipo_chave: { tipo, chave } }, select: { enviado: true, seco: true } });
    return a ?? null;
  },

  async anexarConversa(quem, texto) {
    // mascara aqui também: a fala do João pode citar telefone de paciente
    await prisma.joaoofConversa.create({ data: { quem, texto: trechoCurto(texto, 2000) } });
    // guarda ~40: apaga o que passou disso (barato, uma vez por fala)
    const corte = await prisma.joaoofConversa.findMany({ orderBy: { criadoEm: 'desc' }, skip: 40, take: 1, select: { criadoEm: true } });
    if (corte[0]) await prisma.joaoofConversa.deleteMany({ where: { criadoEm: { lte: corte[0].criadoEm } } });
  },

  async ultimasDaConversa(n) {
    const l = await prisma.joaoofConversa.findMany({ orderBy: { criadoEm: 'desc' }, take: n });
    return l.reverse().map((x) => ({ quem: x.quem === 'joao' ? 'joao' : 'joaoof', texto: x.texto, criadoEm: x.criadoEm }));
  },

  async lerEstado<T>(chave: string) {
    const l = await prisma.joaoofEstado.findUnique({ where: { chave } });
    return (l?.valor ?? null) as T | null;
  },

  async gravarEstado(chave, valor) {
    const v = valor as Prisma.InputJsonValue;
    await prisma.joaoofEstado.upsert({ where: { chave }, create: { chave, valor: v }, update: { valor: v } });
  },
};
