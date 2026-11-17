/**
 * O CHAMADO que o franqueado abre no sistema da franqueadora (rede Doutor Hérnia) logo depois de enviar o formulário: pede o Token de Integração da API da franquia para a
 * Doutor Digital. É o passo que só a franqueadora faz, e o que mais atrasa — por isso a tela «Recebemos» entrega título e texto PRONTOS para copiar.
 *
 * A redação é do João (texto padrão do chamado); aqui só entram os dados do formulário nos lugares dele. NADA sensível: não leva o código nem o link do formulário, telefone de paciente,
 * e-mail de atendente, Pix. O e-mail que aparece é o do PRÓPRIO responsável (o campo «E-mail» do texto padrão). Nada disto é gravado: sai na resposta do envio e só.
 *
 * Não inventamos o menu do sistema da franqueadora: a tela só diz «abra um chamado» e entrega o endereço de login.
 */
import type { RespostasFormulario } from './formulario.js';

export const URL_DA_FRANQUEADORA = 'https://app.doutorhernia.com.br/login';
/** O sistema de destino do texto padrão (o João trocou «CRM Kommo» por este nome). Um parâmetro só: aparece em «Sistema de destino» e em «Objetivo». */
export const SISTEMA_DE_DESTINO = 'CRM da Doutor Digital';

const semAcento = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/** «Doutor Hérnia Serra» → «Serra» (o texto já diz «Doutor Hérnia – …»); nome sem o prefixo fica inteiro. */
export function nomeDaUnidadeNoChamado(nomeClinica: string): string {
  const limpo = nomeClinica.replace(/\s+/g, ' ').trim();
  const sem = limpo.replace(/^(?:doutor|dr\.?)\s+h[eé]rnia\b[\s\-–—:]*/i, '').trim();
  return sem && semAcento(sem).length >= 2 ? sem : limpo;
}

export interface Chamado {
  url: string;
  titulo: string;
  texto: string;
}

export function chamadoDaFranquia(r: RespostasFormulario): Chamado {
  const unidade = nomeDaUnidadeNoChamado(r.clinica.nome);
  const nome = r.quem.nome;
  const pedidos: string[] = [];
  if (r.franquia_id_company === undefined) pedidos.push('o código da unidade na franquia (id_company)');
  pedidos.push(`o código de cada profissional (idStaff): ${r.profissionais.map((p) => p.nome).join('; ')}`);
  const linhaExtra = `Peço também informar ${pedidos.join(' e ')}.`;

  const texto = [
    'Bom dia, equipe.',
    '',
    'Solicito a liberação do Token de Integração para esta unidade, conforme as informações técnicas abaixo:',
    '',
    `Responsável: ${nome}`,
    `E-mail: ${r.quem.email}`,
    'Ferramenta que realizará a integração: Doutor Digital',
    `Sistema de destino: ${SISTEMA_DE_DESTINO}`,
    'Empresa responsável pela integração: Doutor Digital',
    `Unidade a ser integrada: Doutor Hérnia – ${unidade}`,
    'Dados que serão consumidos via API:',
    '',
    'Agenda de pacientes;',
    'Cadastro de leads e pacientes;',
    'Grade de horários disponíveis;',
    'Status das consultas, incluindo confirmações, remarcações e cancelamentos;',
    'Categorias de atendimento.',
    'Tratamentos',
    'Tudo relacionado a api da franquia.',
    '',
    `Objetivo da integração: Realizar a integração da agenda da unidade ao ${SISTEMA_DE_DESTINO}, possibilitando a automação dos processos de atendimento, gestão de leads e pacientes e acompanhamento de indicadores operacionais.`,
    '',
    'Solicito a geração do respectivo Token de Integração, bem como o envio da documentação técnica, endpoints e demais informações necessárias para que a equipe responsável possa prosseguir com a configuração.',
    '',
    linhaExtra,
    '',
    'Atenciosamente,',
    '',
    `${nome} Franqueado(a) – Doutor Hérnia`,
  ].join('\n');

  return { url: URL_DA_FRANQUEADORA, titulo: `Solicitação de Token de Integração – Doutor Hérnia ${unidade}`, texto };
}
