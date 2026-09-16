/**
 * Lacuna é o buraco que o modelo deixa na mensagem quando a instrução aponta
 * para um dado em vez de trazer o dado.
 *
 * Em 16/09/2026 o Renilson, paciente de Rio Verde, recebeu isto às 14:29:
 *
 *   "a chave Pix da clínica é [chave das Fontes Oficiais], no nome Doutor Hérnia
 *    Rio Verde ♥ O valor antecipado fica R$ [valor]"
 *
 * A causa foi corrigida na origem (`orientacaoDePagamento` agora interpola a
 * chave e o valor). Este módulo é a rede embaixo: qualquer caminho — regra de
 * unidade, follow-up, template novo — que produza um colchete na resposta cai
 * aqui antes de virar mensagem. Primeiro tentamos PREENCHER com o dado real da
 * unidade; o que não dá pra preencher vira "vou confirmar", nunca vai com o
 * buraco à mostra.
 *
 * O que NÃO é lacuna: `[[botoes: A | B]]`, que é a marcação interna dos botões
 * rápidos e sai do texto depois; e link markdown `[texto](url)`.
 */

export interface DadosDaUnidade {
  chavePix?: string | null;
  titularPix?: string | null;
  valorAntecipado?: number | null;
}

const MAX_LACUNA = 80;

/** Troca `[[...]]` e `[texto](url)` por espaços do mesmo tamanho, pra não achá-los. */
function mascararOQueNaoEhLacuna(texto: string): string {
  return texto
    .replace(/\[\[[\s\S]*?\]\]/g, (m) => ' '.repeat(m.length))
    .replace(/\[[^\[\]]*\]\([^\s()]*\)/g, (m) => ' '.repeat(m.length));
}

interface Achado {
  inicio: number;
  fim: number;
  conteudo: string;
  abre: '[' | '{';
}

function varrer(texto: string): Achado[] {
  const limpo = mascararOQueNaoEhLacuna(texto);
  const achados: Achado[] = [];
  const re = new RegExp(`\\[([^\\[\\]]{1,${MAX_LACUNA}})\\]|\\{([^{}]{1,${MAX_LACUNA}})\\}`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(limpo)) !== null) {
    const conteudo = m[1] ?? m[2];
    // Só é lacuna se tem letra: "[2]" ou "[...]" numa citação não é buraco de dado.
    if (!/\p{L}/u.test(conteudo)) continue;
    achados.push({
      inicio: m.index,
      fim: m.index + m[0].length,
      conteudo,
      abre: m[1] !== undefined ? '[' : '{',
    });
  }
  return achados;
}

/** Os textos das lacunas encontradas, na ordem em que aparecem. */
export function acharLacunas(texto: string): string[] {
  return varrer(texto ?? '').map((a) => a.conteudo);
}

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ','));

/**
 * Preenche o que dá com o dado real da unidade e devolve o que sobrou.
 * `restantes` vazio = a mensagem pode sair.
 */
export function preencherLacunas(
  texto: string,
  dados: DadosDaUnidade,
): { texto: string; trocas: string[]; restantes: string[] } {
  const achados = varrer(texto ?? '');
  if (achados.length === 0) return { texto, trocas: [], restantes: [] };

  const trocas: string[] = [];
  const restantes: string[] = [];
  let saida = '';
  let cursor = 0;

  for (const a of achados) {
    const antes = texto.slice(cursor, a.inicio);
    const substituto = resolver(a.conteudo, texto.slice(0, a.inicio), dados);
    saida += antes;
    if (substituto === null) {
      saida += texto.slice(a.inicio, a.fim);
      restantes.push(a.conteudo);
    } else {
      saida += substituto;
      trocas.push(`${a.conteudo}→${substituto}`);
    }
    cursor = a.fim;
  }
  saida += texto.slice(cursor);
  return { texto: saida, trocas, restantes };
}

function resolver(conteudo: string, antes: string, dados: DadosDaUnidade): string | null {
  const c = conteudo.toLowerCase();
  const chave = dados.chavePix?.trim();
  const titular = dados.titularPix?.trim();

  // "titular" antes de "chave": "[nome do titular]" cita os dois.
  if (titular && /titular|benefici|nome da cl|raz[ãa]o social/.test(c)) return titular;
  if (chave && /chave|pix|cnpj|cpf/.test(c)) return chave;

  if (dados.valorAntecipado && /valor|pre[çc]o|r\$|quantia/.test(c)) {
    // "R$ [valor]" vira "R$ 250", não "R$ R$ 250".
    return /r\$\s*$/i.test(antes) ? fmt(dados.valorAntecipado) : `R$ ${fmt(dados.valorAntecipado)}`;
  }
  return null;
}
