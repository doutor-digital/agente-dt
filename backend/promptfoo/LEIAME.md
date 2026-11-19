# Promptfoo da Sofia

Roda o **banco de conversas douradas** (`src/eval/banco.ts`) contra a Sofia de verdade e dá nota em duas camadas:

1. **conferências** — as regras fixas de `src/eval/checks.ts` (as mesmas do `npm run eval`);
2. **juíza** — uma IA que lê o *porquê* de cada caso (o erro que já aconteceu com paciente) e reprova a resposta que repete o erro, mesmo quando nenhuma regra fixa pega.

Nada é executado no Kommo nem na franquia: a Sofia só *escolhe* ferramentas, e a escolha é conferida. Nada é gravado no custo de clínica do painel (`llm_calls`).

**Custo:** cada caso chama o modelo **com a chave da unidade do caso** (Porto, Imperatriz, Boa Vista…) — o gasto aparece na conta Anthropic/OpenAI dela. A juíza usa a chave da unidade `default` (troque com `PF_JUIZA_UNIDADE=<slug>`). Uma rodada de 16 casos ≈ 32 chamadas.

## Rodar

Precisa de **Node 22+** (`nvm use 24`) e do banco de produção pelo túnel. O eval só **lê** — com uma exceção: se a unidade de um caso não tiver AgentConfig ativo, `getActiveConfig` cria um (hoje as unidades do banco já têm). Para travar escrita, use um usuário só-leitura no `DATABASE_URL`.

```bash
ssh -N -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes -L 5433:<ip-do-contêiner-do-banco>:5432 root@<vps> &   # o túnel de sempre (agente devops)
cd backend
export DATABASE_URL='postgresql://agente:<senha>@127.0.0.1:5433/agente_dt'

npm run eval:pf                                   # todos os casos
PF_CASO=preco-e-o-do-catalogo npm run eval:pf     # um caso
PF_UNIDADE=doutor-hernia-porto npm run eval:pf    # uma unidade
npm run eval:pf -- --repeat 3                     # 3 voltas: pega caso instável
PF_PROMPT_DA_UNIDADE=1 npm run eval:pf            # com o playbook escrito na unidade
npm run eval:pf:ver                               # painel com o histórico das rodadas
```

Sai com código **100** se algum caso reprovar (serve para travar deploy).

## Em produção (todo dia)

O fluxo `.github/workflows/promptfoo-sofia.yml` roda o banco inteiro **todo dia às 05:37** contra a Sofia que está no ar (mesma imagem do serviço, num contêiner à parte, no runner da própria VPS) e manda o resultado no **Telegram do João**. O relatório HTML fica como artefato da execução no GitHub (30 dias). Para rodar na hora: GitHub → Actions → `promptfoo-sofia` → *Run workflow* (dá para escolher caso, unidade e número de voltas).

## Caso novo

Não existe segundo banco: caso novo entra em `src/eval/banco.ts`, com o erro real no `porque`. O Promptfoo pega sozinho.

## Privacidade

O `npm run eval:pf` desliga telemetria, compartilhamento (`promptfoo share`), geração remota e checagem de atualização. O histórico fica só nesta máquina (`~/.promptfoo`).
