# Ponte — o cartão do Kommo ao lado da conversa no WhatsApp Web

Extensão do Chrome (e do Firefox), **versão 0.3.0 — fase 3**. Com uma conversa aberta no WhatsApp Web, o
painel lateral mostra o cartão do Kommo daquele paciente:

- **Resumo** (novo na fase 2), no topo: quem é, onde está e há quanto tempo, o que já aconteceu na franquia, a
  última conversa e o próximo passo sugerido para a etapa;
- nome do cartão, funil e etapa, com uma barrinha do funil COMERCIAL;
- **aviso de cartão duplicado** (novo na 0.3.0): "Este paciente tem 2 cartões abertos";
- responsável, **etiquetas** (na 0.3.0: pôr e tirar daqui) e se a Sofia está ativa ou quieta (pausa da unidade,
  fora do horário, caixinha "Pausar IA" ou pausa com data);
- **Pausar a Sofia neste paciente** (novo na fase 2);
- de que anúncio o paciente veio;
- o que a franquia sabe: consulta marcada ou não, última consulta, tratamento;
- como o cartão foi achado (pelo telefone, pelas mensagens, pelo nome — "confira" — ou escolhido por você);
- o botão **Abrir no Kommo**.

E mais duas abas: **Fila de hoje** (nova na fase 2): quem chamar ou ligar hoje, por etapa, agora com o botão
**Começar a ligar** (0.3.0); e **Respostas** (nova na 0.3.0): as respostas prontas do Kommo para copiar.

Também tem um bloco "Modo aprendiz", que diz onde cada coisa fica dentro do Kommo. Por enquanto ele é fixo; uma
fase futura vai escolher qual dica mostrar e quando.

## O que há de novo na 0.3.0 (fase 3)

### Etiquetas: ver, pôr e tirar

No cartão, cada etiqueta vira um chip com **✕** para tirar, e o botão **+ etiqueta** abre uma busca entre as
etiquetas que **já existem** na conta do Kommo. A atendente não cria etiqueta nova (decisão A3 da trilha): se o
nome não existe na conta, o servidor recusa — o `tags_to_add` do Kommo criaria a etiqueta sozinho.

Etiqueta que começa com **▶** faz um robô (Salesbot) do Kommo **mandar um modelo de WhatsApp para o paciente**.
Ao escolher uma ▶, o painel pergunta: "Esta etiqueta faz o robô mandar uma mensagem para o paciente. Pôr mesmo
assim?" — e só põe depois de **Pôr mesmo assim**. O servidor também recusa uma ▶ sem essa confirmação, deixa uma
nota no cartão ("Etiqueta ▶ Retomada posta pela Ponte · por Ana") e põe no máximo 30 ▶ por hora em cada conta
(`PONTE_ETIQUETA_ROBO_POR_HORA`): se a chave da unidade vazar, ela não vira um disparador. Tirar não pede
confirmação.

Depois de pôr ou tirar, o servidor **relê o cartão** e o painel mostra a lista que o Kommo devolveu. Rotas:
`GET` (as etiquetas da conta, cache de 10 min), `POST` e `DELETE /api/public/widget/:slug/ponte/etiquetas`, com
`{ leadId, nome, por, confirmado }`. A armadilha do Kommo continua valendo: `tags_to_add` / `tags_to_delete` vão
na RAIZ do corpo do PATCH (dentro de `_embedded` o Kommo ignora, e `_embedded.tags` substitui todas) — quem grava
é o `addTag` / `removeTag` de sempre, e há teste disso.

### Fila de ligações com 1 clique ("Começar a ligar")

O João queria um discador automático pelo WhatsApp. Automatizar o clique de ligar é automação do WhatsApp (risco
de banir o número), então a Ponte faz tudo **menos ligar**: a atendente dá o único clique, no 📞 do próprio
WhatsApp Web (que liga pelo navegador desde jul/2026).

Na aba **Fila de hoje**, **Começar a ligar** entra no modo ligação: um paciente por vez, na ordem da fila (etapa
e tempo de espera). Para cada um, a Ponte abre a conversa (o mesmo "Abrir conversa" de antes: troca a URL da aba
para `web.whatsapp.com/send?phone=…`, só navegação), mostra nome, etapa e motivo, e diz **"Clique no 📞 do
WhatsApp para ligar"**. Depois a atendente marca: **Atendeu · Não atendeu · Caixa postal · Número errado ·
Pular**.

- O resultado (menos Pular) vai para `POST /api/public/widget/:slug/ponte/ligacao` `{ leadId, resultado, por }` e
  é gravado nos campos ☎ do cartão, **achados pelo nome** (nunca id fixo): ☎ Última ligação = agora; ☎ Resultado
  = a opção (Atendida, Não atendida, Caixa postal, Número inválido); ☎ Tentativas + 1; ☎ Agente = "Ponte · Ana";
  e ☎ Campanha 3C **vazio** (é assim que se separa a ligação da SDR da discadora 3C: se o cartão tinha a campanha
  de uma ligação antiga da 3C, ela é esvaziada; gravação e duração da 3C não são tocadas). Sempre com a nota
  "☎ Ligação pela Ponte: não atendeu · por Ana". Conta sem os campos ☎: só a nota.
- Depois do resultado, avança sozinho. **Ritmo**, para não parecer spam: no mínimo 40 s entre abrir uma conversa
  e a próxima, e no máximo 40 por hora (janela corrida), com contagem regressiva na tela ("próximo em 25 s").
  Os números ficam em `RITMO_DAS_LIGACOES` (`backend/src/lib/ponte-ligacao.ts`), no estilo de `PRAZOS_DA_FILA`:
  `PONTE_LIGACAO_INTERVALO_S` (mínimo 15) e `PONTE_LIGACAO_TETO_HORA` (máximo 120). Vão para a extensão junto da
  fila.
- Paciente sem telefone (só @lid ou nome de usuário) é pulado com o aviso "sem telefone — abra pelo Kommo".
  Pular não grava nada. **Pausar** segura a contagem; **Sair** volta para a fila.
- A posição sobrevive a fechar o painel: fica em `chrome.storage.local` só o dia, a unidade, os ids dos cartões
  feitos e as horas das aberturas — **nunca nome nem telefone**. Reabrindo, o botão vira "Continuar a ligar".
- A Ponte não põe ▶ Retomada (nem etiqueta nenhuma) depois da ligação — decisão do João.

### Respostas prontas para COPIAR

A aba **Respostas** lista as respostas prontas da conta: os **modelos gerais** do Kommo (texto livre,
`GET /api/v4/chats/templates` com `type: "amocrm"`). Os modelos do WhatsApp (`type: "waba"`) ficam de fora. Tem
busca e o botão **Copiar**, que troca o marcador de nome (`{{contact.name}}`, "[Nome do contato]") pelo primeiro
nome do paciente da conversa aberta; campo do cartão (`{{lead.cf.…}}`) aparece como "[◷ Data da Consulta]", com
o aviso "Complete o que está entre colchetes antes de enviar". A Ponte **nunca** põe texto na caixa do WhatsApp
nem envia: a atendente cola e envia. Cache de 10 min. Rota: `GET /api/public/widget/:slug/ponte/respostas`.

Conta sem nenhuma: "Nenhuma resposta pronta cadastrada no Kommo", com onde cadastrar: **Configurações › Modelos ›
Modelos gerais › Adicionar um novo modelo** (só administrador; caminho da ajuda do Kommo em pt-BR, 14/10/2026).

### Aviso de cartão duplicado

A resposta do cartão traz `duplicados`: os outros cartões **abertos** (fora de GANHO e PERDIDO, em qualquer funil)
do mesmo contato, ou de outros contatos com o **mesmo telefone completo** (DDD + número). Com dois ou mais
abertos, o painel mostra a faixa amarela "Este paciente tem 2 cartões abertos", cada um com nome, funil/etapa,
⚑ Origem e **Abrir no Kommo**, e a regra: "Fica o que veio do anúncio; o outro é juntado (Mesclar) no Kommo,
nunca apagado". A Ponte não junta nem apaga nada.

## O que há de novo na 0.2.0 (fase 2)

### Pausar a Sofia neste paciente

No cartão, o botão **Pausar a Sofia neste paciente** abre as opções: **até amanhã às 8h**, **3 dias**,
**1 semana** ou **escolher a data** (a Sofia volta às 8h do dia escolhido; no máximo 30 dias), e um motivo
opcional. Pausada, o painel mostra "Sofia pausada até 14/10 08:00 · motivo · por Ana" e o botão
**Retomar agora**.

É a **mesma pausa** do widget "Pausar a Sofia" do Kommo (`backend/src/lib/pausa-lead.ts`): a linha em
`lead_pausas` manda na Sofia, a caixinha "Pausar IA" é marcada junto (os Salesbots leem a caixinha) e o worker
de vencimento solta sozinho na data. Rotas: `POST` e `DELETE /api/public/widget/:slug/ponte/pausa`, com
`{ leadId, ate, motivo, por }`. O `por` é o **Seu nome** das opções da extensão (campo novo, opcional).

Se a SDR marcou a caixinha "Pausar IA" à mão (sem data), o painel só avisa — a caixinha é dela, e a Sofia só
volta quando alguém desmarcar no Kommo.

### Fila de hoje ("ligações por etapa")

O João pediu "ligações por etapa". A leitura: uma aba com quem a atendente precisa **chamar ou ligar hoje**,
separada por etapa do funil COMERCIAL, cada grupo com contador:

| Etapa | Entra na fila quando | Motivo |
| --- | --- | --- |
| entrada / EM QUALIFICAÇÃO | a conversa do Kommo está aberta e **não lida** há mais de 2 h, e a última fala não foi a Sofia | sem resposta |
| EM ESPERA | o "◷ Retomar em" é hoje ou já passou | retomar contato |
| AGENDADO | a "◷ Data da Consulta" é amanhã e a "✓ Situação da consulta" não diz confirmada | confirmar presença |
| NÃO COMPARECEU | sempre (menos quem já tem consulta nova no futuro) | faltou: remarcar |
| EM NEGOCIAÇÃO | o cartão não mudou de etapa e a conversa não mexeu há 3 dias (o "parado" do worker de parados) | retomar negociação |

Cada paciente mostra nome, etapa, o motivo, há quanto tempo, e três botões: **Abrir conversa** (troca a URL da
aba do WhatsApp Web para `https://web.whatsapp.com/send?phone=<dígitos>` — é navegação, como clicar num link;
nada é digitado nem enviado), **Copiar telefone** (para ligar) e **Abrir no Kommo**.

Rota: `GET /api/public/widget/:slug/ponte/fila`, só leitura, com cache de 2 min por conta do Kommo. Os prazos
(amanhã, 3 dias, 2 h…) ficam todos em `PRAZOS_DA_FILA` (`backend/src/lib/ponte-fila.ts`), cada um com variável
de ambiente (`PONTE_FILA_CONFIRMAR_DIAS`, `PONTE_FILA_NEGOCIACAO_DIAS`, `PONTE_FILA_SEM_RESPOSTA_HORAS`…).

### Resumo do lead

3 a 5 linhas no topo do cartão, **sem gastar IA**: os campos do cartão (cidade, queixa, região da dor), a
memória que a Sofia já guarda do paciente (desfecho e onde travou), a franquia (consultas, faltas, tratamento)
e há quanto tempo o cartão está na etapa. Por último, o próximo passo sugerido para a etapa.

O botão **Resumir com IA** só aparece quando a unidade tem chave da Anthropic. Ele lê a conversa do Kommo e
pede o resumo ao modelo mais barato que o projeto já usa em tarefa auxiliar (Haiku 4.5), com a chave da
própria unidade; o custo entra na tela de custo da IA. Fica guardado 6 h por paciente. Sem conversa para ler,
devolve o resumo do cartão sem chamar a IA. Rota: `POST /api/public/widget/:slug/ponte/resumo-ia`.

## Instalar (modo desenvolvedor)

1. No Chrome, abra `chrome://extensions` e ligue **Modo do desenvolvedor**, no canto de cima à direita.
2. Clique em **Carregar sem compactação** e escolha esta pasta (`extensao-ponte/`).
3. A página de opções abre sozinha. Preencha:
   - o **slug da unidade** (ex.: `doutor-hernia-acailandia`);
   - a **chave**: a mesma do widget do cartão no Kommo daquela unidade (o HMAC do slug, ver
     `backend/src/lib/widget-agenda.ts`);
   - **seu nome** (opcional): aparece como "por Ana" quando você pausa a Sofia num paciente.

   Depois clique em **Salvar e testar**. Deve aparecer "Conectado: <unidade>".

   Já tinha uma versão anterior instalada? Em `chrome://extensions`, clique no ↻ da Ponte e recarregue a aba do
   WhatsApp Web (F5).
4. Abra `https://web.whatsapp.com` e clique no ícone da Ponte na barra do Chrome. O painel lateral abre.

A chave fica só no computador, em `chrome.storage.local`. O servidor é o mesmo dos widgets do Kommo
(`https://agente-vps.doutordigitalconsultoria.com`, em `config.js`); trocar o endereço exige trocar também o
`host_permissions` do `manifest.json`.

## Como acha o cartão

Pela rota `POST /api/public/widget/:slug/ponte/cartao` (`backend/src/controllers/ponte.controller.ts`). É POST
para que nome e telefone vão no corpo e não na URL, que fica no log de acesso; a rota não escreve nada. São 4
passos, nesta ordem, parando no primeiro que achar:

1. **Telefone.** Só quando o WhatsApp mostra o número de verdade: o `data-id` da conversa termina em `@c.us`,
   ou o cabeçalho de um contato não salvo mostra o número. O servidor busca o contato no Kommo e **confere o
   número completo**: os 8 últimos dígitos e o DDD. Se o mesmo número tem contatos com nomes diferentes
   (família dividindo o WhatsApp), o painel mostra a lista e a atendente escolhe.
2. **Impressão das mensagens.** O servidor compara a impressão das últimas 5 mensagens recebidas (explicada
   abaixo) com as mensagens que a Sofia guardou nas últimas 48 h. Precisa bater em 2 mensagens; se só uma foi
   enviada, 1 basta, mas só nas últimas 23 h (a impressão não tem data). Empate entre conversas não aponta
   ninguém. Só funciona em unidade com a Sofia.
3. **Nome do cabeçalho.** Busca por texto no Kommo. Se mais de um contato casar, o painel mostra a lista e a
   atendente escolhe.
4. **Nada.** O painel mostra a busca manual por nome.

### A impressão (o texto não sai do navegador)

Para cada mensagem recebida, a extensão calcula `SHA-256(texto normalizado + "|" + HH:MM em São Paulo)`.
Normalizar é passar para minúsculas, tirar os acentos e trocar tudo que não é letra ou número por um espaço.
Só esse hash vai para o servidor, que faz a mesma conta sobre o que já guarda. Os dois lados são testados
contra os mesmos vetores fixos (`testes/vetores-impressao.json`).

## O que a Ponte faz e o que NUNCA faz

**Faz:**

- lê o DOM visível da conversa aberta, só em `https://web.whatsapp.com/*`, num content script em mundo
  isolado: o nome do cabeçalho, o `data-id` das mensagens, e o texto e a hora das últimas mensagens recebidas;
- percebe a troca de conversa com um `MutationObserver`, porque a URL não muda;
- mostra o painel com `chrome.sidePanel`, uma página da própria extensão;
- abre a conversa de um telefone trocando a URL da aba do WhatsApp Web (navegação, sem texto), no "Abrir conversa"
  e no modo "Começar a ligar" (este no ritmo: 40 s entre uma e outra, no máximo 40 por hora);
- copia texto para a área de transferência quando a atendente clica em Copiar.

**Nunca faz:**

- envia, responde ou apaga mensagem; marca como lida; clica, digita, foca ou rola qualquer coisa no WhatsApp;
- **liga**: no modo "Começar a ligar" ela só abre a conversa; o clique no 📞 é sempre da atendente;
- põe texto na caixa de mensagem: as respostas prontas só vão para a área de transferência, no clique em Copiar;
- injeta qualquer coisa na página do WhatsApp (nem botão, nem CSS, nem `web_accessible_resources`);
- usa WA-JS, wppconnect, whatsapp-web.js, "Store" ou qualquer módulo interno do WhatsApp;
- lê a lista de contatos ou de grupos (a coluna da esquerda é ignorada);
- guarda texto de conversa, nem no `storage` da extensão nem no servidor. O texto vira hash dentro do content
  script, e o painel só recebe nome, telefone e hashes;
- trata o id `@lid` como telefone;
- monta link do WhatsApp com texto (`text=`): "Abrir conversa" leva só o telefone, e quem escreve é a atendente;
- cria etiqueta nova no Kommo, põe etiqueta ▶ sem a atendente confirmar, ou põe ▶ Retomada sozinha depois de uma
  ligação;
- junta (mescla) ou apaga cartão: o aviso de duplicado só avisa;
- guarda nome ou telefone de paciente no `storage` (a fila de ligações guarda só ids e horas);
- escreve na franquia. No Kommo, só escreve quando a atendente clica: pausar e retomar a Sofia num paciente, pôr e
  tirar etiqueta, e o resultado da ligação (campos ☎ + nota). Tudo vai pelo NOSSO servidor com a chave da
  unidade — nunca pelo WhatsApp.

Permissões: `sidePanel` e `storage`, mais `host_permissions` apenas para o servidor da Doutor Digital. O
"Abrir conversa" usa `chrome.tabs.update` na aba do WhatsApp Web que a Ponte já lê, que não pede permissão a
mais; o "Copiar telefone" e o "Copiar" das respostas usam a área de transferência só no clique.

## ⚠ Os seletores são uma SUPOSIÇÃO

Todos os seletores estão em `seletores.js`. Eles foram escritos a partir do que se sabe do DOM do WhatsApp
Web em out/2026, e as fixtures de `testes/fixtures/` **imitam** esse DOM: não são cópia do WhatsApp real.
Antes de usar de verdade, é preciso **um dia de teste no computador de uma atendente**, conferindo:

- [ ] `#main` e `#main header` existem, e o nome sai do `span[dir="auto"][title]` do cabeçalho;
- [ ] o `data-id` das mensagens tem o formato `true|false_<jid>_<id>[_<participante>]`, termina em `@c.us`
      nas conversas com número e em `@lid` nas outras. Medir quantas conversas ainda são `@c.us`;
- [ ] o `data-pre-plain-text` começa com `[HH:MM, …]` (ou `[h:mm AM, …]` em inglês);
- [ ] o texto está em `span.selectable-text`;
- [ ] contato não salvo mostra o número no cabeçalho;
- [ ] a impressão bate: abrir uma conversa que a Sofia atendeu e ver o chip "achei pelas mensagens";
- [ ] a Ponte não deixa o WhatsApp Web mais lento (o observador lê no máximo a cada 0,7 s).

Quando um seletor quebrar, o conserto é só em `seletores.js`. Rode os testes de novo depois.

## Testes

```bash
cd extensao-ponte
npm install         # só o jsdom, para os testes
npm test            # node --test 'testes/*.test.js'
```

- `impressao.test.js`: a normalização e o hash batem com os vetores, e a hora é convertida para São Paulo;
- `leitor.test.js`: as fixtures com `@c.us`, `@lid`, número no cabeçalho, grupo e sem conversa, mais a prova
  de que a leitura não clica, não foca, não dispara evento e não muda o DOM;
- `conteudo.test.js`: o content script inteiro no jsdom. Só nome, telefone e hashes saem para o painel, e a
  troca de conversa é percebida;
- `desenho.test.js`: o painel (cartão, candidatos, busca manual e dado do servidor tratado como texto) e, na
  fase 2, o resumo e o "Resumir com IA", o bloco da pausa, a fila (grupos, contadores e os três botões) e a
  prova de que "Abrir conversa" é só o link com o telefone;
- `pausa.test.js`: as datas de cada opção da pausa, o limite de 30 dias e o estado da Sofia depois de pausar;
- `etiquetas.test.js` (0.3.0): a regra do ▶, a busca entre as etiquetas da conta e o bloco do cartão (✕, "+
  etiqueta", a pergunta da ▶ — só põe depois de confirmar —, o erro e o dado tratado como texto);
- `ligacao.test.js` (0.3.0): a ordem da fila de ligações, o ritmo (40 s, teto por hora), o estado guardado (só ids
  e horas) e a tela do modo ligação;
- `respostas.test.js` (0.3.0): o nome no lugar do marcador ("[nome]" quando não se sabe), a busca e a aba;
- `painel.test.js` (0.3.0): o `painel.js` inteiro com `chrome`, `fetch` e relógio falsos — "Começar a ligar"
  abre só pela URL com o telefone, espera o ritmo, grava o resultado, pula quem não tem telefone, respeita o teto
  e continua de onde parou; a etiqueta vai com quem pôs; e a resposta copiada nunca sai com o nome do paciente
  anterior.

No backend: `ponte-fila.test.ts` (cada regra da fila e os prazos), `ponte-resumo.test.ts` (o resumo sem IA, o
pedido e a leitura da resposta da IA), `ponte-pausa.test.ts` (o pedido, as regras de sempre e o próprio
`pausa.js` daqui passando pela regra do servidor) e, na 0.3.0, `ponte-etiquetas.test.ts` (só etiqueta que existe,
▶ só confirmada e com nota, teto de ▶ por hora, releitura, e o PATCH com `tags_to_add` na raiz),
`ponte-ligacao.test.ts` (os campos ☎ pelo nome com os ids reais de Açailândia, tentativas + 1, campanha 3C
esvaziada, só a nota quando falta campo), `ponte-respostas.test.ts` (só os modelos gerais, os marcadores e o
primeiro nome) e `ponte-duplicados.test.ts` (o mesmo telefone completo e quando avisar).

### A conferir no dia de teste (fase 2)

- [ ] a fila "sem resposta": o `is_read` das conversas do Kommo fica falso quando só a Sofia respondeu? (a
      regra já ignora conversa em que a última fala é da Sofia, mas só nas unidades com a Sofia);
- [ ] a fila "EM NEGOCIAÇÃO": o Kommo aceita o filtro `value_after` nos eventos de mudança de etapa? (se não
      aceitar, o grupo avisa e usa a última alteração do cartão, que robô também mexe);
- [ ] "Abrir conversa" recarrega o WhatsApp Web e abre o chat certo; contato sem WhatsApp mostra o aviso do
      próprio WhatsApp;
- [ ] "Copiar telefone" funciona no painel lateral do Chrome e na barra lateral do Firefox.

### A conferir no dia de teste (0.3.0)

- [ ] pôr uma etiqueta ▶ pela Ponte dispara o robô (o gatilho do Kommo vale para etiqueta posta pela API? — é a
      mesma dúvida das "Etiquetas ▶ automáticas"); testar num cartão de teste;
- [ ] "Começar a ligar": depois que a conversa abre, o 📞 aparece e liga; contato sem WhatsApp mostra o aviso do
      próprio WhatsApp (marcar "Número errado");
- [ ] os campos ☎ aparecem certos no cartão (data, resultado, tentativas, "Ponte · <nome>") e a campanha 3C fica
      vazia; o dashboard/relatório que lê ☎ separa a ligação da SDR da 3C;
- [ ] a aba Respostas lista os modelos gerais da conta (em Açailândia, os "⚡ …") e o texto colado no WhatsApp sai
      com o nome certo;
- [ ] a faixa de duplicado aparece num paciente com dois cartões abertos (e não aparece num GANHO + um aberto).

O backend confere o mesmo contrato em `backend/src/lib/ponte-impressao.test.ts`, que carrega o `impressao.js`
daqui, e em `ponte-cartao.test.ts`.

## Firefox

O Firefox não tem o painel lateral do Chrome; a versão dele usa a **barra lateral** (`sidebar_action`). Os
arquivos são os mesmos, só trocam o `manifest.json` e o `fundo.js` (em `firefox/`). Para montar:
`bash firefox/montar.sh ~/Downloads/extensao-ponte-firefox`.

Instalar para testar: `about:debugging` → **Este Firefox** → **Carregar extensão temporária…** → escolha o
`manifest.json` da pasta montada. A extensão temporária some quando o Firefox fecha; para ficar instalada de
vez, precisa ser assinada pela Mozilla (envio "não listado" no addons.mozilla.org). Depois de carregar, em
`about:addons` → Ponte → **Permissões**, ligue o acesso a `web.whatsapp.com` e ao servidor da Doutor Digital
(no Firefox, com Manifest V3, o acesso a sites não vem ligado sozinho).
