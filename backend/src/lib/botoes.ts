/**
 * Botões de resposta rápida nas perguntas fechadas.
 *
 * O modelo escreve a pergunta como sempre e, quando ela é fechada (2 ou 3 respostas
 * curtas), termina com uma linha `[[botoes: A | B | C]]`. Aqui a linha sai do texto
 * e vira a lista de botões; a entrega decide se manda com botões (chat do Kommo)
 * ou só o texto (widget, sem sessão de chat, falha). O paciente que toca num botão
 * manda o rótulo como mensagem de texto normal — a Sofia responde sem nada especial.
 */
import { MAX_BOTOES, MAX_CHARS_BOTAO } from '../services/kommo-chat.service.js';

const MARCADOR = /\s*\[\[\s*bot(?:õ|o)es?\s*:\s*([^\]]*?)\s*\]\]\s*/gi;

export function validarBotoes(itens: string[]): string[] {
  const limpos = itens.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const unicos = [...new Set(limpos)];
  if (unicos.length < 2 || unicos.length > MAX_BOTOES) return [];
  // Um botão inválido invalida o conjunto: mandar só parte das opções engana o paciente.
  const invalido = unicos.some((s) => s.length > MAX_CHARS_BOTAO || /https?:\/\/|www\./i.test(s) || /[\[\]]/.test(s));
  return invalido ? [] : unicos;
}

export function extrairBotoes(reply: string): { texto: string; botoes: string[] } {
  let itens: string[] = [];
  const texto = reply
    .replace(MARCADOR, (_m, lista: string) => {
      if (!itens.length) itens = lista.split('|');
      return '\n';
    })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { texto, botoes: validarBotoes(itens) };
}
