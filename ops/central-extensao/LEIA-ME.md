# Central do João — extensão do Chrome (fase 1)

Pausa o **agente de chamados (63 9103-9464)** sem sair do WhatsApp Web:

- **Pausar para todos**: é a mesma chave do `/pausar` do @ddchamados_bot e do botão do painel.
- **Pausar só esta pessoa**: o agente para de responder e de gravar só a pessoa da conversa aberta. Os outros seguem normais.

A extensão lê **só o número e o nome** da conversa aberta; nenhuma mensagem sai do Chrome. O servidor não guarda o telefone, só
uma chave (HMAC) e os 4 últimos dígitos. Toda mudança avisa você no @ddchamados_bot.

## Instalar (uma vez)
1. No servidor: `bash ~/Kommo-Integracao/_replicacao/ligar-central-extensao.sh`. Ele gera a chave, grava no .env, publica e
   guarda a chave em `~/Kommo-Integracao/_replicacao/central-extensao-chave.txt` (600).
2. Instalar no navegador:
   - **Firefox (121 ou mais novo):** abra `about:debugging#/runtime/this-firefox` → **Carregar extensão temporária…** → escolha
     o arquivo `ops/central-extensao/manifest.json`. No Firefox as permissões de site nascem desligadas: o
     botão **Salvar e testar** (passo 3) pede as duas — aceite. Se recusou sem querer: `about:addons` → Central do João → aba
     **Permissões** → ligue web.whatsapp.com e agente-vps.doutordigitalconsultoria.com. Extensão temporária some ao fechar o Firefox: é só carregar de novo (para ficar fixa, precisa assinar no
     addons.mozilla.org).
   - **Chrome:** `chrome://extensions` → ligue **Modo do desenvolvedor** → **Carregar sem compactação** → escolha a pasta
     `ops/central-extensao` (do repositório agente-dt).
3. Clique no ícone da extensão (no Firefox, pode estar dentro do ícone de quebra-cabeça), cole a chave e clique em **Salvar e testar**. Deve aparecer "✅ Conectado".
4. Abra o WhatsApp Web: o painel **Agente 9103** fica no canto de baixo à direita (clique no título para recolher).

## Limites conhecidos
- Grupo não tem pausa por pessoa.
- Se o WhatsApp esconder o número (contato só com id interno), o painel avisa "Não achei o número desta conversa".
