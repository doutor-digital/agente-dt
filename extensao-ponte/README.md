# Ponte — o cartão do Kommo ao lado da conversa no WhatsApp Web

Extensão do Chrome (e do Firefox), **versão 0.2.0 — fase 2**. Com uma conversa aberta no WhatsApp Web, o
painel lateral mostra o cartão do Kommo daquele paciente:

- **Resumo** (novo na fase 2), no topo: quem é, onde está e há quanto tempo, o que já aconteceu na franquia, a
  última conversa e o próximo passo sugerido para a etapa;
- nome do cartão, funil e etapa, com uma barrinha do funil COMERCIAL;
- responsável, etiquetas e se a Sofia está ativa ou quieta (pausa da unidade, fora do horário, caixinha
  "Pausar IA" ou pausa com data);
- **Pausar a Sofia neste paciente** (novo na fase 2);
- de que anúncio o paciente veio;
- o que a franquia sabe: consulta marcada ou não, última consulta, tratamento;
- como o cartão foi achado (pelo telefone, pelas mensagens, pelo nome — "confira" — ou escolhido por você);
- o botão **Abrir no Kommo**.

E uma segunda aba, **Fila de hoje** (nova na fase 2): quem chamar ou ligar hoje, por etapa.

Também tem um bloco "Modo aprendiz", que diz onde cada coisa fica dentro do Kommo. Por enquanto ele é fixo; a
fase 3 vai escolher qual dica mostrar e quando.

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

   Já tinha a 0.1.0 instalada? Em `chrome://extensions`, clique no ↻ da Ponte e recarregue a aba do WhatsApp
   Web (F5).
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
- mostra o painel com `chrome.sidePanel`, uma página da própria extensão.

**Nunca faz:**

- envia, responde ou apaga mensagem; marca como lida; clica, digita, foca ou rola qualquer coisa no WhatsApp;
- injeta qualquer coisa na página do WhatsApp (nem botão, nem CSS, nem `web_accessible_resources`);
- usa WA-JS, wppconnect, whatsapp-web.js, "Store" ou qualquer módulo interno do WhatsApp;
- lê a lista de contatos ou de grupos (a coluna da esquerda é ignorada);
- guarda texto de conversa, nem no `storage` da extensão nem no servidor. O texto vira hash dentro do content
  script, e o painel só recebe nome, telefone e hashes;
- trata o id `@lid` como telefone;
- monta link do WhatsApp com texto (`text=`): "Abrir conversa" leva só o telefone, e quem escreve é a atendente;
- escreve na franquia. No Kommo, a única escrita é pausar e retomar a Sofia num paciente, quando a atendente
  clica, e ela vai pelo NOSSO servidor com a chave da unidade — nunca pelo WhatsApp.

Permissões: `sidePanel` e `storage`, mais `host_permissions` apenas para o servidor da Doutor Digital. O
"Abrir conversa" usa `chrome.tabs.update` na aba do WhatsApp Web que a Ponte já lê, que não pede permissão a
mais; o "Copiar telefone" usa a área de transferência só no clique.

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
- `pausa.test.js`: as datas de cada opção da pausa, o limite de 30 dias e o estado da Sofia depois de pausar.

No backend: `ponte-fila.test.ts` (cada regra da fila e os prazos), `ponte-resumo.test.ts` (o resumo sem IA, o
pedido e a leitura da resposta da IA) e `ponte-pausa.test.ts` (o pedido, as regras de sempre e o próprio
`pausa.js` daqui passando pela regra do servidor).

### A conferir no dia de teste (fase 2)

- [ ] a fila "sem resposta": o `is_read` das conversas do Kommo fica falso quando só a Sofia respondeu? (a
      regra já ignora conversa em que a última fala é da Sofia, mas só nas unidades com a Sofia);
- [ ] a fila "EM NEGOCIAÇÃO": o Kommo aceita o filtro `value_after` nos eventos de mudança de etapa? (se não
      aceitar, o grupo avisa e usa a última alteração do cartão, que robô também mexe);
- [ ] "Abrir conversa" recarrega o WhatsApp Web e abre o chat certo; contato sem WhatsApp mostra o aviso do
      próprio WhatsApp;
- [ ] "Copiar telefone" funciona no painel lateral do Chrome e na barra lateral do Firefox.

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
