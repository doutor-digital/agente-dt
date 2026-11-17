/**
 * O miolo do retroativo do anúncio no CRM (`scripts/referral-do-crm-retroativo.ts`): para cada conversa da caixa oficial com referral do
 * Chatwoot na janela, faz o MESMO caminho do webhook (guardar → etiqueta → nota só na 1ª vez → origem) e diz, por conversa, o que cada parte
 * fez de fato. Conversa já guardada NÃO é pulada: etiqueta e origem são idempotentes (a etiqueta não regrava, a origem só preenche campo vazio)
 * e rodar de novo conserta o que tinha falhado; a nota não repete (`novo=false`).
 * Separado do script para ser testado com portas de mentira. A saída não tem nome nem telefone.
 */
import { aplicarReferralDoKapso, type ReferralDoKapso } from './kapso-referral.js';
import type { DetalheDoAoAchar } from './chatwoot-ia.js';
import { recarregarAutomacoes } from './automacoes-estado.js';

export interface ReferralAchado {
  wamid: string;
  ref: ReferralDoKapso;
  /** segundos desde 1970 */
  criadaEm: number;
}

export interface PortasDoRetroativo {
  conversas(): Promise<{ lista: Array<{ id: number; contato: number | null }>; truncado: boolean }>;
  referrais(conversa: number): Promise<{ achados: ReferralAchado[]; truncado: boolean }>;
  /** a linha `kapso-referral` desta mensagem já existe? */
  guardado(conversa: number, wamid: string): Promise<boolean>;
  /** a conversa já tem a etiqueta `anuncio`? (null = não deu para ler) */
  temEtiqueta(conversa: number): Promise<boolean | null>;
}

export interface ContagemDoRetroativo {
  conversas: number;
  comReferral: number;
  faltavaGuardar: number;
  jaGuardado: number;
  feito: number;
  falhou: number;
  truncado: number;
}

/**
 * O processo do script é NOVO: o estado das automações ligado pela TELA (tabela `unit_automacoes`) só existe depois de lido — o servidor faz isso
 * no boot (`iniciarAutomacoes`). Sem isto, a 1ª pergunta cai no `.env` e `chatwoot-origem` ligada pela tela aparece `desligado`: a origem não é
 * gravada, a linha é guardada e o «FEITO» mentiria. Chamar ANTES de qualquer outra coisa.
 */
export const prepararEstadoDasAutomacoes = (): Promise<void> => recarregarAutomacoes();

/** Só as opções conhecidas, com valor no formato certo — erro de digitação não pode cair num padrão calado. */
export function lerArgumentos(argv: string[]): { soConferir: boolean; caixa: number; desde: string } {
  let soConferir = false;
  let caixa = 3;
  let desde = '2026-11-13';
  for (const a of argv) {
    if (a === '--so-conferir') soConferir = true;
    else if (/^--caixa=\d+$/.test(a)) caixa = Number(a.slice('--caixa='.length));
    else if (/^--desde=\d{4}-\d{2}-\d{2}$/.test(a) && Number.isFinite(Date.parse(`${a.slice('--desde='.length)}T00:00:00-03:00`))) desde = a.slice('--desde='.length);
    else throw new Error(`opção inválida: ${a} (use --so-conferir, --caixa=N, --desde=AAAA-MM-DD)`);
  }
  if (!Number.isInteger(caixa) || caixa <= 0) throw new Error(`caixa inválida: ${caixa}`);
  return { soConferir, caixa, desde };
}

const dia = (seg: number) => new Date(seg * 1000).toISOString().slice(0, 10);

function resumo(d: DetalheDoAoAchar | null): string {
  if (!d) return 'etiqueta ?, nota ?, origem ? (a etapa falhou antes de responder)';
  return `etiqueta ${d.etiqueta}, nota ${d.nota}, origem ${d.origem}`;
}

export async function rodarRetroativo(
  o: { caixa: number; soConferir: boolean; modoDaOrigem: string },
  p: PortasDoRetroativo,
  aoAchar: (m: { conversa: number; caixa: number; contato: number | null }, ref: ReferralDoKapso, novo: boolean) => Promise<DetalheDoAoAchar>,
  log: (linha: string) => void,
): Promise<ContagemDoRetroativo> {
  const c: ContagemDoRetroativo = { conversas: 0, comReferral: 0, faltavaGuardar: 0, jaGuardado: 0, feito: 0, falhou: 0, truncado: 0 };
  const { lista, truncado } = await p.conversas();
  c.conversas = lista.length;
  if (truncado) {
    c.truncado++;
    log('AVISO  bati no teto de páginas de conversas: pode haver conversas mais antigas da janela que não foram vistas');
  }
  for (const conv of lista) {
    let achados: ReferralAchado[];
    try {
      const r = await p.referrais(conv.id);
      achados = r.achados;
      if (r.truncado) {
        c.truncado++;
        log(`AVISO  conversa ${conv.id}: bati no teto de páginas de mensagens — pode haver referral mais antigo que não foi visto`);
      }
    } catch (err) {
      c.falhou++;
      log(`ERRO   conversa ${conv.id}: não consegui ler as mensagens (${err instanceof Error ? err.message.slice(0, 120) : 'erro'})`);
      continue;
    }
    for (const a of achados) {
      c.comReferral++;
      const quem = `conversa ${conv.id}  ${dia(a.criadaEm)}  anúncio ${a.ref.anuncio ?? '-'}  tipo ${a.ref.tipo ?? '-'}  ctwa_clid ${a.ref.ctwaClid ? 'sim' : 'não'}`;
      const guardado = await p.guardado(conv.id, a.wamid);
      if (guardado) c.jaGuardado++;
      else c.faltavaGuardar++;
      if (o.soConferir) {
        const etq = await p.temEtiqueta(conv.id).catch(() => null);
        const etiqueta = a.ref.tipo !== 'ad' ? 'não se aplica (não é anúncio)' : etq === null ? 'não consegui ler' : etq ? 'já tem' : 'falta';
        log(`${guardado ? 'ok    ' : 'FALTA '} ${quem}  ${guardado ? 'já guardado' : 'não guardado'}; etiqueta ${etiqueta}; origem no modo ${o.modoDaOrigem}${guardado ? ' (rodar de novo reaplica etiqueta e origem; sem nota nova)' : ' (guardaria + etiqueta + nota + origem)'}`);
        continue;
      }
      const feitos: DetalheDoAoAchar[] = [];
      const r = await aplicarReferralDoKapso(
        { conversa: conv.id, caixa: o.caixa, wamid: a.wamid, contato: conv.contato, referral: a.ref },
        {
          aoAchar: async (m, ref, novo) => {
            feitos.push(await aoAchar(m, ref, novo));
          },
        },
      );
      const detalhe = feitos[0] ?? null;
      // «guardado» aqui vale também para linha que já existia (a nota não repete); o que foi feito de fato vem do detalhe
      const ok = r === 'guardado' && !!detalhe && (a.ref.tipo !== 'ad' || detalhe.etiqueta !== 'falhou');
      if (ok) c.feito++;
      else c.falhou++;
      log(`${ok ? 'FEITO ' : 'FALHOU'} ${quem}  ${guardado ? '(já estava guardado)' : '(guardado agora)'}; ${resumo(detalhe)}`);
    }
  }
  return c;
}
