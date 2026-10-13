# Ponte — o cartão do Kommo ao lado da conversa no WhatsApp Web

Extensão do Chrome, **fase 1: só leitura**. Com uma conversa aberta no WhatsApp Web, o painel lateral do
Chrome mostra o cartão do Kommo daquele paciente:

- nome do cartão, funil e etapa, com uma barrinha do funil COMERCIAL;
- responsável, etiquetas e se a Sofia está ativa ou quieta (pausa da unidade, fora do horário, caixinha
  "Pausar IA" ou pausa com data);
- de que anúncio o paciente veio;
- o que a franquia sabe: consulta marcada ou não, última consulta, tratamento;
- como o cartão foi achado (pelo telefone, pelas mensagens, pelo nome — "confira" — ou escolhido por você);
- o botão **Abrir no Kommo**.

Também tem um bloco "Modo aprendiz", que diz onde cada coisa fica dentro do Kommo. Na fase 1 ele é fixo; a
fase 3 vai escolher qual dica mostrar e quando.

## Instalar (modo desenvolvedor)

1. No Chrome, abra `chrome://extensions` e ligue **Modo do desenvolvedor**, no canto de cima à direita.
2. Clique em **Carregar sem compactação** e escolha esta pasta (`extensao-ponte/`).
3. A página de opções abre sozinha. Preencha:
   - o **slug da unidade** (ex.: `doutor-hernia-acailandia`);
   - a **chave**: a mesma do widget do cartão no Kommo daquela unidade (o HMAC do slug, ver
     `backend/src/lib/widget-agenda.ts`).

   Depois clique em **Salvar e testar**. Deve aparecer "Conectado: <unidade>".
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
- escreve no Kommo ou na franquia. A fase 1 é só leitura.

Permissões: `sidePanel` e `storage`, mais `host_permissions` apenas para o servidor da Doutor Digital.

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
- `desenho.test.js`: o painel (cartão, candidatos, busca manual e dado do servidor tratado como texto).

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
