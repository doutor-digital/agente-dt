const $ = (id) => document.getElementById(id);
chrome.storage.local.get(['servidor', 'chave'], (c) => { $('servidor').value = c.servidor || ''; $('chave').value = c.chave ? '••••••••' : ''; });
const ORIGENS = ['https://web.whatsapp.com/*', 'https://agente-vps.doutordigitalconsultoria.com/*'];
$('salvar').onclick = async () => {
  // Firefox: as permissões de site nascem desligadas; pedir aqui (precisa ser no clique). No Chrome já vêm ligadas.
  let permitido = true;
  try { permitido = await chrome.permissions.request({ origins: ORIGENS }); } catch (e) { permitido = false; }
  if (!permitido) { $('msg').textContent = '⚠️ Sem permissão para o WhatsApp Web e o servidor: aceite o pedido do navegador.'; return; }
  const servidor = $('servidor').value.trim().replace(/\/+$/, '');
  // só o servidor da Doutor Digital (é o único que a extensão tem permissão de chamar)
  if (servidor && servidor !== 'https://agente-vps.doutordigitalconsultoria.com') { $('msg').textContent = '⚠️ Servidor inválido: deixe em branco.'; return; }
  const novo = { servidor };
  const campo = $('chave').value.trim();
  if (campo && campo !== '••••••••') novo.chave = campo;
  await chrome.storage.local.set(novo);
  // campo vazio = apagar a chave salva
  if (!campo) { await chrome.storage.local.remove('chave'); $('msg').textContent = 'Chave apagada.'; return; }
  $('msg').textContent = 'Testando…';
  chrome.runtime.sendMessage({ tipo: 'estado', corpo: {} }, (r) => {
    $('msg').textContent = r && r.ok ? `✅ Conectado. Agente ${r.dados.geral.pausado ? 'pausado para todos' : 'respondendo'}.` : `⚠️ ${(r && r.erro) || 'falhou'}`;
    if (novo.chave) $('chave').value = '••••••••';
  });
};
