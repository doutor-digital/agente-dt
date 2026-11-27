/**
 * Confirmação na MANHÃ da consulta (decisão do João, 27/11/2026): faltas e desmarcações das consultas que a Sofia marca.
 *
 * Medido em produção em 27/11 (consultas marcadas pela Sofia nos 30 dias anteriores, já resolvidas, rede sem Caxias e Petrópolis):
 * 33 de 66 não aconteceram (6 faltaram, 27 desmarcaram). Com a pergunta da véspera do servidor, 16 de 34 ainda não vieram.
 * A véspera pergunta uma vez, 24 h antes; o que muda de ideia no dia ninguém pergunta de novo. Esta é a segunda pergunta,
 * curta, no próprio dia, algumas horas antes do horário.
 *
 * É o mesmo caminho da véspera (reminder-worker: `pedirConfirmacao` + `tratarRespostaD1`), com toque `d0`. Nada é duplicado: o toque
 * no botão cai no tratador que já confirma na franquia. Este arquivo só decide QUEM recebe e QUANDO — funções puras, sem banco.
 *
 * LIGA E DESLIGA pela automação `confirmacao-manha` (nasce desligada; «só no papel» anota o que mandaria e não manda).
 * Caxias e Petrópolis ficam FORA por padrão e por código (`UNIDADES_FORA`): mesmo com a lista `*`, a chave nelas vale desligada.
 */
import { estadoDaAutomacao, type Estado } from './automacoes-estado.js';
import { UNIDADES_FORA_DAS_FALTAS } from './automacoes.js';

export const ID_CONFIRMACAO_MANHA = 'confirmacao-manha';

/** Unidades onde a pergunta da manhã e a oferta de datas NUNCA ligam, nem com `*` (pedido do João, 27/11/2026). */
export const UNIDADES_FORA: readonly string[] = UNIDADES_FORA_DAS_FALTAS;

/** O estado da automação na unidade, recusando as unidades de fora. Vale também para a chave irmã `remarcar-oferta`. */
export function estadoDoPlano(slug: string, id: string, raw: string | undefined): Estado {
  if (UNIDADES_FORA.includes(slug)) return 'desligado';
  return estadoDaAutomacao(slug, id, raw);
}

export function estadoDaManha(slug: string, env: NodeJS.ProcessEnv = process.env): Estado {
  return estadoDoPlano(slug, ID_CONFIRMACAO_MANHA, env.CONFIRMACAO_MANHA_SLUGS);
}

/** Pergunta sai de, no máximo, 5 h antes (e nunca antes de a clínica abrir) até 1 h 30 antes: dá tempo de remarcar. */
export const ANTECEDENCIA_MAX_MIN = 5 * 60;
export const ANTECEDENCIA_MIN_MIN = 90;
/** Mensagens novas por unidade em uma varredura: uma rajada de mensagens iguais é o que derruba número no WhatsApp Lite. */
export const MAX_ENVIOS_POR_VARREDURA = 10;

/** Minutos entre dois "AAAA-MM-DDTHH:mm" locais (b - a). NaN se algum não parece data. */
function minutosEntre(a: string, b: string): number {
  return (Date.parse(`${b.slice(0, 16)}:00Z`) - Date.parse(`${a.slice(0, 16)}:00Z`)) / 60_000;
}

/** Consulta de HOJE, entre 1 h 30 e 5 h à frente. `quando` e `agoraLocal` no relógio da clínica. */
/**
 * As faltas estão ligadas nesta unidade — a manhã OU a oferta de horários LIGADA (não «só no papel», que não muda nada para o paciente)?
 * Com qualquer uma ligada, a Sofia e a pergunta convivem na mesma conversa e as travas de «1»/«2» solto e de resposta depois da consulta valem.
 */
export function faltasLigadas(slug: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return estadoDoPlano(slug, ID_CONFIRMACAO_MANHA, env.CONFIRMACAO_MANHA_SLUGS) === 'ligado' || estadoDoPlano(slug, 'remarcar-oferta', env.REMARCAR_OFERTA_SLUGS) === 'ligado';
}

/**
 * Por onde a pergunta da manhã SAIRIA agora. O seco usa a MESMA conta do envio real (`pedirConfirmacao`): janela de 24 h aberta = texto pelo
 * chat; fechada = só o modelo aprovado da manhã; sem ele, não sai nada. Conversa ilegível (`null`) conta como janela fechada.
 */
export function canalDaManha(janelaAberta: boolean, modeloDaManha: number | null): 'texto' | 'modelo' | 'sem_modelo' {
  if (janelaAberta) return 'texto';
  return modeloDaManha ? 'modelo' : 'sem_modelo';
}

export function dentroDaJanelaDaManha(quando: string, agoraLocal: string): boolean {
  if (quando.slice(0, 10) !== agoraLocal.slice(0, 10)) return false;
  const min = minutosEntre(agoraLocal, quando);
  return Number.isFinite(min) && min >= ANTECEDENCIA_MIN_MIN && min <= ANTECEDENCIA_MAX_MIN;
}

/**
 * Filtro BARATO sobre o horário guardado no vínculo (pode estar velho): só poupa a chamada à franquia de quem, pelo que está gravado, não
 * está nem perto da janela (margem de 30 min para cada lado). A decisão de verdade usa o horário que a franquia devolve agora.
 */
export function talvezDentroDaJanela(agendadoPara: string | null | undefined, agoraLocal: string): boolean {
  if (!agendadoPara) return true;
  if (agendadoPara.slice(0, 10) !== agoraLocal.slice(0, 10)) return false;
  const min = minutosEntre(agoraLocal, agendadoPara);
  if (!Number.isFinite(min)) return true;
  return min >= ANTECEDENCIA_MIN_MIN - 30 && min <= ANTECEDENCIA_MAX_MIN + 30;
}

export type MotivoDeNaoMandar =
  | 'desligada'
  | 'robo_do_kommo'
  | 'consulta_nao_confirmada'
  | 'fora_da_janela'
  | 'clinica_fechada'
  | 'leitura_falhou'
  | 'ja_perguntou'
  | 'etapa'
  | 'desistiu'
  | 'pediu_para_remarcar'
  | 'ja_confirmou'
  | 'confirmou_no_whatsapp';

export interface FatosDaManha {
  estado: Estado;
  /** `lembretesDoServidor(unit).vespera`: com o robô do Kommo mandando véspera e lembrete do dia, a do servidor não sai. */
  vespera: 'servidor' | 'robo-kommo';
  clinicaAtendendo: boolean;
  /** A consulta que a franquia devolveu agora: `quando` só vale com estado `confirmada` (data verificada). */
  consulta: { estado: string; quando?: string | null } | null;
  agoraLocal: string;
  perguntouHoje: boolean;
  /** Cartão fechado ou em etapa de quem não vem (`etapaSemVespera`). */
  etapaSemVespera: boolean;
  /** O paciente escreveu que não vem (`desistenciaEscrita`). */
  desistiu: boolean;
  /** `jaConfirmou()`: CONFIRMADO na franquia ou «Agendamento confirmado» da Sofia nas últimas 12 h. */
  confirmadaNaFranquia: string | null;
  /** A última pergunta (véspera ou reforço) DESTA consulta foi respondida com «confirmo». */
  confirmouNoWhatsapp: boolean;
  /** A última pergunta DESTA consulta foi respondida com «preciso remarcar». */
  pediuParaRemarcar: boolean;
}

export type DecisaoDaManha = { acao: 'mandar' } | { acao: 'pular'; motivo: MotivoDeNaoMandar };

/**
 * Manda a pergunta da manhã? A ordem é da mais barata à mais cara, e cada «não» tem nome para o log e para a tela.
 *
 * Quem já confirmou NÃO recebe: pergunta repetida a quem acabou de dizer «confirmo» é o que fez uma paciente da Serra ameaçar bloquear o
 * número (23/09/2026). O «bom motivo» para perguntar mesmo assim não existe nesta versão — se aparecer, entra aqui, com nome.
 */
export function decidirManha(f: FatosDaManha): DecisaoDaManha {
  const nao = (motivo: MotivoDeNaoMandar): DecisaoDaManha => ({ acao: 'pular', motivo });
  if (f.estado === 'desligado') return nao('desligada');
  if (f.vespera === 'robo-kommo') return nao('robo_do_kommo');
  if (!f.consulta || f.consulta.estado !== 'confirmada' || !f.consulta.quando) return nao('consulta_nao_confirmada');
  if (!dentroDaJanelaDaManha(f.consulta.quando, f.agoraLocal)) return nao('fora_da_janela');
  if (!f.clinicaAtendendo) return nao('clinica_fechada');
  if (f.perguntouHoje) return nao('ja_perguntou');
  if (f.etapaSemVespera) return nao('etapa');
  if (f.desistiu) return nao('desistiu');
  if (f.pediuParaRemarcar) return nao('pediu_para_remarcar');
  if (f.confirmadaNaFranquia) return nao('ja_confirmou');
  if (f.confirmouNoWhatsapp) return nao('confirmou_no_whatsapp');
  return { acao: 'mandar' };
}

const RODAPE_SEM_BOTAO = (oferece: boolean) =>
  `Responda *1* para confirmar ou *2* se não conseguir${oferece ? ', que eu te ofereço outro horário' : ''}.`;
const RODAPE_COM_BOTAO = 'Toque em um dos botões aqui embaixo para me avisar.';

/**
 * O texto da pergunta da manhã. `nome` já passou por `primeiroNomeDoPaciente` (nunca o perfil do WhatsApp). Sem "amanhã" e sem
 * horário inventado: `quando` é o da franquia, verificado agora. Sem emoji de 4 bytes (quebram no Kommo).
 * `oferece` = a chave `remarcar-oferta` está LIGADA na unidade: só então a mensagem promete outro horário (nunca promete o que não cumpre).
 */
export function textoConfirmacaoManha(args: {
  nome: string | null | undefined;
  quando: string;
  especialista?: string | null;
  endereco?: string | null;
  /** hora local do envio, para «Bom dia» / «Boa tarde» */
  horaDoEnvio: number;
  oferece: boolean;
  /** com os ids do chat a mensagem vai com botões e o rodapé muda */
  comBotoes: boolean;
}): string {
  const saud = args.horaDoEnvio < 12 ? 'Bom dia' : 'Boa tarde';
  const nome = (args.nome ?? '').trim();
  const quem = args.especialista ? ` com ${args.especialista}` : '';
  const onde = args.endereco ? `\n${args.endereco}` : '';
  return (
    `${saud}${nome ? `, ${nome}` : ''}! Passando para lembrar: sua consulta é *hoje, às ${args.quando.slice(11, 16)}*${quem}.${onde}\n\n` +
    `Você consegue vir? ${args.comBotoes ? RODAPE_COM_BOTAO : RODAPE_SEM_BOTAO(args.oferece)}`
  );
}
