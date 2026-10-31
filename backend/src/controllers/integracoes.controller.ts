/**
 * Painel das chaves de API de terceiros (Asaas, Convênia, Tiquetaque, Tramitação, Sistemas) por unidade. Só super-admin, e a escrita só
 * com sessão (nunca com a chave de serviço): colar a chave do Asaas é dar acesso ao dinheiro da clínica, e o
 * token do Convênia ou do Tiquetaque, aos dados pessoais dos funcionários.
 */
import type { Request, Response } from 'express';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { ehProvedor, listarChaves, salvarChave, PROVEDORES } from '../lib/integracoes/chaves.js';

export async function salvarChaveHandler(req: Request, res: Response): Promise<void> {
  const slug = String(req.params.slug);
  const provedor = String(req.params.provedor);
  const chave = typeof req.body?.chave === 'string' ? req.body.chave : '';
  if (!ehProvedor(provedor)) {
    res.status(400).json({ ok: false, error: `provedor desconhecido: ${provedor}` });
    return;
  }
  try {
    const r = await salvarChave(slug, provedor, chave, req.user?.email ?? 'painel');
    logger.info({ slug, provedor, conta: r.conta, por: req.user?.email }, 'integrações: chave salva');
    res.json({ ok: true, ...r });
  } catch (err) {
    // A mensagem nunca leva a chave: vem do teste no serviço ou da validação.
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function listarChavesHandler(_req: Request, res: Response): Promise<void> {
  res.json({ ok: true, chaves: await listarChaves() });
}

const NOME_DO_PROVEDOR: Record<(typeof PROVEDORES)[number], string> = { asaas: 'Asaas', convenia: 'Convênia (RH)', tiquetaque: 'Tiquetaque (ponto)', tramitacao: 'Tramitação (advocacia)', sistemas: 'Sistemas (RH/Caixa)' };

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function painelIntegracoesHandler(_req: Request, res: Response): Promise<void> {
  const unidades = await prisma.unit.findMany({ where: { isActive: true }, select: { slug: true, name: true }, orderBy: { name: 'asc' } });
  const chaves = await listarChaves();
  const linhas = unidades
    .map((u) => {
      const cels = PROVEDORES.map((p) => {
        const c = chaves.find((x) => x.slug === u.slug && x.provedor === p);
        const estado = c
          ? `<span class="ok">ligado · ${esc(c.conta ?? '')} (${esc(c.final)})</span>${c.ultimoErro ? `<br><span class="erro">${esc(c.ultimoErro)}</span>` : ''}`
          : '<span class="mudo">sem chave</span>';
        return `<td>${estado}<form data-slug="${esc(u.slug)}" data-provedor="${p}"><input type="password" name="chave" autocomplete="off" placeholder="${p === 'sistemas' ? 'colar o JSON {api, chave, tela}' : 'colar a chave de API'}" aria-label="chave ${NOME_DO_PROVEDOR[p]} de ${esc(u.name)}"><button>Salvar</button><output></output></form></td>`;
      }).join('');
      return `<tr><td><b>${esc(u.name)}</b><br><span class="mudo">${esc(u.slug)}</span></td>${cels}</tr>`;
    })
    .join('');
  res.type('html').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Integrações · chaves de API</title><style>
:root{--papel:#F7F8FA;--tinta:#1E2430;--mudo:#677085;--linha:#E1E5EC;--ok:#2F7D5B;--erro:#B4372F;--acento:#2D5BD3;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--papel:#14171D;--tinta:#E8EBF0;--mudo:#98A1B3;--linha:#2A303B;--ok:#63BD92;--erro:#EE7366;--acento:#7FA2F5;color-scheme:dark}}
body{margin:0;background:var(--papel);color:var(--tinta);font:15px/1.5 system-ui,sans-serif;padding:28px max(16px,env(safe-area-inset-left)) 48px}
main{max-width:1000px;margin:0 auto;display:flex;flex-direction:column;gap:18px}h1{margin:0;font-size:1.6rem}.mudo{color:var(--mudo)}.ok{color:var(--ok);font-weight:600}.erro{color:var(--erro)}
.rolar{overflow-x:auto}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:10px;border-bottom:1px solid var(--linha);vertical-align:top}th{font-size:.78rem;text-transform:uppercase;letter-spacing:.05em;color:var(--mudo)}
form{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}input{flex:1;min-width:180px;padding:6px 8px;border:1px solid var(--linha);border-radius:4px;background:transparent;color:inherit}
button{padding:6px 12px;border:0;border-radius:4px;background:var(--acento);color:#fff;font-weight:600;cursor:pointer}button:focus-visible,input:focus-visible{outline:2px solid var(--acento);outline-offset:2px}output{width:100%;font-size:.88rem}
</style></head><body><main>
<h1>Integrações · chaves de API</h1>
<p class="mudo">Cole a chave de API de cada unidade. Ela é testada na hora e guardada cifrada; o conector do claude.ai só consulta (não cria cobrança, não transfere, não admite nem desliga ninguém). No Asaas: Integrações → Chaves de API → gerar chave de produção. No Convênia: foto do perfil → Configurações → API → Adicionar novo token (basta marcar as listagens e detalhes: colaboradores, desligados, férias, faltas e afastamentos, férias coletivas). No Tiquetaque: TiqueAdmin → Configurações → Integrações → API pública → gerar token (o token da conta cobre todas as empresas e locais dela). Na Tramitação Inteligente: Chaves de API (planilha.tramitacaointeligente.com.br/api/chaves) → gerar chave; a API exige o plano Ouro. Em Sistemas (RH/Caixa, o servidor próprio que saiu do Supabase), cole UMA linha de JSON: <code>{"api":"http://api-rh:8080","chave":"&lt;ADMIN_KEY do servidor&gt;","tela":"https://&lt;endereço da tela RH&gt;"}</code> — a ADMIN_KEY está em /root/.sistemas-rh.env no servidor; coloque numa unidade só (a da empresa dona do sistema). Esse conector lê o sistema e altera em dois passos, com registro de quem pediu.</p>
<div class="rolar"><table><thead><tr><th>Unidade</th>${PROVEDORES.map((p) => `<th>${NOME_DO_PROVEDOR[p]}</th>`).join('')}</tr></thead><tbody>${linhas}</tbody></table></div>
</main><script>
for (const f of document.querySelectorAll('form[data-slug]')) {
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = f.querySelector('output'); const inp = f.querySelector('input'); const btn = f.querySelector('button');
    if (!inp.value.trim()) { out.textContent = 'Cole a chave antes de salvar.'; return; }
    btn.disabled = true; out.textContent = 'Testando a chave…';
    try {
      const r = await fetch('/api/integracoes/' + f.dataset.slug + '/' + f.dataset.provedor, { method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chave: inp.value }) });
      const d = await r.json();
      inp.value = '';
      out.innerHTML = d.ok ? '<span class="ok">Salva: ' + d.conta.replace(/[<>&]/g, '') + ' (' + d.final + ')</span>' : '<span class="erro">Não salvei: ' + String(d.error || r.status).replace(/[<>&]/g, '') + '</span>';
    } catch (err) { out.innerHTML = '<span class="erro">Falhou a conexão com o servidor.</span>'; }
    btn.disabled = false;
  });
}
</script></body></html>`);
}
