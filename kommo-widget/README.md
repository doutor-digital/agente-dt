# Widget "Agente DT" — modo widget_request

Widget customizado do Kommo que adiciona um passo **Widget** ao Salesbot. Quando
o bot chega nesse passo, ele faz um `widget_request` (POST) para o nosso backend
(`/api/webhooks/<slug>/widget`); a IA roda e o bot é retomado via `return_url`
com `execute_handlers` `[show…, goto finish]`.

É a alternativa ao caminho **PATCH no campo "Resposta IA" + Digital Pipeline** —
elimina a duplicata (não há campo pro DP reler) e o chunking truncado (balões
nativos numa só chamada).

## Conteúdo

- `manifest.json` — locations (`salesbot_designer`) + o objeto do passo Widget,
  com o único setting `url` (a URL do webhook).
- `script.js` — `onSalesbotDesignerSave` (monta o `widget_request`) e
  `salesbotDesignerSettings` (saídas success/fail).
- `i18n/pt.json`, `i18n/en.json` — textos.
- `images/logo.png` — **placeholder** (quadrado verde). Troque por um logo real
  antes de subir em produção.

## Pré-requisitos

- Plano Kommo **Avançado+** (libera o WebSDK pra subir widget customizado).
- Integração privada criada no Kommo (pega-se a *client secret* dela pra validar
  o JWT — cole no campo "Client Secret" da unidade no nosso painel).

## Como empacotar

O Kommo exige os arquivos na **raiz** do `.zip` (não dentro de uma subpasta):

```bash
cd kommo-widget
zip -r ../kommo-widget.zip . -x '*.DS_Store' 'README.md'
```

## Como instalar/configurar (resumo)

1. Suba `kommo-widget.zip` na sua integração privada.
2. No Salesbot, adicione o passo **Widget** → selecione "Agente DT" → preencha a
   URL: `https://<seu-backend>/api/webhooks/<slug-da-unidade>/widget`.
3. No Digital Pipeline, configure o gatilho **"mensagem recebida → rodar esse
   Salesbot"** e **desligue** o gatilho antigo "campo Resposta IA mudar → rodar
   Salesbot".
4. No nosso painel, na unidade-piloto: ligue **Modo Widget** e cole a *client
   secret* da integração.

Passo a passo completo: ver `docs/kommo-widget-setup.md`.
