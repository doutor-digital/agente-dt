/**
 * Link de mapa que a IA monta sozinha a partir do endereço escrito — e o Google erra o pino.
 *
 * Rio Verde, 21/10/2026 (lead 6271810): a paciente pediu o mapa e a Sofia mandou
 * `google.com/maps/search/?api=1&query=R.+Abel+Pereira+de+Castro,+792…`. O Google põe esse texto alguns quarteirões
 * acima; a clínica fica na esquina com a Almiro de Moraes, onde está a ficha dela no Google. A unidade reclamou.
 *
 * Só vale o link cadastrado (`clinicMapUrl`). Qualquer outro link do Google Maps na resposta vira o cadastrado; sem
 * cadastro, vira o endereço escrito — sem fingir que é um pino.
 */

const LINK_DO_GOOGLE_MAPS =
  /\bhttps?:\/\/(?:(?:www\.)?google\.[a-z.]+\/maps\b|maps\.google\.[a-z.]+|maps\.app\.goo\.gl|goo\.gl\/maps)\S*/gi;

/** Pontuação colada no fim do link não é dele ("…/maps/xyz." no fim da frase). */
function semPontuacaoFinal(link: string): { link: string; resto: string } {
  const m = /[.,;:!?)\]»”"']+$/.exec(link);
  return m ? { link: link.slice(0, m.index), resto: m[0] } : { link, resto: '' };
}

export function corrigirLinkDeMapa(
  texto: string,
  unidade: { clinicMapUrl?: string | null; clinicAddress?: string | null },
): { texto: string; trocou: boolean } {
  const certo = unidade.clinicMapUrl?.trim() || null;
  const endereco = unidade.clinicAddress?.trim() || null;
  let trocou = false;
  const novo = texto.replace(LINK_DO_GOOGLE_MAPS, (bruto) => {
    const { link, resto } = semPontuacaoFinal(bruto);
    if (certo && link === certo) return bruto;
    const troca = certo ?? endereco;
    if (!troca) return bruto;
    trocou = true;
    return troca + resto;
  });
  return { texto: novo, trocou };
}
