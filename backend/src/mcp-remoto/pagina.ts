/**
 * A tela que a diretoria vê ao clicar em "Conectar" no claude.ai. Também é o consentimento:
 * diz QUEM está pedindo acesso e PARA ONDE o acesso vai (o host do retorno), como a
 * documentação de conectores do Claude pede.
 */

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

export function paginaDeLogin(o: { pedido?: string; cliente?: string; retorno?: string; erro?: string; email?: string }): string {
  let host = '';
  try {
    if (o.retorno) host = new URL(o.retorno).host;
  } catch {
    host = '';
  }
  const quem = esc(o.cliente || 'Um aplicativo');
  const formulario = o.pedido
    ? `
      <p class="pedido"><strong>${quem}</strong> quer ler, em seu nome, os dados da franquia: pacientes,
      agenda, tratamentos e indicadores das unidades. Nada é alterado.</p>
      ${host ? `<p class="destino">O acesso será entregue a <strong>${esc(host)}</strong></p>` : ''}
      <form method="post" action="/oauth/entrar" autocomplete="on">
        <input type="hidden" name="pedido" value="${esc(o.pedido)}">
        <label>E-mail <input type="email" name="email" required autofocus value="${esc(o.email ?? '')}" autocomplete="username"></label>
        <label>Senha <input type="password" name="senha" required autocomplete="current-password"></label>
        <button type="submit">Entrar e permitir</button>
      </form>
      <p class="nota">Use o mesmo login do console. Para cortar o acesso depois, remova o conector no Claude.</p>`
    : '';
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Doutor Digital · Conectar ao Claude</title>
<style>
  :root { color-scheme: light dark; --fundo:#f6f5f2; --cartao:#fff; --texto:#1d1d1b; --suave:#6b6a66; --borda:#dcdad4; --acento:#0f5c4d; --erro:#a3271b; }
  @media (prefers-color-scheme: dark) { :root { --fundo:#141413; --cartao:#1f1f1d; --texto:#ecebe7; --suave:#a3a19b; --borda:#3a3936; --acento:#5cc4a9; --erro:#f08a7e; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px 16px; background:var(--fundo); color:var(--texto);
         font:16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width:100%; max-width:400px; background:var(--cartao); border:1px solid var(--borda); border-radius:12px; padding:28px 24px; }
  h1 { font-size:1.15rem; margin:0 0 16px; }
  .pedido { margin:0 0 12px; }
  .destino { margin:0 0 20px; color:var(--suave); font-size:.92rem; }
  label { display:block; font-size:.9rem; margin:0 0 14px; color:var(--suave); }
  input { display:block; width:100%; margin-top:4px; padding:10px 12px; font:inherit; color:var(--texto); background:transparent;
          border:1px solid var(--borda); border-radius:8px; }
  input:focus { outline:2px solid var(--acento); outline-offset:1px; }
  button { width:100%; padding:11px; font:inherit; font-weight:600; color:#fff; background:var(--acento); border:0; border-radius:8px; cursor:pointer; }
  .erro { margin:0 0 16px; padding:10px 12px; border-radius:8px; color:var(--erro); border:1px solid currentColor; font-size:.92rem; }
  .nota { margin:16px 0 0; color:var(--suave); font-size:.82rem; }
</style>
</head>
<body>
<main>
  <h1>Doutor Digital · Conectar ao Claude</h1>
  ${o.erro ? `<p class="erro" role="alert">${esc(o.erro)}</p>` : ''}
  ${formulario}
</main>
</body>
</html>`;
}
