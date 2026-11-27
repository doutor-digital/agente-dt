/**
 * Áudio, foto ou arquivo que a Sofia não leu, e a conversa que morre ali (relatório "por que a Sofia não converte",
 * 27/11/2026: 14 das 136 conversas com o paciente falando e ninguém respondendo, entre elas as de áudio e mídia).
 *
 * O que já existia, e que isto NÃO duplica:
 *  - a transcrição do áudio (Whisper, `transcribeAudio`) e a espera do WhatsApp Lite pelo arquivo (`blocoDaConversaOficial`);
 *  - a leitura de foto/PDF pela rota oficial (`lib/anexos-do-turno.ts`, #485);
 *  - o recado ao modelo quando a leitura falha (`AUDIO_NAO_OUVIDO`, `MARCA_ANEXO_NAO_LIDO`) e a passagem para a equipe
 *    depois de 2 áudios seguidos sem ouvir (`repeticao.ts`).
 * O buraco: o recado é só um PEDIDO ao modelo. Ele responde como se tivesse ouvido, se despede, ou não diz nada, e o
 * paciente fica sem resposta. Aqui o código confere a resposta que saiu: se a mídia do turno não foi lida e a resposta não
 * diz isso, ela é trocada por UMA frase fixa, gentil, pedindo para escrever — e, se havia horários na mesa, repete 2.
 *
 * Nunca em dobro: a frase só entra quando a resposta do modelo NÃO já pede para escrever ou passa para a equipe; só no
 * turno em que o paciente mandou SÓ a mídia (se escreveu algo junto, o modelo responde ao texto); não repete a mesma frase
 * duas vezes seguidas; e a mídia que carrega depois chega pelo turno seguinte já transcrita (conversa-oficial.ts), onde a
 * Sofia responde ao conteúdo e não pede de novo.
 *
 * Tudo aqui é função pura sobre texto — sem banco, sem Kommo.
 */
import { MARCA_AUDIO_NAO_OUVIDO, type Fala } from './repeticao.js';
import { horariosOferecidos, horariosQueJaPassaram, type HorarioOferecido } from './horario-oferecido.js';
import { automacaoLigada } from '../lib/automacoes-estado.js';
import { temMidiaSemArquivo } from '../lib/conversa-oficial.js';
import { desdeUltimaFalaDaSofia, type MensagemOficial } from '../services/kommo-talks.service.js';

/** O mesmo texto de `MARCA_ANEXO_NAO_LIDO` (lib/anexos-do-turno.ts) e do webhook; o teste confere que continuam iguais. */
export const MARCA_ANEXO_NAO_LIDO_DO_TURNO = '[cliente mandou uma imagem ou um arquivo, mas não foi possível ler]';
/** Trecho fixo do recado de `instrucaoAudioNaoTranscrito(true)`; o teste confere que continua lá. */
export const INSTRUCAO_DE_PASSAR_PARA_EQUIPE = 'NÃO peça pra ele gravar de novo nem pra escrever';
const IMAGEM_SEM_CONTEUDO = /\[(imagem|foto|arquivo|documento|pdf)[^\]]*sem conte[úu]do leg[íi]vel\]/i;

/** Chave `midia-nao-lida-pede-escrever` (automacoes.ts): nasce DESLIGADA; liga-se por unidade (piloto) pela tela ou pelo `.env`. */
export function midiaNaoLidaLigada(slug: string): boolean {
  return automacaoLigada(slug, 'midia-nao-lida-pede-escrever', process.env.MIDIA_NAO_LIDA_PEDE_ESCREVER_SLUGS);
}

export type TipoDeMidia = 'audio' | 'imagem' | 'arquivo' | 'midia';

/** Áudio do Lite recente o bastante para ser o deste turno (o turno pode ter esperado ~18 s pelo arquivo e pela fila). */
const JANELA_DO_AUDIO_LITE_MS = 5 * 60_000;

/**
 * WhatsApp Lite: o aviso de mídia está na fala e o ÁUDIO que ele anuncia não foi lido (nem pelo webhook, nem transcrito pela
 * rota oficial). Só ÁUDIO: sticker, reação e foto de unidade que não lê anexo chegam com o mesmo aviso, e pedir "me escreve" a quem
 * mandou um 👍 seria pior que o silêncio. Só vale se a rota oficial JÁ lista o áudio do paciente depois da última fala da Sofia
 * (com ou sem link, mas sem transcrição). Quem chama põe `AUDIO_NAO_OUVIDO` na mensagem do modelo, como no áudio que falha no webhook.
 */
export function liteAudioSemLeitura(a: {
  humanMessage: string;
  /** Os ids dos áudios que ESTE turno transcreveu (`saida.transcritos` de `blocoDaConversaOficial`): o áudio antigo já transcrito não vale pelo novo. */
  transcritos: ReadonlySet<string>;
  leituraNoWebhook: boolean;
  msgs: MensagemOficial[] | null;
  agora?: number;
}): boolean {
  if (!temMidiaSemArquivo(a.humanMessage) || a.leituraNoWebhook || !a.msgs) return false;
  const agora = a.agora ?? Date.now();
  // algum áudio DESTE turno (recente, depois da última fala da Sofia) sem transcrição deste turno
  return desdeUltimaFalaDaSofia(a.msgs).some(
    (m) =>
      m.autor === 'paciente' &&
      m.direcao === 'entrada' &&
      m.anexo?.tipo === 'voice' &&
      agora - m.em.getTime() < JANELA_DO_AUDIO_LITE_MS &&
      !a.transcritos.has(m.id),
  );
}

/** A fala do paciente sem as marcas do sistema, os avisos do Lite e as instruções internas. O que sobra é o que ELE escreveu. */
function oQueEleEscreveu(entrada: string): string {
  return entrada
    .replace(/Você recebeu uma mensagem de mídia[^\n]*/gi, ' ')
    .replace(/'messageContextInfo' is not yet supported[^\n]*/gi, ' ')
    .replace(/Aguarde o carregamento[^\n]*/gi, ' ')
    .replace(/\[[^\]]*\]:?/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * A mídia deste turno que NÃO foi lida, quando o paciente mandou SÓ ela. `entrada` é a fala do paciente como o modelo a leu
 * (com as marcas de "não deu pra ouvir" / "não foi possível ler"). Com texto dele junto, ou com qualquer mídia que foi lida
 * (a transcrição fica depois do marcador), devolve null: o modelo tem o que responder.
 */
/**
 * O texto EFETIVO do turno: o `<conversa_oficial>` que o webhook prega na frente traz o que a equipe falou e a transcrição do áudio
 * recuperado. Quando o modelo responde a isso, a frase fixa NÃO pode trocar a resposta certa. Do bloco só entra o que tem texto entre
 * aspas; o cabeçalho, as regras e as linhas "[áudio]", "[pic]", "[mensagem vazia]" (mídia que continua sem leitura) ficam de fora.
 */
function comOQueOBlocoTrouxe(entrada: string): string {
  return entrada.replace(/<conversa_oficial>[\s\S]*?<\/conversa_oficial>/g, (bloco) =>
    bloco
      .split('\n')
      .map((linha) => /·\s*[^:]+:\s*(.*)$/.exec(linha)?.[1] ?? '')
      .filter((corpo) => corpo.includes('"'))
      .join('\n'),
  );
}

export function midiaNaoLidaDoTurno(entrada: string): TipoDeMidia | null {
  // Unidade que não ouve áudio (ou falha estrutural): o recado ao modelo manda PASSAR PARA A EQUIPE e proíbe pedir para escrever
  // (webhook.controller.ts, instrucaoAudioNaoTranscrito(true)). Pedir para escrever aqui contrariaria isso.
  if (entrada.includes(INSTRUCAO_DE_PASSAR_PARA_EQUIPE)) return null;
  const tipos = new Set<TipoDeMidia>();
  if (entrada.includes(MARCA_AUDIO_NAO_OUVIDO)) tipos.add('audio');
  if (entrada.includes(MARCA_ANEXO_NAO_LIDO_DO_TURNO)) tipos.add('midia');
  const semConteudo = IMAGEM_SEM_CONTEUDO.exec(entrada);
  if (semConteudo) tipos.add(/imagem|foto/i.test(semConteudo[1]) ? 'imagem' : 'arquivo');
  if (tipos.size === 0) return null;
  // "[imagem sem conteúdo legível]" fica entre colchetes e sai na limpeza; o que sobrar é fala dele (ou transcrição lida)
  if (oQueEleEscreveu(comOQueOBlocoTrouxe(entrada))) return null;
  return tipos.size === 1 ? [...tipos][0] : 'midia';
}

const O_QUE_NAO_ABRIU: Record<TipoDeMidia, string> = {
  audio: 'seu áudio',
  imagem: 'sua foto',
  arquivo: 'seu arquivo',
  midia: 'o que você mandou',
};

/** A resposta do modelo já diz que não leu/ouviu, pede para escrever ou passa para a equipe: nada a acrescentar. */
const JA_PEDIU = new RegExp(
  [
    // "não consegui abrir/ouvir seu áudio"
    String.raw`n[ãa]o\s+(?:consegui|deu|foi\s+poss[ií]vel|pude)\s+(?:\w+\s+){0,2}(?:abrir|ouvir|ver|ler|escutar|acessar)`,
    // "me escreve rapidinho", "pode me escrever", "manda por escrito", "manda de novo"
    String.raw`\bme\s+(?:escreve|escreva|conta\s+por\s+escrito|manda\s+por\s+escrito)`,
    String.raw`\b(?:pode|consegue|poderia|prefere)\s+(?:me\s+)?(?:escrever|digitar|mandar\s+(?:de\s+novo|por\s+escrito|em\s+texto))`,
    String.raw`\b(?:escreve|escreva|digita|digite)\s+(?:pra\s+mim|aqui|rapidinho|mesmo)`,
    String.raw`\bmanda(?:r)?\s+(?:de\s+novo|por\s+escrito|em\s+texto)|\breenvi`,
    // passou para a equipe: "alguém da equipe vai ouvir seu áudio e continuar"
    String.raw`(?:equipe|recep[cç][ãa]o|atendente)\b[^.!?]{0,60}\b(?:ouvir|escutar|continu\w+|abrir|ver)\b`,
  ].join('|'),
  'i',
);

const FERRAMENTAS_QUE_RESOLVEM = ['pausar_ia', 'resumir_lead_para_sdr', 'agendar_consulta', 'remarcar_consulta', 'cancelar_consulta', 'confirmar_presenca'];

export function respostaJaTrataDaMidia(resposta: string): boolean {
  return JA_PEDIU.test(resposta);
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

const DIAS_DA_SEMANA = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

/** "terça 01/12 às 16h" (ou "16h30"). */
export function rotuloDoHorario(o: { data: string; hora: string }): string {
  const [ano, mes, dia] = o.data.split('-').map(Number);
  const semana = DIAS_DA_SEMANA[new Date(Date.UTC(ano, mes - 1, dia)).getUTCDay()];
  const [hh, mm] = o.hora.split(':');
  return `${semana} ${pad(dia)}/${pad(mes)} às ${Number(hh)}h${mm === '00' ? '' : mm}`;
}

/**
 * Os horários que a ÚLTIMA fala da Sofia deixou na mesa (até 2, com o dia certo, que ainda não passaram). Só a última fala dela:
 * oferta mais antiga que isso já foi respondida, recusada ou superada, e repeti-la seria empurrar horário velho.
 */
export function horariosNaMesa(falas: readonly Fala[], agoraLocal: string): string[] {
  const ultima = [...falas].reverse().find((f) => f.papel === 'ia');
  if (!ultima) return [];
  const ofertas: HorarioOferecido[] = horariosOferecidos(ultima.texto, agoraLocal);
  const passaram = new Set(horariosQueJaPassaram(ofertas, agoraLocal).map((o) => `${o.data}T${o.hora}`));
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const o of ofertas) {
    if (!o.data) continue;
    const chave = `${o.data}T${o.hora}`;
    if (passaram.has(chave) || vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(rotuloDoHorario({ data: o.data, hora: o.hora }));
    if (saida.length === 2) break;
  }
  return saida;
}

export function fraseDeMidiaNaoLida(tipo: TipoDeMidia, horarios: readonly string[] = []): string {
  const base = `Não consegui abrir ${O_QUE_NAO_ABRIU[tipo]} aqui 🙏 Me escreve rapidinho?`;
  return horarios.length > 0 ? `${base} Se for sobre o horário: ${horarios.join(' ou ')}?` : base;
}

/** A frase já foi a última fala da Sofia: não repete (o 2º áudio sem ouvir segue o caminho da equipe, repeticao.ts). */
function jaFoiADaVez(falas: readonly Fala[]): boolean {
  const ultima = [...falas].reverse().find((f) => f.papel === 'ia');
  return !!ultima && /N[ãa]o consegui abrir .{3,25} aqui 🙏 Me escreve rapidinho\?/.test(ultima.texto);
}

/**
 * A resposta que sai quando a mídia do turno não foi lida, ou null para deixar a do modelo. `ferramentas`: o que o modelo
 * chamou neste turno (pausar_ia = passou para a equipe, não se mexe).
 */
export function respostaDeMidiaNaoLida(a: {
  entrada: string;
  resposta: string;
  ferramentas: readonly string[];
  falas: readonly Fala[];
  agoraLocal: string;
}): { tipo: TipoDeMidia; texto: string } | null {
  const tipo = midiaNaoLidaDoTurno(a.entrada);
  if (!tipo) return null;
  // passou para a equipe, ou o modelo AGENDOU/remarcou/cancelou/confirmou neste turno: a resposta dele fala disso, não se troca
  if (FERRAMENTAS_QUE_RESOLVEM.some((f) => a.ferramentas.includes(f))) return null;
  if (respostaJaTrataDaMidia(a.resposta)) return null;
  if (jaFoiADaVez(a.falas)) return null;
  return { tipo, texto: fraseDeMidiaNaoLida(tipo, horariosNaMesa(a.falas, a.agoraLocal)) };
}
