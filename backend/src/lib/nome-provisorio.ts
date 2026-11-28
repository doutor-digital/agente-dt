/**
 * Nome provisório do lead que a franquia recebe quando ninguém disse o nome ainda (27/11/2026, "cadastrar TODO lead").
 *
 * A franquia exige nome e a recepção não acha "Lead 22261987" nem "Ocupado". Então, sem nome do paciente, sem título bom no
 * cartão e sem nome de perfil do WhatsApp que passe no filtro de nome-lixo, o lead entra com um nome que ninguém confunde
 * com gente de verdade: `Paciente WhatsApp (final 1234)` — só os 4 últimos dígitos aparecem (bastam para a recepção achar a conversa
 * sem expor o telefone inteiro no campo de nome), mas o telefone precisa ter ao menos 8 dígitos para valer.
 *
 * Quem lê o nome (filtro `avaliarNome`) continua tratando isto como "nome automático": tem número e a palavra "whatsapp".
 * Nunca vira nome de PACIENTE — só o cadastro de lead usa (`opcoes.primeiroContato` em `syncLeadToSpine`).
 */

export const PREFIXO_NOME_PROVISORIO = 'Paciente WhatsApp';

/** `null` se o telefone não tem ao menos 8 dígitos (o mesmo mínimo da busca por duplicado): sem isso não há como achar de quem é, e o lead não é cadastrado. */
export function nomeProvisorioDoLead(telefone: string | null | undefined): string | null {
  const d = String(telefone ?? '').replace(/\D/g, '');
  if (d.length < 8) return null;
  return `${PREFIXO_NOME_PROVISORIO} (final ${d.slice(-4)})`;
}

export function ehNomeProvisorio(nome: string | null | undefined): boolean {
  return /^Paciente WhatsApp \(final \d{4}\)$/.test(String(nome ?? '').trim());
}
