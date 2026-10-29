/**
 * A voz do Copiloto (OpenAI Realtime). O servidor só EMITE um acesso temporário: o áudio vai direto do navegador da SDR
 * para a OpenAI (WebRTC) e nunca passa por aqui. A chave PRÓPRIA do Copiloto nunca sai do servidor; o navegador recebe um
 * segredo que vale poucos minutos.
 *
 * Privacidade: a voz NÃO recebe cartão nem conversa de paciente. Só sabe o nome da etapa e a ficha dela (fichas-das-etapas.ts).
 * Ela ensina o Kommo; quem preenche e move o cartão é a pessoa.
 */
import { fichaDaEtapa } from './fichas-das-etapas.js';

export const MODELO_DE_VOZ_PADRAO = 'gpt-realtime-2.1-mini';
export const VOZ_PADRAO = 'marin';
/** O widget encerra a conversa sozinho neste tempo (a OpenAI tem teto de gasto na chave; isto limita cada conversa). */
export const LIMITE_DA_CONVERSA_S = 300;
/** O segredo temporário só serve para ABRIR a conversa dentro deste prazo. */
export const VALIDADE_DO_SEGREDO_S = 120;

const MAX_CHARS_DA_ETAPA = 60;

export function lerEtapaDoPedido(corpo: unknown): string | null {
  if (!corpo || typeof corpo !== 'object') return null;
  const e = (corpo as Record<string, unknown>).etapa;
  return typeof e === 'string' && e.trim() ? e.trim().slice(0, MAX_CHARS_DA_ETAPA) : null;
}

export function instrucoesDaVoz(etapa: string | null): string {
  const f = fichaDaEtapa(etapa);
  const base = [
    'Você é o Copiloto da Doutor Digital. Ensina atendentes (SDR) de clínicas Doutor Hérnia a usar o Kommo, em tempo real, por voz.',
    'Fale em português do Brasil, com calor humano, simples, em no máximo 3 frases curtas por vez. Sem gíria e sem termos técnicos.',
    'Responda só sobre como usar o Kommo e o trabalho de cada etapa do funil. Você só orienta: quem preenche campo e move o cartão é a pessoa.',
    'NUNCA invente regra, preço, chave Pix, endereço, horário ou política de convênio da clínica. Se não souber, diga que essa regra é da unidade e que a coordenação responde.',
    'NUNCA dê orientação médica ou de saúde. Se perguntarem, diga que isso é com o fisioterapeuta na consulta.',
    'Não peça nem repita nome, telefone, CPF ou e-mail de paciente. Se a pessoa disser algum, não repita e siga a explicação sem usar o dado.',
    'Para ver na tela, sugira os botões "Fazer tour" (eu aponto onde clicar) e "Assistir ao vídeo" no painel.',
  ];
  if (f) {
    base.push(
      `A pessoa está na etapa ${f.nome}. Ficha da etapa:`,
      `- Missão: ${f.ficha.missao}`,
      f.ficha.preencher.length ? `- Campos para preencher: ${f.ficha.preencher.join('; ')}` : '- Nesta etapa a equipe não preenche campos à mão.',
      f.ficha.proxima.length ? `- Depois, o cartão costuma ir para: ${f.ficha.proxima.join(' ou ')}` : '- Esta etapa não tem próxima etapa comum.',
      'Se perguntarem o que fazer agora, explique a missão e os campos, um de cada vez, e pergunte se ficou claro.',
    );
  } else {
    base.push('Você não sabe em qual etapa a pessoa está. Se ela perguntar o que fazer numa etapa, pergunte qual etapa é.');
  }
  return base.join('\n');
}

/** O corpo do `POST /v1/realtime/client_secrets`. */
export function corpoDaSessao(modelo: string, voz: string, instrucoes: string) {
  return {
    expires_after: { anchor: 'created_at', seconds: VALIDADE_DO_SEGREDO_S },
    session: {
      type: 'realtime',
      model: modelo,
      instructions: instrucoes,
      audio: {
        input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'pt' }, turn_detection: { type: 'server_vad' } },
        output: { voice: voz },
      },
    },
  };
}

export interface SessaoDeVoz {
  segredo: string;
  expiraEm: number | null;
}

type Fetch = typeof fetch;

/** Pede à OpenAI o acesso temporário. Erro nunca carrega a chave nem o corpo enviado. */
export async function criarSessaoDeVoz(chave: string, corpo: object, buscar: Fetch = fetch): Promise<SessaoDeVoz> {
  const resp = await buscar('https://api.openai.com/v1/realtime/client_secrets', {
    method: 'POST',
    headers: { authorization: `Bearer ${chave}`, 'content-type': 'application/json' },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await resp.json().catch(() => ({}))) as { value?: unknown; expires_at?: unknown; error?: { message?: unknown } };
  if (!resp.ok || typeof data.value !== 'string' || !data.value) {
    const motivo = typeof data.error?.message === 'string' ? data.error.message.slice(0, 160) : 'resposta sem segredo';
    throw new Error(`OpenAI ${resp.status}: ${motivo}`);
  }
  return { segredo: data.value, expiraEm: typeof data.expires_at === 'number' ? data.expires_at : null };
}

// ── limite diário por unidade (em memória: reinicia com o serviço; o teto de gasto da chave é a trava de verdade) ──
const sessoesDoDia = new Map<string, { dia: string; n: number }>();

/** true = pode abrir mais uma conversa hoje. Conta só quando libera. */
export function reservarSessao(slug: string, max: number, agora: Date = new Date()): boolean {
  const dia = agora.toISOString().slice(0, 10);
  const atual = sessoesDoDia.get(slug);
  const n = atual && atual.dia === dia ? atual.n : 0;
  if (n >= max) return false;
  sessoesDoDia.set(slug, { dia, n: n + 1 });
  return true;
}

export function _limparSessoesDoDia(): void {
  sessoesDoDia.clear();
}
