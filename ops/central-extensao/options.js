const $ = (id) => document.getElementById(id);
chrome.storage.local.get(['servidor', 'chave'], (c) => { $('servidor').value = c.servidor || ''; $('chave').value = c.chave ? '••••••••' : ''; });
$('salvar').onclick = async () => {
  const novo = { servidor: $('servidor').value.trim() };
  if ($('chave').value && $('chave').value !== '••••••••') novo.chave = $('chave').value.trim();
  await chrome.storage.local.set(novo);
  $('msg').textContent = 'Testando…';
  chrome.runtime.sendMessage({ tipo: 'estado', corpo: {} }, (r) => {
    $('msg').textContent = r && r.ok ? `✅ Conectado. Agente ${r.dados.geral.pausado ? 'pausado para todos' : 'respondendo'}.` : `⚠️ ${(r && r.erro) || 'falhou'}`;
    if (novo.chave) $('chave').value = '••••••••';
  });
};
