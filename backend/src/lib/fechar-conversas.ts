/**
 * A faxina do inbox: fecha as conversas já lidas, uma vez por dia.
 *
 * Medido em 25/09/2026, nas 19 contas: 3.285 conversas abertas, 2.579 delas sem nenhum
 * movimento há mais de 24 horas. O inbox vira um depósito e a equipe para de olhar —
 * quando tudo está em destaque, nada está.
 *
 * A REGRA, e por que ela é essa: fecha só o que está **lido**. As 372 não lidas ficam
 * onde estão. Fechar uma conversa não lida é esconder paciente que escreveu e não foi
 * respondido; o inbox ficaria bonito e o atendimento pior. Limpeza que apaga trabalho
 * pendente não é limpeza, é varrer pra debaixo do tapete.
 *
 * Fechar aqui é o mesmo "concluir" do botão da tela: tira da lista de abertas e não
 * mexe no cartão, na etapa nem na conversa. Quando o paciente escreve de novo, o Kommo
 * reabre a conversa.
 */
import type { Unit } from '@prisma/client';
import { createKommoClient, type KommoTalk } from '../services/kommo.service.js';
import { logger } from './logger.js';

export interface ResultadoFaxina {
  unidade: string;
  simulado: boolean;
  abertas: number;
  lidas: number;
  naoLidas: number;
  fechadas: number;
  falhas: number;
  /** Uma amostra do que foi (ou seria) fechado, pra conferência humana. */
  amostra: Array<{ talkId: number; leadId: number | null; paradaHa: string }>;
  erro?: string;
}

const HORA_MS = 3_600_000;

function paradaHa(updatedAt: number | undefined, agora: number): string {
  if (!updatedAt) return '?';
  const h = Math.floor((agora - updatedAt * 1000) / HORA_MS);
  if (h < 1) return 'menos de 1h';
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)} dias`;
}

export interface OpcoesFaxina {
  /** Não fecha nada: só conta e devolve a amostra. É o padrão, de propósito. */
  simular?: boolean;
  /** Só fecha conversa parada há pelo menos tantas horas. 0 = qualquer uma lida. */
  minimoHoras?: number;
  /** Teto de fechamentos por rodada, pra uma chamada errada não varrer a conta inteira. */
  maximo?: number;
}

export async function fecharConversasLidas(
  unit: Unit,
  opts: OpcoesFaxina = {},
): Promise<ResultadoFaxina> {
  const simular = opts.simular !== false; // sem dizer nada, simula
  const minimoHoras = Math.max(0, opts.minimoHoras ?? 0);
  const maximo = Math.max(1, Math.min(opts.maximo ?? 500, 2000));
  const base: ResultadoFaxina = {
    unidade: unit.slug,
    simulado: simular,
    abertas: 0,
    lidas: 0,
    naoLidas: 0,
    fechadas: 0,
    falhas: 0,
    amostra: [],
  };
  if (!unit.kommoAccessToken) return { ...base, erro: 'unidade sem credencial do Kommo' };

  const kommo = createKommoClient(unit);
  const agora = Date.now();

  let abertas: KommoTalk[];
  try {
    abertas = await kommo.listarConversasAbertas();
  } catch (err) {
    return { ...base, erro: `não consegui listar as conversas: ${String(err).slice(0, 160)}` };
  }

  const alvos: KommoTalk[] = [];
  for (const t of abertas) {
    base.abertas++;
    if (!t.is_read) {
      base.naoLidas++;
      continue;
    }
    base.lidas++;
    if (minimoHoras && agora - (t.updated_at ?? 0) * 1000 < minimoHoras * HORA_MS) continue;
    alvos.push(t);
  }

  base.amostra = alvos.slice(0, 10).map((t) => ({
    talkId: t.talk_id,
    leadId: t.entity_type === 'lead' ? (t.entity_id ?? null) : null,
    paradaHa: paradaHa(t.updated_at, agora),
  }));

  if (simular) return base;

  for (const t of alvos.slice(0, maximo)) {
    const ok = await kommo.fecharConversa(t.talk_id);
    if (ok) base.fechadas++;
    else base.falhas++;
  }

  logger.info(
    { unit: unit.slug, abertas: base.abertas, fechadas: base.fechadas, falhas: base.falhas },
    'faxina do inbox concluída',
  );
  return base;
}
