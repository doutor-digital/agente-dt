# Kit de unidade nova (CRM da Doutor Digital)

Monta uma clínica nova no CRM: conta própria no Chatwoot, caixa, time, atendentes, etiquetas/atributos/automações copiados de Parauapebas, webhook com a chave
da conta, aba «Funil», modelos da Meta (via Kapso) e a Sofia da unidade. Inventário do que é específico de Parauapebas: `INVENTARIO.md`.
Entrevista: skill `/nova-unidade` (`.claude/skills/nova-unidade/SKILL.md`). Demonstração: `unidades/clinica-demonstracao.yaml`.

## Roteiro do João (no host da VPS, como root, com `bash arquivo` no seu terminal)
1. Uma vez: `bash ops/kit-unidade/criar-platform-app-joao.sh --so-conferir`, depois sem a flag (cria o Platform App; o token vai para um arquivo 600).
2. `bash ops/kit-unidade/nova-unidade-joao.sh <slug> --so-conferir`, depois sem a flag (SECO: mostra o plano) e com `--aplicar` (pergunta antes de cada etapa).
3. `bash ops/kit-unidade/regra-traefik-joao.sh <subdominio> --so-conferir`, depois sem a flag.
4. Copiar os tokens do cofre (`/root/segredos/kit`) para o env do serviço `ddagent_agent` e reiniciar (o servidor só conhece a conta nova depois).
5. Teste da Sofia, e só então `nova-unidade-joao.sh <slug> --aplicar --ligar-robo`.

## Atenção
- **NÃO PUBLIQUE DEPLOY ENQUANTO O KIT RODA.** O kit roda dentro do contêiner `ddagent_agent`; os segredos gerados ficam em `/run/kit-segredos` até o fim, e o token do
  usuário conector da clínica o Chatwoot entrega UMA vez só. Trocar o contêiner no meio perde o token (apague o usuário no Super Admin e rode de novo).
- O contêiner precisa já ter o kit (deploy do PR da fase 2) — o script recusa, dizendo o motivo, se não tiver.
- Nunca `ssh … 'bash -s' < script`: o `docker exec -i` engole o resto do script. Rode o arquivo.
- Clínica de demonstração: a caixa API fica registrada como `cloud`; não ligue as automações do Chatwoot nela.
- Quem aplica em produção é o João. Nada aqui foi rodado na VPS por quem escreveu; a primeira vez é sempre `--so-conferir`.
