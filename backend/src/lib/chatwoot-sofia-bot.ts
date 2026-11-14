/**
 * Sofia como ROBÔ do Chatwoot (Agent Bot «Sofia», id 1 na conta 1, criado 14/11/2026 com a foto de robô) — PREPARADO, NÃO LIGADO.
 *
 * Com `CHATWOOT_SOFIA_COMO_BOT=1` e `CHATWOOT_SOFIA_BOT_TOKEN` (o token de acesso do robô, gerado no Chatwoot — nunca no código):
 *  - as respostas PÚBLICAS da Sofia saem pelo robô (no Chatwoot aparecem como «Sofia (robô)», não como um usuário);
 *  - a passagem para a equipe, além da etiqueta/etapa/nota de sempre, devolve a conversa para «Abertas»
 *    (`POST conversations/:id/toggle_status {status:'open'}`), que é a passagem nativa robô → humano do Chatwoot.
 * Sem as duas variáveis: nada muda (a Sofia segue respondendo pelo usuário «Sofia»).
 *
 * RISCO (explicado ao João em 14/11): com o robô ligado à caixa, conversa nova nasce em «Pendentes» e só vai para «Abertas»
 * quando o robô passa — quem olha só «Minhas/Abertas» não a vê antes disso. Proposta: ligar o robô à caixa só fora do horário.
 * Ligar o robô à caixa é feito no Chatwoot (Caixa → Robô), não aqui.
 */
import { chamar, criarContextoChatwoot, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';

export interface PortaDoRobo {
  /** mensagem PÚBLICA pelo robô; o «usuário» volta null (o remetente é o robô, não um usuário do Chatwoot) */
  publica(conversa: number, texto: string): Promise<{ usuario: number | null; mensagem?: number | null }>;
  /** robô → equipe: a conversa sai de «Pendentes» e vai para «Abertas» */
  abrirParaEquipe(conversa: number): Promise<void>;
}

/** O token do robô, se o modo robô estiver ligado; senão null. Lido a cada chamada (mudou o ambiente, vale no próximo reinício). */
export function tokenDoRobo(env: NodeJS.ProcessEnv = process.env): string | null {
  if (String(env.CHATWOOT_SOFIA_COMO_BOT ?? '').trim() !== '1') return null;
  const t = String(env.CHATWOOT_SOFIA_BOT_TOKEN ?? '').trim();
  return /^[A-Za-z0-9_-]{10,200}$/.test(t) ? t : null;
}

export function portaDoRobo(base: ContextoChatwoot, token: string, o: { fetch?: typeof fetch } = {}): PortaDoRobo | null {
  if (!base.conta) return null;
  const ctx = criarContextoChatwoot({ ...base.conta, token }, { fetch: o.fetch });
  return {
    async publica(conversa, texto) {
      const r = (await chamar(ctx, 'POST', `conversations/${conversa}/messages`, { corpo: { content: texto, message_type: 'outgoing', private: false } })) as {
        id?: unknown;
      } | null;
      const mensagem = Number(r?.id);
      // o remetente é o ROBÔ: o id dele não é de usuário — não pode entrar em «usuários da integração» (o 1 do robô colide com o
      // usuário 1, a Suzanne)
      return { usuario: null, mensagem: Number.isInteger(mensagem) && mensagem > 0 ? mensagem : null };
    },
    async abrirParaEquipe(conversa) {
      await chamar(ctx, 'POST', `conversations/${conversa}/toggle_status`, { corpo: { status: 'open' } });
    },
  };
}
