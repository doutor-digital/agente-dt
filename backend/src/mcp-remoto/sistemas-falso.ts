/**
 * O servidor de administração do sistema novo (`/admin/v1`) de mentira, para os testes do conector: um `fetch` que
 * responde como o contrato de docs/ADMIN-API.md — confere a chave, guarda prévias com validade, grava só na confirmação.
 */
import type { ConfigSistemas } from '../lib/integracoes/sistemas.js';

export const CHAVE_FALSA = 'ADMIN-KEY-super-secreta-0123456789';
export const CONFIG_FALSA: ConfigSistemas = { api: 'http://api-rh:8080', chave: CHAVE_FALSA, tela: 'https://rh.exemplo.com.br/app/' };

export interface Chamada {
  metodo: string;
  caminho: string;
  query: string;
  corpo: any;
  chave: string | undefined;
  quem: string | undefined;
}

export interface OpcoesFalso {
  /** erro devolvido na rota /consulta quando o SQL tem "explode" — o texto repete a chave e o endereço, de propósito */
  vazarNoErro?: boolean;
  /** linhas devolvidas por /consulta */
  linhas?: unknown[];
  /** acrescenta ao esquema as tabelas caixa_precos (3 linhas), caixa_vazia e a fechada rh_usuarios */
  maisTabelas?: boolean;
  /** acrescenta um admin (u-3) e um usuário inativo (u-4) à lista de usuários */
  maisUsuarios?: boolean;
  /** servidor NOVO (API com fin_unidades): /usuarios traz a coluna, existe um financeiro (u-5) e POST /usuario aceita acao fin_unidades (com ensaio), como o sistemas-dd */
  comFinanceiro?: boolean;
  /** relógio do servidor, para a prévia vencer */
  agora?: () => number;
  /** servidor ANTES da 0.1.10.8-pol: não informa o dono no /esquema e não conhece o tipo "regra" de /estrutura */
  servidorAntigo?: boolean;
  /** com `servidorAntigo`: a recusa do tipo "regra" chega como 200 { ok:false, erro } em vez de 400 */
  antigoComo200?: boolean;
}

export function servidorAdminFalso(o: OpcoesFalso = {}) {
  const chamadas: Chamada[] = [];
  const agora = o.agora ?? Date.now;
  const funcionarios = [
    { id: 1, nome: 'Ana', cargo: 'Recepção', unidade: 'serra' },
    { id: 2, nome: 'Bruno', cargo: 'Fisio', unidade: 'serra' },
  ];
  const registro: Array<Record<string, unknown>> = [];
  /** o que `POST /admin/v1/estrutura` (admin_sql) recebeu e "executou" */
  const estruturas: Array<Record<string, any>> = [];
  const preparados = new Map<string, { op: string; tabela: string; filtro: Record<string, unknown>; dados: Record<string, unknown>; em: number }>();
  const usuarios = [
    { user_id: 'u-1', login: 'maria', nome: 'Maria', papel: 'gestao', unidade: null, ativo: true, criado_em: '2026-10-01T10:00:00Z' },
    { user_id: 'u-2', login: 'joao', nome: 'João', papel: 'unidade', unidade: 'serra', ativo: true, criado_em: '2026-10-02T10:00:00Z' },
    ...(o.maisUsuarios
      ? [
          { user_id: 'u-3', login: 'ana', nome: 'Ana Admin', papel: 'admin', unidade: null, ativo: true, criado_em: '2026-10-03T10:00:00Z' },
          { user_id: 'u-4', login: 'bia', nome: 'Bia', papel: 'financeiro', unidade: null, ativo: false, criado_em: '2026-10-04T10:00:00Z' },
        ]
      : []),
  ];
  if (o.comFinanceiro) {
    usuarios.push({ user_id: 'u-5', login: 'fin', nome: 'Fin Teste', papel: 'financeiro', unidade: null, ativo: true, criado_em: '2026-10-05T10:00:00Z' });
    for (const u of usuarios as Array<Record<string, unknown>>) u.fin_unidades ??= null;
  }
  const conhecidas = ['Açailândia-MA', 'Balsas-MA', 'Instituto Trauma', 'Magalhães Advocacia', 'Marabá-PA'];
  const chaveNome = (x: string) => x.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s*-\s*[a-z]{2}$/, '').replace(/\s+/g, ' ').trim();
  let n = 0;
  const json = (status: number, corpo: unknown) =>
    ({ ok: status >= 200 && status < 300, status, text: async () => (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)) }) as unknown as Response;

  const buscar = (async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
    const u = new URL(url);
    const corpo = init.body ? JSON.parse(String(init.body)) : null;
    const chave = init.headers['x-admin-key'];
    chamadas.push({ metodo: String(init.method), caminho: u.pathname, query: u.search, corpo, chave, quem: init.headers['x-admin-quem'] });
    if (chave !== CHAVE_FALSA) return json(401, { erro: 'chave inválida' });
    const rota = `${init.method} ${u.pathname}`;
    switch (rota) {
      case 'GET /admin/v1/esquema':
        return json(200, {
          tabelas: [
            { nome: 'rh_funcionarios', linhas: 2, colunas: [{ nome: 'id', tipo: 'int', nulo: false }], rls: true, politicas: [{ nome: 'ver', comando: 'SELECT', usando: 'true', com_check: null }], dono: 'sistemas' },
            { nome: 'caixa_lancamentos', linhas: 0, colunas: [], rls: true, politicas: [], dono: 'sistemas' },
            ...(o.maisTabelas
              ? [
                  { nome: 'caixa_precos', linhas: 3, colunas: [{ nome: 'id', tipo: 'uuid', nulo: false }, { nome: 'servico', tipo: 'text', nulo: false }, { nome: 'valor', tipo: 'numeric', nulo: true }], rls: true, politicas: [], dono: 'rh_ddl' },
                  { nome: 'caixa_vazia', linhas: 0, colunas: [{ nome: 'id', tipo: 'uuid', nulo: false }], rls: true, politicas: [], dono: 'rh_ddl' },
                  { nome: 'rh_usuarios', linhas: 5, colunas: [{ nome: 'user_id', tipo: 'uuid', nulo: false }, { nome: 'papel', tipo: 'text', nulo: false }], rls: true, politicas: [], dono: 'sistemas' },
                  // criada por este caminho, com unidade (text), uma coluna que NÃO é text e as 3 políticas padrão
                  { nome: 'caixa_semaforo', linhas: 4, colunas: [{ nome: 'id', tipo: 'uuid', nulo: false }, { nome: 'unidade', tipo: 'text', nulo: true }, { nome: 'loja', tipo: 'text', nulo: true }, { nome: 'valor', tipo: 'numeric', nulo: true }], rls: true,
                    politicas: ['caixa_semaforo_sel', 'caixa_semaforo_ins', 'caixa_semaforo_upd'].map((nome) => ({ nome, comando: 'SELECT', usando: 'x', com_check: null })), dono: 'rh_ddl' },
                  // criada por este caminho mas com uma política que ele NÃO criou
                  { nome: 'caixa_estranha', linhas: 1, colunas: [{ nome: 'id', tipo: 'uuid', nulo: false }, { nome: 'unidade', tipo: 'text', nulo: true }], rls: true, politicas: [{ nome: 'caixa_estranha_sel', comando: 'SELECT', usando: 'x', com_check: null }, { nome: 'liberada_por_fora', comando: 'ALL', usando: 'true', com_check: null }], dono: 'rh_ddl' },
                  // criada por este caminho com o modelo unidade_le_e_lanca (a política de INSERT usa caixa_pode)
                  { nome: 'caixa_lancada', linhas: 2, colunas: [{ nome: 'id', tipo: 'uuid', nulo: false }, { nome: 'codigo', tipo: 'text', nulo: true }, { nome: 'unidade', tipo: 'text', nulo: true }], rls: true,
                    politicas: [{ nome: 'caixa_lancada_sel', comando: 'SELECT', usando: 'caixa_pode(unidade)', com_check: null, roles: '{authenticated}' }, { nome: 'caixa_lancada_ins', comando: 'INSERT', usando: null, com_check: 'caixa_pode(unidade)', roles: '{authenticated}' }, { nome: 'caixa_lancada_upd', comando: 'UPDATE', usando: 'caixa_gestor()', com_check: 'caixa_gestor()', roles: '{authenticated}' }], dono: 'rh_ddl' },
                  // criada por este caminho, mas com gatilho (o servidor 0.1.10.8-pol informa `especial` no /esquema)
                  { nome: 'caixa_com_gatilho', linhas: 1, colunas: [{ nome: 'id', tipo: 'uuid', nulo: false }, { nome: 'unidade', tipo: 'text', nulo: true }], rls: true, politicas: [], dono: 'rh_ddl', especial: ['gatilho'] },
                  // view do rh_ddl (o /esquema real marca `view: true`)
                  { nome: 'caixa_vista', view: true, linhas: null, colunas: [{ nome: 'unidade', tipo: 'text', nulo: true }], rls: false, politicas: [], dono: 'rh_ddl' },
                  // antiga (dono sistemas), com unidade
                  { nome: 'fin_lanc', linhas: 900, colunas: [{ nome: 'id', tipo: 'text', nulo: false }, { nome: 'unidade', tipo: 'text', nulo: true }], rls: true, politicas: [{ nome: 'fin_lanc_sel', comando: 'SELECT', usando: 'x', com_check: null }], dono: 'sistemas' },
                ]
              : []),
          ].map((t) => (o.servidorAntigo ? Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'dono' && k !== 'especial')) : t)),
          funcoes: [{ nome: 'meu_papel', definicao: 'select 1' }],
          checks: [{ tabela: 'rh_funcionarios', nome: 'cargo_ok', definicao: "check (cargo <> '')" }],
        });
      case 'POST /admin/v1/consulta': {
        if (/explode/.test(corpo.sql)) {
          return json(400, { erro: o.vazarNoErro ? `falha ao falar com ${CONFIG_FALSA.api} usando ${CHAVE_FALSA}` : 'erro de sintaxe' });
        }
        const linhas = o.linhas ?? funcionarios;
        return json(200, { colunas: Object.keys((linhas[0] as object) ?? {}), linhas, cortado: false });
      }
      case 'POST /admin/v1/simular':
        return json(200, corpo.escrever ? { ok: false, erro: 'permission denied for table rh_funcionarios' } : { ok: true, linhas: [{ id: 1 }] });
      case 'GET /admin/v1/usuarios':
        return json(200, { usuarios, ...(o.comFinanceiro ? { recursos: ['fin_unidades_ensaio'] } : {}) });
      case 'GET /admin/v1/log':
        return json(200, { registros: registro.filter((r) => !u.searchParams.get('tabela') || r.tabela === u.searchParams.get('tabela')) });
      case 'POST /admin/v1/preparar': {
        const lista = funcionarios.filter((f) => Object.entries(corpo.filtro ?? {}).every(([k, v]) => (f as Record<string, unknown>)[k] === v));
        const id = `prep-${++n}`;
        preparados.set(id, { op: corpo.op, tabela: corpo.tabela, filtro: corpo.filtro ?? {}, dados: corpo.dados ?? {}, em: agora() });
        return json(200, {
          id,
          resumo: `${corpo.op} em ${corpo.tabela}: ${lista.length} linha(s)`,
          afetadas: lista.length,
          antes: lista,
          depois: lista.map((f) => ({ ...f, ...(corpo.dados ?? {}) })),
        });
      }
      case 'POST /admin/v1/confirmar': {
        const p = preparados.get(corpo.id);
        if (!p) return json(404, { erro: 'prévia desconhecida ou já usada' });
        preparados.delete(corpo.id);
        if (agora() - p.em > 10 * 60_000) return json(410, { erro: 'a prévia venceu (10 minutos): prepare de novo' });
        let afetadas = 0;
        for (const f of funcionarios) {
          if (Object.entries(p.filtro).every(([k, v]) => (f as Record<string, unknown>)[k] === v)) {
            Object.assign(f, p.dados);
            afetadas++;
          }
        }
        registro.push({ tabela: p.tabela, quem: corpo.quem, op: p.op });
        return json(200, { ok: true, afetadas, conferido: true, backup_id: 'bk-1' });
      }
      case 'POST /admin/v1/estrutura':
        // contrato: { tipo, ...campos, sqlAprovado, quem, motivo? } -> 200 { ok:true, sql } | 200 { ok:false, erro } | { erro } nos 4xx/5xx
        // o servidor 0.1.10.6 (admin.ts: `throw new Erro('tipo do pedido: use tabela, coluna ou indice')`, status 400); `antigoComo200` simula a variante em que o texto chegaria como 200 ok:false
        if (o.servidorAntigo && corpo.tipo === 'regra') return o.antigoComo200 ? json(200, { ok: false, erro: 'tipo do pedido: use tabela, coluna ou indice' }) : json(400, { erro: 'tipo do pedido: use tabela, coluna ou indice' });
        if (!['tabela', 'coluna', 'indice', 'regra'].includes(corpo.tipo) || typeof corpo.sqlAprovado !== 'string' || !corpo.sqlAprovado.trim()) return json(400, { erro: 'pedido de estrutura inválido' });
        // servidor 0.1.10.6 REAL: o SQL que ele gera para tabela nova é o de antes (sem revoke/grant explícitos), então o que este conector mostra e manda SEMPRE difere dele — com ou sem `regra`.
        // (coluna e índice têm o mesmo SQL nas duas versões e passam.)
        if (o.servidorAntigo && corpo.tipo === 'tabela') return json(200, { ok: false, erro: 'o SQL que o servidor gera agora é diferente do que foi aprovado (a tabela pode ter mudado desde a prévia): prepare de novo' });
        // servidor 0.1.10.8-pol REAL: a troca de regra exige a impressão das políticas que a prévia viu
        if (corpo.tipo === 'regra' && typeof corpo.politicas_vistas !== 'string') return json(400, { erro: 'falta politicas_vistas (as políticas da tabela que o conector viu na prévia): prepare de novo pelo conector atualizado' });
        if (corpo.nome === 'erro_do_servidor') return json(500, { erro: `falha interna em ${CONFIG_FALSA.api}` });
        if (corpo.nome === 'falha_do_banco') return json(200, { ok: false, erro: 'o SQL mudou desde a prévia: prepare de novo' });
        estruturas.push({ ...corpo });
        registro.push({ tabela: '(estrutura)', quem: corpo.quem, op: 'estrutura' });
        return json(200, { ok: true, sql: String(corpo.sqlAprovado).split(';\n') });
      case 'POST /admin/v1/usuario':
        if (corpo.acao === 'fin_unidades') {
          if (!o.comFinanceiro) return json(400, { erro: 'acao deve ser papel, unidade ou ativo' });
          const alvo = (usuarios as Array<Record<string, any>>).find((x) => x.user_id === corpo.user_id);
          if (!alvo) return json(400, { erro: 'usuário não encontrado' });
          if (alvo.papel !== 'financeiro') return json(400, { erro: `fin_unidades só vale para o papel financeiro (este usuário é ${alvo.papel})` });
          let nova: string[] | null = null;
          if (Array.isArray(corpo.valor) && corpo.valor.length) {
            nova = [];
            for (const x of corpo.valor as string[]) {
              const c = conhecidas.find((k) => chaveNome(k) === chaveNome(x));
              if (!c) return json(400, { erro: `o banco recusou: fin_unidades: "${x}" não é uma empresa/unidade conhecida. Conhecidas: ${conhecidas.join(', ')}` });
              if (!nova.includes(c)) nova.push(c);
            }
            nova.sort();
          }
          const antes = { ...alvo };
          if (corpo.ensaio === true) return json(200, { ok: true, ensaio: true, antes, depois: { ...alvo, fin_unidades: nova } });
          alvo.fin_unidades = nova;
          registro.push({ tabela: 'rh_usuarios', quem: corpo.quem, op: 'fin_unidades', valor: nova });
          return json(200, { ok: true, antes, depois: { ...alvo }, backup_id: 'bk-fin-1' });
        }
        // contrato novo do servidor: admin só com `confirmado_admin: true` (que o conector manda só na confirmação)
        if (corpo.acao === 'papel' && corpo.valor === 'admin' && corpo.confirmado_admin !== true) return json(403, { erro: 'o perfil admin exige confirmado_admin' });
        registro.push({ tabela: 'rh_usuarios', quem: corpo.quem, op: corpo.acao });
        return json(200, { ok: true, antes: { [corpo.acao]: 'x' }, depois: { [corpo.acao]: corpo.valor } });
      case 'POST /admin/v1/convite':
        if (corpo.papel === 'admin' && corpo.confirmado_admin !== true) return json(403, { erro: 'convite de admin exige confirmado_admin' });
        return json(200, { ok: true, token: 'tok123456789abc', caminho: '#a-tok123456789abc' });
      default:
        return json(404, { erro: 'rota inexistente' });
    }
  }) as unknown as typeof fetch;

  return { fetch: buscar, chamadas, funcionarios, registro, preparados, estruturas };
}
