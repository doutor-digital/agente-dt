/**
 * «Sofia atendendo» no CRM (Chatwoot) — pedido do João, 19/11/2026.
 *
 * Problema: com a Sofia ligada à caixa como ROBÔ (chatwoot-sofia-bot.ts), toda conversa nova nasce em «Pendentes» e some da lista de quem
 * atende; a equipe só a via quando a Sofia passava (ou nunca: a pausa quando a equipe responde pelo celular também não mexia no status —
 * conversa 972, 19/11 11h20, pendente e sem responsável, a menina não achava).
 *
 * Agora, na caixa em que a Sofia atende como robô:
 *  1. a conversa que a Sofia vai atender passa para «Abertas» logo na PRIMEIRA mensagem do paciente (não espera os 60 s da Sofia);
 *  2. enquanto ela conversa, a conversa leva a etiqueta roxa `sofia-atendendo` («A Sofia (IA) está atendendo esta conversa»);
 *  3. a etiqueta SAI sozinha quando a equipe responde (CRM ou celular: é a pausa), quando a Sofia passa para a equipe, quando a rodada
 *     termina sem a Sofia poder responder, e quando a conversa é resolvida; e VOLTA na próxima mensagem do paciente se a Sofia voltar a atender.
 *
 * A atribuição pelo rodízio da caixa (a conversa aberta é distribuída a quem está online) NÃO é lida como «a equipe assumiu»: nada daqui nem
 * da pausa olha o responsável; quem pausa a Sofia é MENSAGEM de gente (chatwoot-pausa.ts), não ter dono.
 *
 * Chave: `CHATWOOT_SOFIA_ATENDENDO=0` desliga tudo isto (a Sofia segue como estava). Só vale onde há robô (token do robô configurado) e só na
 * unidade com a automação `chatwoot-ia` LIGADA (no seco a Sofia não responde: dizer que está atendendo seria mentira).
 */
import { logger } from './logger.js';
import { chamar, type ContextoChatwoot } from '../mcp-remoto/chatwoot.js';
import { conversaLidaDoChatwoot, type ConversaLida } from './chatwoot-porta.js';
import { motivoDeNaoResponder } from './chatwoot-sofia.js';
import { CAIXAS_REGUA } from './chatwoot-regua.js';

export const ETIQUETA_SOFIA_ATENDENDO = 'sofia-atendendo';
export const DESCRICAO_SOFIA_ATENDENDO = 'A Sofia (IA) está atendendo esta conversa';
export const COR_SOFIA_ATENDENDO = '#7C3AED';

/** Ligado por padrão; `CHATWOOT_SOFIA_ATENDENDO=0` desliga. Lido na hora de montar as portas (mudou o ambiente, vale no próximo reinício). */
export const atendimentoLigado = (env: NodeJS.ProcessEnv = process.env): boolean => String(env.CHATWOOT_SOFIA_ATENDENDO ?? '').trim() !== '0';

export interface ConversaDoAtendimento {
  /** open | pending | resolved | snoozed (o que o Chatwoot disser) */
  status: string;
  lida: ConversaLida;
}

export interface PortaDoAtendimento {
  conversa(id: number): Promise<ConversaDoAtendimento | null>;
  /** o Chatwoot SUBSTITUI a lista: mandar a lista inteira */
  etiquetas(id: number, lista: string[]): Promise<void>;
  /** «Pendentes» → «Abertas» */
  abrir(id: number): Promise<void>;
  /** cria a etiqueta na conta (roxa, descrição, na barra) se ainda não existir; nunca lança */
  garantirEtiqueta(): Promise<void>;
}

/** A Sofia ainda pode estar conversando aqui? Conversa viva (aberta/pendente) e nada que a cale (pausa, humano, interno, tratamento, grupo). */
export function sofiaPodeAtender(c: ConversaDoAtendimento): boolean {
  if (c.status !== 'open' && c.status !== 'pending') return false;
  return motivoDeNaoResponder(c.lida) === null;
}

const tem = (c: ConversaDoAtendimento) => c.lida.etiquetas.includes(ETIQUETA_SOFIA_ATENDENDO);

export type Comeco = 'sem-conversa' | 'etiquetada' | 'ja-etiquetada' | 'sem-etiqueta';

/**
 * Primeira mensagem (ou a seguinte, se a Sofia voltou): abre a conversa que está em «Pendentes» e, se a Sofia pode atender, põe a etiqueta.
 * Falhar ao abrir não impede a etiqueta: cada passo avisa no log. A lista de etiquetas é relida logo ANTES de regravar (o Chatwoot a substitui
 * inteira; abrir e criar a etiqueta na conta demoram, e a equipe pode ter respondido — pausa — nesse meio-tempo). Devolve o que ficou.
 */
export async function comecarAtendimento(conversa: number, p: PortaDoAtendimento): Promise<{ comeco: Comeco; abriu: boolean }> {
  let c = await p.conversa(conversa);
  if (!c) return { comeco: 'sem-conversa', abriu: false };
  let abriu = false;
  if (c.status === 'pending') {
    try {
      await p.abrir(conversa);
      abriu = true;
    } catch (err) {
      logger.warn({ err: String(err), conversa }, 'chatwoot-sofia-atendendo: não consegui abrir a conversa');
    }
  }
  if (!sofiaPodeAtender(c)) return { comeco: 'sem-etiqueta', abriu };
  if (tem(c)) return { comeco: 'ja-etiquetada', abriu };
  await p.garantirEtiqueta();
  c = (await p.conversa(conversa)) ?? c;
  if (!sofiaPodeAtender(c)) return { comeco: 'sem-etiqueta', abriu };
  if (tem(c)) return { comeco: 'ja-etiquetada', abriu };
  await p.etiquetas(conversa, [...c.lida.etiquetas, ETIQUETA_SOFIA_ATENDENDO]);
  return { comeco: 'etiquetada', abriu };
}

/** Relê a conversa e, se ela tem a etiqueta e `tirarSe` diz que deve sair, regrava a lista sem ela. `true` = tirou. */
async function tirarEtiqueta(conversa: number, p: PortaDoAtendimento, tirarSe: (c: ConversaDoAtendimento) => boolean): Promise<boolean> {
  const c = await p.conversa(conversa);
  if (!c || !tem(c) || !tirarSe(c)) return false;
  await p.etiquetas(conversa, c.lida.etiquetas.filter((e) => e !== ETIQUETA_SOFIA_ATENDENDO));
  return true;
}

/** Tira a etiqueta (a equipe respondeu, a Sofia passou, a rodada não respondeu). `true` = tirou. */
export const encerrarAtendimento = (conversa: number, p: PortaDoAtendimento): Promise<boolean> => tirarEtiqueta(conversa, p, () => true);

/** Tira a etiqueta SÓ se a conversa mostra que a Sofia não está mais atendendo (resolvida, pausada, passada à equipe…). `true` = tirou. */
export const conferirAtendimento = (conversa: number, p: PortaDoAtendimento): Promise<boolean> => tirarEtiqueta(conversa, p, (c) => !sofiaPodeAtender(c));

/**
 * `conversation_updated` de conversa de caixa do mapa que TEM a etiqueta e já mostra que a Sofia saiu (resolvida, pausada, esperando humano,
 * interno) → conferir; senão null. A leitura fresca decide (o aviso pode estar velho); sem a etiqueta no aviso nada é lido.
 */
export function eventoDeAtendimento(corpo: any, caixas: Readonly<Record<number, string>> = CAIXAS_REGUA): { conversa: number } | null {
  if (corpo?.event !== 'conversation_updated' && corpo?.event !== 'conversation_status_changed') return null;
  const conversa = Number(corpo?.id);
  const caixa = Number(corpo?.inbox_id);
  if (!Number.isInteger(conversa) || conversa <= 0 || !caixas[caixa]) return null;
  const etiquetas: string[] = Array.isArray(corpo?.labels) ? corpo.labels.map(String) : [];
  if (!etiquetas.includes(ETIQUETA_SOFIA_ATENDENDO)) return null;
  // o Chatwoot manda `conversation_updated` a cada mensagem: só vale a pena ler a conversa quando o AVISO já mostra que a Sofia saiu
  const lida = conversaLidaDoChatwoot(corpo);
  const status = String(corpo?.status ?? '');
  if (!lida || !status || sofiaPodeAtender({ status, lida })) return null;
  return { conversa };
}

/** O Chatwoot, com o token da conta; `abrir` pelo robô (a passagem nativa robô → equipe) quando ele existe. */
export function portaDoAtendimento(ctx: ContextoChatwoot, abrir: (conversa: number) => Promise<void>): PortaDoAtendimento {
  let etiquetaGarantida = false;
  return {
    async conversa(id) {
      const raw = (await chamar(ctx, 'GET', `conversations/${id}`)) as { status?: unknown } | null;
      const lida = conversaLidaDoChatwoot(raw);
      return lida ? { status: String(raw?.status ?? ''), lida } : null;
    },
    async etiquetas(id, lista) {
      await chamar(ctx, 'POST', `conversations/${id}/labels`, { corpo: { labels: lista } });
    },
    abrir,
    async garantirEtiqueta() {
      if (etiquetaGarantida) return;
      try {
        const r = (await chamar(ctx, 'GET', 'labels')) as { payload?: unknown } | null;
        const existentes = (Array.isArray(r?.payload) ? r.payload : []).map((l: any) => String(l?.title ?? ''));
        if (!existentes.includes(ETIQUETA_SOFIA_ATENDENDO)) {
          await chamar(ctx, 'POST', 'labels', { corpo: { title: ETIQUETA_SOFIA_ATENDENDO, description: DESCRICAO_SOFIA_ATENDENDO, color: COR_SOFIA_ATENDENDO, show_on_sidebar: true } });
          logger.info(`chatwoot-sofia-atendendo: etiqueta ${ETIQUETA_SOFIA_ATENDENDO} criada na conta`);
        }
        etiquetaGarantida = true;
      } catch (err) {
        // sem a etiqueta cadastrada o Chatwoot ainda aceita o título na conversa (só sem cor/descrição): não trava o atendimento
        logger.warn({ err: String(err) }, 'chatwoot-sofia-atendendo: não consegui garantir a etiqueta na conta');
      }
    },
  };
}
