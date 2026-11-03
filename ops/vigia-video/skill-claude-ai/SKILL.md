---
name: vigiar-video-conector
description: Analisa gravações de câmera de segurança (horas de vídeo do OBS, já trianguladas por movimento) pelo conector Doutor Digital, procurando comportamento suspeito - mexer em caixa, gaveta ou estoque, pegar objeto e esconder, movimento fora do horário, câmera tampada. Use quando a pessoa pedir para "ver as gravações", "olhar a câmera do caixa", "achar algo suspeito no vídeo", "alguém mexeu no caixa", "movimento fora do horário", ou citar câmera, gravação, folha de contato ou clipe.
---

# Vigiar vídeo pelo conector

Você **não assiste** 10 horas de vídeo: o claude.ai não recebe vídeo de GB e você só enxerga imagem. O computador da loja já mediu o
movimento da gravação e separou os **eventos** (trechos com gente se mexendo). Para cada evento existe uma **folha de contato**
(12 quadros em ordem) e um **clipe curto** de 480p. O fluxo é: lista → índice → folhas em lotes → nota → clipe dos suspeitos →
relatório. **Quem decide é a pessoa, vendo o clipe.**

Ferramentas do conector (só aparecem para quem tem permissão; se não aparecerem, diga que o vigia não está liberado para esta conta):

| Ferramenta | Faz |
|---|---|
| `video_gravacoes` | lista as gravações: id, câmera, hora real de início e fim, duração, nº de eventos, segundos de movimento **por hora** |
| `video_folhas` | sem `eventos`: o **índice** (id, hora real, duração, pico). Com até 8 ids: as **folhas como imagem** + o horário de cada quadro |
| `video_clipe` | **link** do clipe (vale 15 min, no máximo 30) para a pessoa abrir no navegador |

## 0. Contexto (uma pergunta só, e só o que faltar)

- Qual câmera e dia (ou intervalo)? O que ela mostra (caixa, recepção, estoque, sala)?
- O que é normal ali e quem pode estar? Horário de funcionamento?
- Há suspeita concreta (ex.: "sumiu dinheiro do caixa na terça à tarde")? Se houver, comece por esse intervalo.

## 1. Escolher a gravação

Chame `video_gravacoes` (com `camera` e/ou `dia` se souber). Mostre à pessoa, em tabela curta, o que achou.
Leia `movimentoPorHora`: **movimento em hora que deveria estar vazia** (madrugada, loja fechada) já é um achado por si só; anote.
A hora é a do relógio do computador que gravou (sem conversão de fuso).

## 2. Índice e folhas, em lotes

1. `video_folhas({gravacao})` sem `eventos` devolve o índice. Passe os olhos: muitos eventos curtos e de pico baixo costumam ser
   passagem normal; pico alto, evento longo e hora fora do normal merecem folha.
2. Peça as folhas em **lotes de até 8** (`eventos: [..]`). Mais de ~60 eventos: priorize pelo contexto (intervalo suspeito, fora do
   horário, longos, picos altos) e diga à pessoa quais ficaram sem olhar; se ela quiser tudo, siga lote a lote (índice paginado por
   `aPartirDoEvento`). Cada folha custa ~1,5 mil tokens: avise antes de passar de ~100 folhas.
3. Cada folha é uma grade de 12 quadros (4 por linha), em ordem, da esquerda para a direita e de cima para baixo. O texto que vem
   com a imagem dá o **horário real de cada quadro**: use-o para citar o momento exato.

## 3. Nota por evento

| Nota | Significa |
|---|---|
| **0** | normal (passagem, rotina esperada) |
| **1** | atípico, provavelmente inocente |
| **2** | suspeito: precisa ver de perto |
| **3** | muito suspeito |

Sinais que **sobem** a nota: mão em caixa, gaveta, bolsa ou estoque e o objeto some; olhar em volta antes de agir; esconder algo na
roupa ou na bolsa; pessoa fora do horário ou em área que não é dela; câmera tampada, desviada ou imagem que escurece de repente;
a mesma ação repetida em dias ou horários parecidos (padrão); alguém sozinho por muito tempo onde normalmente há duas pessoas.

Regra de honestidade: a folha tem **baixa resolução e pula segundos**. "Parece pegar algo" não é "pegou". Registre para cada evento:
`id | nota | o que se vê` (uma linha, descritiva).

## 4. Clipe dos de nota 2 ou 3

Chame `video_clipe({gravacao, evento})` para cada um e entregue o **link** (a pessoa abre no navegador; você não vê vídeo).
O link vence em 15 min: se ela voltar depois, peça outro. Se `clipeCortado` vier verdadeiro, o clipe é só o começo do evento: diga isso.
Se uma folha mostrar algo que precisa de mais detalhe, diga o horário exato para ela procurar no clipe.

## 5. Relatório (no chat; curto)

- Quantas horas analisadas, quantos eventos, quantos olhados, quantos com nota 2 ou 3, e **o que ficou sem olhar**.
- Tabela dos de nota ≥ 2: **hora real**, câmera, o que se vê, link do clipe.
- Movimento fora do horário (da tabela por hora), mesmo sem folha.
- Padrões entre eventos (mesmo horário, lugar, ação).
- O que a triagem **não cobre** (abaixo).

## Regras que não mudam

- **Descreva o que se vê; nunca acuse ninguém.** Não diga "roubou", "furtou", "fulano pegou". Diga "às 14:32 uma pessoa abre a
  gaveta do caixa e leva a mão ao bolso". Quem decide é a pessoa, vendo o clipe.
- Você não identifica pessoas por rosto e não deve tentar: descreva roupa, posição e ação.
- O relatório **não é prova**. Gravação de funcionário é dado pessoal (LGPD) e exige aviso; qualquer providência passa por revisão humana.
- Não repita o link do clipe além do necessário e não o cole em lugar público.

## Limites (diga quando relevante)

- Movimento muito lento, pequeno ou de pouco contraste pode ficar abaixo do limiar da triagem; câmera com muito ruído à noite gera evento falso.
- A triagem usa quadros-chave: uma ação de poucos segundos pode cair entre dois quadros da folha.
- Não há áudio e não há reconhecimento facial.
- Só existem gravações dos últimos dias (o `video_gravacoes` diz a `retencaoDias`; padrão 30) e só as que o computador da loja já terminou de enviar (uma gravação em andamento não aparece).
