# Como desfazer, quando der ruim

Escrito pra ser lido com pressa. Cada item: **o sintoma**, **como confirmar** e **como voltar**.

Regra geral: quase tudo aqui volta por **variável de ambiente**, sem deploy. Deploy leva ~4 min;
variável leva ~40 s. Sempre tente a variável primeiro.

```bash
# onde tudo mora
ssh root@89.116.214.130
cd /opt/doutordigital/agente-dt     # o .env fica aqui
AG=$(docker ps -q -f name=ddagent_agent -f status=running | head -1)
```

---

## 1. A IA parou de responder / responde errado

**Confirmar primeiro** — em 30 segundos você sabe se é a IA ou o Kommo:

```bash
docker service ps ddagent_agent --format '{{.CurrentState}} {{.Image}}' | head -2
docker logs $AG --since 10m 2>&1 | grep -iE "error|falhou" | tail -20
```

Se o container está `Running (healthy)` e não há erro, o problema é entrega (Kommo/Salesbot),
não a IA.

**Voltar a versão anterior** (o jeito mais rápido e mais seguro):

```bash
docker service update --image ghcr.io/doutor-digital/agente-dt-backend:<sha-anterior> ddagent_agent
```

Os SHAs estão em `git log origin/main --oneline`. Sobe o novo, testa o /api/health, e só então
derruba o velho — não tem janela sem atendimento.

---

## 2. Dieta do prompt (v1.150.0 e v1.152.0 — 25/09/2026)

**O que mudou:** o prompt encolheu de 45.406 para 37.820 tokens na Serra. Saíram: repetições
(ESCASSEZ e PROVA estavam escritas duas vezes), a lista de campos que a ferramenta já lista, o
parâmetro `leadId` que o código sobrescrevia, e o metadado de schema que a Anthropic ignora.
Calendário, endereço e aprendizados foram do bloco "vivo" pro bloco de cache de 1 hora.

**Sintoma de que deu ruim:** ela para de chamar ferramenta (não grava queixa, não move etapa,
não abre a agenda), ou passa a falar coisa fora das Fontes Oficiais.

**Como medir, não achar:**

```sql
-- % de conversas que chamaram alguma ferramenta, dia a dia.
-- Se despencar depois de um deploy, foi o deploy.
select e.created_at::date d, count(*) traces,
  round(100.0*count(*) filter (where exists (
    select 1 from execution_steps s where s.trace_id=e.id and s.kind='TOOL_CALL'))/count(*),1) pct
from execution_traces e
where e.channel='kommo_chat' and e.created_at > now() - interval '10 days'
group by 1 order by 1;
```

Referência medida em 24–25/09: **12% a 14%**. Abaixo de 8% por um dia inteiro é sinal ruim.

**Voltar:** não tem variável — é voltar a imagem (item 1). A v1.149.0 é a última sem dieta.

---

## 3. Resposta segurada quando o paciente emenda mensagem

**O que mudou:** se o paciente manda outra mensagem enquanto a IA escreve, a resposta pronta
**não é enviada** — o próximo turno responde as duas juntas. E a janela de espera subiu de 8 s
pra 15 s.

**Sintoma:** paciente reclamando que a IA demora, ou conversa onde ela parece ter pulado uma
pergunta.

**Voltar a janela** (sem deploy, ~40 s):

```bash
docker service update --env-add AGENT_COALESCE_MS=8000 ddagent_agent
# e no .env, pra sobreviver ao próximo deploy:
sed -i 's/^AGENT_COALESCE_MS=.*/AGENT_COALESCE_MS=8000/' /opt/doutordigital/agente-dt/.env
```

**Ver quantas respostas foram seguradas hoje:**

```bash
docker logs $AG --since 24h 2>&1 | grep -c "Resposta segurada"
```

---

## 4. Rotas do cérebro (v1.151.0)

`GET /api/units/:id/cerebro/panorama` e `/cerebro/paciente`. **Só leitura** — não escrevem no
Kommo nem na franquia. Se derem erro, o atendimento não é afetado: ninguém do fluxo do paciente
chama essas rotas.

---

## 5. O que NÃO está no ar (não procure bug aqui)

- **`aderencia-worker`** — a escada de 2/3/5 faltas. Escrita e testada, nunca commitada.
- **Conserto de preço** de Serra/Boa Vista/Olímpia/Bebedouro — foi revertido de propósito: a
  gestão definiu esses valores.
- **`dd-mcp`** — roda só na máquina do João, não toca em produção.

---

## Números de referência (medidos em 25/09/2026)

Guardados pra você comparar quando desconfiar de alguma coisa.

| o quê | normal |
|---|---|
| erros nas chamadas à IA | **0%** |
| conversas que chamam ferramenta | 12% a 14% |
| respostas bloqueadas pelo guardrail | 0 |
| entrada média por chamada | ~31.000 tokens |
| custo por chamada | US$ 0,017 a 0,019 |
| conversas por dia na rede | ~2.100 |

**Armadilha ao consultar o banco:** `created_at` é gravado em **UTC**, mas o `now()` do Postgres
roda em São Paulo — 3 horas de diferença. Em janela curta ("última hora"), use carimbo explícito:
`created_at >= timestamp '2026-09-25 12:05'`. Em janela de 30 dias não faz diferença.
