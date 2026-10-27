/**
 * O que pode sair no Telegram sobre um paciente: 1º nome, 4 últimos dígitos do telefone e trecho sem número.
 * Puro, para o teste provar que nada além disso passa.
 */

/** O 1º nome, só se parecer nome de gente (cadastro com telefone ou número no lugar do nome vira null). */
export function primeiroNome(contato: string | null | undefined): string | null {
  const nome = (contato ?? '').trim().split(/\s+/)[0] ?? '';
  if (!nome || /\d/.test(nome) || nome.length < 2) return null;
  return nome.slice(0, 20);
}

/** Só os 4 últimos dígitos. */
export function final4(telefone: string | null | undefined): string | null {
  const d = (telefone ?? '').replace(/\D/g, '');
  return d.length >= 4 ? d.slice(-4) : null;
}

/** Tira número de telefone/CPF de dentro do texto e corta no tamanho de uma linha de Telegram. */
export function limparTrecho(texto: string, max = 140): string {
  const semNumero = texto.replace(/\+?\d[\d\s().-]{6,}\d/g, '[número]').replace(/\s+/g, ' ').trim();
  return semNumero.length > max ? `${semNumero.slice(0, max - 1)}…` : semNumero;
}
