# Análise das rotas · Relatório da rede (18h)

Cada chamada que o relatório faz, de ponta a ponta. Linhas de código conferidas em 30/09/2026.

## Visão geral

```
n8n (18h)
  └─ A  GET  backend /api/relatorios/rede-diaria            ← a única chamada do n8n ao agente
        └─ para cada unidade (2 por vez, 400 ms de pausa):
             ├─ B  POST franquia /api/schedules/search       agenda de hoje e amanhã
             ├─ C  POST franquia /api/treatments/search      tratamentos do último mês
             ├─ D  GET  Kommo    /api/v4/leads/custom_fields  ids dos campos pelo nome (cache 30 min)
             ├─ D  GET  Kommo    /api/v4/leads  created_at    leads criados nos 7 dias
             └─ D  GET  Kommo    /api/v4/leads  updated_at    cartões mexidos nos 7 dias (consultas)
  └─ E  POST Evolution /message/sendText/alertas2           envio do WhatsApp
```

Todas de **leitura**, menos a E, que é o envio. **Nenhuma grava campo, move cartão ou cria paciente.**

---

## A · n8n → backend

| | |
|---|---|
| **Rota** | `GET /api/relatorios/rede-diaria` |
| **Código** | rota em `api.routes.ts:318` · handler em `relatorio-rede.controller.ts:97` |
| **Autenticação** | cabeçalho `x-internal-key` = `INTERNAL_API_KEY`. Sem chave, cai no login normal e exige **super admin** |
| **Posição na cadeia** | **acima** do `apiRouter.use(requireAuth)` (linha 321). Se ficasse abaixo, o 401 global responderia antes de alguém ler a chave. Há um teste que trava essa ordem |
| **Parâmetros** | `data=AAAA-MM-DD` (padrão: hoje) · `unidades=slug1,slug2` (padrão: todas) · `formato=texto` (devolve texto puro) |
| **Efeito colateral** | nenhum. É seguro chamar à vontade |
| **Timeout no n8n** | 900 s (15 min) |
| **Resposta** | `{ data, texto, totais, unidades[], semFranquia[], saude: { unidades, falhas, completo } }` |
| **Erros** | `400 data_invalida` · `404 nenhuma_unidade` (slug errado) · `500 relatorio_falhou` |

O n8n usa `saude.completo` para decidir se avisa o João de que saiu incompleto.

### Como o backend escolhe as unidades (`relatorio-rede.controller.ts:75`)

1. `isActive = true`
2. fora `default` e `laboratorio-kommo`
3. `spineEnabled = true` **e** `spineToken` preenchido
4. fora sufixos `-resgate`, `-tratamento`, `-financeiro` (dividem conta com a unidade principal)
5. uma linha por **token da franquia** (dois slugs com o mesmo token são a mesma clínica)

Ativas que não passaram no 3 vão para `semFranquia`, que aparece no bloco ATENÇÃO.

---

## B · backend → franquia: agenda

| | |
|---|---|
| **Rota** | `POST {spineBaseUrl}/api/schedules/search` |
| **Código** | `spine.service.ts:190` (`searchSchedules`) |
| **Corpo** | `initialDate` = hoje · `endDate` = amanhã **+1 dia** (o fim é exclusivo) · `pagination: { page, rowsPerPage: 100 }` |
| **Janela** | 2 dias — bem abaixo do limite de 30 dias da rota |
| **Chamadas por unidade** | `ceil(agendamentos em 2 dias ÷ 100)`. Uma clínica com 150 sessões/dia faz 3. Teto: 40 páginas |
| **Timeout** | 30 s por chamada |
| **Fuso** | `spineTimezone` da unidade (padrão `America/Sao_Paulo`). "Hoje" é o da clínica, não o UTC: consulta das 21h não vira "amanhã" |
| **Falha** | unidade entra com *"agenda da franquia não respondeu (motivo)"* e continua com os leads |

**Restrição que muda o teste:** a franquia **recusa IP que não seja o da VPS** (403). Só dá para provar esta chamada pelo backend em produção.

## C · backend → franquia: tratamentos

| | |
|---|---|
| **Rota** | `POST {spineBaseUrl}/api/treatments/search` |
| **Código** | `spine.service.ts:845` (`searchTreatments`) |
| **Corpo** | `initialCreatedDate` = 1 mês atrás · `endCreatedDate` = hoje · 100 por página |
| **Por que 1 mês** | o padrão do serviço é 12 meses (caro). Para "fechado hoje" só precisa do mês. **Sem data a rota devolve só o mês corrente** — por isso a janela é sempre enviada |
| **Chamadas por unidade** | 1 a poucas |
| **Filtro** | criado **hoje** (no fuso da clínica) e status sem "cancel" |
| **Falha** | *"tratamentos da franquia não responderam"*; o resto da unidade continua |

## D · backend → Kommo: leads e análise de 7 dias

| | |
|---|---|
| **Rotas** | `GET /api/v4/leads/custom_fields` (+ pipelines) · `GET /api/v4/leads?filter[created_at]…` · `GET /api/v4/leads?filter[updated_at]…` |
| **Código** | `kommo.service.ts` (`listLeadsNaJanela`, novo) · `kommo-schema.ts` (`esquemaDaUnidade`, já existia, cache 30 min) · cálculo em `relatorio-rede-analise.ts` |
| **Campos** | achados pelo **nome**, sem os símbolos (o id muda de conta para conta). Conta sem o campo → aviso "a conta não tem …" |
| **Criados** | janela = hoje e os 6 dias anteriores, fuso da clínica. Até 8 páginas de 250 |
| **Mexidos** | do início da janela até **agora** (o Kommo filtra pela última alteração). Até 12 páginas de 250 |
| **Por que "mexidos"** | o Kommo **não filtra por campo personalizado**: `filter[custom_fields_values]` devolveu 400 no teste da Serra |
| **Medido na Serra (30/09)** | criados 7 dias: 132 leads, 1 página, 1,7 s · mexidos 7 dias: 331 cartões, 2 páginas, 3,9 s |
| **Teto** | bateu no teto → aviso "lista cortada, os números são um piso" |
| **Em sequência** | as chamadas de uma unidade não vão em paralelo: rajada no Kommo já bloqueou o IP da VPS |
| **Falha** | *"Kommo não respondeu"*: a unidade sai sem leads e sem análise; o placar da franquia continua |

## E · n8n → Evolution: envio

| | |
|---|---|
| **Rota** | `POST http://evolution_api:8080/message/sendText/alertas2` (rede interna do Swarm) |
| **Corpo** | `{ number, text, linkPreview: false }` |
| **Autenticação** | cabeçalho `apikey` |
| **Cadência** | 1 mensagem por vez, 1,5 s entre elas |
| **Destino** | modo `teste`: o João. Modo `producao`: `destinoChefe` |
| **Observação** | número de grupo precisa ser JID `…@g.us` e o `alertas2` precisa participar dele |

---

## Custo total estimado

Por unidade: **B** 1–3 + **C** 1–2 + **D** 3–10 = cerca de **5 a 15 chamadas**.
Para 14 unidades: **aproximadamente 70 a 200 chamadas**, 2 unidades por vez.

Tempo: não medi. Com a franquia respondendo em 1–2 s por chamada, é de ordem de 1 a 2 minutos. O pior caso é limitado: 120 s por unidade × 14 ÷ 2 ≈ 14 min, dentro do timeout de 15 min do n8n. **O número real sai do passo 5 do roteiro de teste.**

---

## O que pode dar errado, e o que o relatório faz

| Situação | Resultado |
|---|---|
| Franquia de uma unidade fora | Unidade aparece como *franquia indisponível* com os leads; bloco ATENÇÃO explica; **João é avisado**, a chefe recebe o relatório |
| Kommo de uma unidade fora | Unidade sai sem a contagem de leads; mesmo tratamento |
| Uma unidade demora mais de 120 s | Entra no ATENÇÃO como *demorou mais de 120 s*; as outras não esperam |
| Backend fora / chave errada / 500 | **A chefe não recebe nada.** O João recebe *"Relatório das 18h FALHOU"* |
| Destino da chefe não preenchido em produção | O workflow **para com erro** antes de enviar |
| Categoria de agendamento desconhecida | Fica fora da conta e é sinalizada no ATENÇÃO |
| Nenhuma unidade elegível | `404 nenhuma_unidade` e o João é avisado |

O desenho evita a armadilha de sempre em relatório: **falha virando zero**. Quando uma fonte não responde, o texto diz que não respondeu.
