# dd-mcp — o cérebro dentro do Claude Code

Servidor MCP que roda **na sua máquina**, por stdio, e conversa com o backend de
produção por HTTPS. Ele não guarda token de franquia nem de Kommo — quem tem essas
chaves é o servidor. Aqui só passa o login do console, trocado por um cookie de sessão
que vive em memória e morre junto com o processo.

**Só leitura.** Nenhuma ferramenta escreve campo, e mover etapa não entra nunca — é o que
dispara gatilho, template e cobrança.

## Compilar

O `dist/` é ignorado pelo git, então ele não vem pronto no clone:

```bash
cd backend
npx tsc -p tsconfig.json
```

Sai em `backend/dist/mcp/dd-mcp.js`. Compile **sempre pro `dist/` do próprio `backend/`**:
o Node procura `node_modules` subindo a partir do arquivo, e um `--outDir` pra fora do
repositório (`/tmp`, por exemplo) morre com `ERR_MODULE_NOT_FOUND` antes de abrir a boca.
Depois de mexer no `dd-mcp.ts`, recompile — o Claude Code roda o `.js`, não o `.ts`.

## Registrar no Claude Code

```bash
claude mcp add dd-cerebro \
  --env DD_API_URL=https://agente-vps.doutordigitalconsultoria.com \
  --env DD_EMAIL=<seu e-mail do console> \
  --env DD_SENHA=<sua senha do console> \
  -- node /caminho/absoluto/do/repo/backend/dist/mcp/dd-mcp.js
```

O caminho do `node` precisa ser absoluto: o Claude Code sobe o processo de um diretório
que não é necessariamente o do repositório.

### As três variáveis

| Variável | Para que serve |
| --- | --- |
| `DD_API_URL` | Endereço do backend. Se faltar, assume a produção. Aponte pra `http://localhost:3000` quando quiser testar contra o backend local. |
| `DD_EMAIL` | E-mail do seu usuário do console. É esse login que decide **quais unidades você enxerga**: `UNIT_ADMIN` só vê a própria. |
| `DD_SENHA` | Senha do mesmo usuário. |

Senha vai no comando, nunca em arquivo versionado. Se você preferir, registre o servidor
com `claude mcp add` uma vez e deixe o valor só no `~/.claude.json`, que não é do
repositório.

## As ferramentas

| Ferramenta | O que faz |
| --- | --- |
| `cerebro_unidades` | Lista as unidades que esse acesso enxerga, com slug e nome. Use quando não souber o slug exato. |
| `cerebro_panorama` | O retrato de uma unidade: agenda e tratamentos da franquia conferidos contra os cartões do Kommo. Devolve as contagens e a lista `paraOlhar` — quem está sem cartão, quem ficou ambíguo (com os candidatos e a parecença de nome medida) e quem está sumindo do tratamento. Parâmetros: `unidade` (obrigatório), `dias` (padrão 60) e `meses` (padrão 6). |
| `cerebro_paciente` | A ficha de um paciente: sessões, tratamentos, cartão no Kommo e como ele foi casado. Parâmetros: `unidade` e `busca` (nome ou telefone). Serve pra aprofundar um caso que o panorama marcou como ambíguo. |

Todas aceitam **slug** no lugar do id (`doutor-hernia-maraba`): o servidor traduz slug →
id antes de chamar a API, porque as rotas do cérebro esperam o id.

## Conferir que está de pé

Sem passar por Claude nenhum, direto no terminal:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node backend/dist/mcp/dd-mcp.js
```

Tem que sair o `serverInfo` `dd-cerebro` e as três ferramentas. Esse mesmo aperto de mão
está automatizado em `dd-mcp.test.ts`, que sobe o processo de verdade e não toca na API.

## Quando não funcionar

- **`ERR_MODULE_NOT_FOUND`** — você compilou pra fora do repositório. Veja "Compilar".
- **`faltam DD_EMAIL e DD_SENHA no ambiente do MCP`** — as variáveis não chegaram ao
  processo; confira com `claude mcp get dd-cerebro`.
- **`login recusado (401)`** — e-mail ou senha do console errados.
- **`unidade "x" não existe`** — o erro já lista os slugs que esse acesso enxerga.
- **`sem_token_da_franquia`** — a unidade existe, mas não tem `spineToken` cadastrado; o
  cérebro depende da API da franquia.
- **Nada aparece no Claude Code** — as rotas `/cerebro/*` ainda não subiram pra produção.
  Enquanto isso, aponte o `DD_API_URL` pro backend local.
