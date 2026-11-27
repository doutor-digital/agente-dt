# Vigia externo: o alerta que chega mesmo com a VPS fora

## Por que

Na noite de 26 para 27/11 a Sofia ficou 15 h sem responder por falta de crédito. Todo o erro estava em `llm_calls` e o alerta não chegou a ninguém. Os avisos que existiam viviam **dentro** do servidor (relay de e-mail, Evolution; o WhatsApp dos alertas foi banido em 06/10), então morrem junto com ele ou dependem de uma cadeia que ninguém vigia. Este vigia roda no GitHub, consulta o agente de fora e avisa por canais que não passam pela VPS.

## Como funciona

```
GitHub Actions (cron, a cada ~10 min)
  └─ .github/scripts/vigia-externo.mjs
       1. GET https://<agente>/api/health/ia   (cabeçalho X-Health-Token)
       2. decide com backend/src/lib/watchdog-decisao.ts (as mesmas regras testadas na suíte)
       3. avisa: WhatsApp (Kapso, modelo aprovado) + Telegram (reserva)
       4. guarda o estado no cache do Actions (último aviso por tipo, início do incidente)
```

**O endpoint `GET /api/health/ia`** (`backend/src/controllers/saude-externa.controller.ts`, `lib/saude-externa.ts`):

- Responde `ok`, `degradado` ou `fora`, a causa (`credito`, `autenticacao`, `limite`, `indisponivel`, `outra`) e contagens da janela de 10 min por provedor, mais há quantos minutos foi o último sucesso.
- **Barato**: UMA consulta em `llm_calls` pelo índice de `created_at`, sobre a última hora (o teste com 30 mil linhas confere que o plano usa índice), mais cache de 15 s em memória.
- **`cancelled` fica fora da conta**: chamada em que quem chamou desistiu (prazo estourado) não é do provedor e diluiria a taxa justo quando o provedor trava.
- **Sem dado sensível**: só números e o nome do provedor. Nada de unidade, telefone, lead ou texto de erro.
- **Fechado por padrão**: sem `HEALTH_IA_TOKEN` no servidor responde 404; com ele exige o mesmo valor em `X-Health-Token` (401 se errar, comparação em tempo constante). O repositório é público; o endpoint não precisa ser.
- Banco fora vira `503 {error: "db_unavailable"}` (nunca 200 e SEM `estado`): o vigia trata como servidor inacessível e só avisa na 2ª rodada seguida; um soluço do banco não vira «Sofia fora do ar».
- Sem `HEALTH_URL` cadastrado o script sai **verde** com um aviso (`::warning::`) no log, para não mandar ~144 e-mails de falha por dia até os segredos serem cadastrados.

**Regras** (`watchdog-decisao.ts`):

| Estado | Quando |
|---|---|
| `fora` | 90% ou mais das chamadas falhando na REDE inteira, com pelo menos 5 chamadas (de madrugada a rede toda faz ~20 por 10 min), e o erro aparece em 2 unidades ou mais, nenhuma com mais de 70% dos erros, sem exceção (cada unidade pode ter a própria chave: `Unit.anthropicApiKey`; a de uma acabando não é a rede toda fora) |
| `degradado` | 25% da rede falhando com pelo menos 10 chamadas, ou metade de um provedor (inclusive um provedor a 100%: a chave de reserva ou o outro provedor pode estar atendendo; o aviso diz o provedor e a causa) com pelo menos 5 chamadas; os dois com erro em 2 unidades ou mais |
| `ok` | o resto. Silêncio (nenhuma chamada) NÃO é queda |
| `inacessivel` (visto pelo vigia) | o servidor não respondeu, ou respondeu 5xx sem dado de saúde: VPS, Traefik ou processo fora. Só avisa na **2ª rodada seguida**, inclusive com outro incidente já aberto (um deploy ou reinício de ~1 min não pode acordar ninguém) |
| `cego` (visto pelo vigia) | 401/403 ou 404 COM o JSON do app (`not_found`); um 404 em texto puro do Traefik é a rota que sumiu junto com o contêiner e vira `inacessivel`: segredo errado ou rota desligada. Vigia cego não pode parecer vigia tranquilo. Também só na 2ª rodada seguida |

**Throttle e «voltou ao normal»**:

- No máximo **1 aviso por tipo de incidente a cada 30 min** (só o **tipo**: a causa dominante pode mudar de rodada para rodada e vai no texto, não na chave). Incidente aberto há mais de 2 h lembra só de 2 em 2 h. Trocar de tipo (degradado para fora) avisa na hora.
- «VOLTOU AO NORMAL» sai uma vez, depois de 2 rodadas ok seguidas (um respiro no meio da queda não encerra o incidente), e cita a leitura que abriu o incidente. Encerrado o incidente o throttle zera: uma queda nova, mesmo 10 min depois, avisa como queda (ALERTA), não como LEMBRETE; LEMBRETE é só a repetição de um incidente que segue aberto.
- Incidente que nenhum canal anunciou termina em silêncio (nada de «VOLTOU AO NORMAL» sobre uma queda que o João nunca soube). O intervalo de 30 min tem folga de 2 min por causa do atraso do cron do GitHub.
- Se **nenhum** canal entrega, a rodada fica **vermelha** (exit 1, e o GitHub avisa por e-mail quem editou o cron) e o throttle **não** é gasto: a rodada seguinte tenta de novo.
- Teste do alarme: o workflow tem `workflow_dispatch` com a opção «teste» e um cron mensal (dia 1, 09h de Brasília) que manda um aviso de TESTE. Se o aviso mensal não chegar, o canal morreu e a rodada fica vermelha.

## Segredos que o João cadastra

No GitHub: Settings > Secrets and variables > Actions > New repository secret.

| Segredo | Valor | Obrigatório |
|---|---|---|
| `HEALTH_URL` | `https://<domínio do agente em produção>/api/health/ia` (o host que o roteador do Traefik serve, ver `AGENT_DOMAIN` no `docker-compose.yml`; não está escrito aqui porque o repositório é público) | sim |
| `HEALTH_IA_TOKEN` | um texto aleatório longo, por exemplo `openssl rand -hex 32`. **O mesmo valor** precisa estar em `HEALTH_IA_TOKEN` no `.env` do servidor (o `env_file` do `docker-compose.yml`) | sim |
| `TELEGRAM_BOT_TOKEN` | token do bot DD-Avisos (o mesmo `TELEGRAM_BOT_TOKEN` do servidor) | recomendado (é o canal que já funciona hoje) |
| `TELEGRAM_CHAT_ID` | o chat do João no Telegram (o mesmo `TELEGRAM_CHAT_JOAO` do servidor; ver `backend/src/lib/telegram.ts`) | junto com o token |
| `KAPSO_API_KEY` | a chave do Kapso (a que o servidor usa como `KAPSO_API_KEY`) | para o WhatsApp |
| `KAPSO_PHONE_NUMBER_ID` | o `phone_number_id` do número do Kapso que ENVIA o alerta | para o WhatsApp |
| `ALERTA_WHATSAPP_NUMERO` | o WhatsApp do João com DDI e DDD, só números (ex. `5511999999999`) | para o WhatsApp |
| `KAPSO_TEMPLATE` | nome do modelo aprovado (padrão `alerta_sistema`) | opcional |

Basta **um** canal configurado para o aviso sair; os dois juntos dão redundância.

### O modelo do WhatsApp

Mensagem livre só entra na janela de 24 h depois de o João ter escrito para o número. Para alerta às 3h da manhã é preciso um **modelo aprovado**: categoria Utilidade, idioma `pt_BR`, nome `alerta_sistema`, corpo:

```
{{1}}
```

(uma única variável com o texto inteiro; o script manda em uma linha só, sem quebra de linha, como a Meta exige). Se a Meta recusar um corpo que seja só a variável, use `Alerta do sistema Doutor Digital: {{1}}` e ajuste o prefixo. Enquanto o modelo não é aprovado o script tenta texto livre (funciona só dentro da janela de 24 h), e o Telegram cobre.

**O que NÃO está provado**: o envio real pelo Kapso. O formato (`POST /meta/whatsapp/v24.0/<phone_number_id>/messages`, `X-API-Key`, corpo de modelo da Meta) segue o que o repositório já usa para o Kapso e foi testado contra um servidor falso, mas não foi chamado de verdade (não toquei em produção). A primeira prova é rodar o workflow à mão com «teste» marcado.

## Alternativas avaliadas

| Opção | Custo | Confiabilidade | Veredito |
|---|---|---|---|
| **GitHub Actions + script próprio** (escolhida) | R$ 0: o repositório é público, e minutos de Actions em repositório público são gratuitos | Roda fora da VPS e do provedor dela. Limites: o cron do GitHub não é pontual (atrasos de alguns minutos, às vezes mais de 10, em horário de pico) e o piso é 5 min; a rodada pode ser pulada; agendamento é desligado após 60 dias sem atividade no repositório (aqui há commits toda semana) | Escolhida: dá para ter regra própria (causa pelo erro do provedor, throttle, «voltou»), WhatsApp pelo Kapso e Telegram, sem mais um serviço |
| Healthchecks.io (dead-man's switch: a VPS faz ping e o serviço avisa se o ping some) | plano gratuito com 20 verificações; avisos por e-mail, Telegram, webhook. WhatsApp/SMS em plano pago (não verificado) | Muito bom para «o servidor sumiu», mas só enxerga o que o servidor se dispõe a anunciar: com a Sofia 100% em erro e o processo vivo, o ping continua saindo e nada avisa, a não ser que o ping só saia quando a saúde está ok (aí vira o mesmo endpoint de saúde). Não identifica a causa | Boa **segunda camada** para «VPS inteira fora», grátis, com um ping do próprio agente a cada 5 min (sugestão, fora deste PR) |
| UptimeRobot | plano gratuito: 50 monitores a cada 5 min, e a licença do gratuito é só para uso não comercial (conferir os termos atuais); avisos por e-mail/Telegram/webhook, WhatsApp não | Bom para «a URL deixou de responder» e para procurar uma palavra no corpo (`"estado":"ok"`). Não tem lógica de causa nem de throttle por tipo | Alternativa simples para a segunda camada. Para uso comercial exigiria plano pago |

Recomendação: **GitHub Actions como vigia principal** (este PR) e, se o João quiser dois fornecedores independentes, um monitor gratuito de URL (UptimeRobot ou Healthchecks) só para «a VPS caiu inteira», que não precisa de código. O que o vigia próprio faz e os outros não: lê o erro do provedor e diz **por que** a Sofia caiu (crédito, chave, limite).

## Verificação de saldo dos provedores

**Não existe endpoint público de saldo.** Para a OpenAI e a Anthropic:

- OpenAI: as chaves de API (`sk-...`) não leem o saldo pré-pago. O que a API oferece com chave de administrador (`/v1/organization/costs` e `/usage`, que o repositório já usa em `openai-platform.service.ts`) é o **gasto**, não o que sobra. O endpoint antigo de saldo do painel (`/dashboard/billing/...`) exige sessão de navegador e não é suportado.
- Anthropic: a Admin API (`/v1/organizations/usage_report/...` e `cost_report`) também devolve uso e custo, não o saldo de créditos. O saldo só existe no console (e o aviso por e-mail de recarga automática).
- Não consegui chamar nenhum dos dois para confirmar ao vivo (sem chave de administrador nesta sessão e sem tocar em produção). Isso reflete a documentação que conheço, não um teste. Conferir no console de cada provedor se o quadro mudou.

O que cobre a lacuna: o saldo esgotado aparece **dentro de 10 min** como `fora` (rede inteira) ou `degradado` (um provedor), com causa crédito, que é a causa que o vigia lê da mensagem do provedor (`credit balance is too low`, `no credits remaining`). Aviso **antes** de zerar só com recarga automática ligada nos dois consoles, ou com uma estimativa própria (saldo comprado informado à mão menos o custo do `cost_report`), que seria outro PR.

## Relação com o PR do fuso (`fix/fuso-janelas-taxa-erro`)

Os dois PRs saem do `main` e não dependem um do outro. `backend/src/lib/causa-erro-ia.ts` (a leitura da causa do erro, em JS e em SQL) é **idêntico nos dois**: se os dois forem mesclados o git junta sem conflito. A consulta de saúde usa `(now() at time zone 'utc')` escrito por extenso, sem importar o `sql-tempo.ts` do outro PR, pelo mesmo motivo.

## Limites conhecidos

- Chamada `cancelled` (prazo estourado pelo chamador) não conta, como no monitor interno: um provedor que TRAVA e cujas chamadas morrem no prazo fica invisível. Cobrir isso pede um alarme de proporção de `cancelled`, outro PR.
- Um incidente em que só UMA unidade tem tráfego (madrugada) fica abaixo da regra de 2 unidades até uma segunda falar. É o preço de a chave poder ser por unidade; decisão do sênior.
- Erros de chamada sem `unit_id` não entram na contagem de unidades.
- `ops-alert.ts` (aviso de dentro da VPS) grava o horário do envio antes de saber se o relay aceitou; é anterior a este PR e não foi tocado.
