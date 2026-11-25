/**
 * Unidade que SAIU da Kommo: o número de WhatsApp foi para a Kapso e quem atende é o CRM (Chatwoot). Pedido do João em 25/11/2026,
 * no corte de Timbó.
 *
 * A Sofia do CRM e a régua não falam com paciente que tem cartão ATIVO no Kommo da unidade (decisão 31: «duas Sofias falando com a
 * mesma pessoa é o pior dos mundos»). Depois do corte, a Kommo não recebe nem manda mais nada, mas os cartões continuam abertos lá.
 * Sem esta chave, a Sofia do CRM ficaria calada com quase todo paciente atual da unidade.
 *
 * A credencial da Kommo continua na unidade (o importador do histórico e os relatórios ainda leem de lá): por isso a trava é uma
 * chave própria, e não «unidade sem token».
 *
 * Env: `CHATWOOT_KOMMO_CORTADO_SLUGS` — slugs separados por vírgula (ex.: `doutor-hernia-timbo`), sem diferença de maiúscula. Vazio =
 * nenhuma unidade cortada.
 *
 * A trava do cartão também segurava o paciente EM TRATAMENTO (cartão ativo no funil TRATAMENTO). Na unidade cortada quem responde isso
 * é a FRANQUIA (`consultarFranquia`, a mesma pergunta do incidente de 14/11): tratamento ativo ou sessão futura = a Sofia não responde.
 */
import type { SinalDaFranquia } from './paciente-em-tratamento.js';
export function kommoCortado(slug: string | null | undefined, lista: string | undefined = process.env.CHATWOOT_KOMMO_CORTADO_SLUGS): boolean {
  const alvo = (slug ?? '').trim().toLowerCase();
  if (!alvo || !lista) return false;
  return lista
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(alvo);
}

/**
 * A Sofia do CRM e a régua devem conferir «cartão ATIVO no Kommo» desta unidade? Só se ela tem Kommo configurado E não foi cortada.
 * Usada nos dois lugares (chatwoot-ia.ts e chatwoot-regua-worker.ts) para a regra não divergir.
 */
export function confereCartaoNoKommo(
  unit: { slug: string; kommoSubdomain?: string | null; kommoAccessToken?: string | null },
  lista: string | undefined = process.env.CHATWOOT_KOMMO_CORTADO_SLUGS,
): boolean {
  return !!unit.kommoSubdomain && !!unit.kommoAccessToken && !kommoCortado(unit.slug, lista);
}

/**
 * `indisponivel` em que a franquia NÃO achou o telefone (ou nem dava para perguntar): a Sofia segue, com log. Os motivos vêm de
 * `consultarFranquia` (paciente-em-tratamento.ts): unidade sem franquia, telefone ilegível, índice ainda não carregado ou vencido
 * (só chega aqui quando o telefone NÃO estava no índice como paciente).
 */
const SEGUE_SEM_FRANQUIA = /^(unidade sem franquia conectada|telefone ilegível|índice de telefones)/;

/**
 * Puro: o sinal da franquia cala a Sofia na unidade cortada? Devolve o motivo (vai para a nota e o Registro) ou null (a Sofia segue).
 *  - paciente com tratamento ativo ou sessão futura → cala (a mesma regra do `decidir` de paciente-em-tratamento.ts);
 *  - lead, não achado, paciente sem tratamento e sem sessão → segue;
 *  - franquia NÃO CONFERIU (ficha que não veio, estouro do tempo, erro): CALA. Na unidade cortada a franquia é a única barreira contra
 *    responder paciente em tratamento — melhor calar que errar, como fazia a trava do Kommo («kommo-indisponivel»);
 *  - índice vencido/não carregado com o telefone NÃO achado, telefone ilegível, unidade sem franquia: segue (quem chama loga).
 */
export function tratamentoNaFranquia(s: SinalDaFranquia): string | null {
  if (s.tipo === 'indisponivel') {
    if (SEGUE_SEM_FRANQUIA.test(s.motivo)) return null;
    return `não consegui conferir na franquia se é paciente em tratamento (${s.motivo.slice(0, 120)})`;
  }
  if (s.tipo !== 'paciente' || (!s.tratamentoAtivo && !s.sessaoFutura)) return null;
  const por = [s.tratamentoAtivo ? 'tratamento ativo' : '', s.sessaoFutura ? 'sessão futura' : ''].filter(Boolean).join(' + ');
  return `paciente da franquia (idClient ${s.idClient}) com ${por}`;
}
