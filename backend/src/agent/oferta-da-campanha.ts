/**
 * A oferta do disparo, dita à Sofia antes dela abrir a boca.
 *
 * O problema (Outubro Rosa, o caso do R$ 150): a clínica manda uma campanha com uma proposta — preço, prazo, condição —
 * e o paciente responde. Quem responde é a Sofia, que NÃO sabe da proposta; ela fala o preço da ficha, ou inventa um
 * parecido, e o paciente confronta a clínica com o print da mensagem que ela mesma mandou.
 *
 * Aqui a campanha ganha um texto de oferta (escrito por gente, no cadastro da campanha) e quem RECEBEU o disparo
 * (destinatário `enviado` de verdade, nos últimos 14 dias) passa a ter um bloco curto no prompt com ele. O mesmo texto
 * alimenta o guardrail de preço (`agent/guardrail.ts`): o valor da oferta não é "fora do catálogo".
 */

/** O que o prompt precisa saber de uma oferta vigente para um paciente. */
export interface OfertaVigente {
  campanha: string;
  oferta: string;
  enviadoEm: Date;
  /** a mensagem que ele recebeu, com o nome dele no lugar; vazio se não deu para montar */
  textoEnviado: string;
}

const semMarca = (s: string) => s.replace(/[<>]/g, '').trim();

function haQuantoTempo(enviadoEm: Date, agora: Date): string {
  const dias = Math.floor((agora.getTime() - enviadoEm.getTime()) / 86_400_000);
  if (dias <= 0) return 'hoje';
  return dias === 1 ? 'há 1 dia' : `há ${dias} dias`;
}

/** O bloco do prompt. Vazio quando não há oferta vigente: quem não recebeu o disparo não ganha bloco nenhum. */
export function renderOfertaDaCampanha(o: OfertaVigente | null | undefined, agora: Date = new Date()): string {
  const oferta = o ? semMarca(o.oferta) : '';
  if (!o || !oferta) return '';
  const enviado = semMarca(o.textoEnviado);
  return [
    '<oferta_da_campanha>',
    `ELE RECEBEU UM DISPARO DA CLÍNICA ${haQuantoTempo(o.enviadoEm, agora)} (campanha "${semMarca(o.campanha)}") e provavelmente está respondendo a ele.`,
    ...(enviado ? ['A mensagem que ele leu foi:', `"${enviado.slice(0, 700)}"`] : []),
    '',
    'A OFERTA DESTA CAMPANHA, escrita pela clínica (é a ÚNICA fonte de preço, prazo e condição dela):',
    oferta,
    '',
    '- Se ele perguntar de valor, prazo ou condição da proposta, responda com ESTES números e condições.',
    '- NUNCA invente outro preço, desconto, parcelamento, brinde ou prazo. O que a oferta não diz, você não promete: diga que vai confirmar com a equipe.',
    '- A oferta não troca o roteiro da unidade (dor, consulta, agenda): ela só diz o que a clínica propôs a ele.',
    '- Se a oferta e a ficha de preços divergirem para o mesmo serviço, vale a oferta enquanto estiver dentro do prazo e das condições escritas acima; fora deles, vale a ficha.',
    '</oferta_da_campanha>',
  ].join('\n');
}
