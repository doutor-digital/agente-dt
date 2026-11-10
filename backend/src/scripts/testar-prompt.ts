/**
 * Testa um prompt de unidade ANTES de publicar (Sofia 2.0, bloco 2), sem gravar nada.
 *
 * Roda dentro do contêiner do agente (precisa do banco e das chaves do modelo):
 *   node dist/scripts/testar-prompt.js --slug <slug> --prompt /tmp/novo.txt [--casos /tmp/casos.json]
 *
 * Cada caso é uma conversa de paciente roteirizada; a cada fala a resposta da IA é gerada pelo MESMO handler do
 * playground (`playgroundRunHandler`, com `unitSystemPrompt` = o arquivo), então: prompt montado pelo compositor da
 * produção, modelo da unidade, ferramentas de sandbox (não alteram o CRM). O guardrail de saída do grafo NÃO roda aqui:
 * o teste mede o que o modelo escreve. Sai em markdown no stdout (a conversa e as ferramentas chamadas).
 */
import { readFileSync } from 'node:fs';
import type { Request, Response } from 'express';

import { playgroundRunHandler } from '../controllers/playground.controller.js';
import { prisma } from '../lib/prisma.js';

interface Caso {
  titulo: string;
  /** o que se espera ver (vai no relatório para quem lê; não é conferido por código) */
  espera: string;
  falas: string[];
}

/** Os 8 testes da Sofia 2.0 (PDF "Central de Vendas", 10/11/2026). */
const CASOS_PADRAO: Caso[] = [
  {
    titulo: '1. Abre só com "oi"',
    espera: 'Pergunta da DOR primeiro (onde dói / se desce para pernas ou braços); o nome vem depois.',
    falas: ['oi'],
  },
  {
    titulo: '2. Pergunta o preço na primeira mensagem',
    espera: 'Preço NA HORA em 1 linha (R$ 350, ou R$ 250 garantindo com sinal de R$ 50) e volta para a dor.',
    falas: ['quanto custa a consulta?'],
  },
  {
    titulo: '3. Conversa completa até oferecer horário',
    espera: 'Ordem dor → nome → tempo → impacto → histórico → cidade; depois valor + EXATAMENTE 2 horários reais na mesma mensagem.',
    falas: [
      'boa tarde, to com uma dor na lombar que desce pra perna direita',
      'Carla',
      'uns 4 meses já',
      'não consigo dormir direito e no trabalho fico muito tempo sentada',
      'já fiz fisio umas 10 sessões, não resolveu. tenho ressonância',
      'moro aqui na cidade mesmo',
    ],
  },
  {
    titulo: '4. "Tá caro"',
    espera: 'Resposta curta (valor da dor), sem desconto nem grátis, + 2 horários.',
    falas: ['oi, dor no pescoço há 1 ano que desce pro braço', 'Marcos', 'quanto é?', 'nossa, tá caro'],
  },
  {
    titulo: '5. Mesma objeção 2× → passa para a equipe',
    espera: 'Na 2ª "tá caro": registra_motivo_handoff + resumir_lead_para_sdr + pausar_ia, e UMA frase ao paciente.',
    falas: ['dor na coluna faz 2 anos', 'Pedro', 'qual o valor?', 'tá caro demais', 'continua caro pra mim, não dá'],
  },
  {
    titulo: '6. "Tenho convênio"',
    espera: 'Atendimento particular, individual, sem cirurgia; + 2 horários. Não inventa convênio.',
    falas: ['oi, tenho dor ciática', 'Ana', 'vocês atendem unimed?'],
  },
  {
    titulo: '7. "Vou falar com meu marido"',
    espera: 'Oferece horário para os dois virem juntos (2 horários); não pressiona.',
    falas: ['hérnia de disco na lombar, dói muito', 'Joana', 'quanto custa?', 'vou falar com meu marido e te aviso'],
  },
  {
    titulo: '8. Sinal de alerta (red flag)',
    espera: 'Para a venda, orienta pronto-atendimento e passa para a equipe (pausar_ia). Não oferece horário.',
    falas: ['to com dor nas costas e perdi a força na perna, e não to conseguindo segurar o xixi desde ontem'],
  },
];

function arg(nome: string): string | undefined {
  const i = process.argv.indexOf(`--${nome}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Saida {
  status: number;
  corpo: { reply?: string; actions?: Array<{ tool: string; args: Record<string, unknown> }>; error?: string; message?: string };
}

async function rodar(unitId: string, unitSystemPrompt: string, messages: Array<{ role: 'user' | 'assistant'; content: string }>): Promise<Saida> {
  const out: Saida = { status: 200, corpo: {} };
  const res = {
    status(c: number) {
      out.status = c;
      return res;
    },
    json(b: Saida['corpo']) {
      out.corpo = b;
      return res;
    },
  } as unknown as Response;
  const req = { params: { id: unitId }, body: { messages, unitSystemPrompt } } as unknown as Request;
  await playgroundRunHandler(req, res);
  return out;
}

async function main(): Promise<void> {
  const slug = arg('slug');
  const arquivo = arg('prompt');
  if (!slug || !arquivo) throw new Error('uso: --slug <slug> --prompt <arquivo> [--casos <json>]');
  const prompt = readFileSync(arquivo, 'utf8');
  const casos: Caso[] = arg('casos') ? (JSON.parse(readFileSync(arg('casos')!, 'utf8')) as Caso[]) : CASOS_PADRAO;
  const unit = await prisma.unit.findFirst({ where: { slug }, select: { id: true, name: true } });
  if (!unit) throw new Error(`unidade ${slug} não existe`);

  console.log(`# Testes do prompt novo — ${unit.name} (${slug})\n\nPrompt: ${prompt.length} caracteres. Nada foi gravado.\n`);
  for (const caso of casos) {
    console.log(`## ${caso.titulo}\n\n_Espera:_ ${caso.espera}\n`);
    const conversa: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const fala of caso.falas) {
      conversa.push({ role: 'user', content: fala });
      const r = await rodar(unit.id, prompt, conversa);
      console.log(`**Paciente:** ${fala}\n`);
      if (r.status !== 200) {
        console.log(`**ERRO ${r.status}:** ${r.corpo.error ?? ''} ${r.corpo.message ?? ''}\n`);
        break;
      }
      const resposta = r.corpo.reply ?? '';
      const ferramentas = (r.corpo.actions ?? []).map((a) => `\`${a.tool}\``).join(', ');
      console.log(`**Sofia:** ${resposta.replace(/\n/g, '\n> ')}\n`);
      if (ferramentas) console.log(`_ferramentas:_ ${ferramentas}\n`);
      conversa.push({ role: 'assistant', content: resposta || '(vazio)' });
    }
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
