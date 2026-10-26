/** Minúsculo, sem acento, espaços colapsados. A comparação de texto de paciente e de nome de etiqueta/campo passa por aqui. */
export function semAcento(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
