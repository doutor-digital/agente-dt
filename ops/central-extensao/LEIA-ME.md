# Central do João — extensão do WhatsApp Web (fases 1 e 1b)

## Chamados (fase 1b)
A cada 20 s a extensão olha a **lista de conversas** (só as que estão na tela) e manda ao servidor:
- **@ menção a você** em grupo (selo de menção do WhatsApp, ou "@joão" na prévia — ajuste os nomes nas opções);
- **💬 não lida no privado** (não lidas em grupo sem menção ficam de fora: ligue nas opções se quiser).

Vai **só o nome da conversa e a prévia** que a lista já mostra (≤ 280 caracteres). Telefone, CPF, cartão, e-mail e qualquer número longo são
mascarados no servidor. A extensão **nunca abre conversa sozinha**.

No painel aparece a fila **📥 Chamados abertos**: **Abrir** clica na conversa da lista; **Feito** tira da fila. Um chamado por
conversa: mensagens novas da mesma conversa entram no mesmo chamado. A **não lida** sai sozinha quando você abre a conversa
(ou depois de 3 dias parada); a **menção** só sai com **Feito**. Feito é Feito: o mesmo selo não reabre o chamado; só mensagem
nova reabre. Aberto parado 30 dias expira; fechado há mais de 30 dias é apagado.

A extensão guarda **neste navegador** o que já mandou, o nome real de cada chamado (o servidor só tem o nome mascarado) e quais
conversas são grupo (aprende quando você abre a conversa).

**📌 Virar chamado**: com uma conversa aberta, grava o texto que você selecionou (ou, sem seleção, a última mensagem recebida).

A linha cinza "Lista: N conversas na tela · X não lidas · Y menções" é o diagnóstico: se ficar em 0 com conversas não lidas na
tela, o WhatsApp mudou a página — avise.

## Pausa do agente 9103 (fase 1)
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
4. Abra o WhatsApp Web: o painel **Central do João** fica no canto de baixo à direita (clique no título para recolher).

## Limites conhecidos
- Chamados: só vê as conversas que a lista mostra (as do topo). Rolar a lista faz ela ver mais.
- Duas conversas com o mesmo nome caem no mesmo chamado.
- Grupo × privado: até você abrir a conversa uma vez, é adivinhado pela prévia ("Fulano: texto" = grupo; "Obs: …" não conta).
- Grupo não tem pausa por pessoa.
- Se o WhatsApp esconder o número (contato só com id interno), o painel avisa "Não achei o número desta conversa".
