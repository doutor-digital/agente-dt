/**
 * O portão protege a lista de `sugestoes`, mas o TEXTO da resposta também pode mandar "preencha X". Aqui, depois da IA,
 * toda frase que manda mexer num campo que o portão recusaria é trocada pelo motivo. Duas exceções de bom senso:
 * - explicar o que falta para MOVER de etapa ("para mover para AGENDADO, preencha o Valor da Consulta") fica;
 * - nomes de uma palavra só (Alta, Origem, Cidade…) só contam se o verbo vier logo antes ("troque a Origem"), para
 *   "a chance de ele marcar é alta" não virar aviso sobre o campo Alta.
 */
import { DICIONARIO } from './dicionario-campos.js';
import type { ContextoDoCartao } from './contexto.js';
import { validarProposta, type PapelDeQuemUsa } from './mapa-de-campos.js';

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
// "por" e "pôr" ficaram de fora de propósito ("por favor", "por telefone"); "marque/marcar" ficam porque a IA as usa para mandar preencher
const VERBOS = 'preencha|preencher|marque|marcar|coloque|colocar|escreva|escrever|digite|digitar|altere|alterar|mude|mudar|ponha|defina|definir|atualize|atualizar|insira|inserir|lance|lancar|selecione|selecionar|escolha|escolher|deixe|deixar|ajuste|ajustar|troque|trocar|informe|informar|registre|registrar|anote|anotar|complete|completar';
const TEM_VERBO = new RegExp(`(?<![a-z0-9])(?:${VERBOS})(?![a-z0-9])`, 'i');
const LIGACAO = 'a|o|as|os|um|uma|no|na|do|da|de|em|campo|valor';
const MOVER = /(?<![a-z0-9])(mover|mova|movimentar|avancar|avance|passar|passe|proxima etapa|etapa)(?![a-z0-9])/;

const escapa = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Nome do campo sem o símbolo do começo ("✎ Queixa" → "queixa"): é assim que a IA costuma escrever. */
function chaveCurta(nome: string): string {
  return norm(nome.replace(/^[^\p{L}\p{N}]+/u, ''));
}

function citaComoOrdem(nf: string, curto: string): boolean {
  const nome = escapa(curto);
  // "Consulta pg antecipado: Sim" / "Origem = Instagram": valor logo depois do nome é ordem de preencher, mesmo sem verbo
  if (new RegExp(`(?<![a-z0-9])${nome}\\s*[:=]\\s*\\S`).test(nf)) return true;
  if (!curto.includes(' ')) {
    // uma palavra só: o verbo precisa vir logo antes (só artigos/preposições no meio)
    return new RegExp(`(?<![a-z0-9])(?:${VERBOS})\\s+(?:(?:${LIGACAO})\\s+){0,3}${nome}(?![a-z0-9])`).test(nf);
  }
  return new RegExp(`(?<![a-z0-9])${nome}(?![a-z0-9])`).test(nf) && TEM_VERBO.test(nf);
}

export function filtrarResposta(resposta: string, ctx: ContextoDoCartao, papel: PapelDeQuemUsa = 'sdr'): string {
  const frases = resposta.split(/(?<=[.!?])\s+/);
  const nomes = Object.keys(DICIONARIO.campos);
  return frases
    .map((frase) => {
      const nf = norm(frase);
      for (const nome of nomes) {
        const curto = chaveCurta(nome);
        if (curto.length < 4 || !citaComoOrdem(nf, curto)) continue;
        const naConta = nome in ctx.valores;
        const base = { etapa: ctx.etapa ?? '', papel, valorAtual: (c: string) => ctx.valores[c] ?? null };
        const estrito = validarProposta({ campo: nome, valor: 'x' }, { ...base, incluirProximas: false });
        if (naConta && estrito.acao === 'propor') continue;
        // explicar o que falta para mover de etapa é permitido (regra 10 do prompt)
        const folgado = validarProposta({ campo: nome, valor: 'x' }, { ...base, incluirProximas: true });
        if (naConta && folgado.acao === 'propor' && MOVER.test(nf)) continue;
        const motivo = !naConta
          ? 'esse campo não existe no cartão desta unidade.'
          : folgado.acao === 'propor'
            ? 'esse campo é de uma etapa mais à frente. Preencha quando o cartão chegar lá.'
            : estrito.motivo;
        return `Sobre ${nome}: ${motivo}`;
      }
      return frase;
    })
    .join(' ');
}
