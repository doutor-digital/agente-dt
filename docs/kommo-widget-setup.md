# Modo Widget (widget_request) — setup do piloto

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
  → Digital Pipeline "mensagem recebida → rodar Salesbot (com passo Widget)"
  → Salesbot passo "Widget" → POST  /api/webhooks/<slug>/widget
       body: { token(JWT), data:{ message, lead }, return_url }
  → backend: ACK 200 (≤2s) + valida JWT + dedup
  → [async] roda o agente (mesmo grafo de hoje) → texto
  → POST return_url { execute_handlers:[ {show…}, {goto finish} ] }
  → Kommo entrega os balões ao paciente
```

---

## Passo a passo

### 1. Integração privada + client secret
1. Kommo → **Configurações → Integrações → Criar integração** (privada).
2. Guarde a **client secret** (chave secreta) da integração.

### 2. Subir o widget
1. Empacote `kommo-widget/` (veja `kommo-widget/README.md`):
   ```bash
   cd kommo-widget && zip -r ../kommo-widget.zip manifest.json script.js i18n images
   ```
   (já existe um `kommo-widget.zip` gerado na raiz do repo).
2. Suba o `.zip` na integração privada.
3. Troque `images/logo.png` por um logo real antes de produção (o atual é
   placeholder).

### 3. Montar o Salesbot
1. Crie/edite um Salesbot.
2. Adicione o passo **Widget** → selecione **"Agente DT"**.
3. No campo **URL**, cole:
   ```
   https://<seu-backend>/api/webhooks/<slug-da-unidade>/widget
   ```
   (o painel da unidade mostra essa URL quando o Modo Widget está ligado).

### 4. Digital Pipeline (gatilhos)
1. **Ligue** o gatilho: **"mensagem recebida → rodar esse Salesbot"**.
2. **Desligue** o gatilho antigo: **"campo Resposta IA mudar → rodar Salesbot"**
   (senão os dois caminhos competem).

### 5. Nosso painel (unidade-piloto)
1. Unidade → aba Kommo → ligue **🚀 Modo Widget (widget_request)**.
2. Cole a **client secret** no campo "Client Secret da integração".
   - No piloto a validação do JWT é **permissiva** (loga e segue mesmo sem
     secret ou com assinatura divergente). Depois de confirmar que o Kommo
     assina em HS256 com essa chave, endurecemos pra rejeitar 401 — ver
     `backend/src/controllers/widget.controller.ts` (`verifyWidgetToken`).
3. Salve. A flag invalida o cache da unidade em ~30s.

> A partir daí, para a unidade-piloto, o webhook `/kommo` **deixa de gerar/enviar
> resposta** (só trata status/conversão); quem responde é o `/widget`.

---

## Migração de dados (coluna no banco)

A migration `20260527120000_unit_widget_mode` adiciona 3 colunas em `units`
(`kommo_widget_reply_enabled`, `kommo_widget_secret`, `kommo_widget_salesbot_id`).
É **aditiva e segura** (defaults mantêm tudo desligado). Aplicar no banco do
Railway com o fluxo à prova de reset (NÃO usar `migrate dev`):

```bash
cd backend
npx prisma db execute --file prisma/migrations/20260527120000_unit_widget_mode/migration.sql --schema prisma/schema.prisma
npx prisma migrate resolve --applied 20260527120000_unit_widget_mode
npx prisma generate
```

---

## Verificação (na unidade-piloto)

1. **Gate**: confirme que o passo "Widget" aparece no designer e que o widget
   subiu sem erro.
2. **1 mensagem**: mande UMA mensagem de WhatsApp → espere **1 resposta**, em
   balões, **sem duplicata**. Confira o trace no painel (latência) e a conversa.
3. **Rajada**: mande 2 mensagens rápidas → observe o comportamento da trava
   "um bot por entidade" do Kommo (maior risco novo).
4. **Falha**: force um erro do agente → o bot deve receber o `show` de desculpa
   + `goto finish` (não pode ficar pendurado).
5. **IA pausada / fora-de-horário**: confirme que o bot é finalizado/recebe a
   mensagem-padrão e não trava.

---

## Rollback

Basta **desligar a flag** Modo Widget na unidade (e reativar o gatilho antigo do
Digital Pipeline). O código do caminho legado fica intacto — `deliver` ausente =
`sendChatReply` de sempre.
