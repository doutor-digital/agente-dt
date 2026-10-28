/**
 * O que a IA recebe e como a resposta dela é lida. O prompt só descreve o que o dicionário diz; quem DECIDE o que
 * pode ser sugerido é o portão (`mapa-de-campos.ts`), depois, mesmo que a IA desobedeça.
 */
import { DICIONARIO } from './dicionario-campos.js';
import type { ContextoDoCartao } from './contexto.js';
import { camposDaEtapa, infoDoCampo, missaoDaEtapa, podeSugerir, type PapelDeQuemUsa } from './mapa-de-campos.js';

export interface FalaParaIa {
  quem: 'paciente' | 'clinica';
  texto: string;
}
export interface TurnoDoHistorico {
  papel: 'pessoa' | 'copiloto';
  texto: string;
}
export interface SugestaoDaIa {
  campo: string;
  valor: string;
  porque: string;
}
export interface RespostaDaIa {
  resposta: string;
  sugestoes: SugestaoDaIa[];
}

export const MAX_CHARS_DA_CONVERSA = 6000;
export const MAX_CHARS_DA_PERGUNTA = 500;

const REGRAS = `Você é o Copiloto da recepção de uma clínica Doutor Hérnia. Ajuda a atendente a usar o Kommo.
Regras:
1. Responda em português do Brasil, tratando por "você", em no máximo 4 frases curtas e simples.
2. Use SÓ os dados abaixo. Se não souber, diga "não tenho certeza" e diga o que falta. Nunca invente.
3. Você NÃO grava nada. Quem digita no Kommo é a atendente. Você só explica e sugere.
4. Sugira preencher um campo SOMENTE se ele estiver na lista "Campos da pessoa nesta etapa" e estiver vazio. Os campos que chegam sozinhos você só explica, nunca sugere. Se a atendente pedir para preencher um campo que chega sozinho ou que não é dela, explique isso em vez de preencher.
5. Só inclua "sugestoes" quando a atendente perguntar o que preencher ou quando a pergunta for sobre os campos. Em qualquer outra pergunta, use "sugestoes": [].
6. Não dê orientação médica nem prometa resultado de tratamento.
7. O nome e o telefone do paciente você NÃO vê (aparece [paciente]). Se perguntarem, diga para olhar no cartão.
Responda SEMPRE em JSON: {"resposta": "texto para a atendente", "sugestoes": [{"campo": "código do campo, como C1", "valor": "valor sugerido", "porque": "de onde veio"}]}. Use o CÓDIGO (C1, C2…) da lista de campos da pessoa. "sugestoes" pode ser [].`;

function linhaDoCampo(ctx: ContextoDoCartao, nome: string, codigo: string): string {
  const i = infoDoCampo(nome)!;
  const v = ctx.valores[nome];
  const op = ctx.opcoes[nome];
  return `- [${codigo}] ${nome} | atual: ${v ?? '(vazio)'} | ${i.oQueE}${op ? ` | opções: ${op.join(' / ')}` : ''}`;
}

export function montarPrompt(p: {
  ctx: ContextoDoCartao;
  papel?: PapelDeQuemUsa;
  conversa: FalaParaIa[];
  historico?: TurnoDoHistorico[];
  pergunta: string;
}): { system: string; user: string; codigos: Record<string, string> } {
  const papel = p.papel ?? 'sdr';
  const codigos: Record<string, string> = {};
  const etapa = p.ctx.etapa;
  const daPessoa: string[] = [];
  const outros: string[] = [];
  if (etapa) {
    for (const c of camposDaEtapa(etapa)) {
      if (!(c.nome in p.ctx.valores)) continue; // a conta não tem esse campo
      const d = podeSugerir(c.nome, papel);
      if (d.acao === 'propor') {
        const codigo = `C${daPessoa.length + 1}`;
        codigos[codigo] = c.nome;
        daPessoa.push(linhaDoCampo(p.ctx, c.nome, codigo));
      } else outros.push(`- ${c.nome}: ${d.motivo}`);
    }
  }
  const automaticos = Object.keys(DICIONARIO.campos)
    .map((n) => infoDoCampo(n)!)
    .filter((i) => (i.chegaSozinho || i.atores.includes('automatico')) && i.nome in p.ctx.valores)
    .map((i) => `- ${i.nome}: chega sozinho (${i.chegaSozinho ?? i.quemPreencheTexto}). Atual: ${p.ctx.valores[i.nome] ?? '(vazio)'}`);

  let conversa = p.conversa.map((f) => `${f.quem === 'paciente' ? 'paciente' : 'clínica'}: ${f.texto}`).join('\n');
  if (conversa.length > MAX_CHARS_DA_CONVERSA) conversa = '…\n' + conversa.slice(-MAX_CHARS_DA_CONVERSA);

  const user = [
    `Etapa do cartão: ${p.ctx.etapaNome ?? '(desconhecida)'}${etapa ? '' : ' (o dicionário não conhece esta etapa)'}`,
    etapa && missaoDaEtapa(etapa) ? `O que se faz nesta etapa: ${missaoDaEtapa(etapa)}` : '',
    '',
    'Campos da pessoa nesta etapa (só estes podem ser sugeridos):',
    daPessoa.join('\n') || '(nenhum)',
    '',
    'Campos desta etapa que NÃO são da pessoa:',
    outros.join('\n') || '(nenhum)',
    '',
    'Campos que chegam sozinhos (só explique, nunca sugira):',
    automaticos.join('\n') || '(nenhum)',
    '',
    'Conversa (mais antiga primeiro):',
    conversa || '(sem conversa)',
    '',
    ...(p.historico?.length ? ['Conversa com a atendente até agora:', ...p.historico.map((t) => `${t.papel === 'pessoa' ? 'atendente' : 'copiloto'}: ${t.texto}`), ''] : []),
    `Pergunta da atendente: ${p.pergunta}`,
  ].join('\n');
  return { system: REGRAS, user, codigos };
}

/** Lê o JSON que a IA devolveu sem confiar nele: formato errado vira resposta vazia, nunca erro que derruba. */
export function interpretarResposta(bruto: string, codigos: Record<string, string> = {}): RespostaDaIa | null {
  let o: unknown;
  try {
    const limpo = bruto.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    o = JSON.parse(limpo);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object') return null;
  const r = (o as { resposta?: unknown }).resposta;
  const s = (o as { sugestoes?: unknown }).sugestoes;
  if (typeof r !== 'string' || !r.trim()) return null;
  const sugestoes: SugestaoDaIa[] = [];
  if (Array.isArray(s)) {
    for (const x of s.slice(0, 8)) {
      if (!x || typeof x !== 'object') continue;
      const { campo, valor, porque } = x as Record<string, unknown>;
      if (typeof campo === 'string' && typeof valor === 'string' && campo.trim() && valor.trim()) {
        const nome = codigos[campo.trim().toUpperCase()] ?? campo.trim();
        sugestoes.push({ campo: nome, valor: valor.trim().slice(0, 300), porque: typeof porque === 'string' ? porque.trim().slice(0, 200) : '' });
      }
    }
  }
  return { resposta: r.trim().slice(0, 1200), sugestoes };
}
