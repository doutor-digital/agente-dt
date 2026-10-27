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
/**
 * Tentativas por dia quando a consulta ou o envio falham. O worker passa a cada 5 min, então 12 tentativas
 * cobrem ~1 h de banco ou Telegram instável sem martelar; a janela inteira (07:30–12:00) ainda é o teto.
 */
export const TENTATIVAS_POR_DIA = 12;
/**
 * O lease nasce CURTO (a mensagem está sendo montada/enviada) e, depois que o Telegram aceita, é renovado para 36 h
 * (a chave já carrega a data; a próxima manhã é outro lease). Assim, processo que morre no meio do envio não tranca o
 * dia: em 10 min o lease vence e o próximo líder envia. E quem já enviou continua barrando um segundo envio.
 */
export const TTL_DO_LEASE_MS = 36 * 60 * 60_000;
export const TTL_DO_LEASE_EM_ENVIO_MS = 10 * 60_000;
export const PREFIXO_DO_LEASE = 'resumo-diario-ia:';

function normalizar(raw: string | undefined): string {
  return (raw ?? '').trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}

/** Vazio = seco: o texto aparece no log sem mandar nada, e ligar é uma troca de uma palavra. */
export function modoDoResumo(raw: string | undefined): ModoResumo {
  const v = normalizar(raw);
  if (v === 'ligado') return 'ligado';
  if (v === 'desligado' || v === 'off' || v === '0') return 'desligado';
  return 'seco';
}

/** A variável tem um valor que o worker entende? (Valor estranho cai em seco; o worker avisa em vez de calar.) */
export function valorReconhecido(raw: string | undefined): boolean {
  return ['', 'seco', 'ligado', 'desligado', 'off', '0'].includes(normalizar(raw));
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
  /** Não deu para pegar o lease (banco): tenta no próximo passo, sem gastar uma das tentativas. */
  | 'sem-lease'
  /** Falhou, mas ainda há tentativa: o worker tenta de novo no próximo passo. */
  | 'tentar-de-novo'
  | 'desistiu';

type Tipo = 'diario' | 'semanal';

/** Começo do bloco da pior conversa no texto (`texto.ts`): daqui até o fim é dado de paciente. */
export const INICIO_DA_PIOR_CONVERSA = 'Pior conversa avaliável:';

/**
 * O log não guarda NENHUM dado de paciente: nem fala, nem 1º nome, nem final de telefone, nem número do cartão.
 * O bloco da pior conversa (que é o último do texto) sai inteiro; o resto são só números e nomes de unidade.
 */
export function paraLog(texto: string): string {
  const i = texto.indexOf(INICIO_DA_PIOR_CONVERSA);
  return i < 0 ? texto : `${texto.slice(0, i)}[pior conversa omitida no log: tem dado de paciente]`;
}

/**
 * Resolve o resumo de `hoje` (o texto fala de ontem). Nunca lança. `tentativa` começa em 1.
 *
 * Cada mensagem (diário, semanal) tem o SEU lease do dia, só no modo ligado: o seco só escreve no log, e
 * um lease gravado em seco trancaria o primeiro dia depois de ligar (o processo novo teria outro dono).
 * O lease de uma mensagem que falhou é solto, para a próxima tentativa — aqui ou em outro processo.
 * `jaEnviados` guarda o que já saiu neste processo (o lease sozinho não protege: o mesmo dono o reivindica de novo).
 */
export async function resolverODia(
  hoje: Dia,
  modo: ModoResumo,
  dep: Dependencias,
  tentativa = 1,
  jaEnviados: Set<Tipo> = new Set(),
): Promise<DesfechoDoDia> {
  if (modo === 'desligado') return 'desligado';
  if (modo === 'ligado' && !dep.telegramConfigurado()) {
    dep.registrar('error', { hoje }, 'resumo-diario-ia: ligado, mas TELEGRAM_BOT_TOKEN não está configurado — nada enviado');
    return 'sem-telegram';
  }

  // Sábado: além do diário, o semanal (o cron antigo de sábado 14h mandava pelo WhatsApp banido).
  const todos: Tipo[] = diaDaSemana(hoje) === 6 ? ['diario', 'semanal'] : ['diario'];
  const tipos = todos.filter((t) => !jaEnviados.has(t));
  let falhou = false;
  let semLease = false;
  let deOutro = 0;

  for (const tipo of tipos) {
    const lease = `${PREFIXO_DO_LEASE}${hoje}:${tipo}`;
    if (modo === 'ligado') {
      const r = await dep.reivindicar(lease, TTL_DO_LEASE_EM_ENVIO_MS);
      if (r === 'de-outro') {
        dep.registrar('warn', { hoje, tipo }, 'resumo-diario-ia: o lease do dia é de outro processo — não envio por aqui (se nada chegar no Telegram, o dono do lease morreu antes de enviar)');
        jaEnviados.add(tipo);
        deOutro += 1;
        continue;
      }
      if (r === 'erro') {
        semLease = true;
        dep.registrar('warn', { hoje, tipo }, 'resumo-diario-ia: sem lease (banco?) — não envio sem ele, tento no próximo passo');
        continue;
      }
    }

    let texto: string;
    try {
      texto = tipo === 'diario' ? montarDiario(await dep.coletarDiario(hoje)) : montarSemanal(await dep.coletarSemanal(hoje));
    } catch (err) {
      dep.registrar('error', { hoje, tipo, tentativa, err: String(err) }, 'resumo-diario-ia: falhou ao montar o resumo');
      falhou = true;
      if (modo === 'ligado') await dep.liberar(lease);
      continue;
    }

    if (modo === 'seco') {
      // O "só no papel" desta automação: prova o conteúdo no log sem mandar nada.
      dep.registrar('info', { hoje, tipo, texto: paraLog(texto) }, `resumo-diario-ia [seco]: mandaria no Telegram (${tipo})`);
      jaEnviados.add(tipo);
    } else if (await dep.enviar(texto)) {
      jaEnviados.add(tipo);
      await dep.reivindicar(lease, TTL_DO_LEASE_MS); // enviado: o lease passa a durar o dia todo
      dep.registrar('info', { hoje, tipo, caracteres: texto.length }, 'resumo-diario-ia: enviado no Telegram');
    } else {
      falhou = true;
      await dep.liberar(lease);
    }
  }

  if (falhou) {
    if (tentativa >= TENTATIVAS_POR_DIA) {
      dep.registrar('error', { hoje }, 'resumo-diario-ia: desisti por hoje depois das tentativas');
      // Silêncio parece dia calmo: avisa que o resumo NÃO saiu (se o Telegram estiver de pé; sem dado nenhum).
      if (modo === 'ligado') {
        await dep.enviar('Resumo diário da Sofia: não consegui montar o de hoje (erro nas consultas). Veja o log "resumo-diario-ia" no servidor.');
      }
      return 'desistiu';
    }
    return 'tentar-de-novo';
  }
  if (semLease) return 'sem-lease';
  if (tipos.length > 0 && deOutro === tipos.length) return 'de-outro-processo';
  return modo === 'seco' ? 'seco' : 'enviado';
}

/** O dia que o texto cobre (ontem), exposto para o teste e para o log. */
export const diaResumido = (hoje: Dia): Dia => somarDias(hoje, -1);
