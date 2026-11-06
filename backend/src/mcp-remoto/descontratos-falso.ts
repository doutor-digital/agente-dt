/**
 * O servidor do DESCONTRATOS (`/admin/v1` do sistema `dsc`) de mentira, para os testes do conector. Só tem as 4 rotas que o servidor de verdade tem
 * (esquema, consulta, descontrato/preparar, confirmar) e responde 404 "não existe no Descontratos" a todo o resto, como o real. Chave própria, diferente da do RH.
 */
export const CHAVE_DSC_FALSA = 'ADMIN-KEY-do-descontratos-9876543210abcd';
export const CONFIG_DSC_FALSA = { api: 'http://api-dsc:8080', chave: CHAVE_DSC_FALSA };

export interface ChamadaDsc { metodo: string; caminho: string; corpo: any; chave: string | undefined; quem: string | undefined }

export function servidorDescontratosFalso(o: { agora?: () => number } = {}) {
  const chamadas: ChamadaDsc[] = [];
  const agora = o.agora ?? Date.now;
  const previas = new Map<string, { corpo: any; em: number; falhou?: boolean }>();
  /** descontratos gravados (confirmados) */
  const gravados: Array<{ id: string; corpo: any }> = [];
  let n = 0;
  const json = (status: number, corpo: unknown) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(corpo) }) as unknown as Response;
  const buscar = (async (url: string, init: RequestInit & { headers: Record<string, string> }) => {
    const u = new URL(url);
    const corpo = init.body ? JSON.parse(String(init.body)) : null;
    const chave = init.headers['x-admin-key'];
    chamadas.push({ metodo: String(init.method), caminho: u.pathname, corpo, chave, quem: init.headers['x-admin-quem'] });
    if (chave !== CHAVE_DSC_FALSA) return json(401, { erro: 'chave inválida' });
    switch (`${init.method} ${u.pathname}`) {
      case 'GET /admin/v1/esquema':
        return json(200, { tabelas: [{ nome: 'dsc_docs', linhas: 246, colunas: [{ nome: 'col', tipo: 'text', nulo: false }, { nome: 'id', tipo: 'text', nulo: false }, { nome: 'data', tipo: 'jsonb', nulo: false }], rls: true, politicas: [] }, { nome: 'fichas', linhas: 3, colunas: [{ nome: 'slug', tipo: 'text', nulo: false }], rls: true, politicas: [] }], funcoes: [], checks: [] });
      case 'POST /admin/v1/consulta':
        return json(200, { colunas: ['id', 'status'], linhas: [{ id: 'd-1', status: 'pronto_pagamento' }], cortado: false });
      case 'POST /admin/v1/descontrato/preparar': {
        if (corpo.id === 'nao-existe') return json(404, { erro: 'não achei o descontrato nao-existe' });
        if (corpo.id === 'sem-comprovante') return json(409, { erro: 'falta o comprovante do pagamento: anexe-o na tela' });
        const id = `dc-${++n}`;
        previas.set(id, { corpo, em: agora() });
        return json(200, { id, resumo: `Registrar o pagamento de R$ ${corpo.valor_pago} ...`, afetadas: 1, descontrato: { id: corpo.id ?? 'd-1', protocolo: corpo.protocolo ?? 'ARA-2026-001', unidade: 'ARA', paciente: 'Fulana', status_atual: 'Pronto para pagamento' }, avisos: [], antes: [{ status: 'pronto_pagamento' }], depois: [{ status: 'pago' }] });
      }
      case 'POST /admin/v1/confirmar': {
        const p = previas.get(corpo.id);
        if (!p) return json(400, { erro: 'prévia não encontrada ou vencida (valem 10 minutos): prepare de novo' });
        // como o servidor de verdade: trava ocupada = 503 e o código CONTINUA valendo (a 2ª tentativa passa); documento mexido = 409 e o código acaba
        if (p.corpo.id === 'confirma-503' && !p.falhou) { p.falhou = true; return json(503, { erro: 'o descontrato está em uso por outra operação (esperei 5 segundos pela trava)' }); }
        if (p.corpo.id === 'confirma-409') { previas.delete(corpo.id); return json(409, { erro: 'o descontrato mudou desde a prévia (alguém mexeu na tela?): prepare de novo' }); }
        previas.delete(corpo.id);
        gravados.push({ id: corpo.id, corpo: p.corpo });
        return json(200, { ok: true, afetadas: 1, conferido: true, backup_id: 'bk-dsc-1', descontrato: { id: p.corpo.id ?? 'd-1', status_antes: 'pronto_pagamento', status_depois: 'pago' } });
      }
            // a página da tela (dsc_site): o servidor 0.1.10.10 aceita /preparar só para dsc_site, e /site/trocar e /desfazer
      case 'POST /admin/v1/preparar': {
        const corpo = init.body ? JSON.parse(String(init.body)) : {};
        if (corpo.tabela !== 'dsc_site') return json(400, { erro: 'no Descontratos esta rota só escreve em dsc_site (a página da tela); descontratos mudam por sistemas_preparar_descontrato' });
        const id = `prep-dsc-${++n}`;
        previas.set(id, { corpo, em: agora() });
        return json(200, { id, resumo: `${corpo.op} em dsc_site`, afetadas: 1, antes: [], depois: [] });
      }
      case 'POST /admin/v1/site/trocar':
        return json(200, { ok: true, part: JSON.parse(String(init.body)).part, tabela: 'dsc_site', bytes_antes: 10, bytes_depois: 11, backup_id: '00000000-0000-4000-8000-0000000000d5', conferido: true });
      case 'POST /admin/v1/desfazer': {
        const corpo = JSON.parse(String(init.body));
        return corpo.backup_id === '00000000-0000-4000-8000-0000000000d5' ? json(200, { ok: true, tabela: 'dsc_site', op_original: 'atualizar', afetadas: 1, backup_id: '00000000-0000-4000-8000-0000000000d6', desfeito: corpo.backup_id }) : json(400, { erro: 'a tabela dsc_docs não volta por aqui' });
      }
      default:
        return json(404, { erro: 'essa rota não existe no Descontratos (só esquema, consulta, concluir descontrato e a página da tela)' });
    }
  }) as unknown as typeof fetch;
  return { fetch: buscar, chamadas, gravados, previas };
}
