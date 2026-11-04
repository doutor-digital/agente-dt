/**
 * Anexar comprovante, nota fiscal ou recibo a um lançamento do sistema novo (Caixa `caixa_lanc` ou Financeiro `fin_lanc`) pelo chat.
 * É a ponte entre o cofre de envio (`cofre-arquivos.ts`, o mesmo do ClickSign) e a rota `POST /admin/v1/anexo` do servidor do sistema, que
 * guarda o arquivo (Caixa: armazenamento do Caixa + prévias como a tela; Financeiro: documento em rh_docs col 'anexos', o formato que a tela do Financeiro abre) (contrato: docs/ADMIN-API.md do repositório sistemas-dd).
 *
 *  1. `sistemas_preparar_anexo`  confere o lançamento e devolve o LINK DE ENVIO (cofre: 256 bits, uso único, 10 min, só PDF/JPG/PNG até 15 MB,
 *                                preso ao lançamento e a quem pediu). A pessoa abre o link, ou o ambiente da Lia faz um PUT nele.
 *  2. `sistemas_anexar_envio`    pega o arquivo do cofre, entrega ao servidor do sistema e apaga do cofre. O destino (lançamento, tipo) vem do PEDIDO
 *                                do passo 1, não de argumentos: o link de um lançamento não anexa a outro.
 *  3. `sistemas_anexar_url`      o servidor BAIXA o arquivo de um endereço (lista branca de domínios, sem rede interna: ver `baixar-url.ts`) e entrega igual.
 *
 * Só quem pode escrever no sistema vê estas ferramentas (a mesma lista de `sistemas_confirmar_alteracao`). Quem anexou fica em `admin_log` e
 * `rh_log` do servidor (e-mail de quem entrou no conector) e na auditoria do conector (só tabela, tipo, lançamento e domínio; nunca o conteúdo).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { ErroSistemas } from '../lib/integracoes/sistemas.js';
import { baixarUrl, type Baixado, type OpcoesDeDownload } from './baixar-url.js';
import { CofreDeArquivos, ErroDeCofre, detectarTipo, type TipoDeArquivo } from './cofre-arquivos.js';
import { executar } from './ferramenta.js';
import { resolverSistema, type ContextoSistemas, type QuemSistemas, type Saida } from './sistemas.js';

export const TIPOS_ANEXO = ['comprovante', 'nota_fiscal', 'recibo'] as const;
type TipoAnexo = (typeof TIPOS_ANEXO)[number];
const LEGIVEL: Record<TipoAnexo, string> = { comprovante: 'comprovante de pagamento', nota_fiscal: 'nota fiscal', recibo: 'recibo' };
const TABELAS = ['caixa_lanc', 'fin_lanc'] as const;
type Tabela = (typeof TABELAS)[number];
const ACEITOS: readonly TipoDeArquivo[] = ['pdf', 'jpg', 'png'];
export const ANEXO_MAX_BYTES = 15 * 1024 * 1024;
export const ENVIO_VALE_MS = 10 * 60_000;
export const NOME_PADRAO = 'Lia (pela Suzanne)';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DESTINO_TIPO = 'anexo-lancamento';

/** O destino guardado no pedido, conferido de novo na entrega (nada de cast: um formato inesperado é recusado). */
function destinoConferido(d: Readonly<Record<string, string>> | undefined): { sistema: string; tabela: Tabela; lancamento: string; tipoAnexo: TipoAnexo } {
  if (!d || d.tipo !== DESTINO_TIPO) throw new ErroDeEntrada('esse envio não foi pedido por sistemas_preparar_anexo: não sei a que lançamento anexar. Peça um novo link por sistemas_preparar_anexo.');
  if (!d.sistema || !(TABELAS as readonly string[]).includes(d.tabela ?? '') || !(TIPOS_ANEXO as readonly string[]).includes(d.tipoAnexo ?? '') || !UUID.test(d.lancamento ?? '')) {
    throw new ErroDeEntrada('o pedido deste envio está incompleto: peça um novo link por sistemas_preparar_anexo.');
  }
  return { sistema: d.sistema, tabela: d.tabela as Tabela, lancamento: d.lancamento!, tipoAnexo: d.tipoAnexo as TipoAnexo };
}

/** Nome de arquivo que vai para o sistema: só o último trecho, sem barras, sem '..', sem caractere de controle. */
export function nomeLimpo(bruto: string): string {
  const base = bruto.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\.{2,}/g, '.').trim().slice(0, 100);
}

export interface DepsAnexo {
  cofre: CofreDeArquivos;
  /** origem pública do conector (é o domínio do link de envio) */
  baseUrl: () => string;
  /** domínios de onde o servidor pode baixar (sistemas_anexar_url) */
  dominios: readonly string[];
  /** em nome de quem o arquivo fica gravado (`caixa_docs.enviado_nome`) */
  enviadoNome?: string;
  /** só nos testes: troca a rede */
  download?: Partial<OpcoesDeDownload>;
  baixar?: (url: string, o: OpcoesDeDownload) => Promise<Baixado>;
}

const iso = (ms: number) => new Date(ms).toISOString();

function lancamentoValido(v: unknown): string {
  if (typeof v !== 'string' || !UUID.test(v.trim())) throw new ErroDeEntrada('lancamento: o id do lançamento (um uuid, como o de sistemas_consultar)');
  return v.trim().toLowerCase();
}

interface Lancamento {
  unidade: string;
  valor: unknown;
  resumo: Record<string, unknown>;
}

/** Confere que o lançamento existe (e pode receber o arquivo) ANTES de gastar um link ou um download. */
async function conferirLancamento(ctx: ContextoSistemas, quem: QuemSistemas, sistema: string | undefined, tabela: Tabela, id: string): Promise<{ slug: string; lanc: Lancamento }> {
  const c = resolverSistema(ctx, sistema);
  const sql =
    tabela === 'caixa_lanc'
      ? `select id, unidade, data, tipo, categoria, valor, forma, status from caixa_lanc where id = '${id}'`
      : `select id, unidade, data, tipo, descricao, valor, anexo from fin_lanc where id = '${id}'`;
  const r = (await c.fonte.chamar('POST', '/admin/v1/consulta', { corpo: { sql }, quem: quem.nome })) as { linhas?: Array<Record<string, unknown>> };
  const linha = r.linhas?.[0];
  if (!linha) throw new ErroDeEntrada(`não achei o lançamento ${id} em ${tabela}. Confira o id com sistemas_consultar.`);
  if (tabela === 'caixa_lanc' && linha.status === 'cancelado') throw new ErroDeEntrada('esse lançamento do Caixa está cancelado: não anexo arquivo a ele');
  if (tabela === 'fin_lanc' && linha.anexo) {
    throw new ErroDeEntrada(`esse lançamento já tem anexo (${String(linha.anexo).slice(0, 60)}). Para trocar, limpe a coluna anexo antes (sistemas_preparar_alteracao) e anexe de novo.`);
  }
  return { slug: c.slug, lanc: { unidade: String(linha.unidade ?? ''), valor: linha.valor, resumo: linha } };
}

/**
 * Entrega os bytes ao servidor do sistema. `definitivo` = o servidor respondeu com uma recusa/aceite da REGRA dele (2xx, 4xx); false = o arquivo tem que ficar.
 * 404 NÃO é recusa: é o servidor desatualizado (ainda sem a rota /admin/v1/anexo) ou algo que sumiu; o arquivo continua no cofre. 5xx e sem resposta: não sei se gravou.
 */
async function entregar(
  ctx: ContextoSistemas,
  quem: QuemSistemas,
  sistema: string,
  enviadoNome: string,
  p: { tabela: Tabela; lancamento: string; tipo: TipoAnexo; nome: string; bytes: Buffer; origem: string },
): Promise<{ definitivo: boolean; resposta?: Saida; erro?: ErroSistemas | Error; desatualizado?: boolean }> {
  const c = resolverSistema(ctx, sistema);
  try {
    const r = (await c.fonte.chamar('POST', '/admin/v1/anexo', {
      corpo: { tabela: p.tabela, id: p.lancamento, tipo: p.tipo, nome: p.nome, conteudo_b64: p.bytes.toString('base64'), enviado_nome: enviadoNome, origem: p.origem, quem: quem.nome },
      quem: quem.nome,
      timeoutMs: 120_000,
    })) as Saida;
    return { definitivo: true, resposta: r };
  } catch (e) {
    if (e instanceof ErroSistemas && e.status !== null && e.status < 500 && e.status !== 404) return { definitivo: true, erro: e };
    if (e instanceof ErroSistemas && e.status === 404) return { definitivo: false, erro: e, desatualizado: true };
    return { definitivo: false, erro: e as Error };
  }
}

function resultado(slug: string, r: Saida, extra: Record<string, unknown> = {}) {
  const caixa = r.doc_id !== null && r.doc_id !== undefined;
  return {
    sistema: slug,
    anexado: true,
    ...r,
    ...extra,
    registro: 'Fica no registro do sistema (sistemas_log: tabela caixa_docs ou fin_lanc) com o e-mail de quem pediu, e em admin_log.',
    proximoPasso: caixa
      ? r.previas > 0
        ? 'O documento está no Caixa com ia_status "aguardando"; as prévias estão em caixa_docs_prev (doc_id acima) para a conferência.'
        : 'O documento está no Caixa com ia_status "aguardando", MAS sem prévia (veja aviso_previa): não dá para conferir o conteúdo por aqui; peça um arquivo sem senha ou em outro formato.'
      : 'A coluna anexo do fin_lanc foi preenchida com o id do documento em rh_docs (col "anexos"), o formato que o botão do comprovante da tela do Financeiro abre. Não há prévia.',
  };
}

function mensagemDeFalha(e: ErroSistemas | Error | undefined, certo: boolean, desatualizado = false): string {
  const texto = e?.message ?? 'erro desconhecido';
  if (desatualizado) {
    return 'o servidor do sistema respondeu 404: está DESATUALIZADO (ainda sem a rota /admin/v1/anexo; a API 0.1.10.3 precisa ser publicada antes) ou o lançamento sumiu. Nada foi gravado e o arquivo continua guardado no cofre até vencer; avise o João e tente de novo depois da atualização.';
  }
  return certo
    ? `o servidor do sistema recusou o anexo: ${texto}`
    : `NÃO sei se o anexo foi gravado (${texto}). Confira com sistemas_consultar em caixa_docs (ou o campo anexo do fin_lanc) e com sistemas_log ANTES de repetir.`;
}

/** Argumentos que vão para a auditoria do conector: sem nome de arquivo, sem endereço completo (o código do recibo é privado). */
function auditarAnexo(auditar: Auditar): Auditar {
  return (r) => {
    const a = (r.argumentos ?? {}) as Record<string, unknown>;
    let argumentos: unknown = r.argumentos;
    if (r.ferramenta === 'sistemas_preparar_anexo') argumentos = { sistema: a.sistema, tabela: a.tabela, lancamento: a.lancamento, tipo: a.tipo };
    else if (r.ferramenta === 'sistemas_anexar_url') {
      let host = '';
      try {
        host = new URL(String(a.url)).hostname;
      } catch {
        host = '(inválida)';
      }
      argumentos = { sistema: a.sistema, tabela: a.tabela, lancamento: a.lancamento, tipo: a.tipo, host };
    }
    auditar({ ...r, argumentos });
  };
}

export function registrarAnexosSistemas(server: McpServer, ctx: ContextoSistemas, quem: QuemSistemas, deps: DepsAnexo, auditarBruto: Auditar): void {
  const auditar = auditarAnexo(auditarBruto);
  const enviadoNome = deps.enviadoNome ?? NOME_PADRAO;
  const base = () => deps.baseUrl().replace(/\/+$/, '');
  const baixar = deps.baixar ?? baixarUrl;
  const SISTEMA = z.string().optional().describe('qual sistema (slug); pode omitir se só há um ligado');
  const TABELA = z.enum(TABELAS).describe('caixa_lanc = lançamento do Caixa da unidade (cria o documento com prévia para a conferência); fin_lanc = lançamento do Financeiro (guarda o arquivo e preenche a coluna anexo)');
  const TIPO = z.enum(TIPOS_ANEXO);
  const LANC = z.string().min(36).max(36).describe('id (uuid) do lançamento, o de sistemas_consultar');

  server.registerTool(
    'sistemas_preparar_anexo',
    {
      title: 'Sistema novo (Caixa/Financeiro): pedir o link para enviar o comprovante de um lançamento',
      description:
        'PASSO 1 de 2 para ANEXAR um comprovante, nota fiscal ou recibo a UM lançamento (caixa_lanc ou fin_lanc). Confere que o lançamento existe e devolve o LINK DE ENVIO: ' +
        `de uso único, vale ${ENVIO_VALE_MS / 60_000} minutos, preso a este lançamento e a este tipo, aceita só PDF, JPG ou PNG até ${ANEXO_MAX_BYTES / 1024 / 1024} MB (conferido pelo conteúdo). ` +
        'Entregue o link à pessoa (abre no celular ou computador) OU, se você tem o arquivo no seu ambiente e o domínio do link está liberado em Configurações > Capacidades, ' +
        'envie você mesma com o comando devolvido em "comandoCurl". Depois chame sistemas_anexar_envio com o "envio". Não grava nada ainda. ' +
        'Se o arquivo está num endereço (recibo da InfinitePay, boleto do Asaas), use sistemas_anexar_url em vez deste. Não cole o link de envio em lugar público.',
      inputSchema: { sistema: SISTEMA, tabela: TABELA, lancamento: LANC, tipo: TIPO, nome_arquivo: z.string().max(100).optional().describe('nome do arquivo que será enviado, só para montar o comando curl (ex.: recibo-pix.pdf)') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      executar('sistemas_preparar_anexo', args, auditar, async () => {
        const id = lancamentoValido(args.lancamento);
        const { slug, lanc } = await conferirLancamento(ctx, quem, args.sistema, args.tabela, id);
        let p;
        try {
          p = deps.cofre.pedirEnvio({
            userId: quem.usuario,
            // aparece na página de quem envia: unidade e valor ajudam a conferir que é o lançamento certo; nada de nome de paciente
            finalidade: `${LEGIVEL[args.tipo]} do lançamento de ${lanc.valor} (${lanc.unidade}), em PDF, JPG ou PNG`,
            validoMs: ENVIO_VALE_MS,
            tipos: ACEITOS,
            tamanhoMaxBytes: ANEXO_MAX_BYTES,
            destino: { tipo: DESTINO_TIPO, sistema: slug, tabela: args.tabela, lancamento: id, tipoAnexo: args.tipo },
          });
        } catch (e) {
          if (e instanceof ErroDeCofre) throw new ErroDeEntrada(e.message);
          throw e;
        }
        const link = `${base()}/arquivos/enviar/${p.token}`;
        // sem nome dado: SEM extensão (o tipo vem do conteúdo; "comprovante.pdf" com um PNG dentro seria recusado e queimaria o link)
        const nome = encodeURIComponent((args.nome_arquivo ?? args.tipo).replace(/[\r\n]/g, ' '));
        return {
          sistema: slug,
          envio: p.id,
          linkDeEnvio: link,
          validoAte: iso(p.validoAte),
          validoMinutos: Math.max(1, Math.round((p.validoAte - deps.cofre.agora()) / 60_000)),
          lancamento: { tabela: args.tabela, id, tipoDoAnexo: args.tipo, linha: lanc.resumo },
          aceita: ['pdf', 'jpg', 'png'],
          tamanhoMaxMB: ANEXO_MAX_BYTES / 1024 / 1024,
          comandoCurl: `curl -sS -X PUT --data-binary @ARQUIVO -H 'Content-Type: application/octet-stream' -H 'X-Nome-Arquivo: ${nome}' '${link}'`,
          dominioDoLink: new URL(link).host,
          proximoPasso: `Quando o arquivo tiver sido enviado (a página diz "Pronto!" ou o curl devolve {"ok":true}), chame sistemas_anexar_envio com envio="${p.id}".`,
          aviso: 'O link é de uso único e expira em poucos minutos (veja validoAte); só serve para ESTE lançamento. Se o ambiente não alcançar o domínio, peça à pessoa para abrir o link.',
        };
      }),
  );

  server.registerTool(
    'sistemas_anexar_envio',
    {
      title: 'Sistema novo (Caixa/Financeiro): anexar o arquivo enviado ao lançamento',
      description:
        'PASSO 2 de 2. Pega o arquivo que chegou pelo link de sistemas_preparar_anexo e o anexa ao lançamento daquele pedido (o destino vem do pedido, não daqui): ' +
        'grava no armazenamento do Caixa (unidade/AAAA-MM/uuid-nome), cria o documento em caixa_docs com ia_status "aguardando" e as prévias em caixa_docs_prev (lançamento do Caixa) ' +
        'ou, em fin_lanc, grava o documento em rh_docs (col anexos) e preenche a coluna anexo com o id dele (o que o botão do comprovante da tela abre; sem prévia). Depois apaga o arquivo do cofre. Se o arquivo ainda não chegou, diz isso (peça para enviar e chame de novo). ' +
        'Uma vez só por envio. Registra quem anexou. Confira antes com a pessoa que o lançamento é o certo.',
      inputSchema: { envio: z.string().trim().min(8).max(64).describe('o "envio" devolvido por sistemas_preparar_anexo') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      executar('sistemas_anexar_envio', args, auditar, async () => {
        let d;
        let dest;
        try {
          dest = destinoConferido(deps.cofre.destinoDe(quem.usuario, args.envio));
          // `abrir` marca o envio como em uso antes de qualquer espera: uma segunda chamada ao mesmo tempo é recusada (nada de anexo em dobro)
          d = await deps.cofre.abrir(quem.usuario, args.envio);
        } catch (e) {
          if (e instanceof ErroDeCofre) throw new ErroDeEntrada(e.message);
          throw e;
        }
        let out;
        try {
          out = await entregar(ctx, quem, dest.sistema, enviadoNome, { tabela: dest.tabela, lancamento: dest.lancamento, tipo: dest.tipoAnexo, nome: nomeLimpo(d.nome) || 'arquivo', bytes: d.conteudo, origem: 'envio' });
        } catch (e) {
          deps.cofre.soltar(quem.usuario, args.envio);
          throw e;
        }
        // o servidor respondeu (aceitou ou recusou): o arquivo não tem mais o que fazer no cofre. Sem resposta: fica, para tentar de novo depois de conferir.
        if (out.definitivo) deps.cofre.apagar(quem.usuario, args.envio);
        else deps.cofre.soltar(quem.usuario, args.envio);
        if (!out.resposta) throw new ErroDeEntrada(mensagemDeFalha(out.erro, out.definitivo, out.desatualizado));
        return resultado(dest.sistema, out.resposta, { origem: 'envio', arquivoApagadoDoCofre: true });
      }),
  );

  server.registerTool(
    'sistemas_anexar_url',
    {
      title: 'Sistema novo (Caixa/Financeiro): anexar a um lançamento o arquivo de um endereço',
      description:
        'O SERVIDOR baixa o comprovante de um endereço e o anexa ao lançamento (caixa_lanc ou fin_lanc) como sistemas_anexar_envio — para quando o seu ambiente não alcança o site. ' +
        `Só domínios da lista: ${deps.dominios.join(', ')} (outro só o João libera, no servidor). Só https, sem redirecionar para fora da lista, sem rede interna, até ${ANEXO_MAX_BYTES / 1024 / 1024} MB e 25 segundos. ` +
        'O endereço tem que levar DIRETO a um PDF, JPG ou PNG. Uma PÁGINA (HTML) não vale: o servidor não tem navegador para imprimir a página em PDF; nesse caso peça à pessoa o PDF ou um print e use sistemas_preparar_anexo. ' +
        'Grava direto (sem prévia de confirmação): confira o lançamento com a pessoa antes.',
      inputSchema: { sistema: SISTEMA, tabela: TABELA, lancamento: LANC, tipo: TIPO, url: z.string().url().max(2000).describe('endereço https do arquivo') },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      executar('sistemas_anexar_url', args, auditar, async () => {
        const id = lancamentoValido(args.lancamento);
        const { slug } = await conferirLancamento(ctx, quem, args.sistema, args.tabela, id);
        const b = await baixar(args.url, { dominios: deps.dominios, ...deps.download });
        const tipo = detectarTipo(b.bytes);
        if (tipo !== 'pdf' && tipo !== 'jpg' && tipo !== 'png') {
          const html = b.contentType.includes('html') || /^\s*</.test(b.bytes.subarray(0, 64).toString('utf8'));
          throw new ErroDeEntrada(
            html
              ? `o endereço (${b.host}) devolveu uma PÁGINA da web, não um arquivo. O servidor não tem navegador para imprimir a página em PDF. Peça à pessoa o PDF ou um print (JPG/PNG) e use sistemas_preparar_anexo.`
              : `o endereço (${b.host}) não devolveu PDF, JPG nem PNG (conteúdo: ${b.contentType || 'desconhecido'}).`,
          );
        }
        // a extensão vem do CONTEÚDO, não do endereço (".../recibo.png" que entrega um PDF vira recibo.pdf)
        const sugerido = nomeLimpo(b.nomeSugerido).replace(/\.(pdf|jpe?g|png)$/i, '');
        const nome = `${(sugerido || args.tipo).slice(0, 90)}.${tipo}`;
        const out = await entregar(ctx, quem, slug, enviadoNome, { tabela: args.tabela, lancamento: id, tipo: args.tipo, nome, bytes: b.bytes, origem: `url:${b.host}` });
        if (!out.resposta) throw new ErroDeEntrada(mensagemDeFalha(out.erro, out.definitivo, out.desatualizado));
        return resultado(slug, out.resposta, { origem: `baixado de ${b.host}`, tamanhoBaixado: b.bytes.length });
      }),
  );
}
