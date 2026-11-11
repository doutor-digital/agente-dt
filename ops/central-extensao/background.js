// Central do João — fala com o servidor (a chave mora só aqui, no chrome.storage.local, nunca na página do WhatsApp).
const PADRAO = 'https://agente-vps.doutordigitalconsultoria.com';
const ROTAS = { estado: 'estado', geral: 'geral', pessoa: 'pessoa' };

async function config() {
  const c = await chrome.storage.local.get(['servidor', 'chave']);
  return { servidor: (c.servidor || PADRAO).replace(/\/+$/, ''), chave: c.chave || '' };
}

async function chamar(rota, corpo) {
  const { servidor, chave } = await config();
  if (!chave) return { ok: false, erro: 'Falta a chave: clique no ícone da extensão e cole a chave.' };
  try {
    const r = await fetch(`${servidor}/api/public/central/${rota}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Central-Chave': chave },
      body: JSON.stringify(corpo || {}),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, erro: j.error || `erro ${r.status}` };
    return { ok: true, dados: j };
  } catch (e) {
    return { ok: false, erro: 'Sem conexão com o servidor.' };
  }
}

chrome.runtime.onMessage.addListener((msg, remetente, responder) => {
  // só a página do WhatsApp Web (o content script) e a tela de opções da própria extensão
  const daExtensao = remetente.id === chrome.runtime.id;
  const doWhatsApp = remetente.url && remetente.url.startsWith('https://web.whatsapp.com/');
  const daOpcoes = remetente.url && remetente.url.startsWith(`chrome-extension://${chrome.runtime.id}/`);
  if (!daExtensao || !(doWhatsApp || daOpcoes) || !msg || !ROTAS[msg.tipo]) return false;
  chamar(ROTAS[msg.tipo], msg.corpo).then(responder);
  return true; // resposta assíncrona
});
