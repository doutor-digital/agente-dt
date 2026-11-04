/**
 * Anexar um DOCUMENTO (contrato, ASO, termo, ficha…) a um registro do sistema novo pelo chat: pasta de um colaborador, documentos de uma empresa, documentos de um
 * paciente do Caixa ou o contrato de um cliente da Doutor Digital. É o irmão de `sistemas-anexo.ts` (comprovante de lançamento) e usa o MESMO cofre e o MESMO
 * segundo passo (`sistemas_anexar_envio`); aqui só mora o PRIMEIRO passo e a entrega à rota `POST /admin/v1/documento` do servidor do sistema, que grava no mesmo formato
 * da tela (bucket, caminho, linha) para o arquivo aparecer na tela como se a pessoa o tivesse anexado (contrato: docs/ADMIN-API.md do repositório sistemas-dd).
 *
 *  1. `sistemas_preparar_documento`  pergunta ao servidor QUEM é o destino (nome do colaborador, da empresa, do paciente, do cliente) e devolve isso para a pessoa
 *                                    conferir, mais o LINK DE ENVIO do cofre (uso único, 10 min, PDF/JPG/PNG/DOCX/XLSX até 15 MB, preso a este destino e a quem pediu).
 *  2. `sistemas_anexar_envio`        (em sistemas-anexo.ts) vê que o pedido é de documento e chama `anexarEnvioDocumento`: abre o arquivo do cofre, entrega ao servidor, apaga do cofre.
 *
 * O destino NUNCA vem de argumento no passo 2: fica preso ao pedido do passo 1. Um registro que não existe, ou um cliente que já tem contrato, é recusado no passo 1,
 * antes de gastar um link. Só quem pode escrever no sistema vê estas ferramentas.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { ErroSistemas } from '../lib/integracoes/sistemas.js';
import { CofreDeArquivos, ErroDeCofre, type TipoDeArquivo } from './cofre-arquivos.js';
import { executar } from './ferramenta.js';
import { classificarErroDaEntrega, nomeLimpo, type ResultadoDaEntrega } from './sistemas-entrega.js';
import { resolverSistema, type ContextoSistemas, type QuemSistemas, type Saida } from './sistemas.js';

export const DESTINO_DOCUMENTO = 'documento';
export const DESTINOS_DOCUMENTO = ['rh_colaborador', 'rh_empresa', 'caixa_paciente', 'cliente_dd'] as const;
type DestinoDoc = (typeof DESTINOS_DOCUMENTO)[number];
/** o que a tela do Caixa oferece em "Tipo de documento" */
export const TIPOS_CAIXA = ['contrato', 'termo', 'comprovante', 'recibo', 'boleto', 'ficha_sessoes', 'nf', 'outro'] as const;
const ACEITOS_RH: readonly TipoDeArquivo[] = ['pdf', 'jpg', 'png', 'docx', 'xlsx'];
const ACEITOS_CAIXA: readonly TipoDeArquivo[] = ['pdf', 'jpg', 'png'];
export const DOCUMENTO_MAX_BYTES = 15 * 1024 * 1024;
export const DOCUMENTO_VALE_MS = 10 * 60_000;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const ROTULO: Record<DestinoDoc, string> = {
  rh_colaborador: 'pasta de um colaborador (RH)',
  rh_empresa: 'documentos de uma empresa (RH)',
  caixa_paciente: 'documentos de um paciente (Caixa)',
  cliente_dd: 'contrato de um cliente da Doutor Digital',
};

export interface DepsDocumento {
  cofre: CofreDeArquivos;
  /** origem pública do conector (é o domínio do link de envio) */
  baseUrl: () => string;
  /** em nome de quem o arquivo fica gravado (`caixa_docs.enviado_nome`) */
  enviadoNome: string;
}

interface DestinoGuardado {
  sistema: string;
  alvo: DestinoDoc;
  id: string;
  tratRef: string;
  tipoDocumento: string;
  validade: string;
  assinar: boolean;
}

/** O destino guardado no pedido do cofre, conferido de novo na entrega (formato inesperado é recusado). */
export function destinoDocumentoConferido(d: Readonly<Record<string, string>> | undefined): DestinoGuardado {
  if (!d || d.tipo !== DESTINO_DOCUMENTO) throw new ErroDeEntrada('esse envio não foi pedido por sistemas_preparar_documento.');
  const alvo = d.alvo as DestinoDoc;
  if (!d.sistema || !(DESTINOS_DOCUMENTO as readonly string[]).includes(alvo) || !d.tipoDocumento) {
    throw new ErroDeEntrada('o pedido deste envio está incompleto: peça um novo link por sistemas_preparar_documento.');
  }
  if (alvo === 'caixa_paciente' ? !d.tratRef : !ID.test(d.id ?? '')) throw new ErroDeEntrada('o pedido deste envio está incompleto: peça um novo link por sistemas_preparar_documento.');
  return { sistema: d.sistema, alvo, id: d.id ?? '', tratRef: d.tratRef ?? '', tipoDocumento: d.tipoDocumento, validade: d.validade ?? '', assinar: d.assinar === 'sim' };
}

const iso = (ms: number) => new Date(ms).toISOString();
function dataReal(v: string): boolean {
  const m = DATA.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(v.slice(0, 4)), Number(v.slice(5, 7)) - 1, Number(v.slice(8, 10))));
  return d.toISOString().slice(0, 10) === v;
}
/** Nome seguro para o corpo e para o comando curl: só [A-Za-z0-9._-], sem acento, sem "..", até 80 caracteres. */
export function nomeParaCurl(bruto: string): string {
  return (bruto.split(/[\\/]/).pop() ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-._]+|[-_]+$/g, '')
    .slice(0, 80);
}

/** O corpo que a rota espera, igual na conferência e na entrega (a entrega acrescenta o arquivo). */
function corpoDoDestino(d: DestinoGuardado, quem: QuemSistemas, enviadoNome: string, nome: string): Record<string, unknown> {
  return {
    destino: d.alvo,
    ...(d.alvo === 'caixa_paciente' ? { trat_ref: d.tratRef } : { id: d.id }),
    tipo_documento: d.tipoDocumento,
    nome,
    ...(d.validade ? { validade: d.validade } : {}),
    ...(d.assinar ? { precisa_assinatura: true } : {}),
    enviado_nome: enviadoNome,
    quem: quem.nome,
  };
}

/** Entrega os bytes ao servidor. `definitivo` = o servidor respondeu (aceitou ou recusou); false = não sei se gravou. */
async function entregar(
  ctx: ContextoSistemas,
  quem: QuemSistemas,
  d: DestinoGuardado,
  enviadoNome: string,
  arquivo: { nome: string; bytes: Buffer },
): Promise<ResultadoDaEntrega<Saida>> {
  const c = resolverSistema(ctx, d.sistema);
  try {
    const r = (await c.fonte.chamar('POST', '/admin/v1/documento', {
      corpo: { ...corpoDoDestino(d, quem, enviadoNome, arquivo.nome), conteudo_b64: arquivo.bytes.toString('base64'), origem: 'envio' },
      quem: quem.nome,
      timeoutMs: 120_000,
    })) as Saida;
    return { definitivo: true, resposta: r };
  } catch (e) {
    return classificarErroDaEntrega(e);
  }
}

const ONDE_APARECE: Record<DestinoDoc, string> = {
  rh_colaborador: 'O documento está na pasta do colaborador (rh_docs, colaboradores, pasta.documentos) e a tela do RH o abre pelo caminho guardado.',
  rh_empresa: 'O documento está nos documentos da empresa (rh_docs, empresas, arquivados) e a tela do RH o abre pelo caminho guardado.',
  caixa_paciente: 'O documento está no Caixa (caixa_docs) com ia_status "aguardando"; as prévias das páginas estão em caixa_docs_prev para a conferência.',
  cliente_dd: 'O contrato está no cadastro do cliente (rh_docs, dd_clientes, campo arquivo) e a tela de Clientes DD o abre pelo caminho guardado.',
};

/**
 * Passo 2 de um envio de DOCUMENTO (chamado por `sistemas_anexar_envio`). Abre o arquivo do cofre (uma entrega por vez), entrega ao servidor e apaga do cofre
 * quando o servidor respondeu; sem resposta, o arquivo fica para tentar de novo depois de conferir.
 */
export async function anexarEnvioDocumento(ctx: ContextoSistemas, quem: QuemSistemas, cofre: CofreDeArquivos, envio: string, enviadoNome: string, guardado: Readonly<Record<string, string>> | undefined): Promise<Record<string, unknown>> {
  let d: DestinoGuardado;
  let aberto;
  try {
    d = destinoDocumentoConferido(guardado);
    // `abrir` marca o envio como em uso antes de qualquer espera: uma segunda chamada ao mesmo tempo é recusada (nada de anexo em dobro)
    aberto = await cofre.abrir(quem.usuario, envio);
  } catch (e) {
    if (e instanceof ErroDeCofre) throw new ErroDeEntrada(e.message);
    throw e;
  }
  let out;
  try {
    out = await entregar(ctx, quem, d, enviadoNome, { nome: nomeLimpo(aberto.nome) || 'arquivo', bytes: aberto.conteudo });
  } catch (e) {
    cofre.soltar(quem.usuario, envio);
    throw e;
  }
  if (out.definitivo) cofre.apagar(quem.usuario, envio);
  else cofre.soltar(quem.usuario, envio);
  if (!out.resposta) {
    const texto = out.erro?.message ?? 'erro desconhecido';
    throw new ErroDeEntrada(
      out.definitivo
        ? `o servidor do sistema recusou o documento: ${texto}`
        : out.desatualizado
          ? 'o servidor do sistema respondeu 404: está DESATUALIZADO (ainda sem a rota /admin/v1/documento; a API 0.1.10.4 precisa ser publicada antes) ou o registro sumiu. Nada foi gravado e o arquivo continua guardado no cofre até vencer; avise o João e tente de novo depois da atualização.'
          : out.naoGravou
          ? `o servidor do sistema não aceitou agora (${texto}). Nada foi gravado e o arquivo continua guardado por alguns minutos: tente sistemas_anexar_envio de novo.`
          : `NÃO sei se o documento foi gravado (${texto}). Confira com sistemas_consultar (a pasta do registro, ou caixa_docs) e com sistemas_log ANTES de repetir.`,
    );
  }
  return {
    sistema: d.sistema,
    anexado: true,
    ...out.resposta,
    arquivoApagadoDoCofre: true,
    registro: 'Fica no registro do sistema (sistemas_log e admin_log) com o e-mail de quem pediu.',
    proximoPasso: ONDE_APARECE[d.alvo],
  };
}

/** Argumentos que vão para a auditoria do conector: identificadores sim, nome de arquivo e nomes de pessoas não. */
export function auditarDocumento(r: { ferramenta: string; argumentos?: unknown }): unknown {
  const a = (r.argumentos ?? {}) as Record<string, unknown>;
  if (r.ferramenta === 'sistemas_preparar_documento') return { sistema: a.sistema, destino: a.destino, id: a.id, trat_ref: a.trat_ref, tipo_documento: a.tipo_documento };
  return r.argumentos;
}

export function registrarDocumentosSistemas(server: McpServer, ctx: ContextoSistemas, quem: QuemSistemas, deps: DepsDocumento, auditar: Auditar): void {
  const base = () => deps.baseUrl().replace(/\/+$/, '');
  server.registerTool(
    'sistemas_preparar_documento',
    {
      title: 'Sistema novo (RH/Caixa): pedir o link para enviar um documento de colaborador, empresa, paciente ou cliente',
      description:
        'PASSO 1 de 2 para ANEXAR um DOCUMENTO (contrato, ASO, termo, ficha de sessões, alvará…) a UM registro, no mesmo lugar em que a tela do sistema o guarda. destino: ' +
        '"rh_colaborador" (pasta do colaborador; id = o id do colaborador em rh_docs, col="colaboradores"), "rh_empresa" (documentos da empresa; id da empresa, col="empresas"), ' +
        `"caixa_paciente" (documentos do paciente no Caixa; trat_ref = caixa_trat.ref do tratamento; tipo_documento: ${TIPOS_CAIXA.join(', ')}) ou "cliente_dd" (contrato do cliente da Doutor Digital; id do cliente em rh_docs, col="dd_clientes"; não sobrescreve contrato que já existe). ` +
        'Ache o id/ref ANTES com sistemas_consultar (ex.: select id, data->>\'nome\' from rh_docs where col=\'colaboradores\' and data->>\'nome\' ilike \'%maria%\'; select ref, paciente, unidade from caixa_trat where paciente ilike \'%maria%\'). ' +
        'O servidor confere que o registro existe e devolve QUEM ele é ("alvo": nome do colaborador/empresa/paciente/cliente, unidade): MOSTRE isso à pessoa e confirme que é o registro certo ANTES de entregar o link. ' +
        `Devolve o LINK DE ENVIO: de uso único, vale ${DOCUMENTO_VALE_MS / 60_000} minutos, preso a este registro, aceita PDF, JPG, PNG, DOCX ou XLSX (no Caixa só PDF, JPG ou PNG) até ${DOCUMENTO_MAX_BYTES / 1024 / 1024} MB, conferido pelo conteúdo. ` +
        'Entregue o link à pessoa (abre no celular ou computador) OU, se o arquivo está no seu ambiente e o domínio do link está liberado em Configurações > Capacidades, envie você mesma com o comando devolvido em "comandoCurl". ' +
        'Depois chame sistemas_anexar_envio com o "envio". Não grava nada ainda. tipo_documento no RH é texto livre (ex.: "ASO admissional", "Contrato social", "Atestado médico").',
      inputSchema: {
        sistema: z.string().optional().describe('qual sistema (slug); pode omitir se só há um ligado'),
        destino: z.enum(DESTINOS_DOCUMENTO),
        id: z.string().max(64).optional().describe('rh_colaborador, rh_empresa e cliente_dd: o id do registro (de sistemas_consultar)'),
        trat_ref: z.string().max(200).optional().describe('caixa_paciente: a referência do tratamento (caixa_trat.ref)'),
        tipo_documento: z.string().max(80).optional().describe(`RH: o tipo, texto livre (obrigatório). Caixa: ${TIPOS_CAIXA.join(' | ')}. cliente_dd: não precisa (é sempre o contrato)`),
        validade: z.string().max(10).optional().describe('AAAA-MM-DD, se o documento vence (só RH: colaborador e empresa)'),
        precisa_assinatura: z.boolean().optional().describe('só colaborador: marca o documento como pendente de assinatura do colaborador'),
        nome_arquivo: z.string().max(100).optional().describe('nome do arquivo que será enviado, só para montar o comando curl (ex.: aso-maria.pdf)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      executar('sistemas_preparar_documento', args, (r) => auditar({ ...r, argumentos: auditarDocumento(r) }), async () => {
        const alvo = args.destino;
        const id = args.id?.trim() ?? '';
        const tratRef = args.trat_ref?.trim() ?? '';
        const validade = args.validade?.trim() ?? '';
        let tipoDocumento = args.tipo_documento?.trim() ?? '';
        if (alvo === 'caixa_paciente') {
          if (!tratRef) throw new ErroDeEntrada('caixa_paciente precisa de trat_ref: a referência do tratamento (select ref, paciente, unidade from caixa_trat where paciente ilike …).');
          if (!(TIPOS_CAIXA as readonly string[]).includes(tipoDocumento)) throw new ErroDeEntrada(`tipo_documento do Caixa: use ${TIPOS_CAIXA.join(', ')}`);
        } else {
          if (!ID.test(id)) throw new ErroDeEntrada(`${alvo} precisa do id do registro (letras, números, - e _; de sistemas_consultar)`);
          if (alvo === 'cliente_dd') tipoDocumento = 'contrato';
          else if (tipoDocumento.length < 2) throw new ErroDeEntrada('diga o tipo do documento (ex.: "ASO admissional", "Contrato social", "Atestado médico")');
        }
        if (validade && (!dataReal(validade) || (alvo !== 'rh_colaborador' && alvo !== 'rh_empresa'))) throw new ErroDeEntrada('validade: uma data real no formato AAAA-MM-DD, e só para documento de colaborador ou de empresa');
        if (args.precisa_assinatura && alvo !== 'rh_colaborador') throw new ErroDeEntrada('precisa_assinatura só vale para documento de colaborador');
        const c = resolverSistema(ctx, args.sistema);
        const guardado: DestinoGuardado = { sistema: c.slug, alvo, id, tratRef, tipoDocumento, validade, assinar: args.precisa_assinatura === true };
        // só letras, números, ponto, hífen e sublinhado: o nome vai para o servidor e para o comando curl (entre aspas simples)
        // sem nome dado: SEM extensão (o tipo vem do conteúdo; "aso.pdf" com um JPG dentro seria recusado e queimaria o link)
        const nomeArquivo = nomeParaCurl(args.nome_arquivo ?? '') || nomeParaCurl(tipoDocumento).replace(/\./g, '-') || 'documento';
        // o servidor diz QUEM é o destino (e recusa o que não existe) ANTES de gastar um link
        const conf = (await c.fonte.chamar('POST', '/admin/v1/documento/conferir', { corpo: corpoDoDestino(guardado, quem, deps.enviadoNome, nomeArquivo), quem: quem.nome })) as Saida;
        if (!conf || conf.ok !== true || !conf.alvo || typeof conf.alvo !== 'object' || Array.isArray(conf.alvo)) throw new ErroDeEntrada('o servidor não confirmou o destino (resposta fora do contrato): nenhum link foi gerado. Avise o João; pode ser versão antiga do servidor do sistema.');
        const tipos = alvo === 'caixa_paciente' ? ACEITOS_CAIXA : ACEITOS_RH;
        let p;
        try {
          p = deps.cofre.pedirEnvio({
            userId: quem.usuario,
            // aparece na página de quem envia; sem nome de pessoa (o link é secreto, mas a página não precisa dele)
            finalidade: `${tipoDocumento} — ${ROTULO[alvo]}, em ${tipos.map((t) => t.toUpperCase()).join(', ')}`,
            validoMs: DOCUMENTO_VALE_MS,
            tipos,
            tamanhoMaxBytes: DOCUMENTO_MAX_BYTES,
            destino: {
              tipo: DESTINO_DOCUMENTO,
              sistema: c.slug,
              alvo,
              id,
              tratRef,
              tipoDocumento,
              validade,
              assinar: guardado.assinar ? 'sim' : 'nao',
            },
          });
        } catch (e) {
          if (e instanceof ErroDeCofre) throw new ErroDeEntrada(e.message);
          throw e;
        }
        const link = `${base()}/arquivos/enviar/${p.token}`;
        const nome = encodeURIComponent(nomeArquivo);
        return {
          sistema: c.slug,
          envio: p.id,
          linkDeEnvio: link,
          validoAte: iso(p.validoAte),
          validoMinutos: Math.max(1, Math.round((p.validoAte - deps.cofre.agora()) / 60_000)),
          destino: { tipo: alvo, tipoDoDocumento: tipoDocumento, ...(validade ? { validade } : {}), ...(guardado.assinar ? { precisaAssinatura: true } : {}), quemE: conf.alvo },
          aceita: tipos,
          tamanhoMaxMB: DOCUMENTO_MAX_BYTES / 1024 / 1024,
          comandoCurl: `curl -sS -X PUT --data-binary @ARQUIVO -H 'Content-Type: application/octet-stream' -H 'X-Nome-Arquivo: ${nome}' '${link}'`,
          dominioDoLink: new URL(link).host,
          proximoPasso: `Mostre à pessoa QUEM é o destino ("quemE") e só então entregue o link. Quando o arquivo tiver sido enviado (a página diz "Pronto!" ou o curl devolve {"ok":true}), chame sistemas_anexar_envio com envio="${p.id}".`,
          aviso: 'O link é de uso único e expira em poucos minutos (veja validoAte); só serve para ESTE registro. Se o ambiente não alcançar o domínio, peça à pessoa para abrir o link.',
        };
      }),
  );
}
