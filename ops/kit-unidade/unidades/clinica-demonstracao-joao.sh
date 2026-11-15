#!/usr/bin/env bash
# O roteiro do João para a CLÍNICA DEMONSTRAÇÃO (a clínica de vitrine). Passo a passo; cada comando é seguro de repetir.
#
#   (tudo isto roda no HOST da VPS, como root, com `bash arquivo` no seu terminal; o kit roda DENTRO do contêiner ddagent_agent)
#   0) uma vez:  bash ops/kit-unidade/criar-platform-app-joao.sh --so-conferir   e depois sem a flag
#      e:        bash ops/kit-unidade/unidades/clinica-demonstracao-joao.sh --so-conferir
#   1) SECO:     bash ops/kit-unidade/unidades/clinica-demonstracao-joao.sh              (mostra o plano; não grava nada)
#   2) APLICAR:  bash ops/kit-unidade/unidades/clinica-demonstracao-joao.sh --aplicar    (pergunta antes de cada etapa)
#   3) SUBDOMÍNIO: bash ops/kit-unidade/regra-traefik-joao.sh demo --so-conferir   e depois sem a flag
#   4) COFRE -> SERVIÇO: copie CHATWOOT_API_TOKEN_DEMO e CHATWOOT_SOFIA_BOT_TOKEN_DEMO de /root/segredos/kit para o env do serviço ddagent_agent e reinicie
#      (o servidor só conhece a conta nova depois do reinício). Os valores NÃO aparecem em lugar nenhum deste roteiro.
#
# Na demonstração o WhatsApp e a Meta ficam em SECO (não há número nem WABA) e os convites usam e-mail @example.com.
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../nova-unidade-joao.sh" clinica-demonstracao "$@"
