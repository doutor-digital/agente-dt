/**
 * A conversa OFICIAL de um cartão (Sofia + equipe + paciente), como a SDR vê no Kommo, em falas com autor e hora.
 *
 * É a leitura de conversa DO botão "Sugerir motivo" do widget, tirada do controller para servir também às
 * automações que classificam a conversa (`perda-ia`, `motivo-perdido-ia`): a leitura tem de ser uma só, senão o
 * botão e o robô passam a "ver" conversas diferentes. Áudio do paciente é transcrito à parte (`transcreverAudios`)
 * — quem tem portões baratos antes (a perda-ia) só gasta transcrição com o cartão que passou por eles.
 */
import type { Unit } from '@prisma/client';
import type { KommoClient } from '../services/kommo.service.js';
import { transcribeAudio } from '../services/transcription.service.js';
import { autorDaMensagem, type FalaDaConversa } from './sugestao-motivo.js';

const MAX_CHARS_POR_FALA = 600;
export const MAX_TALKS_PADRAO = 5;
export const MAX_AUDIOS_PADRAO = 6;

type KommoDeConversa = Pick<KommoClient, 'listTalks' | 'listTalkMessages'>;

/** As falas em ordem de hora e o id da última mensagem (chave de cache: conversa que não mudou não precisa ser relida pela IA). */
export async function lerFalasDoCartao(
  kommo: KommoDeConversa,
  leadId: number,
  opcoes: { maxTalks?: number } = {},
): Promise<{ falas: FalaDaConversa[]; ultimaId: string }> {
  // as conversas mais recentes primeiro: a ordem da API não é garantida e o teto não pode cortar justamente o fim
  const talks = [...(await kommo.listTalks(leadId))]
    .sort((a, b) => (b.updated_at ?? b.created_at ?? 0) - (a.updated_at ?? a.created_at ?? 0))
    .slice(0, opcoes.maxTalks ?? MAX_TALKS_PADRAO);
  const msgs = [];
  for (const t of talks) {
    msgs.push(...(await kommo.listTalkMessages(Number((t as { talk_id?: number; id?: number }).talk_id ?? (t as { id?: number }).id), 100)));
  }
  msgs.sort((a, b) => a.created_at - b.created_at);
  const falas: FalaDaConversa[] = [];
  for (const m of msgs) {
    // o corte vem ANTES da marca: um texto longo com áudio não pode perder o «[áudio]» (é ele que a transcrição troca)
    const anexo = m.attachment?.type;
    const marca = anexo === 'voice' ? '[áudio]' : anexo ? `[${anexo === 'picture' ? 'imagem' : anexo === 'file' ? 'arquivo' : String(anexo).slice(0, 20)}]` : '';
    const base = (m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHARS_POR_FALA - (marca ? marca.length + 1 : 0));
    const texto = `${base.trimEnd()} ${marca}`.trim();
    const audioLink = anexo === 'voice' && m.attachment?.link ? m.attachment.link : undefined;
    if (texto) falas.push({ autor: autorDaMensagem(m.author), texto, em: m.created_at, ...(audioLink ? { audioLink } : {}) });
  }
  return { falas, ultimaId: msgs.length ? String(msgs[msgs.length - 1].id) : 'vazia' };
}

/**
 * Transcreve os `maxAudios` áudios MAIS RECENTES do PACIENTE e troca o "[áudio]" do texto por "(áudio) fala". Falha de
 * transcrição deixa o "[áudio]". Os mais antigos ficam como "[áudio]": o fim da conversa é o que decide.
 */
export async function transcreverAudios(
  unit: Unit,
  falas: FalaDaConversa[],
  maxAudios: number = MAX_AUDIOS_PADRAO,
  transcrever: typeof transcribeAudio = transcribeAudio,
): Promise<void> {
  // só o que o PACIENTE disse: a nota de voz da Sofia ou da equipe não prova nada e não vale a transcrição
  const pendentes = falas.filter((f) => f.audioLink && f.autor === 'PACIENTE').slice(-maxAudios);
  for (const f of pendentes) {
    const t = await transcrever(unit, f.audioLink as string).catch(() => null);
    if (t?.text) f.texto = f.texto.replace('[áudio]', () => `(áudio) ${t.text}`).trim().slice(0, MAX_CHARS_POR_FALA);
  }
}
