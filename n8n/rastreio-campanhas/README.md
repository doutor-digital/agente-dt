# Rastreio de Campanhas — WhatsApp > Kommo

Captura a atribuição de campanha (Click-to-WhatsApp) de leads que chegam pelo WhatsApp
e grava nos campos personalizados do lead na Kommo — **sem tocar** na integração
WhatsApp ↔ Kommo que já está em produção.

```
n8n/rastreio-campanhas/
├── build-workflow.mjs                        # gera o JSON da variante webhook manual
├── rastreio-campanhas-whatsapp-kommo.json    # ← saída do builder (ATRASADA, ver aviso)
├── producao/ZqW9mOjb0td2Flik.json            # export do workflow ATIVO — fonte da verdade
├── derive-nativo.mjs                         # deriva a variante de nó nativo do export acima
├── rastreio-campanhas-nativo.json            # ← variante WhatsApp Trigger (§10)
├── sql/schema.sql                            # tabelas de dedup, auditoria e log
└── README.md
```

> ⚠️ **`build-workflow.mjs` está atrasado em relação à produção.** O workflow ativo
> recebeu correções direto na UI que o builder não tem (`META_ADS_TOKEN`, imagem do
> anúncio, `origemTipo` orgânico×pago, unwrap da resposta do Kommo, contexto vindo de
> `Avaliar busca`). **Rodar `node build-workflow.mjs` + `PUT` hoje reverte tudo isso.**
> Enquanto o builder não for reconciliado, a fonte da verdade é
> `producao/ZqW9mOjb0td2Flik.json` — reexporte antes de derivar:
>
> ```bash
> curl -s -H "X-N8N-API-KEY: $N8N_API_KEY" \
>   https://n8n.doutordigitalconsultoria.com/api/v1/workflows/ZqW9mOjb0td2Flik \
> | node -e "const w=JSON.parse(require('fs').readFileSync(0,'utf8'));
>   const o={id:w.id,name:w.name,active:w.active,nodes:w.nodes,connections:w.connections,settings:w.settings};
>   require('fs').writeFileSync('producao/ZqW9mOjb0td2Flik.json', JSON.stringify(o,null,2)+'\n')"
> ```

Para editar um nó Code: mexa em `build-workflow.mjs` e rode `node build-workflow.mjs`.
Editar o JSON na mão funciona, mas o JS escapado dentro da string é onde bug entra sem
ser visto.

---

## 1. Arquitetura — por que a Kommo não é afetada

A Meta permite que **vários apps assinem a mesma WABA** (WhatsApp Business Account).
Cada app tem seu próprio callback URL e recebe uma cópia independente de cada evento.

```
                        ┌──────────────────────────────┐
   lead clica no        │  Meta / WhatsApp Cloud API   │
   anúncio e manda  ───▶│  (fan-out para N assinantes) │
   mensagem             └───────┬──────────────┬───────┘
                                │              │
              (app da Kommo,    │              │   (SEU app, novo)
               intocado)        ▼              ▼
                       ┌────────────────┐   ┌──────────────────────┐
                       │  Kommo         │   │  n8n  /webhook/      │
                       │  cria lead,    │   │  meta-ctwa-tracking  │
                       │  salesbot, IA  │   └──────────┬───────────┘
                       └────────┬───────┘              │
                                │           1. valida HMAC, responde 200
                                │           2. dedup + salva payload (Postgres)
                                │           3. resolve o anúncio na Graph API
                                │           4. acha o lead pelo telefone
                                ▼                      ▼
                       ┌───────────────────────────────────────────┐
                       │  Kommo CRM — PATCH nos campos de origem   │
                       └───────────────────────────────────────────┘
```

Três propriedades que garantem o "não afeta":

1. **Nada é interceptado.** O n8n não fica no caminho da Kommo. Se o n8n cair, a Kommo
   continua recebendo mensagens normalmente — você só perde atribuição do período, e
   os eventos ficam registrados na Meta para reentrega.
2. **O único write na Kommo é um PATCH aditivo** em campos personalizados de origem, mais
   uma nota e uma tag. Nada de status, responsável, pipeline ou mensagens.
3. **A escrita é first-touch.** Campo que já tem valor nunca é sobrescrito.

> **Pré-requisito que precisa ser conferido antes de tudo:** a WABA precisa estar no
> Business Manager **do cliente** (é o caso quando a conexão foi feita pelo embedded
> signup da Kommo). Se a WABA pertencer ao BM da Kommo, você não consegue assinar um
> segundo app — nesse cenário o rastreio por webhook não é possível e a alternativa é
> reconciliação por relatório (ver §9).
>
> Colocar o n8n como proxy na frente da Kommo **não** é alternativa aceitável aqui: você
> não controla o app da Kommo para trocar o callback URL, e mesmo controlando isso
> transformaria o n8n em ponto único de falha do atendimento.

---

## 2. Que dado a Meta entrega (e o que ela não entrega)

O evento `messages` do WhatsApp Cloud API traz um objeto `referral` **na primeira
mensagem** de quem veio de um anúncio Click-to-WhatsApp:

```jsonc
{
  "messages": [{
    "from": "5599999999999",
    "id": "wamid.HBgN...",
    "timestamp": "1753960000",
    "type": "text",
    "referral": {
      "source_url": "https://fb.me/2abcDEF",
      "source_id": "120210000000000000",   // ID DO ANÚNCIO
      "source_type": "ad",                 // "ad" | "post"
      "headline": "Avaliação gratuita",
      "body": "Agende hoje mesmo...",
      "media_type": "image",
      "ctwa_clid": "ARBx..."               // click id — serve para CAPI depois
    }
  }]
}
```

Campanha, conjunto, nome do anúncio e **UTMs não vêm no webhook**. Eles são resolvidos
com uma chamada à Graph API usando o `source_id`:

```
GET /{versao}/{ad_id}
  ?fields=id,name,campaign{id,name,objective},
          adset{id,name,targeting{publisher_platforms}},
          creative{id,name,url_tags,effective_object_story_id}
```

As UTMs saem de `creative.url_tags` (o campo "Parâmetros de URL" do anúncio), com as
macros da Meta — `{{campaign.name}}`, `{{ad.name}}` etc. — já resolvidas pelo workflow.

**Precedência das UTMs** (a primeira que existir vence):

1. query string de `referral.source_url`;
2. `creative.url_tags`;
3. derivado: `utm_source` = plataforma do conjunto, `utm_medium` = `paid_social`,
   `utm_campaign` = nome da campanha, `utm_content` = nome do anúncio,
   `utm_term` = nome do conjunto.

O campo `origemUtm` na nota de auditoria registra qual das três origens foi usada.

**Limitação real, não contornável por webhook:** clique sem mensagem **não gera evento
nenhum**. A Meta só dispara o webhook quando o usuário efetivamente envia a primeira
mensagem. Volume de cliques só existe no Ads Insights (`actions` →
`onsite_conversion.total_messaging_connection`), que é agregado e não tem telefone.

---

## 3. Configuração no Meta for Developers

1. **Criar o app.** developers.facebook.com → *Meus apps* → *Criar app* → tipo **Negócios**.
   Nome sugerido: `Doutor Digital — Rastreio CTWA`.
2. **Vincular ao Business Manager** que é dono da WABA (aba *Configurações básicas* →
   *Verificação da empresa* / *Business Manager*).
3. **Adicionar produtos**: **WhatsApp** e **Marketing API**.
4. **Anotar o App Secret** (*Configurações → Básico → Chave secreta do app*) →
   vira `META_APP_SECRET`.
5. **Criar um usuário do sistema** no Business Manager (*Configurações do negócio →
   Usuários → Usuários do sistema*), papel **Admin**, e atribuir a ele:
   - a **conta de anúncios** (permissão de visualização) → necessário para `ads_read`;
   - a **WhatsApp Business Account** (controle total).
6. **Gerar token do usuário do sistema** com os escopos:
   `whatsapp_business_management`, `whatsapp_business_messaging`, `ads_read`,
   `business_management`. Marque **token que não expira**. → vira a credencial
   `Meta Graph API — Rastreio CTWA` no n8n.
7. **Configurar o webhook** (WhatsApp → *Configuração* → *Webhooks*):
   - **Callback URL**: `https://webhook-n8n.doutordigitalconsultoria.com/webhook/meta-ctwa-tracking`
     (atenção: o n8n roda em modo fila e os webhooks atendem por **`webhook-n8n.`**,
     não pelo host do editor `n8n.`)
   - **Token de verificação**: o mesmo valor de `META_WEBHOOK_VERIFY_TOKEN`
   - Clique em *Verificar e salvar* — o workflow precisa estar **ativo** no n8n para o
     handshake `GET` responder.
   - **Assinar o campo `messages`** (só ele; `message_template_status_update` e afins não
     interessam aqui).
8. **Assinar o app na WABA.** É o passo que costuma faltar — configurar o webhook no app
   não basta, o app precisa ser assinante daquela WABA:

   ```bash
   curl -X POST \
     "https://graph.facebook.com/v23.0/<WABA_ID>/subscribed_apps" \
     -H "Authorization: Bearer <TOKEN_DO_USUARIO_DO_SISTEMA>"
   ```

   Confira que a Kommo continua lá (a lista tem que ter **os dois** apps):

   ```bash
   curl "https://graph.facebook.com/v23.0/<WABA_ID>/subscribed_apps" \
     -H "Authorization: Bearer <TOKEN_DO_USUARIO_DO_SISTEMA>"
   ```

   > Se essa lista voltar só com o seu app depois do POST, **pare e reverta**
   > (`DELETE /subscribed_apps` com o seu token) — significa que a WABA não suporta
   > múltiplos assinantes nessa configuração e você acabou de tirar a Kommo do ar.
   > Faça esse teste fora do horário comercial e com uma mensagem de teste na mão.
9. O app pode ficar em **modo de desenvolvimento**: webhooks de uma WABA atribuída ao seu
   BM funcionam sem App Review.

---

## 4. Configuração na Kommo

### 4.1 Campos personalizados (entidade **Leads**)

Kommo → *Configurações* → *Campos personalizados* → aba **Leads** → grupo sugerido
"Origem / Campanha".

| # | Nome do campo             | Tipo do campo no Kommo | Variável de ambiente         |
|---|---------------------------|------------------------|------------------------------|
| 1 | Origem – Campanha         | Texto                  | `KOMMO_CF_CAMPANHA`          |
| 2 | Origem – Conjunto         | Texto                  | `KOMMO_CF_CONJUNTO`          |
| 3 | Origem – Anúncio          | Texto                  | `KOMMO_CF_ANUNCIO`           |
| 4 | Origem – ID do anúncio    | Texto                  | `KOMMO_CF_AD_ID`             |
| 5 | Origem – utm_source       | Texto                  | `KOMMO_CF_UTM_SOURCE`        |
| 6 | Origem – utm_medium       | Texto                  | `KOMMO_CF_UTM_MEDIUM`        |
| 7 | Origem – utm_campaign     | Texto                  | `KOMMO_CF_UTM_CAMPAIGN`      |
| 8 | Origem – utm_content      | Texto                  | `KOMMO_CF_UTM_CONTENT`       |
| 9 | Origem – utm_term         | Texto                  | `KOMMO_CF_UTM_TERM`          |
|10 | Origem – URL              | Texto (ou URL)         | `KOMMO_CF_ORIGEM_URL`        |
|11 | Origem – ctwa_clid        | Texto                  | `KOMMO_CF_CTWA_CLID`         |
|12 | Origem – Tipo             | Texto                  | `KOMMO_CF_ORIGEM_TIPO`       |
|13 | Origem – Primeiro contato | **Data e hora**        | `KOMMO_CF_PRIMEIRO_CONTATO`  |
|14 | Origem – Headline         | Texto (área de texto)  | `KOMMO_CF_HEADLINE`          |
|15 | Origem – Plataforma       | Texto                  | `KOMMO_CF_PLATAFORMA`        |

Notas:

- **Use "Texto", não "Lista"**, para campanha/conjunto/anúncio/UTM. Lista exige que o valor
  exista como opção cadastrada; nome de campanha nova cairia no vazio silenciosamente.
- O campo 13 é o único **Data e hora** — a API recebe unix timestamp em segundos, que é o
  que o workflow envia.
- Qualquer campo que você não quiser é só deixar a variável de ambiente vazia: o workflow
  pula os campos sem ID configurado.

Pegue os IDs numéricos com:

```bash
curl -s "https://<SUBDOMINIO>.kommo.com/api/v4/leads/custom_fields?limit=250" \
  -H "Authorization: Bearer $KOMMO_ACCESS_TOKEN" \
| jq -r '._embedded.custom_fields[] | select(.name|test("Origem")) | "\(.id)\t\(.name)\t\(.type)"'
```

### 4.2 Tag

O workflow adiciona a tag definida em `KOMMO_TAG_ORIGEM` (padrão: `Origem: Anuncio pago`).
**Crie a tag antes na Kommo** — `tags_to_add` com nome inexistente é ignorado sem erro.

### 4.3 Token

*Configurações → Integrações → criar integração privada* → copie o **token de acesso de
longa duração**. É o mesmo tipo de token que o `agente-dt` já usa em `KOMMO_ACCESS_TOKEN`.
Permissões: leitura e escrita de leads e contatos.

---

## 5. Credenciais e variáveis de ambiente do n8n

### 5.1 Credenciais

O workflow **já aponta para credenciais que existem** na instância
`n8n.doutordigitalconsultoria.com` — nenhum segredo precisou ser recadastrado:

| Nó | Credencial usada | Tipo |
|---|---|---|
| `Resolver anuncio (Graph API)` | `Facebook Graph account` | `facebookGraphApi` |
| 5 nós Kommo | `Kommo Imperatriz` | `kommoLongLivedApi` |
| 9 nós de log | `Postgres - Rastreio CTWA` | `postgres` |

Dois pontos para conferir antes de ligar:

- **Unidade da Kommo.** Imperatriz é o padrão (unidade canônica de configuração,
  subdomínio `attivacorpoementeitz`). Para outra unidade: troque a credencial nos 5 nós
  Kommo pela UI **e** ajuste `KOMMO_SUBDOMAIN`. A instância tem credencial para
  Araguaína, Balsas, Canaã, Açailândia, Marabá, Parauapebas, Porto Nacional, Serra e
  Trauma.
- **Banco.** Já existe e é **dedicado**: banco `n8n_rastreio` com role própria `rastreio`,
  na instância `postgres:14` da VPS (a mesma que hospeda o `n8n_queue`). Não compartilha
  nada com o banco do 3C nem com o do `agente-dt`. A senha vive só na VPS, em
  `/root/.rastreio-db.env` (chmod 600).
- O token do `Facebook Graph account` precisa ter **`ads_read`**. Se a credencial atual
  só cobre WhatsApp, o nó de enriquecimento falha — o workflow continua gravando
  `ctwa_clid`, `source_url` e headline, mas sem campanha/conjunto/UTM.

### 5.2 Variáveis de ambiente do container n8n

```bash
# ── Meta ────────────────────────────────────────────────────────────────────
META_APP_SECRET=...                    # Configurações → Básico → Chave secreta
META_WEBHOOK_VERIFY_TOKEN=...          # string aleatória sua; a mesma no painel da Meta
META_GRAPH_VERSION=v23.0

# ── Kommo ───────────────────────────────────────────────────────────────────
KOMMO_SUBDOMAIN=attivacorpoementeitz
KOMMO_TAG_ORIGEM=Origem: Anuncio pago

KOMMO_CF_CAMPANHA=123456
KOMMO_CF_CONJUNTO=123457
KOMMO_CF_ANUNCIO=123458
KOMMO_CF_AD_ID=123459
KOMMO_CF_UTM_SOURCE=123460
KOMMO_CF_UTM_MEDIUM=123461
KOMMO_CF_UTM_CAMPAIGN=123462
KOMMO_CF_UTM_CONTENT=123463
KOMMO_CF_UTM_TERM=123464
KOMMO_CF_ORIGEM_URL=123465
KOMMO_CF_CTWA_CLID=123466
KOMMO_CF_ORIGEM_TIPO=123467
KOMMO_CF_PRIMEIRO_CONTATO=123468
KOMMO_CF_HEADLINE=123469
KOMMO_CF_PLATAFORMA=123470

# ── comportamento ───────────────────────────────────────────────────────────
# false (padrão): não cria nada; lead ausente vira "orfao" no log.
# Só ligue depois de medir quantos órfãos sobram de verdade.
KOMMO_CREATE_IF_MISSING=false
KOMMO_PIPELINE_ID=                     # obrigatório só se CREATE_IF_MISSING=true
KOMMO_STATUS_ID=
CTWA_LOOKUP_MAX_TENTATIVAS=4
CTWA_LOOKUP_BACKOFF_SEGUNDOS=20
ALERT_WEBHOOK_URL=                     # opcional (Slack/Telegram/Chatwoot)

# ── requisitos do n8n — JÁ ATENDIDOS nesta instância, não mexer ─────────────
# NODE_FUNCTION_ALLOW_BUILTIN=*        (o nó de HMAC precisa de require('crypto'))
# N8N_BLOCK_ENV_ACCESS_IN_NODE=false   (o nó Config lê tudo de $env)
```

### 5.3 Como aplicar as env vars nesta VPS

A instância é **Docker Swarm em modo fila**: `n8n_n8n_editor`, `n8n_n8n_worker` e
`n8n_n8n_webhook`. As execuções rodam no **worker**, então a env var precisa estar nos
três serviços (o editor avalia expressões na UI, o webhook recebe a requisição).

```bash
ssh root@89.116.214.130
VARS=(
  "META_APP_SECRET=..."
  "META_WEBHOOK_VERIFY_TOKEN=..."
  "META_GRAPH_VERSION=v23.0"
  "KOMMO_SUBDOMAIN=attivacorpoementeitz"
  "KOMMO_TAG_ORIGEM=Origem: Anuncio pago"
  "KOMMO_CREATE_IF_MISSING=false"
  "CTWA_LOOKUP_MAX_TENTATIVAS=4"
  "CTWA_LOOKUP_BACKOFF_SEGUNDOS=20"
  "KOMMO_CF_CAMPANHA=..." # ... os 15 IDs de campo
)
ARGS=(); for v in "${VARS[@]}"; do ARGS+=(--env-add "$v"); done
for svc in n8n_n8n_editor n8n_n8n_worker n8n_n8n_webhook; do
  docker service update "${ARGS[@]}" --update-order start-first "$svc"
done
```

> Isso reinicia os três serviços (rolling, ~1 min). A instância tem **20+ workflows
> ativos em produção** — inclusive webhooks do 3C Plus. Faça **de uma vez só**, com
> todos os valores em mão, em vez de um update por variável.

**"Variables" não resolve isso.** A licença gratuita do Community Edition libera só
*Folders*, *Debug in editor* e *Custom execution data* — `$vars` continua sendo recurso
Enterprise. E mesmo que estivesse disponível, `$vars` ≠ `$env`: o workflow lê `$env`.

---

## 6. Estado atual e o que falta

**Já feito** (via API pública do n8n, em 2026-07-31):

- Workflow criado: **`ZqW9mOjb0td2Flik`** —
  <https://n8n.doutordigitalconsultoria.com/workflow/ZqW9mOjb0td2Flik>
- Pasta criada no projeto pessoal: **`Rastreio de Campanhas`** (`zvdmW1iUfpn0CgZq`)
- Banco dedicado **`n8n_rastreio`** criado na VPS (postgres:14, role `rastreio`),
  com `ctwa_eventos` e `ctwa_logs` já aplicados
- Credencial **`Postgres - Rastreio CTWA`** (`y6Q1JmvPL4BodI9u`) criada e ligada
  aos 9 nós de log
- Credenciais já vinculadas (§5.1)
- Estado: **parado**, de propósito — ativar registra o webhook e é passo do operador

**Falta, na ordem:**

1. Criar os 15 campos personalizados na Kommo (§4.1) e anotar os IDs.
2. Aplicar as env vars nos 3 serviços do n8n (§5.3) — **uma vez só**. Sem elas o
   workflow sobe mas não faz nada útil:
   - `META_APP_SECRET` vazio → todo evento vira 401
   - `KOMMO_CF_*` vazios → nenhum campo é gravado
3. Arrastar o workflow para a pasta `Rastreio de Campanhas` na UI (a API pública
   não expõe atribuição de pasta).
4. Conferir a unidade da Kommo nos 5 nós Kommo (§5.1).
5. **Ativar** o workflow — o handshake `GET` da Meta só responde com ele ativo.
6. Configurar o webhook na Meta e assinar a WABA (§3.7 e §3.8), com o cuidado do §1.

Para reimportar depois de mexer no builder:

```bash
node build-workflow.mjs
curl -X PUT "https://n8n.doutordigitalconsultoria.com/api/v1/workflows/ZqW9mOjb0td2Flik" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" -H 'Content-Type: application/json' \
  -d "$(node -e "const w=require('./rastreio-campanhas-whatsapp-kommo.json');
        process.stdout.write(JSON.stringify({name:w.name,nodes:w.nodes,connections:w.connections,settings:w.settings}))")"
```

---

## 7. Estrutura de nós

**Trilha de verificação (GET)** — handshake da Meta.

| Nó | Papel |
|---|---|
| `Meta — Verificacao (GET)` | Webhook `GET /meta-ctwa-tracking` |
| `Verify token confere?` | Compara `hub.verify_token` com `META_WEBHOOK_VERIFY_TOKEN` |
| `Responder hub.challenge` / `Recusar verificacao` | 200 com o challenge, ou 403 |

**Trilha de eventos (POST)**

| Nó | Papel |
|---|---|
| `Meta — Eventos (POST)` | Webhook `POST` com **Raw Body** ligado (o HMAC é sobre os bytes originais) |
| `Validar assinatura HMAC` | `X-Hub-Signature-256` vs. HMAC-SHA256 do corpo bruto, comparação `timingSafeEqual` |
| `Assinatura valida?` | Inválida → **401** + log (4xx não gera reentrega da Meta; 5xx geraria loop) |
| `Responder 200 (ACK)` | 200 **antes de qualquer I/O** — a Meta reentrega se não receber 200 em ~20s |
| `Config` | Lê todo o `$env` num lugar só e pendura em `cfg` |
| `Extrair mensagens e referral` | Achata `entry[].changes[].value.messages[]`; descarta eventos de `statuses` |
| `Tem dados de campanha?` | Sem `referral` → log `ignorado` e fim |
| `Dedup + registrar evento` | `INSERT ... ON CONFLICT ... RETURNING (xmax = 0)`: grava payload **e** diz se é novo |
| `Evento novo?` | Reentrega → log `duplicado` e fim |
| `Contexto do anuncio` | Reidrata o contexto casando por `wamid` (chave, não índice) |
| `Resolver anuncio (Graph API)` | Campanha/conjunto/anúncio/`url_tags`. 3 tentativas; falha **não** aborta |
| `Normalizar atribuicao` | Resolve macros `{{campaign.name}}`, monta UTMs por precedência |
| `Loop por lead` | Um lead por vez — mantém contexto acessível e respeita rate limit da Kommo |
| `Buscar contato na Kommo` | `GET /contacts?query=<8 últimos dígitos>&with=leads` |
| `Avaliar busca` | Casa por sufixo de telefone; **contato sem lead = não achou** |
| `Contato com lead?` | ✔ segue para gravar · ✘ vai para o backoff |
| `Tentativas esgotadas?` → `Aguardar a Kommo criar o lead` | Backoff 20s/40s/60s (teto 120s), volta para a busca |
| `Criar lead se nao existir?` | Só com `KOMMO_CREATE_IF_MISSING=true`; senão log `orfao` |
| `Ler lead atual` | Lê `custom_fields_values` para decidir o que está vazio |
| `Montar PATCH (first-touch)` | Só campos vazios; monta **um** PATCH com campos + `tags_to_add` na raiz |
| `Ha algo para gravar?` | Tudo preenchido → log `preservado` |
| `Atualizar lead (PATCH unico)` | PATCH; saída de erro vai para log + alerta |
| `Nota de auditoria no lead` | Nota com a atribuição completa (aditivo, nunca sobrescreve) |
| `Log — *` | Postgres, sempre `onError: continue` — log não derruba fluxo |

Três detalhes que valem lembrar quando for mexer:

- **`tags_to_add` vai na raiz do body**, não em `_embedded`. Dentro de `_embedded` a Kommo
  responde 200 e ignora em silêncio.
- **Um PATCH só por lead.** PATCHes concorrentes no mesmo lead têm race na API da Kommo:
  o último a chegar pode apagar o que o anterior gravou.
- **`Raw Body` é obrigatório** no nó Webhook. Com o corpo já parseado, qualquer
  reserialização muda os bytes e o HMAC nunca fecha.

---

## 8. Plano de testes

Rode com o workflow ativo e o n8n em *Executions → All*. Para os cenários sintéticos, use
o botão **Test URL** do webhook e um `curl` com a assinatura correta:

```bash
BODY='{"object":"whatsapp_business_account","entry":[...]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$META_APP_SECRET" -r | cut -d' ' -f1)"
curl -X POST https://webhook-n8n.doutordigitalconsultoria.com/webhook/meta-ctwa-tracking \
  -H "Content-Type: application/json" -H "X-Hub-Signature-256: $SIG" -d "$BODY"
```

| # | Cenário | Como executar | Resultado esperado |
|---|---|---|---|
| 1 | **Lead novo vindo de anúncio** | Clique real no anúncio com um número que nunca falou com a empresa, mande "oi" | Kommo cria o lead; ~20–60s depois o workflow acha e grava os 15 campos + tag + nota. `ctwa_logs.status='sucesso'`. **A mensagem tem que aparecer normalmente no chat da Kommo** |
| 2 | **Lead existente com atribuição anterior** | Repita o clique com um número que já tem lead com campos de origem preenchidos | `status='preservado'`; campos antigos **intactos**; nota nova adicionada. Confirme campo a campo |
| 3 | **Clique sem mensagem** | Clique no anúncio e feche o WhatsApp sem enviar nada | **Nenhuma execução no n8n** — a Meta não dispara webhook sem mensagem. Comportamento esperado, não é bug (§2) |
| 4 | **Mensagem sem dados de campanha** | Mande mensagem de um número qualquer direto no WhatsApp | Execução chega até `Tem dados de campanha?` → ramo falso → `status='ignorado'`. Nada escrito na Kommo |
| 5 | **Evento duplicado** | Reenvie o mesmo `curl` (mesmo `wamid`) 3× | 1ª: fluxo completo. 2ª e 3ª: `status='duplicado'`, param no dedup. `ctwa_eventos.repeticoes = 2`. **Nenhum PATCH extra na Kommo** |
| 6a | **Erro de API — Kommo** | Troque o token da credencial Kommo por um inválido e dispare o cenário 1 | 3 tentativas com 5s, depois `status='falha'` com o corpo do erro; alerta disparado se `ALERT_WEBHOOK_URL`. Fluxo continua para o próximo lead do lote |
| 6b | **Erro de API — Graph** | Use um `source_id` inexistente no payload | `Resolver anuncio` falha, `erroGraph` preenchido, e **a gravação acontece mesmo assim** com `ctwa_clid`, `source_url`, headline e UTMs derivadas |
| 7 | **Assinatura inválida** | Mesmo `curl` com `X-Hub-Signature-256: sha256=deadbeef` | HTTP **401**, `etapa='assinatura'`, `status='falha'`. Nada processado |
| 8 | **Lead ainda não existe (race)** | Dispare o `curl` com um telefone que não existe na Kommo | 4 tentativas com backoff; depois `status='orfao'` (padrão) — sem lead duplicado criado |
| 9 | **Regressão da Kommo** (o mais importante) | Durante 24h após ativar: acompanhe volume de mensagens recebidas e leads criados na Kommo | Números iguais aos do dia anterior. Qualquer queda → `DELETE /subscribed_apps` do **seu** app imediatamente |

Consultas de conferência estão comentadas no fim de `sql/schema.sql`.

---

## 9. Operação

- **Saúde diária:** `select status, count(*) from ctwa_logs where criado_em > now() - interval '24 hours' group by 1;`
- **Órfãos:** a query comentada em `schema.sql` lista os leads que não existiam na hora.
  Se o volume for consistente, aumente `CTWA_LOOKUP_MAX_TENTATIVAS` antes de considerar
  ligar `KOMMO_CREATE_IF_MISSING`.
- **`repeticoes > 2` em `ctwa_eventos`:** a Meta está insistindo, ou seja, o 200 não está
  saindo a tempo. Olhe latência do n8n e se o nó `Responder 200 (ACK)` continua antes do
  `Config`.
- **Rollback:** `DELETE https://graph.facebook.com/v23.0/<WABA_ID>/subscribed_apps` com o
  **seu** token remove só o seu app. A Kommo não é tocada.
- **`ctwa_clid`** fica guardado no lead e no `ctwa_eventos`. É a chave para, depois,
  mandar conversões de volta para a Meta pela Conversions API e fechar o ciclo
  clique → lead → venda.
- **Se a WABA não aceitar um segundo app** (§1): o caminho que resta é reconciliação
  agregada — puxar Ads Insights por dia/campanha e cruzar com leads criados na janela,
  sem atribuição individual por telefone. É estimativa, não atribuição.

---

## 10. Variante com nó nativo (`WhatsApp Trigger`) — **em produção desde 2026-08-18**

Workflow **`4T4HALkkLJtcNAY1`** —
<https://n8n.doutordigitalconsultoria.com/workflow/4T4HALkkLJtcNAY1> — **ativo**; o
`ZqW9mOjb0td2Flik` ficou parado como fallback. É o `ZqW9mOjb0td2Flik` de produção com a
cabeça trocada: saem os 10 nós da
trilha manual (GET/POST, HMAC, 401, ACK), entram `On messages` +
`Normalizar formato do Trigger`. Todo o miolo é **byte a byte o de produção** — é o que
o `derive-nativo.mjs` garante.

Gerar de novo depois de reexportar a produção:

```bash
node derive-nativo.mjs
K=$N8N_API_KEY
BODY=$(node -e "const w=require('./rastreio-campanhas-nativo.json');
  const ok=['executionOrder','saveDataErrorExecution','saveDataSuccessExecution',
            'saveExecutionProgress','saveManualExecutions','executionTimeout','errorWorkflow','timezone'];
  const s={}; for(const k of ok) if(w.settings[k]!==undefined) s[k]=w.settings[k];
  process.stdout.write(JSON.stringify({name:w.name,nodes:w.nodes,connections:w.connections,settings:s}))")
curl -s -X PUT "https://n8n.doutordigitalconsultoria.com/api/v1/workflows/4T4HALkkLJtcNAY1" \
  -H "X-N8N-API-KEY: $K" -H 'Content-Type: application/json' -d "$BODY"
```

> A API pública recusa `settings` com propriedades extras (`binaryMode`, `callerPolicy`,
> `availableInMCP`) — daí o filtro. E `PUT` reativa o workflow sozinho: confira o
> `active` na resposta e chame `/deactivate` se a intenção era mantê-lo parado.

### 10.1 O que o nó faz sozinho

- responde o handshake `hub.challenge` — o **`verify_token` é o id do nó**
  (`whatsapp-trigger-nativo`);
- valida `x-hub-signature-256` com o **App Secret da credencial** (some o
  `META_APP_SECRET` do fluxo);
- responde **200 na hora** (`responseMode: onReceived`), antes de qualquer I/O — mesma
  garantia do antigo nó `Responder 200 (ACK)`;
- ao **ativar**, chama `POST /{app_id}/subscriptions` apontando para a URL do webhook
  deste n8n; ao **desativar**, apaga a inscrição.

O que ele **não** faz: assinar a WABA. `POST /{WABA_ID}/subscribed_apps` continua
manual (§3.8).

### 10.2 Mesmo app, callback repontado (feito em 2026-08-18)

Não existe "usar a mesma URL": o caminho do nó nativo é fixo em
`/webhook/<webhookId>/webhook` — o sufixo vem da própria definição do nó. O que dá (e é
o que interessa) é **manter o mesmo app da Meta**, `1108510921356615`, e só repontar o
callback dele. Vantagem sobre criar app novo: **`subscribed_apps` da WABA não é tocado**,
então o risco de derrubar a Kommo (§1, §3.8) sai da jogada inteira.

Estado atual, conferido na Graph:

```
GET /1108510921356615/subscriptions
  callback_url: https://webhook-n8n.doutordigitalconsultoria.com/webhook/meta-ctwa-tracking-nativo/webhook
  fields: messages · active: true
```

O `webhookId` do nó está **fixado no JSON** como `meta-ctwa-tracking-nativo` justamente
para essa URL ser estável e legível — se o n8n sortear um UUID a cada import, o callback
muda sem ninguém perceber.

### 10.3 Trocar de app / reativar do zero

O `checkExists` do nó compara `callback_url` com a URL dele e **lança erro** se o app já
tiver outra inscrição:

> `The WhatsApp App ID <id> already has a webhook subscription. Delete it or use another App`

Ou seja, para ativar em um app que já tem webhook, apaga primeiro:

```bash
APP=1108510921356615; SEC=<app secret>          # = META_APP_SECRET
curl -s "https://graph.facebook.com/v23.0/$APP/subscriptions?access_token=$APP%7C$SEC"
curl -X DELETE "https://graph.facebook.com/v23.0/$APP/subscriptions?object=whatsapp_business_account&access_token=$APP%7C$SEC"
```

Depois **ativar o workflow** (UI ou `POST /api/v1/workflows/4T4HALkkLJtcNAY1/activate`) —
o n8n registra o callback sozinho. Conferir com o `GET` acima.

Smoke test sem esperar lead real (o segundo não escreve nada no Kommo: mensagem sem
`referral` morre no ramo `ignorado`):

```bash
U=https://webhook-n8n.doutordigitalconsultoria.com/webhook/meta-ctwa-tracking-nativo/webhook
curl -s "$U?hub.mode=subscribe&hub.verify_token=whatsapp-trigger-nativo&hub.challenge=DESAFIO123"   # -> DESAFIO123
BODY='{"object":"whatsapp_business_account","entry":[{"id":"1558318502323307","changes":[{"field":"messages","value":{"metadata":{"phone_number_id":"1192220830640227"},"messages":[{"from":"5563991021043","id":"wamid.SMOKE-001","timestamp":"1755548000","type":"text"}]}}]}]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SEC" -r | cut -d' ' -f1)"
curl -X POST "$U" -H 'Content-Type: application/json' -H "X-Hub-Signature-256: $SIG" -d "$BODY"
```

O `verify_token` é o **id do nó** (`whatsapp-trigger-nativo`), não uma string escolhida.

### 10.4 Rollback para a trilha manual

Um curl e uma reativação — a inscrição volta para o `ZqW9`:

```bash
curl -X POST "https://graph.facebook.com/v23.0/$APP/subscriptions" \
  -d "object=whatsapp_business_account" \
  -d "callback_url=https://webhook-n8n.doutordigitalconsultoria.com/webhook/meta-ctwa-tracking" \
  -d "verify_token=$META_WEBHOOK_VERIFY_TOKEN" \
  -d "fields=messages" -d "include_values=true" \
  -d "access_token=$APP|$SEC"
```

Reativar `ZqW9mOjb0td2Flik` e desativar `4T4HALkkLJtcNAY1` (nessa ordem — desativar o
nativo apaga a inscrição que você acabou de criar).

### 10.5 Watchdog — o que impede a inscrição de sumir sem ninguém ver

`ops/ctwa-webhook-watchdog.sh`, instalado em `/root/ctwa-webhook-watchdog.sh` na VPS,
rodando a cada 2 minutos:

```cron
*/2 * * * * /usr/bin/flock -n /tmp/ctwa-wd.lock /root/ctwa-webhook-watchdog.sh >> /root/ctwa-webhook-watchdog.log 2>&1
```

O que ele faz, nessa ordem:

1. bate um `hub.challenge` na URL de produção — se o n8n não devolver o desafio, o
   workflow está parado: **loga e para**, porque registrar agora só levaria recusa;
2. compara o `callback_url` que a Meta guarda com o esperado;
3. se divergir (ou não existir), repõe com `POST /{app_id}/subscriptions` — **sem
   desativar/reativar o workflow**: a rota do n8n nunca caiu, o que sumiu foi só o
   registro do lado da Meta. Confere depois de gravar.

Silencioso quando está tudo certo; o log só acumula anomalia. Segredos em
`/root/.ctwa-webhook.env` (chmod 600): `APP_ID`, `APP_SECRET`, `VERIFY_TOKEN`
(= id do nó) e `CALLBACK_ESPERADO`.

Testado em 2026-08-18 apagando a inscrição de propósito: detectou e restaurou em 2s.

> Se você mudar o `webhookId` do nó ou o id do nó, **atualize
> `/root/.ctwa-webhook.env`** — senão o watchdog restaura para a URL antiga a cada
> 2 minutos e briga com o n8n.

#### A camada que o watchdog NÃO cobre — e que caiu em 2026-08-18

São **duas** camadas independentes na Meta, e confundi-las custa horas:

| Camada | Endpoint | Quem mexe | Vigiada? |
|---|---|---|---|
| o app tem webhook, e em qual URL | `/{app_id}/subscriptions` | n8n (ativar/desativar) e o watchdog | sim |
| **a WABA entrega eventos para esse app** | `/{WABA_ID}/subscribed_apps` | ninguém, desde a instalação (§3.8) | **não** |

Recriar a primeira **não** recria a segunda. Apagar a inscrição do app (o teardown do
"Listen for test event") derrubou o app da lista de assinantes da WABA: o endpoint
respondia, `GET /subscriptions` mostrava `active: true`, o workflow processava `curl`
assinado — e **nenhum evento real chegava**, porque a WABA parou de fazer fan-out.

**Como diagnosticar isso em 1 minuto** (foi o que fechou o caso): o access-log do Traefik
mostra tudo que a Meta bate na VPS.

```bash
C=$(docker ps -qf name=traefik | head -1)
docker exec $C sh -c "grep meta-ctwa /var/log/traefik/access-log | grep POST | tail -5"
```

Se **não há POST nenhum em URL alguma**, o problema é a camada da WABA — não adianta
mexer em callback, nem voltar para o fluxo antigo (ele morre junto, pelo mesmo motivo).

**Correção** (token com `whatsapp_business_management`; o temporário de 24h em
*WhatsApp → Configuração da API* serve):

```bash
curl -X POST "https://graph.facebook.com/v23.0/1558318502323307/subscribed_apps" \
  --data-urlencode "override_callback_uri=https://webhook-n8n.doutordigitalconsultoria.com/webhook/meta-ctwa-tracking-nativo/webhook" \
  -d "verify_token=whatsapp-trigger-nativo" \
  -H "Authorization: Bearer <TOKEN>"
```

O `override_callback_uri` é o detalhe que fecha: a assinatura da WABA tinha um override
apontando para a URL antiga, e **override vence o callback do app** — por isso trocar o
callback no nível do app não mudava para onde a Meta entregava.

Conferir depois (têm de aparecer os três, com a Kommo intacta):

```bash
curl -s "https://graph.facebook.com/v23.0/1558318502323307/subscribed_apps?access_token=<TOKEN>"
# 1108510921356615 Doutor Hérnia Imperatriz (override → nó nativo)
# 27796843533314686 Doutor Digital — Anuncios
# 1022173854571346 Kommo
```

Com um token **permanente** de usuário do sistema guardado na VPS, o watchdog passa a
vigiar essa camada também. Enquanto isso, ela é o ponto cego.

### 10.6 Last-touch, correção de origem e backfill (19/08/2026)

Aplicados por `patch-last-touch.mjs` sobre `producao/4T4HALkkLJtcNAY1.json`. Cada patch
casa por âncora e **aborta se o nó mudou** — não existe patch aplicado pela metade.

| # | O que mudou | Por quê |
|---|---|---|
| 1 | Tag condicional: `Origem: Anuncio pago` **ou** `Origem: Organico` (tag `184861`, criada) | a tag era fixa e caía em Reel orgânico, inflando "lead pago" no relatório |
| 2 | Erro de Graph em `source_type='post'` não vira `erroGraph` | post não tem campo `campaign`; o `(#100)` é esperado e sujava a nota com falso alarme |
| 3 | **Last-touch**: `⌂ Último anúncio` (2446113) e `⌂ Cliques no anúncio` (2446115), no grupo MARKETING | histórico de clique dentro do lead, sem violar o first-touch dos demais campos |
| 4 | Nota em todo clique, prefixada com `Clique nº N` | antes, clique repetido sem campo novo saía sem nota nenhuma |
| 5 | Log grava `preservados` e `CORRIGIDO`, não só `gravados` | sem isso não dá para explicar por que um campo ficou com valor antigo |
| 6 | **Correção de `⚑ Origem`** por conflito de família | ver abaixo |

**A regra do `⚑ Origem`** (única exceção ao first-touch, deliberadamente estreita):

- famílias: `Meta-*` = veio de anúncio pago · `Org-*` = veio de post/Reel orgânico;
- **orgânico → pago** sempre corrige: `source_type='ad'` é prova dura;
- **pago → orgânico** só corrige se **não** houver `⌂ Campanha` preenchida — campanha
  gravada significa anúncio pago rastreado antes, e um clique orgânico posterior não
  pode apagar esse first-touch;
- diferença **dentro** da mesma família (`Meta-Facebook` × `Meta-Instagram`) não é
  tocada: não muda decisão de verba.

Motivo de existir: um Reel orgânico caiu num lead que já tinha `⚑ Origem = Meta-Facebook`
posto por outro mecanismo (este CRM tem mais de um escrevendo nesse campo — ver o log com
`preservados`). Sem a regra, tráfego orgânico ficava creditado como verba paga para sempre.

**Backfill** (`ops/build-backfill.mjs` → `ops/backfill-graph.json`): workflow descartável
que repassa os leads atribuídos enquanto o `META_ADS_TOKEN` não existia — a Graph
respondia "Bad request" e campanha/conjunto/anúncio ficavam vazios. **228 leads**. Herda
as regras do fluxo principal: só grava campo vazio, um PATCH por lead, um lead por vez,
falha em um não derruba o lote. Rodar, conferir e **apagar o workflow**:

```bash
node ops/build-backfill.mjs
# criar via API, ativar, POST em /webhook/ctwa-backfill-tmp, e apagar depois
select status, count(*) from ctwa_logs where etapa = 'backfill' group by 1;
```

### 10.7 Armadilhas — uma delas já custou 9 minutos

- **`PUT` na API pública REATIVA o workflow.** Foi o que aconteceu em 2026-08-18: o PUT
  ativou o nativo, que registrou o callback no app de produção; o PUT seguinte trocou o
  `webhookId` e a Meta ficou entregando numa URL morta. **9 minutos de eventos perdidos**
  (a Meta reentrega parte). Sempre `POST /workflows/{id}/deactivate` logo depois do PUT,
  ou edite pela UI.
- **Nunca clique em "Listen for test event" neste nó.** Ele **apaga a inscrição de
  produção** e tenta registrar a URL de teste — que nesta instância **não existe**:
  `/webhook-test/...` dá **404 nos dois hosts** (editor e webhook), porque em modo fila o
  webhook de teste só vive no processo do editor e o proxy não o expõe. A Meta recusa com
  `(#2200) Callback verification failed ... HTTP Status Code = 404`, e o app fica **sem
  webhook nenhum** — rastreio cego até alguém reativar. Aconteceu em 2026-08-18.
  Conserto: `POST /workflows/4T4HALkkLJtcNAY1/deactivate` seguido de `/activate` (só
  ativar não basta — o n8n acha que já registrou). Para testar, use os `curl` do §10.3.
- **Desativar apaga a inscrição** no app — o rastreio fica sem callback nenhum até você
  ativar de novo. O `subscribed_apps` da WABA continua intacto.
- **Duplicar o nó `On messages` muda o `verify_token`** (é o id do nó).
- **`META_WABA_ID`**: o trigger não entrega `entry.id`, então o shim usa
  `$env.META_WABA_ID` com fallback fixo em `1558318502323307` (WABA da Imperatriz;
  `phone_number_id` `1192220830640227`). Outra unidade: defina a env var.
- **Assinatura inválida virou silêncio**: o nó nativo devolve 200 e não executa nada —
  sem `401`, sem `Log — assinatura invalida`. Testado: o POST forjado não gera execução.

---

## 11. Replicação por unidade (19/08/2026)

Um workflow por unidade, cada um na sua pasta dentro de **Rastreio de Campanhas**:

| Unidade | Workflow | Subdomínio | Estado |
|---|---|---|---|
| Imperatriz | `4T4HALkkLJtcNAY1` | `attivacorpoementeitz` | **ativo** |
| Açailândia | `kyUteT0dasgmOWfd` | `doutorherniaacailandia` | **ativo** (app `1459276342253680`) |
| Araguaína | `2bBAZljomcdn72n5` | `araguainadoutorhernia` | **ativo** (app `799026632856132`) |
| Balsas | `8CUvdGSlSOlBsCQv` | `doutorherniabalsas` | **ativo** (app `792664793859784`) |
| Canaã | `byDObl5viTi7f0Su` | `doutorherniacanaa` | **ativo** (app `3844247235870320`) |
| Marabá | `eoiopbEAkLVYEOrF` | `marabadoutorhernia` | **ativo** (app `849074488166578`) |
| Parauapebas | `FMguVfgaBzRj5oih` | `parauapebasdoutorhernia` | **ativo** (app `758388503991516`) |
| Porto Nacional | `BNurr5MrqLCe39Tv` | `doutorherniaporto` | parado |
| Serra | `HASTT3Gs5DrHgUyy` | `drherniaserra` | parado |

Fora: **Instituto Trauma** (6 de 18 campos, não é unidade Doutor Hérnia — criar 12 campos
num CRM que não usa o rastreio seria intromissão, não replicação) e **Boa Vista** (existe
no dashboard, mas não tem credencial Kommo no n8n).

### 11.1 O que muda de unidade para unidade

`$env` é **global no n8n** — dez workflows lendo `$env.KOMMO_CF_*` gravariam todos na
Imperatriz. Por isso o gerador transforma em literal o que é da unidade e deixa em `$env`
só o que é global:

| Literal por unidade | Continua em `$env` (global) |
|---|---|
| `kommoSubdomain`, os 18 ids de campo | `META_ADS_TOKEN`, `META_GRAPH_VERSION` |
| credencial Kommo nos 5 nós | `KOMMO_CREATE_IF_MISSING`, `KOMMO_TAG_*` |
| id do nó trigger (= `verify_token`) e `webhookId` (= URL do callback) | `CTWA_LOOKUP_*`, `ALERT_WEBHOOK_URL` |
| `unidade` carimbada em todo INSERT | |

`ctwa_eventos` e `ctwa_logs` ganharam a coluna **`unidade`** (linhas antigas viraram
`imperatriz`). Sem ela, dez unidades no mesmo banco viram uma sopa sem como separar.

### 11.2 Ferramentas (todas descartáveis, todas já removidas do n8n)

| Script | O que faz |
|---|---|
| `ops/unidades.mjs` | mapa unidade → subdomínio + credencial, e a lista dos 18 campos |
| `ops/build-inventario.mjs` | lê os campos de cada conta com a credencial dela e diz o que falta |
| `ops/build-provisionar.mjs` | cria os campos/tags que faltam, já no grupo MARKETING da conta |
| `ops/build-unidades.mjs` | gera `ops/unidades/<slug>.json` a partir do workflow da Imperatriz |
| `ops/build-backfill.mjs` | backfill de campanha/conjunto/anúncio (§10.6) |

O padrão dos três primeiros: workflow temporário que usa a credencial Kommo **já
cadastrada** — ninguém precisa ver token de dez contas. Enquanto ativo é um endpoint
aberto, então **apagar logo depois** (todos foram).

Provisionado em 19/08: `⌂ Último anúncio` + `⌂ Cliques no anúncio` nas 8 unidades (grupo
MARKETING de cada conta) e as tags `Origem: Anuncio pago` / `Origem: Organico`. As 4
opções do `⚑ Origem` (`Meta-*`, `Org-*`) já existiam em todas.

### 11.3 O que falta para cada unidade sair do papel

O trabalho de CRM está pronto. O que trava é a Meta, e é **por unidade**:

1. **App próprio da Meta.** Um webhook por app (§10.3) — não dá para as unidades
   dividirem o app da Imperatriz: a segunda a ativar derruba a inscrição da primeira.
2. **Credencial `WhatsApp Trigger · <Unidade>`** no n8n (App ID + App Secret) ligada no nó
   `On messages` — o gerador deixa o campo vazio de propósito.
3. **Ativar o workflow** — o n8n registra o callback
   `/webhook/meta-ctwa-<slug>/webhook` sozinho.
4. **`POST /{WABA_ID}/subscribed_apps`** com token `whatsapp_business_management` daquela
   unidade, e conferir que a Kommo continua na lista (§10.5).
5. Descobrir o `WABA_ID` e preencher em `ops/build-unidades.mjs` (`WABA`) — hoje só a
   Imperatriz tem; nas outras o shim grava `waba_id = null`, que é melhor que gravar o id
   de outra unidade.

Cada workflow parado tem essa lista na nota de topo do próprio canvas.

### 11.4 Os apps das unidades já vinham em uso — conferir SEMPRE antes de ativar

Ao ligar Balsas e Araguaína (19/08), os dois apps da Meta **já tinham webhook registrado**,
apontando para outra instância de n8n: `n8n-n8n.mgvdq4.easypanel.host`. Alguém montou
rastreio nessas unidades por lá antes.

Diferença que decidiu o que fazer em cada uma — o teste leva 10 segundos:

```bash
# 1. o app já tem inscrição? para onde ela aponta?
curl -s "https://graph.facebook.com/v23.0/<APP_ID>/subscriptions?access_token=<APP_ID>|<SECRET>"
# 2. esse callback ainda está vivo?
curl -s -o /dev/null -w "%{http_code}\n" "<CALLBACK_URL>?hub.mode=subscribe&hub.verify_token=probe&hub.challenge=probe"
```

- **Araguaína**: `404` — endpoint morto, a Meta entregava no vazio. Assumido sem perda.
- **Balsas**: `200` — estava **vivo e recebendo**. Assumido com autorização explícita do
  João; o fluxo da easypanel parou de receber os eventos de Balsas nesse instante.

Ativar sem checar isso derruba integração de terceiro em silêncio. Como um app só aceita
um webhook, a alternativa sem quebra é criar um app novo para o rastreio e assinar a WABA
com ele (vários apps podem assinar a mesma WABA) — aí o passo 4 do §11.3 volta a ser
obrigatório.

**Ainda não confirmado nessas duas:** se a WABA da unidade assina o app (camada separada,
§10.5). Balsas quase certamente sim — o app estava entregando. Araguaína é dúvida: o
endpoint estava morto, então não dá para saber se a Meta ainda mandava. Sem evento real em
algumas horas de expediente, rodar o `POST /{WABA_ID}/subscribed_apps` da unidade.

### 11.5 Callbacks e rollback da tomada dos apps

URLs registradas automaticamente pelo n8n na ativação — **não precisa colar no painel da
Meta**. O `verify_token` é o id do nó, não um valor escolhido.

| Unidade | Callback | `verify_token` |
|---|---|---|
| Imperatriz | `/webhook/meta-ctwa-tracking-nativo/webhook` | `whatsapp-trigger-nativo` |
| Araguaína | `/webhook/meta-ctwa-araguaina/webhook` | `whatsapp-trigger-araguaina` |
| Balsas | `/webhook/meta-ctwa-balsas/webhook` | `whatsapp-trigger-balsas` |
| Canaã | `/webhook/meta-ctwa-canaa/webhook` | `whatsapp-trigger-canaa` |
| Marabá | `/webhook/meta-ctwa-maraba/webhook` | `whatsapp-trigger-maraba` |
| Parauapebas | `/webhook/meta-ctwa-parauapebas/webhook` | `whatsapp-trigger-parauapebas` |
| Açailândia | `/webhook/meta-ctwa-acailandia/webhook` | `whatsapp-trigger-acailandia` |

**Rollback** — os callbacks que estavam registrados antes (instância `easypanel`, todos
vivos no momento da troca, exceto Araguaína que dava 404). Para devolver uma unidade,
desativar o workflow aqui e recriar a inscrição lá:

| Unidade | App | Callback anterior |
|---|---|---|
| Balsas | `792664793859784` | `https://n8n-n8n.mgvdq4.easypanel.host/webhook/381d0093-4a37-4359-89e4-9e00c66bfe44/webhook` |
| Canaã | `3844247235870320` | `https://n8n-n8n.mgvdq4.easypanel.host/webhook/b2f929f3-ed87-4b64-801b-f03bdc1f9338/webhook` |
| Parauapebas | `758388503991516` | `https://n8n-n8n.mgvdq4.easypanel.host/webhook/40e7d5e5-cf23-41cd-a6af-712b51deee4e/webhook` |
| Marabá | `849074488166578` | `https://n8n-n8n.mgvdq4.easypanel.host/webhook/64c4d9f0-3ce5-43a4-8ee0-bdf916b363f2/webhook` |
| Açailândia | `1459276342253680` | `https://n8n-n8n.mgvdq4.easypanel.host/webhook/a034e5b9-876e-4dbc-8ce3-9b39141584f4/webhook` |
| Araguaína | `799026632856132` | `https://n8n-n8n.mgvdq4.easypanel.host/webhook/webhook-meta` (já estava 404) |

O `verify_token` da inscrição antiga não é recuperável por API — se precisar reverter,
pegar o id do nó no n8n da easypanel.

Faltam **Porto Nacional** e **Serra** (workflows criados e parados, esperando o app).
