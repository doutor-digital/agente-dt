/**
 * O portão protege a lista de `sugestoes`, mas o TEXTO da resposta também pode mandar "preencha X". Aqui, depois da IA,
 * toda frase que manda mexer (preencha, marque, coloque…) num campo que o portão recusaria é trocada pelo motivo.
 */
import { DICIONARIO } from './dicionario-campos.js';
import type { ContextoDoCartao } from './contexto.js';
import { validarProposta, type PapelDeQuemUsa } from './mapa-de-campos.js';

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const VERBO_DE_AGIR = /\b(preencha|preencher|marque|marcar|coloque|colocar|escreva|escrever|digite|digitar|altere|alterar|mude|mudar|ponha|por|defina|definir|atualize|atualizar|insira|inserir|lance|lancar|selecione|selecionar)\b/i;

/** Nome do campo sem o símbolo do começo ("✎ Queixa" → "queixa"): é assim que a IA costuma escrever. */
function chaveCurta(nome: string): string {
  return norm(nome.replace(/^[^\p{L}\p{N}]+/u, ''));
}

export function filtrarResposta(resposta: string, ctx: ContextoDoCartao, papel: PapelDeQuemUsa = 'sdr'): string {
  const frases = resposta.split(/(?<=[.!?])\s+/);
  const nomes = Object.keys(DICIONARIO.campos);
  return frases
    .map((frase) => {
      const nf = norm(frase);
      if (!VERBO_DE_AGIR.test(nf)) return frase;
      for (const nome of nomes) {
        const curto = chaveCurta(nome);
        if (curto.length < 4 || !new RegExp(`(?<![a-z0-9])${curto.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9])`).test(nf)) continue;
        // o campo só existe para o portão se a conta o tem; fora disso ele já seria recusado
        const d = validarProposta({ campo: nome, valor: 'x' }, {
          etapa: ctx.etapa ?? '',
          papel,
          valorAtual: (c) => ctx.valores[c] ?? null,
          incluirProximas: false,
        });
        const naConta = nome in ctx.valores;
        if (d.acao !== 'propor' || !naConta) return `Sobre ${nome}: ${naConta ? d.motivo : 'esse campo não existe no cartão desta unidade.'}`;
      }
      return frase;
    })
    .join(' ');
}
