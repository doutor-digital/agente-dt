const $ = (id) => document.getElementById(id);
const CFG = { mencoes: true, privado: true, grupos: false, nomes: 'joão,joao' };
chrome.storage.local.get(['servidor', 'chave', 'cfg'], (c) => {
  $('servidor').value = c.servidor || '';
  $('chave').value = c.chave ? '••••••••' : '';
  const g = Object.assign({}, CFG, c.cfg || {});
  $('mencoes').checked = !!g.mencoes; $('privado').checked = !!g.privado; $('grupos').checked = !!g.grupos; $('nomes').value = g.nomes;
});
const ORIGENS = ['https://web.whatsapp.com/*', 'https://agente-vps.doutordigitalconsultoria.com/*'];
$('salvar').onclick = () => {
  const servidor = $('servidor').value.trim().replace(/\/+$/, '');
  // só o servidor da Doutor Digital (é o único que a extensão tem permissão de chamar)
  if (servidor && servidor !== 'https://agente-vps.doutordigitalconsultoria.com') { $('msg').textContent = '⚠️ Servidor inválido: deixe em branco.'; return; }
  const novo = { servidor, cfg: { mencoes: $('mencoes').checked, privado: $('privado').checked, grupos: $('grupos').checked, nomes: $('nomes').value.trim().slice(0, 200) || CFG.nomes } };
  const campo = $('chave').value.trim();
  if (campo && campo !== '••••••••') novo.chave = campo;
  // GRAVA PRIMEIRO, sem esperar nada: no Firefox o pedido de permissão fecha o popup, e o que viesse depois dele se perderia.
  // Campo vazio = apagar a chave salva.
  const salvo = chrome.storage.local.set(novo).then(() => (campo ? null : chrome.storage.local.remove('chave')));
  // Firefox: as permissões de site nascem desligadas; pedir aqui, ainda dentro do clique (sem await antes). No Chrome já vêm ligadas.
  let pedido;
  try { pedido = Promise.resolve(chrome.permissions.request({ origins: ORIGENS })).catch(() => false); } catch (e) { pedido = Promise.resolve(false); }
  Promise.all([salvo, pedido]).then(([, permitido]) => {
    if (!permitido) { $('msg').textContent = '⚠️ Salvo, mas sem permissão para o WhatsApp Web e o servidor: aceite o pedido do navegador.'; return; }
    if (!campo) { $('msg').textContent = 'Chave apagada.'; return; }
    $('msg').textContent = 'Testando…';
    chrome.runtime.sendMessage({ tipo: 'estado', corpo: {} }, (r) => {
      $('msg').textContent = r && r.ok ? `✅ Conectado. Agente ${r.dados.geral.pausado ? 'pausado para todos' : 'respondendo'}.` : `⚠️ ${(r && r.erro) || 'falhou'}`;
      if (novo.chave) $('chave').value = '••••••••';
    });
  });
};
