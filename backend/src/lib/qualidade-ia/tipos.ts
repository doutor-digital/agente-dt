import type { Sinais } from './sinais.js';

/** Dia de calendário em America/Sao_Paulo, `AAAA-MM-DD`. */
export type Dia = string;

/** O que o juiz fez num dia (pelo dia em que a AVALIAÇÃO foi gravada). */
export interface DiaAvaliado {
  dia: Dia;
  /** Avaliações gravadas no dia. */
  total: number;
  /** A Sofia não falou nenhuma vez na conversa (pausa, etapa não permitida): nota sem sentido. */
  semSofia: number;
  /** A Sofia falou, mas o paciente não escreveu mais nada depois da 1ª fala dela. */
  sumiu: number;
  /** A Sofia falou E o paciente respondeu: só estas medem a Sofia. */
  avaliaveis: number;
  /** Média (0 a 10) só das avaliáveis; null quando não houve nenhuma. */
  mediaAvaliaveis: number | null;
}

/** O que chegou de mensagem num dia (pelo dia da mensagem). */
export interface DiaMensagens {
  dia: Dia;
  /** Conversas em que o paciente escreveu no dia. */
  conversasComPaciente: number;
  /** Dessas, as que não têm nenhuma fala da Sofia até o fim do dia. */
  conversasSemSofia: number;
  mensagensPaciente: number;
  /** Mensagens do paciente gravadas vazias (áudio/imagem sem texto) ou "não deu pra ouvir". */
  mensagensPacienteVazias: number;
  sinais: Sinais;
}

export interface UnidadeNota {
  nome: string;
  avaliaveis: number;
  media: number;
}

export interface PiorConversa {
  nota: number;
  unidade: string;
  /** Só o 1º nome; `null` quando o cadastro não tem nome de pessoa. */
  primeiroNome: string | null;
  /** Só os 4 últimos dígitos do telefone; `null` sem telefone. */
  final4: string | null;
  leadId: string;
  /** Até 2 linhas, já sem telefone e com tamanho cortado. */
  trecho: string[];
}

export interface FaixaDeNota {
  faixa: 'baixa' | 'media' | 'alta';
  conversas: number;
  /** Com `converted_at` (entrou em etapa de Ganho). */
  ganhos: number;
  /** Com consulta marcada na franquia (`spine_lead_links.spine_id_schedule`). */
  comConsulta: number;
}

export interface DadosDiarios {
  /** O dia resumido (ontem). */
  dia: Dia;
  /** Os 8 dias até ontem: o dia, a véspera e os 7 anteriores ao dia. Ordem crescente. */
  avaliacoes: DiaAvaliado[];
  mensagens: DiaMensagens[];
  /** Piores unidades do dia (mínimo de avaliáveis aplicado na consulta). */
  piores: UnidadeNota[];
  pior: PiorConversa | null;
}

export interface DadosSemanais {
  /** Último dia da semana (ontem). A semana são os 7 dias até aqui. */
  fim: Dia;
  /** Os 14 dias até `fim`: 7 da semana e 7 da anterior, para comparar. */
  avaliacoes: DiaAvaliado[];
  mensagens: DiaMensagens[];
  /** Faixas de nota da semana, com a conversão de cada uma. */
  faixas: FaixaDeNota[];
  piores: UnidadeNota[];
}
