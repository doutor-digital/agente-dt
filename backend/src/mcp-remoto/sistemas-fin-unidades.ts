/**
 * Quais empresas do Financeiro um usuário de papel FINANCEIRO enxerga (a lista `fin_unidades` do sistema novo, migration 090/092 do sistemas-dd):
 * `sistemas_preparar_fin_unidades` mostra o antes e o depois (a lista já na grafia oficial, validada pelo banco) e devolve um código;
 * `sistemas_confirmar_fin_unidades` com o código grava. Sempre em dois passos: tirar uma empresa da lista de alguém muda o que essa pessoa vê
 * (lançamentos, vencimentos, pacientes, comprovantes, folha, ponto, colaboradores), e pôr de volta é a única forma de ela voltar a ver.
 *
 * O servidor (sistemas-dd, POST /admin/v1/usuario acao "fin_unidades") só repassa ao banco: quem valida e normaliza cada nome é o gatilho; o passo 1 usa
 * `ensaio: true` (roda e DESFAZ), então um nome errado aparece ANTES de a pessoa aprovar, com a lista das empresas conhecidas. Não muda papel, unidade nem ativo.
 * Quem preparou é quem confirma, o código vale 10 minutos e uma vez; um código de dados, estrutura ou admin não confirma isto (nem o contrário).
 */
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { ErroSistemas } from '../lib/integracoes/sistemas.js';
import { executar } from './ferramenta.js';
import { motivoValido } from './sistemas-admin.js';
import { idUsuario, resolverSistema, VALIDADE_MS, type ContextoSistemas, type PendentesSistemas, type QuemSistemas, type Saida } from './sistemas.js';

const SISTEMA = z.string().optional().describe('qual sistema (slug da unidade onde está cadastrado); pode omitir se só há um ligado');

const textoLista = (l: string[] | null | undefined) => (l && l.length ? l.join('; ') : 'TODAS as empresas');
/** mesma ideia do fin_chave do banco (sem acento, sem caixa, sem espaço sobrando, sem "-UF"): só para comparar listas na prévia; quem decide é o banco */
const chaveNome = (x: string) => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s*-\s*[a-z]{2}$/, '').replace(/\s+/g, ' ').trim();
const mesmaLista = (a: string[] | null, b: string[] | null) => {
  const ka = new Set((a ?? []).map(chaveNome)), kb = new Set((b ?? []).map(chaveNome));
  return ka.size === kb.size && [...ka].every((k) => kb.has(k));
};

function listaDoServidor(v: unknown, o: string): string[] | null {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return v.length ? (v as string[]) : null;
  throw new ErroDeEntrada(`o servidor devolveu ${o} num formato inesperado: não vou continuar`);
}

/** erro 4xx do servidor (nome desconhecido, usuário que não é financeiro…) vira mensagem para a pessoa; o resto (rede, 5xx) sobe como está */
function recusaDoServidor(e: unknown): never {
  if (e instanceof ErroSistemas && e.status !== null && e.status >= 400 && e.status < 500) throw new ErroDeEntrada(`o servidor recusou: ${e.message}`);
  throw e;
}

export async function prepararFinUnidades(
  ctx: ContextoSistemas,
  pendentes: PendentesSistemas,
  quem: QuemSistemas,
  a: { sistema?: string; usuario: string; empresas: string[] | null; motivo: string },
): Promise<Saida> {
  const user_id = idUsuario(a.usuario);
  const motivo = motivoValido(a.motivo);
  if (a.empresas !== null && !(Array.isArray(a.empresas) && a.empresas.length <= 50 && a.empresas.every((x) => typeof x === 'string' && x.trim() && x.length <= 100))) {
    throw new ErroDeEntrada('empresas: uma lista de nomes (até 50) das empresas/unidades que a pessoa PODE ver, ou null para liberar todas');
  }
  const pedido = a.empresas === null || a.empresas.length === 0 ? null : a.empresas.map((x) => x.trim());
  const c = resolverSistema(ctx, a.sistema);
  const lista = (await c.fonte.chamar('GET', '/admin/v1/usuarios', { quem: quem.nome })) as { usuarios?: Array<Record<string, unknown>>; recursos?: unknown };
  const u = (lista.usuarios ?? []).find((x) => x.user_id === user_id);
  if (!u) throw new ErroDeEntrada('usuário não encontrado: use o user_id que sistemas_usuarios devolve');
  // o servidor tem de DIZER que sabe a lista E o ensaio: o passo 1 manda um POST de gravação com ensaio:true, e um servidor que aceitasse a ação e ignorasse o ensaio gravaria sem o ok da pessoa
  if (!Array.isArray(lista.recursos) || !lista.recursos.includes('fin_unidades_ensaio') || !('fin_unidades' in u)) {
    throw new ErroDeEntrada('este servidor ainda não tem a lista de empresas do Financeiro com ensaio (precisa da API nova e da migration 090 no banco): nada foi feito');
  }
  const antes = listaDoServidor(u.fin_unidades, 'a lista atual');
  // quem não é financeiro só pode ter uma lista PARADA limpa (null); gravar lista é só para financeiro
  if (u.papel !== 'financeiro' && !(pedido === null && antes !== null)) throw new ErroDeEntrada(`${String(u.nome)} é "${String(u.papel)}": a lista só vale para o papel financeiro${antes !== null ? '; para tirar a lista que ficou parada, mande empresas = null' : ''}`);
  // ENSAIO no servidor: o banco valida e normaliza cada nome e DESFAZ; nada é gravado
  let r: Saida;
  try {
    r = (await c.fonte.chamar('POST', '/admin/v1/usuario', { corpo: { acao: 'fin_unidades', user_id, valor: pedido, ensaio: true, quem: quem.nome }, quem: quem.nome })) as Saida;
  } catch (e) { recusaDoServidor(e); }
  const depoisBruto = (r.depois as Record<string, unknown> | undefined)?.fin_unidades;
  if (r.ensaio !== true || depoisBruto === undefined) throw new ErroDeEntrada('ATENÇÃO: o servidor não respondeu como ensaio. Se ele aceitou a ação sem entender o ensaio, a lista PODE ter sido gravada: confira com sistemas_usuarios antes de qualquer outra coisa.');
  const depois = listaDoServidor(depoisBruto, 'a lista nova');
  const nome = String(u.nome ?? u.login ?? user_id);
  const login = String(u.login ?? '');
  const chavesDepois = new Set((depois ?? []).map(chaveNome)), chavesAntes = new Set((antes ?? []).map(chaveNome));
  const tira = antes === null ? [] : antes.filter((x) => !chavesDepois.has(chaveNome(x)));
  const poe = depois === null ? [] : depois.filter((x) => !chavesAntes.has(chaveNome(x)));
  const nada = mesmaLista(antes, depois);
  const resumo = [
    `${nome} (login ${login}, financeiro${u.ativo === false ? ' — atenção: o usuário está INATIVO hoje' : ''}): hoje vê ${textoLista(antes)}`,
    `passa a ver ${textoLista(depois)}`,
    nada
      ? 'a lista já é exatamente esta: nada muda.'
      : antes === null && depois !== null
      ? 'ATENÇÃO: o que NÃO está na lista deixa de aparecer para ela já na próxima vez que abrir a tela: lançamentos, vencimentos, pacientes e comprovantes do Financeiro, e colaboradores, ponto, folha e arquivos de folha do RH dessas empresas. Escrever nelas também deixa de ser possível.'
      : depois === null
        ? 'ATENÇÃO: sem lista ela volta a ver TODAS as empresas do grupo (inclusive as que hoje estão escondidas).'
        : `${tira.length ? `deixa de ver: ${tira.join('; ')}. ` : ''}${poe.length ? `passa a ver: ${poe.join('; ')}.` : ''}`,
    'O Caixa (boleto, nota, Asaas) não segue esta lista. "Doutor Digital" na lista também libera a página Clientes.',
  ];
  const id = `fin-${randomBytes(9).toString('hex')}`;
  const expiraEm = pendentes.guardar(id, { usuario: quem.usuario, sistema: c.slug, operacao: 'fin_unidades', tabela: 'rh_usuarios', finUnidades: { usuario: user_id, nome, login, antes, depois, motivo } });
  return {
    sistema: c.slug,
    motivo,
    resumo,
    antes: antes ?? 'todas',
    depois: depois ?? 'todas',
    confirmacao: id,
    expiraEm,
    instrucao: `Nada foi alterado ainda. Mostre o resumo à pessoa e, SÓ se ela aprovar explicitamente, chame sistemas_confirmar_fin_unidades com confirmacao="${id}" (vale ${VALIDADE_MS / 60_000} minutos, uma vez).`,
  };
}

export async function confirmarFinUnidades(
  ctx: ContextoSistemas,
  pendentes: PendentesSistemas,
  quem: QuemSistemas,
  a: { confirmacao: string },
  rastro: { usuario?: string; resultado?: string } = {},
): Promise<Saida> {
  const id = String(a.confirmacao ?? '').trim();
  const p = pendentes.tirar(id, quem.usuario, 'fin_unidades');
  const f = p.finUnidades!;
  rastro.usuario = f.usuario;
  const c = resolverSistema(ctx, p.sistema);
  // a prévia pode ter até 10 minutos: se a lista MUDOU desde então (outra pessoa), o "antes" que foi aprovado está velho — recusa, sem sobrescrever (o código fica gasto: prepare de novo)
  let agora: { usuarios?: Array<Record<string, unknown>> };
  try {
    agora = (await c.fonte.chamar('GET', '/admin/v1/usuarios', { quem: quem.nome })) as { usuarios?: Array<Record<string, unknown>> };
  } catch (e) {
    if (e instanceof ErroSistemas && (e.status === null || e.status >= 500)) { pendentes.devolver(id, p); throw new ErroDeEntrada(`não consegui conferir a lista atual antes de gravar (${e.message}): NADA foi gravado e o código ${id} continua valendo; tente de novo`); }
    throw e;
  }
  const atual = (agora.usuarios ?? []).find((x) => x.user_id === f.usuario);
  if (!atual) throw new ErroDeEntrada('o usuário não existe mais: nada foi gravado');
  if (!mesmaLista(listaDoServidor(atual.fin_unidades, 'a lista atual'), f.antes)) {
    rastro.resultado = 'a lista mudou desde a prévia: nada gravado';
    throw new ErroDeEntrada(`a lista de ${f.nome} MUDOU desde a prévia (agora: ${textoLista(listaDoServidor(atual.fin_unidades, 'a lista atual'))}; a prévia dizia: ${textoLista(f.antes)}). Nada foi gravado: prepare de novo.`);
  }
  let r: Saida;
  try {
    // grava a lista JÁ NORMALIZADA pelo ensaio (o gatilho a aceita igual); repetir dá o mesmo resultado
    r = (await c.fonte.chamar('POST', '/admin/v1/usuario', { corpo: { acao: 'fin_unidades', user_id: f.usuario, valor: f.depois, quem: quem.nome }, quem: quem.nome })) as Saida;
  } catch (e) {
    if (e instanceof ErroSistemas && (e.status === null || e.status >= 500 || [408, 409, 429].includes(e.status))) {
      rastro.resultado = 'sem resposta: resultado incerto';
      pendentes.devolver(id, p); // idempotente: o código volta
      throw new ErroDeEntrada(`NÃO sei se a lista foi gravada (${e.message}). Confira com sistemas_usuarios antes de repetir; o código ${id} continua valendo.`);
    }
    rastro.resultado = `recusado: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
    return recusaDoServidor(e);
  }
  if (r.ok === false) {
    const erro = String(r.erro ?? 'o servidor recusou sem dizer o motivo').slice(0, 300);
    rastro.resultado = `recusado: ${erro}`;
    throw new ErroDeEntrada(`o servidor NÃO gravou: ${erro}`);
  }
  rastro.resultado = 'ok';
  return {
    sistema: c.slug,
    ok: r.ok ?? true,
    usuario: f.nome,
    antes: f.antes ?? 'todas',
    depois: listaDoServidor((r.depois as Record<string, unknown> | undefined)?.fin_unidades, 'a lista gravada') ?? 'todas',
    backup_id: r.backup_id,
    registro: 'A mudança ficou no registro do sistema (sistemas_log) com quem pediu, o antes e o depois. Para desfazer: prepare de novo com a lista de antes.',
  };
}

/** A auditoria do conector leva o usuário (id) e o código, sem nome nem login. */
function auditarFin(auditar: Auditar): Auditar {
  return (r) => {
    const a = (r.argumentos ?? {}) as Record<string, unknown>;
    auditar({ ...r, argumentos: { sistema: a.sistema, usuario: a.usuario, empresas: a.empresas, motivo: a.motivo, confirmacao: a.confirmacao, resultado: a.resultado } });
  };
}

export function registrarFinUnidadesSistemas(server: McpServer, ctx: ContextoSistemas, pendentes: PendentesSistemas, quem: QuemSistemas, auditarBruto: Auditar): void {
  const auditar = auditarFin(auditarBruto);
  server.registerTool(
    'sistemas_preparar_fin_unidades',
    {
      title: 'Sistema novo (RH/Caixa): preparar a lista de empresas do Financeiro de um usuário',
      description:
        'PASSO 1 de 2 para dizer QUAIS empresas/unidades um usuário de papel FINANCEIRO enxerga e altera no Financeiro (lançamentos, vencimentos, pacientes, comprovantes) e no RH (colaboradores, ponto, folha): ' +
        'usuario = user_id de sistemas_usuarios (tem de ser financeiro); empresas = lista de nomes (ex.: "Balsas-MA", "Instituto Trauma") — SÓ essas aparecem; null ou lista vazia = TODAS. ' +
        'Os nomes válidos: sistemas_consultar "select * from fin_empresas_conhecidas()". NÃO muda nada: o servidor valida cada nome (grafia, acento e "-UF" são normalizados; nome desconhecido volta com a lista das conhecidas) ' +
        'e devolve o antes, o depois e um código. Mostre o resumo à pessoa e só chame sistemas_confirmar_fin_unidades se ela aprovar. Empresa nova de propósito NÃO aparece até entrar na lista.',
      inputSchema: {
        sistema: SISTEMA,
        usuario: z.string().min(1).max(64).describe('user_id (de sistemas_usuarios)'),
        empresas: z.array(z.string().min(1).max(100)).max(50).nullable().describe('nomes das empresas que a pessoa PODE ver; null ou [] = todas'),
        motivo: z.string().min(5).max(300).describe('por que — fica no registro'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => executar('sistemas_preparar_fin_unidades', args, auditar, () => prepararFinUnidades(ctx, pendentes, quem, args)),
  );
  server.registerTool(
    'sistemas_confirmar_fin_unidades',
    {
      title: 'Sistema novo (RH/Caixa): confirmar a lista de empresas do Financeiro',
      description:
        'PASSO 2 de 2: grava a lista de empresas do usuário, com o código de sistemas_preparar_fin_unidades. Só chame depois que a pessoa aprovou o resumo (antes → depois). ' +
        'O código vale 10 minutos e uma vez, só para quem preparou; um código de dados, estrutura ou admin não serve aqui. Fica no registro do sistema (sistemas_log) com o antes e o depois.',
      inputSchema: { confirmacao: z.string().min(4).max(64) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => {
      const rastro: { usuario?: string; resultado?: string } = {};
      const comRastro: Auditar = (r) => auditar({ ...r, argumentos: { confirmacao: (r.argumentos as { confirmacao?: string }).confirmacao, usuario: rastro.usuario, resultado: rastro.resultado ?? (r.ok ? 'ok' : undefined) } });
      return executar('sistemas_confirmar_fin_unidades', args, comRastro, () => confirmarFinUnidades(ctx, pendentes, quem, args, rastro));
    },
  );
}
