/**
 * Conceder o perfil ADMIN (acesso total ao sistema novo) pelo claude.ai, SEMPRE em dois passos:
 * `sistemas_preparar_admin` mostra quem vira admin (ou quem é convidado como admin) e devolve um código;
 * `sistemas_confirmar_admin` com o código executa. `sistemas_usuario` e `sistemas_convite` recusam "admin" e mandam para cá.
 *
 * Por que ferramentas à parte e não um modo dentro de sistemas_usuario/sistemas_convite: aquelas rodam direto, sem prévia; uma ferramenta
 * que às vezes executa e às vezes só mostra convida o erro (a IA acha que gravou). Aqui o nome diz o que acontece.
 *
 * O servidor (sistemas-dd, /admin/v1/usuario e /convite) só aceita admin quando o corpo traz `confirmado_admin: true`; o conector
 * só manda isso na confirmação (nunca na preparação). Quem preparou é quem confirma, o código vale 10 minutos e uma vez, e um código
 * de dados ou de estrutura não confirma admin (nem o contrário).
 */
import { randomBytes } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { ErroSistemas } from '../lib/integracoes/sistemas.js';
import { executar } from './ferramenta.js';
import { idUsuario, linkDoConvite, resolverSistema, VALIDADE_MS, type ContextoSistemas, type PendentesSistemas, type QuemSistemas, type Saida } from './sistemas.js';

const SISTEMA = z.string().optional().describe('qual sistema (slug da unidade onde está cadastrado); pode omitir se só há um ligado');

function motivoValido(v: unknown): string {
  const m = typeof v === 'string' ? v.trim() : '';
  if (m.length < 5) throw new ErroDeEntrada('diga o motivo em uma frase (mínimo 5 caracteres): quem vira admin e por quê fica no registro');
  return m.slice(0, 300);
}

export async function prepararAdmin(
  ctx: ContextoSistemas,
  pendentes: PendentesSistemas,
  quem: QuemSistemas,
  a: { sistema?: string; acao: 'promover' | 'convite'; usuario?: string; nome?: string; login?: string; motivo: string },
): Promise<Saida> {
  if (a.acao !== 'promover' && a.acao !== 'convite') throw new ErroDeEntrada('acao: use promover (um usuário que já existe) ou convite (alguém novo, como admin)');
  const motivo = motivoValido(a.motivo);
  const c = resolverSistema(ctx, a.sistema);
  const id = `adm-${randomBytes(9).toString('hex')}`;
  let resumo: string[];
  let admin: NonNullable<Parameters<PendentesSistemas['guardar']>[1]['admin']>;
  if (a.acao === 'promover') {
    const user_id = idUsuario(a.usuario);
    const lista = (await c.fonte.chamar('GET', '/admin/v1/usuarios', { quem: quem.nome })) as { usuarios?: Array<Record<string, unknown>> };
    const u = (lista.usuarios ?? []).find((x) => x.user_id === user_id);
    if (!u) throw new ErroDeEntrada('usuário não encontrado: use o user_id que sistemas_usuarios devolve');
    const papelAntes = String(u.papel ?? '');
    if (papelAntes === 'admin') throw new ErroDeEntrada(`${String(u.nome)} já é admin: nada a fazer`);
    const nome = String(u.nome ?? u.login ?? user_id);
    const login = String(u.login ?? '');
    resumo = [
      `${nome} (login ${login}) passa de "${papelAntes}" para ADMIN${u.ativo === false ? ' — atenção: o usuário está INATIVO hoje' : ''}`,
      'ADMIN vê e mexe em tudo no sistema novo (RH, Caixa, financeiro, usuários).',
    ];
    admin = { acao: 'promover', usuario: user_id, nome, login, papelAntes, motivo };
  } else {
    if (!c.tela) throw new ErroDeEntrada('falta o endereço da tela RH na configuração do sistema: cadastre de novo no painel de integrações, com o campo "tela"');
    const nome = a.nome?.trim();
    const login = a.login?.trim();
    if (!nome || !login) throw new ErroDeEntrada('convite precisa de nome e login');
    resumo = [
      `Criar convite de acesso como ADMIN para ${nome} (login ${login}); vale 7 dias e quem receber o link escolhe a própria senha.`,
      'ADMIN vê e mexe em tudo no sistema novo (RH, Caixa, financeiro, usuários): entregue o link só à própria pessoa.',
    ];
    admin = { acao: 'convite', nome, login, motivo };
  }
  const expiraEm = pendentes.guardar(id, { usuario: quem.usuario, sistema: c.slug, operacao: `admin:${a.acao}`, tabela: '', admin });
  return {
    sistema: c.slug,
    acao: a.acao,
    motivo,
    resumo,
    confirmacao: id,
    expiraEm,
    instrucao: `Nada foi alterado ainda. Mostre o resumo à pessoa e, SÓ se ela aprovar explicitamente a concessão de ADMIN, chame sistemas_confirmar_admin com confirmacao="${id}" (vale ${VALIDADE_MS / 60_000} minutos, uma vez).`,
  };
}

export async function confirmarAdmin(
  ctx: ContextoSistemas,
  pendentes: PendentesSistemas,
  quem: QuemSistemas,
  a: { confirmacao: string },
  rastro: { acao?: string; usuario?: string; resultado?: string } = {},
): Promise<Saida> {
  const id = String(a.confirmacao ?? '').trim();
  const p = pendentes.tirar(id, quem.usuario, 'admin');
  const adm = p.admin!;
  rastro.acao = adm.acao;
  if (adm.acao === 'promover') rastro.usuario = adm.usuario;
  const c = resolverSistema(ctx, p.sistema);
  let r: Saida;
  try {
    const bruto = adm.acao === 'promover'
      ? await c.fonte.chamar('POST', '/admin/v1/usuario', { corpo: { acao: 'papel', user_id: adm.usuario, valor: 'admin', quem: quem.nome, confirmado_admin: true }, quem: quem.nome })
      : await c.fonte.chamar('POST', '/admin/v1/convite', { corpo: { nome: adm.nome, login: adm.login, papel: 'admin', quem: quem.nome, confirmado_admin: true }, quem: quem.nome });
    r = bruto && typeof bruto === 'object' ? (bruto as Saida) : {};
  } catch (e) {
    if (e instanceof ErroSistemas && (e.status === null || e.status >= 500)) {
      pendentes.devolver(id, p);
      rastro.resultado = 'sem resposta: resultado incerto';
      throw new ErroDeEntrada(`NÃO sei se o perfil admin foi concedido (${e.message}). Confira com sistemas_usuarios antes de repetir; o código ${id} continua valendo.`);
    }
    rastro.resultado = `recusado: ${e instanceof Error ? e.message : String(e)}`.slice(0, 500);
    throw e;
  }
  rastro.resultado = 'ok';
  if (adm.acao === 'promover') {
    return { sistema: c.slug, ok: r.ok ?? true, usuario: adm.nome, papelAntes: adm.papelAntes, papelDepois: 'admin', antes: r.antes, depois: r.depois, registro: 'A mudança ficou no registro do sistema (sistemas_log) com quem pediu, o antes e o depois.' };
  }
  if (typeof r.caminho !== 'string') {
    rastro.resultado = 'sem caminho do convite';
    throw new ErroDeEntrada('o servidor não devolveu o caminho do convite: nenhum link foi gerado');
  }
  if (!c.tela) throw new ErroDeEntrada('falta o endereço da tela RH na configuração do sistema');
  return {
    sistema: c.slug,
    ok: r.ok ?? true,
    convidado: adm.nome,
    papel: 'admin',
    link: linkDoConvite(c.tela, r.caminho),
    validade: '7 dias',
    aviso: 'Convite de ADMIN: quem receber o link escolhe a própria senha e tem acesso total. Envie só para a pessoa convidada.',
  };
}

/** A auditoria do conector leva o tipo de concessão e o usuário (id), sem nome nem login do convidado. */
function auditarAdmin(auditar: Auditar): Auditar {
  return (r) => {
    const a = (r.argumentos ?? {}) as Record<string, unknown>;
    auditar({ ...r, argumentos: { sistema: a.sistema, acao: a.acao, usuario: a.usuario, motivo: a.motivo, confirmacao: a.confirmacao, resultado: a.resultado } });
  };
}

export function registrarAdminSistemas(server: McpServer, ctx: ContextoSistemas, pendentes: PendentesSistemas, quem: QuemSistemas, auditarBruto: Auditar): void {
  const auditar = auditarAdmin(auditarBruto);
  server.registerTool(
    'sistemas_preparar_admin',
    {
      title: 'Sistema novo (RH/Caixa): preparar concessão de ADMIN',
      description:
        'PASSO 1 de 2 para dar o perfil ADMIN (acesso total) no sistema novo: acao="promover" (usuário que já existe; informe usuario = user_id de sistemas_usuarios) ou ' +
        'acao="convite" (alguém novo; informe nome e login). NÃO muda nada: devolve o resumo (quem vira admin, papel atual → admin) e um código. ' +
        'Mostre o resumo à pessoa e só chame sistemas_confirmar_admin se ela aprovar a concessão de ADMIN. Outros papéis seguem em sistemas_usuario e sistemas_convite.',
      inputSchema: {
        sistema: SISTEMA,
        acao: z.enum(['promover', 'convite']),
        usuario: z.string().max(64).optional().describe('user_id (de sistemas_usuarios) — só em promover'),
        nome: z.string().max(120).optional().describe('só em convite'),
        login: z.string().max(120).optional().describe('só em convite'),
        motivo: z.string().min(5).max(300).describe('por que — fica no registro'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => executar('sistemas_preparar_admin', args, auditar, () => prepararAdmin(ctx, pendentes, quem, args)),
  );
  server.registerTool(
    'sistemas_confirmar_admin',
    {
      title: 'Sistema novo (RH/Caixa): confirmar concessão de ADMIN',
      description:
        'PASSO 2 de 2: concede o perfil ADMIN (ou cria o convite de admin e devolve o link), com o código de sistemas_preparar_admin. Só chame depois que a pessoa aprovou ' +
        'explicitamente. O código vale 10 minutos e uma vez, só para quem preparou; um código de dados ou de estrutura não serve aqui.',
      inputSchema: { confirmacao: z.string().min(4).max(64) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    },
    (args) => {
      const rastro: { acao?: string; usuario?: string; resultado?: string } = {};
      const comRastro: Auditar = (r) => auditar({ ...r, argumentos: { confirmacao: (r.argumentos as { confirmacao?: string }).confirmacao, acao: rastro.acao, usuario: rastro.usuario, resultado: rastro.resultado ?? (r.ok ? 'ok' : undefined) } });
      return executar('sistemas_confirmar_admin', args, comRastro, () => confirmarAdmin(ctx, pendentes, quem, args, rastro));
    },
  );
}
