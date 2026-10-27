/**
 * A decisão do resumo diário da qualidade da Sofia, sem banco e sem Telegram dentro: tudo que toca o mundo
 * entra por `Dependencias`. O worker (`resumo-diario-ia-worker.ts`) liga as dependências de verdade; o teste
 * liga as de mentira.
 *
 * Estados (variável `RESUMO_DIARIO_IA`, global — a rede toda, não por unidade):
 *   ligado     manda o texto no Telegram do João
 *   seco       monta o texto e só o registra no log (padrão quando a variável está vazia)
 *   desligado  não consulta nada
 */
import { diaDaSemana, relogioLocal, diaLocal, somarDias } from './dias.js';
import { montarDiario, montarSemanal } from './texto.js';
import type { DadosDiarios, DadosSemanais, Dia } from './tipos.js';

export type ModoResumo = 'ligado' | 'seco' | 'desligado';

/** Hora local (SP) a partir da qual o resumo sai, e a hora em que desiste (resumo velho de manhã não serve à tarde). */
export const HORA_DO_RESUMO = { hora: 7, minuto: 30 } as const;
export const HORA_LIMITE = 12;
/** Tentativas por dia quando a consulta ou o envio falham. */
export const TENTATIVAS_POR_DIA = 3;
/** Vence depois do dia seguinte; a chave já carrega a data, então a próxima manhã é outro lease. */
export const TTL_DO_LEASE_MS = 36 * 60 * 60_000;
export const PREFIXO_DO_LEASE = 'resumo-diario-ia:';

/** Vazio = seco: o texto aparece no log sem mandar nada, e ligar é uma troca de uma palavra. */
export function modoDoResumo(raw: string | undefined): ModoResumo {
  const v = (raw ?? '').trim().replace(/^['"]|['"]$/g, '').toLowerCase();
  if (v === 'ligado') return 'ligado';
  if (v === 'desligado' || v === 'off' || v === '0') return 'desligado';
  return 'seco';
}

/** Já é hora (07:30–12:00 em São Paulo) e o dia ainda não foi resolvido? */
export function estaNaHora(agora: Date, ultimoDia: Dia | null): { rodar: boolean; hoje: Dia } {
  const hoje = diaLocal(agora);
  const { hora, minuto } = relogioLocal(agora);
  const passou = hora > HORA_DO_RESUMO.hora || (hora === HORA_DO_RESUMO.hora && minuto >= HORA_DO_RESUMO.minuto);
  return { rodar: passou && hora < HORA_LIMITE && ultimoDia !== hoje, hoje };
}

export type ResultadoDoLease = 'minha' | 'de-outro' | 'erro';

export interface Dependencias {
  coletarDiario: (hoje: Dia) => Promise<DadosDiarios>;
  coletarSemanal: (hoje: Dia) => Promise<DadosSemanais>;
  /** true = o Telegram aceitou. */
  enviar: (texto: string) => Promise<boolean>;
  telegramConfigurado: () => boolean;
  reivindicar: (nome: string, ttlMs: number) => Promise<ResultadoDoLease>;
  liberar: (nome: string) => Promise<void>;
  registrar: (nivel: 'info' | 'warn' | 'error', dados: Record<string, unknown>, mensagem: string) => void;
}

export type DesfechoDoDia =
  | 'enviado'
  | 'seco'
  | 'desligado'
  | 'de-outro-processo'
  | 'sem-telegram'
  /** Falhou, mas ainda há tentativa: o worker tenta de novo no próximo passo. */
  | 'tentar-de-novo'
  | 'desistiu';

/**
 * Resolve o resumo de `hoje` (o texto fala de ontem). Nunca lança. `tentativa` começa em 1.
 * `jaEnviados` guarda o que já saiu hoje (diário, semanal), para uma nova tentativa não repetir mensagem.
 */
export async function resolverODia(
  hoje: Dia,
  modo: ModoResumo,
  dep: Dependencias,
  tentativa = 1,
  jaEnviados: Set<'diario' | 'semanal'> = new Set(),
): Promise<DesfechoDoDia> {
  if (modo === 'desligado') return 'desligado';
  const lease = `${PREFIXO_DO_LEASE}${hoje}`;

  // Reivindica a cada tentativa: depois de uma falha o lease foi solto, e o mesmo dono o pega de volta.
  const r = await dep.reivindicar(lease, TTL_DO_LEASE_MS);
  if (r === 'de-outro') return 'de-outro-processo';
  if (r === 'erro') {
    dep.registrar('warn', { hoje }, 'resumo-diario-ia: sem lease (banco?) — não rodo sem ele, tento no próximo passo');
    return 'tentar-de-novo';
  }

  if (modo === 'ligado' && !dep.telegramConfigurado()) {
    dep.registrar('error', { hoje }, 'resumo-diario-ia: ligado, mas TELEGRAM_BOT_TOKEN não está configurado — nada enviado');
    return 'sem-telegram';
  }

  try {
    const mensagens: Array<{ tipo: 'diario' | 'semanal'; texto: string }> = [];
    if (!jaEnviados.has('diario')) mensagens.push({ tipo: 'diario', texto: montarDiario(await dep.coletarDiario(hoje)) });
    // Sábado: além do diário, o semanal (o cron antigo de sábado 14h mandava pelo WhatsApp banido).
    if (diaDaSemana(hoje) === 6 && !jaEnviados.has('semanal')) {
      mensagens.push({ tipo: 'semanal', texto: montarSemanal(await dep.coletarSemanal(hoje)) });
    }

    let falhou = false;
    for (const m of mensagens) {
      if (modo === 'seco') {
        // O texto no log é o que a tela de automações chamaria "só no papel": prova o conteúdo sem mandar nada.
        dep.registrar('info', { hoje, tipo: m.tipo, texto: m.texto }, `resumo-diario-ia [seco]: mandaria no Telegram (${m.tipo})`);
        jaEnviados.add(m.tipo);
        continue;
      }
      if (await dep.enviar(m.texto)) {
        jaEnviados.add(m.tipo);
        dep.registrar('info', { hoje, tipo: m.tipo, caracteres: m.texto.length }, 'resumo-diario-ia: enviado no Telegram');
      } else {
        falhou = true;
      }
    }
    if (!falhou) return modo === 'seco' ? 'seco' : 'enviado';
  } catch (err) {
    dep.registrar('error', { hoje, tentativa, err: String(err) }, 'resumo-diario-ia: falhou ao montar o resumo');
  }

  if (tentativa >= TENTATIVAS_POR_DIA) {
    dep.registrar('error', { hoje }, 'resumo-diario-ia: desisti por hoje depois das tentativas');
    return 'desistiu';
  }
  // Nada saiu: solta o lease para o próximo passo (neste ou em outro processo) poder tentar de novo.
  if (jaEnviados.size === 0) await dep.liberar(lease);
  return 'tentar-de-novo';
}

/** O dia que o texto cobre (ontem), exposto para o teste e para o log. */
export const diaResumido = (hoje: Dia): Dia => somarDias(hoje, -1);
