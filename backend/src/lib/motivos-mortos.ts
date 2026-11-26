/**
 * Motivos de perda que a SDR ou a IA escolhem quando o caso ESTÁ ENCERRADO — insistir é spam. Os cinco do João (06/11/2026)
 * mais os de risco que o resto da casa já trata como intocáveis. "Sem condições financeiras" NÃO está aqui: a perda-ia a trata
 * como trabalhável (decisão de 02/10).
 *
 * Mora aqui (e não em `rotina-nucleo.ts`) para a Sofia do CRM perguntar à MESMA lista, sem puxar a rotina do Kommo inteira.
 */
import { normalizarNome } from './kommo-schema.js';

export const MOTIVOS_MORTOS: readonly string[] = [
  'Outra cidade',
  'Mora em outra cidade',
  'Clicou por engano',
  'Outra patologia',
  'Plano de Saúde',
  'Sem interesse',
  'Bandeira vermelha',
  'Financeiramente vulnerável',
  'Assinou contrato',
  'Caso enviado para a franquia',
  'Informação para terceiro',
].map(normalizarNome);

/** O motivo é «morto» (igualdade, como o Kommo compara)? */
export const ehMotivoMorto = (nome: string): boolean => MOTIVOS_MORTOS.includes(normalizarNome(nome));
