/**
 * O anúncio que o paciente clicou, dito à IA antes dela abrir a boca.
 *
 * A Meta entrega, junto da primeira mensagem de quem veio de "Clique para
 * WhatsApp", o bloco `referral`: qual anúncio, qual campanha e — o que importa
 * aqui — o TÍTULO do anúncio, a frase que convenceu a pessoa a clicar. Os
 * workflows de rastreio já capturam isso e gravam no cartão do Kommo.
 *
 * Só que a IA nunca viu esse dado. Pior: o bloco `coleta_origem` manda ela
 * PERGUNTAR ao paciente como ele conheceu a clínica — uma coisa que o sistema
 * já sabe. E ela pergunta mal: em 1.052 leads medidos, capturou origem em 2.
 *
 * Duas perdas na mesma troca: gasta um turno perguntando o que já sabemos, e
 * abre a conversa genérica ("em que região dói?") quando podia abrir na dor que
 * o anúncio prometeu resolver.
 *
 * Aqui o dado vira duas coisas: um bloco de contexto para a primeira resposta,
 * e o desligamento da pergunta que sobrou.
 */

/** Nomes canônicos no Kommo. Id de campo é por conta — sempre resolver por NOME. */
export const CAMPOS_DO_ANUNCIO = {
  titulo: '⌂ Título do anúncio',
  anuncio: '⌂ Anúncio (ad)',
  campanha: '⌂ Campanha',
  plataforma: '⌂ Plataforma de origem',
  origem: '⚑ Origem',
} as const;

export interface AnuncioDeOrigem {
  /** O título do anúncio — a promessa em que a pessoa clicou. */
  titulo: string | null;
  anuncio: string | null;
  campanha: string | null;
  plataforma: string | null;
  origem: string | null;
}

type CampoDoLead = { field_id?: number; values?: Array<{ value?: unknown }> };

/**
 * O campo "Título do anúncio" guarda o BOTÃO do anúncio, não a promessa dele.
 *
 * Medido em 17/09/2026 sobre 554 leads de Rio Verde, Araguaína e Imperatriz:
 * 7 títulos distintos, 86% genéricos — "Converse conosco" (435x), o nome da
 * página (75x), "api.whatsapp.com" (29x). Nenhum descreve uma dor.
 *
 * Mandar "o anúncio dizia: Converse conosco" para o modelo é ruído: gasta token
 * e convida a IA a falar do anúncio em vez de falar com a pessoa. Título que não
 * diz nada é tratado como título ausente — a origem continua conhecida (isso
 * ainda desliga a pergunta "como nos conheceu"), só não serve de gancho.
 */
const TITULO_GENERICO =
  /^(converse|fale|clique|chame|saiba mais|agendar|agende|contato|entre em contato|enviar mensagem|send message|whats)/i;

export function tituloUtil(bruto: string | null): string | null {
  const t = bruto?.trim();
  if (!t || t.length < 12) return null;
  if (TITULO_GENERICO.test(t)) return null;
  // nome de página ("Doutor Hérnia Unidade X") e URL não são promessa de anúncio
  if (/^doutor h[ée]rnia\b/i.test(t)) return null;
  if (/^(https?:\/\/|www\.|[a-z0-9.-]+\.(com|br|me)\b)/i.test(t)) return null;
  // promessa de verdade tem frase, não duas palavras soltas
  return t.split(/\s+/).length >= 3 ? t : null;
}

/**
 * Lê o anúncio do cartão. `idPorNome` vem do esquema da unidade (resolvido por
 * nome, cacheado) — nunca de id chumbado.
 */
export function lerAnuncioDoLead(
  campos: CampoDoLead[] | null | undefined,
  idPorNome: (nome: string) => number | null,
): AnuncioDeOrigem | null {
  const porId = new Map<number, string>();
  for (const c of campos ?? []) {
    const id = Number(c.field_id);
    const bruto = c.values?.[0]?.value;
    const v = typeof bruto === 'string' ? bruto.trim() : bruto == null ? '' : String(bruto).trim();
    if (Number.isFinite(id) && v) porId.set(id, v);
  }
  const pega = (nome: string): string | null => {
    const id = idPorNome(nome);
    return id ? (porId.get(id) ?? null) : null;
  };

  const a: AnuncioDeOrigem = {
    titulo: tituloUtil(pega(CAMPOS_DO_ANUNCIO.titulo)),
    anuncio: pega(CAMPOS_DO_ANUNCIO.anuncio),
    campanha: pega(CAMPOS_DO_ANUNCIO.campanha),
    plataforma: pega(CAMPOS_DO_ANUNCIO.plataforma),
    origem: pega(CAMPOS_DO_ANUNCIO.origem),
  };
  return a.titulo || a.anuncio || a.campanha || a.origem ? a : null;
}

/**
 * Já sabemos por onde ele chegou?
 *
 * Só conta quando a origem é RASTREADA de verdade — anúncio, campanha ou o campo
 * de origem preenchido pelo rastreio. Se não sabemos, a pergunta continua valendo:
 * desligar a coleta sem ter o dado seria perder a informação de vez.
 */
export function origemJaConhecida(a: AnuncioDeOrigem | null | undefined): boolean {
  if (!a) return false;
  return Boolean(a.titulo || a.anuncio || a.campanha || a.origem);
}

/** Texto curto de onde veio, para o bloco e para o log. */
export function resumoDaOrigem(a: AnuncioDeOrigem): string {
  const partes = [a.plataforma, a.campanha, a.anuncio].filter(Boolean);
  return partes.length > 0 ? partes.join(' · ') : (a.origem ?? 'anúncio');
}

/**
 * O bloco que entra no prompt.
 *
 * Regra de tom que vale mais que o dado: a IA usa o ASSUNTO do anúncio para
 * abrir, e NUNCA conta que sabe. "Vi que você clicou no anúncio X" soa a
 * vigilância e derruba a conversa — o paciente não lembra o que clicou, e ainda
 * se assusta. O jeito certo é já entrar no tema: quem clicou num anúncio de dor
 * ciática quer falar de dor ciática.
 */
export function renderAnuncioDeOrigem(a: AnuncioDeOrigem | null | undefined): string {
  if (!a) return '';
  const linhas: string[] = [];
  if (a.titulo) linhas.push(`- O anúncio dizia: "${a.titulo}"`);
  if (a.anuncio && a.anuncio !== a.titulo) linhas.push(`- Nome do anúncio: ${a.anuncio}`);
  if (a.campanha) linhas.push(`- Campanha: ${a.campanha}`);
  if (a.plataforma) linhas.push(`- Chegou por: ${a.plataforma}`);
  if (linhas.length === 0 && a.origem) linhas.push(`- Origem registrada: ${a.origem}`);

  const comoUsar = a.titulo
    ? 'Abra a conversa JÁ NO ASSUNTO do anúncio, como quem continua um papo que ' +
      'ele começou: se o anúncio fala de dor ciática, pergunte da ciática; se fala ' +
      'de hérnia de disco, pergunte da hérnia. Isso economiza duas ou três trocas.'
    : 'Use como contexto de fundo. Não muda o roteiro, mas você já sabe que ele veio de anúncio.';

  return [
    '<anuncio_de_origem>',
    'POR ONDE ELE CHEGOU — você JÁ SABE, não pergunte.',
    ...linhas,
    '',
    comoUsar,
    '',
    'PROIBIDO: dizer que viu o clique dele, citar o anúncio, falar em "campanha", ' +
    '"anúncio" ou "you clicked". Ele não lembra o que clicou e soa vigilância. ' +
    'PROIBIDO também perguntar "como você nos conheceu" — a resposta está aqui em cima.',
    'Se o assunto do anúncio não combinar com o que ele contar, siga o que ELE disser: ' +
    'a queixa da pessoa vale mais que a segmentação do anúncio.',
    '</anuncio_de_origem>',
  ].join('\n');
}
