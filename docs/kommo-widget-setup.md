# Modo Widget (widget_request) — setup

> **Alvo do piloto: Instituto Trauma.** Conta Kommo `institutotraumakommon.kommo.com`
> (id `36378507`, amojo `d104d847-48f4-4998-b743-9f1ee7169f26`, BR/pt).
> ⚠️ **O slug da unidade é `default`**, não `instituto-trauma`. A linha do banco
> que atende essa conta é a original (`slug=default`, `kommo_subdomain=institutotraumakommon`).
> Webhook correto:
> `https://agente-vps.doutordigitalconsultoria.com/api/webhooks/default/widget`
>
> Isso já custou um teste perdido: o `default_value` do widget vinha com
> `instituto-trauma`, o bot chamou essa URL e levou `404 unit_not_found` — o
> paciente não recebeu nada e **não gerou trace nenhum**. Corrigido em
> `manifest.json` e `script.js`, mas **widget já instalado não se atualiza
> sozinho**: quem manda é a URL digitada no passo do bot.
>
> **Estado em 22/08/2026:** integração privada **"Agente DT" criada e widget
> instalado**. `ID de integração e5e15778-7620-48d1-9ddd-dfbe32b52f9a`,
> código do widget `t5tojflw4l3fhdyhu3r8bivf0gku2rzlt4dlomjo`. Chave secreta fora
> do repo. Unidade com `kommo_widget_reply_enabled=true`, persona gravada,
> `claude-sonnet-5`.
>
> Referência de slug que funciona: `doutor-hernia-imperatriz` responde
> `200 {"skipped":"widget_mode_disabled"}` — é o formato esperado quando a
> unidade existe e a flag está desligada.

Migração da entrega do bot de **PATCH no campo "Resposta IA" + Digital Pipeline**
para o handler **`widget_request`** do Salesbot. Resolve por construção os dois
problemas do caminho legado:

- **Duplicata** — o DP relê o campo e reenvia em loop. No modo widget não há
  campo pro DP reler.
- **Chunking truncado/lento** — o campo trunca em ~250 chars e mandávamos PATCH
  sequencial com 900ms. No modo widget os balões são `show` nativos numa só
  chamada de `return_url`.

> ⚠️ **Pré-requisito que bloqueia tudo:** plano Kommo **Avançado ou superior**
> (libera o WebSDK pra subir widget customizado). Se ao tentar criar a
> integração não aparecer a opção de subir widget, o plano não suporta — pare e
> reavalie (upgrade, ou continuar no caminho legado).

---

## Visão geral do fluxo

```
Paciente → WhatsApp → Kommo
  → Digital Pipeline "mensagem recebida → rodar Salesbot (com passo Agente DT)"
  → Salesbot passo "Agente DT" → POST  /api/webhooks/<slug>/widget
       body: { token(JWT), data:{ message, lead, contact_name, from }, return_url }
  → backend: ACK 200 (≤2s) + valida JWT + dedup por return_url
  → [async] roda o agente (mesmo grafo de hoje) → texto
  → POST return_url { data:{status}, execute_handlers:[ {show…}, … ] }
  → Kommo entrega os balões ao paciente
```

O contrato dos dois lados:

| lado | arquivo | o que faz |
| --- | --- | --- |
| widget (roda no navegador, no designer do bot) | [widget/script.js](../widget/script.js) | `onSalesbotDesignerSave` devolve o fluxo do bot em JSON |
| backend (recebe o webhook) | [backend/src/controllers/widget.controller.ts](../backend/src/controllers/widget.controller.ts) | lê `data.message` + `data.lead`, ACK 200, processa async |
| backend (responde) | [backend/src/services/kommo.service.ts:1256](../backend/src/services/kommo.service.ts#L1256) | `continueSalesbotWidget` → POST no `return_url` |

O JSON que o widget grava no bot (validado — `node` + `JSON.parse`):

```json
[{"question":[{"handler":"widget_request","params":{
  "url":"https://agente-vps.doutordigitalconsultoria.com/api/webhooks/<slug>/widget",
  "data":{"message":"{{message_text}}","lead":"{{lead.id}}",
          "contact_name":"{{contact.name}}","from":"agente-dt"}}}],"require":[]}]
```

É **um passo só**: o bot pausa no `widget_request` e só volta a andar quando o
backend chama o `return_url`. Como não há passo seguinte, o bot termina depois
dos `show`.

---

## Passo a passo

### 1. Criar a integração privada
Precisa estar logado como **administrador** da conta.

1. Kommo → **Configurações → Integrações → Criar integração** → **Privada**.
2. Preencha: **nome** (3–255 chars), **descrição** (5+ chars) e os **escopos**
   (permissões). Ícone e redirect URL são opcionais.
3. **Salvar**. O Kommo gera na aba **Chaves e escopos**: token de longa duração,
   **chave secreta**, ID da integração e — depois que houver widget — o
   **widget code**.

Integração privada não passa por moderação e só funciona na conta onde foi
criada.

### 2. Empacotar e subir o widget

✅ **Validado em produção (Instituto Trauma, 22/08/2026):** no **primeiro**
upload o manifest tem que ir **SEM** `code` e **SEM** `secret_key`. As duas
chaves só existem depois que a integração é salva, e mandar valor inventado é o
que produz o `Ops! Algo deu errado.` genérico (o Kommo compara o `code` do
manifest com o da integração — o erro conhecido é *"Upload and manifest codes
not equal"*).

1. Gere o zip de primeiro upload (só o slug):
   ```bash
   cd widget
   node build.mjs --slug=default
   ```
   O [build.mjs](../widget/build.mjs) reescreve a URL do webhook com o slug,
   **simula o `onSalesbotDesignerSave`** pra provar que o fluxo gravado no bot é
   JSON válido com `message` + `lead`, e monta o `widget.zip` com o
   `manifest.json` na **raiz**. O gerado fica em `widget/dist/`.
2. Na tela **Criar integração**: preencha nome/descrição/escopos, clique em
   **Fazer upload de novo arquivo**, escolha o `widget.zip` e salve em **Fazer
   upload de integração**.
   - Sinal de que o manifest foi lido: aparecem na hora os controles extras
     (Controle de duplicatas, Fontes múltiplas, seletor de Idioma).
3. Abra a integração criada → **Instalar** (marcando o aceite de políticas).
4. Aba **Configurações** da integração: preencha a **URL do webhook** e salve.
5. Só num **re-upload** (widget já existe) passe as chaves:
   ```bash
   node build.mjs --slug=default --code=CODIGO_DO_WIDGET --secret=CHAVE_SECRETA --version=1.1.1
   ```
   Re-upload exige `version` **maior** que a anterior.

Estrutura obrigatória do pacote (`images/` com 6 PNGs e `i18n/` são exigidos;
`script.js`/`style.css` são opcionais mas é neles que mora a lógica):

```
widget.zip
├── manifest.json   (raiz, obrigatório)
├── script.js
├── style.css
├── images/         (logo.png 130x100, logo_small 108x108, logo_main 400x272,
│                    logo_medium 240x84, logo_min 84x84, logo_dp 174x109)
└── i18n/           (pt.json, en.json, es.json — tem que casar com widget.locale)
```

`tour.is_tour` é obrigatório e, quando `true`, precisa vir com `tour_images` por
idioma e a chave `tour_description` presente nos i18n — sem isso o upload falha
com o mesmo erro genérico.

> `images/logo*.png` ainda são placeholders — trocar por logo real antes de
> escalar pra cliente que vê a tela.

### 3. Montar o Salesbot
1. Crie/edite um Salesbot.
2. Adicione o passo do widget → **"Agente DT"**.
3. No campo **URL do webhook**, confirme/cole:
   ```
   https://agente-vps.doutordigitalconsultoria.com/api/webhooks/<slug-da-unidade>/widget
   ```
   O `default_value` do manifest já vem preenchido — **conferir o slug**, que é o
   da unidade no nosso painel, não o subdomínio do Kommo.
4. Salve. Se o passo salvar sem erro, o `onSalesbotDesignerSave` rodou.

### 4. Gatilho — fica NO BOT, não no Digital Pipeline
No Kommo atual o disparo de Salesbot **saiu** do Pipeline Digital e mora dentro
do próprio bot. Ao salvar o bot, abre sozinha a tela **Condição de execução**:

1. **Quando isso acontece:** `Quando o chat é iniciado por mensagem de entrada
   em qualquer canal`
2. **Horário ativo:** sempre → **Pronto**

Não precisa mexer em nada no **Automatizar**. No Instituto Trauma varri as 22
etapas e a única automação existente é "Quando movido para esta etapa → Meta
Conversions API", que não tem relação com a IA.

O gatilho antigo ("campo Resposta IA mudar → rodar Salesbot") só precisa ser
desligado **se existir** — em unidades novas ele nem foi criado. Confira antes
de procurar: se os dois caminhos ficarem ligados, a duplicata volta.

### 5. Nosso painel
1. Unidade → aba Kommo → ligue **🚀 Modo Widget (widget_request)**.
2. Cole a **client secret** da integração no campo "Client Secret".
   - A validação do JWT é **permissiva** hoje: loga e segue mesmo sem secret ou
     com assinatura divergente. Depois de confirmar que o Kommo assina em HS256
     com essa chave, endurecer pra 401 em `verifyWidgetToken`.
3. Salve. A flag invalida o cache da unidade em ~30s.

> A partir daí o webhook `/kommo` **deixa de gerar/enviar resposta** nessa
> unidade (só trata status/conversão); quem responde é o `/widget`.

---

## Migração de dados (coluna no banco)

A migration `20260527120000_unit_widget_mode` adiciona 3 colunas em `units`
(`kommo_widget_reply_enabled`, `kommo_widget_secret`, `kommo_widget_salesbot_id`).
É **aditiva e segura** (defaults mantêm tudo desligado). Aplicar com o fluxo à
prova de reset (NÃO usar `migrate dev`):

```bash
cd backend
npx prisma db execute --file prisma/migrations/20260527120000_unit_widget_mode/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied 20260527120000_unit_widget_mode
npx prisma generate
```

---

## Verificação

1. **Rota viva**: `POST /api/webhooks/<slug>/widget` com slug inexistente tem que
   devolver `404 {"ok":false,"error":"unit_not_found"}`. Com o slug certo e o
   Modo Widget desligado: `200 {"skipped":"widget_mode_disabled"}`. Bom smoke
   test antes de encostar no Kommo.
2. **Widget instalado**: dá pra conferir por API sem abrir a tela —
   ```bash
   curl -s "https://institutotraumakommon.kommo.com/api/v4/widgets?limit=250" \
     -H "Authorization: Bearer SEU_TOKEN" | grep -o '"code":"[^"]*"'
   ```
   o `code` do nosso widget tem que aparecer na lista.
3. **Gate**: o passo "Agente DT" aparece no designer e salva sem erro.
4. **1 mensagem**: mande UMA mensagem de WhatsApp → espere **1 resposta**, em
   balões, **sem duplicata**. Confira o trace no painel (latência) e a conversa.
5. **Rajada**: 2 mensagens rápidas → observe a trava "um bot por entidade" do
   Kommo (maior risco novo).
6. **Falha**: force um erro do agente → o bot recebe o `show` de desculpa e
   termina (não pode ficar pendurado).
7. **IA pausada / fora-de-horário**: o bot é finalizado e não trava.

### Iterar sem reenviar o zip

Pra ajustar o `script.js` sem refazer upload a cada mudança, o Kommo tem modo de
desenvolvimento: sirva os arquivos num localhost e no console do navegador rode
`localStorage.setItem('<widget_code>_is_dev', '<porta>')`. O widget passa a
carregar do seu servidor local. Útil no ajuste do fluxo do bot; o zip final ainda
tem que subir pra valer.

### Ponto de atenção no primeiro teste real

`continueSalesbotWidget` fecha os `execute_handlers` com
`{ handler: 'goto', params: { type: 'finish' } }`, **sem `step`**. A doc do Kommo
descreve `goto` como `{type: question|answer|finish, step: N}` — `finish` pula
pra seção `finish` de um passo, não encerra o bot. Como o nosso fluxo tem um
passo só e nenhuma seção `finish`, o esperado é o bot simplesmente acabar. Se no
teste 3 o bot ficar pendurado depois de entregar os balões, **remover esse
`goto`** é a primeira coisa a tentar.

---

## Rollback

Basta **desligar a flag** Modo Widget na unidade (e reativar o gatilho antigo do
Digital Pipeline). O código do caminho legado fica intacto — `deliver` ausente =
`sendChatReply` de sempre.

---

## Referências

- [Private chatbot integration](https://developers.kommo.com/docs/private-chatbot-integration) — o tutorial que este doc segue
- [Salesbot SDK](https://developers.kommo.com/docs/salesbot-sdk) — contrato do `salesbot_designer` e do `onSalesbotDesignerSave`
- [Salesbot no Digital Pipeline](https://developers.kommo.com/docs/salesbot-dp) — handlers (`show`, `goto`, `conditions`, `exits`)
