/**
 * Ferramentas do claude.ai para passar um ARQUIVO a outro conector que só aceita LINK (ex.: ClickSign, `create_envelope_with_file_url`).
 * O claude.ai não consegue entregar a um conector um arquivo anexado na conversa. Aqui a pessoa sobe o arquivo numa página
 * nossa (`arquivo_pedir_upload`), conferimos que ele chegou (`arquivo_ver_envio`) e damos um link de download curto
 * (`arquivo_link_temporario`) para o outro conector. O cofre, as regras e as rotas públicas estão em `cofre-arquivos.ts`
 * e `cofre-http.ts`.
 *
 * Quem vê estas ferramentas: o portão `registrarArquivosSePermitido` (a lista de quem envia arquivos; em produção, quem está
 * em MCP_ESCRITA_EMAILS ou MCP_ARQUIVOS_EMAILS). Fora da lista elas nem existem na sessão. Dentro dela, cada envio é só
 * do usuário que o pediu.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Auditar } from '../franquia-mcp/ferramentas.js';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';
import { executar } from './ferramenta.js';
import { CofreDeArquivos, EXTENSOES_ACEITAS, ErroDeCofre } from './cofre-arquivos.js';

const iso = (ms: number) => new Date(ms).toISOString();
const minutosAte = (ms: number, agora: number) => Math.max(0, Math.round((ms - agora) / 60_000));

/** Erro do cofre vira erro de entrada (com a mensagem em português que a pessoa pode ler) */
async function comoEntrada<T>(fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ErroDeCofre) throw new ErroDeEntrada(e.message);
    throw e;
  }
}

export function registrarArquivos(
  server: McpServer,
  cofre: CofreDeArquivos,
  quem: { userId: string },
  baseUrl: () => string,
  auditar: Auditar,
): void {
  const base = () => baseUrl().replace(/\/+$/, '');
  const maxMb = Math.floor(cofre.limites.tamanhoMaxBytes / 1024 / 1024);
  const aceita = EXTENSOES_ACEITAS.map((e) => `.${e}`).join(' ');

  server.registerTool(
    'arquivo_pedir_upload',
    {
      title: 'Pedir um link para a pessoa enviar um arquivo',
      description:
        'PASSO 1 de 3 para entregar um ARQUIVO a outro conector que só aceita LINK (ex.: ClickSign, create_envelope_with_file_url). ' +
        'O claude.ai não consegue passar a outro conector um arquivo anexado na conversa; por isso a pessoa sobe o arquivo numa página nossa. ' +
        `Devolve o LINK DE ENVIO: mande-o à pessoa (abre no celular ou no computador). Vale ${Math.round(cofre.limites.envioValeMs / 60_000)} minutos e serve para UM envio só. ` +
        `Aceita ${aceita}, até ${maxMb} MB; o tipo é conferido pelo conteúdo, não pela extensão. ` +
        'O arquivo costuma ter dado pessoal sensível (CPF, endereço, salário): só peça quando a pessoa realmente vai usá-lo, e não cole o link de envio em lugar público. ' +
        'Depois que a pessoa disser que enviou, confira com arquivo_ver_envio.',
      inputSchema: {
        finalidade: z.string().trim().min(3).max(200).describe('para que é, curto, aparece na página da pessoa (ex.: "contrato de admissão da Maria para assinar no ClickSign")'),
        nome_sugerido: z.string().trim().max(120).optional().describe('opcional: como a pessoa deve chamar o arquivo; só orientação, o nome final vem do arquivo'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      executar('arquivo_pedir_upload', args, auditar, () =>
        comoEntrada(() => {
          const p = cofre.pedirEnvio({ userId: quem.userId, finalidade: args.finalidade, nomeSugerido: args.nome_sugerido });
          return {
            id: p.id,
            linkDeEnvio: `${base()}/arquivos/enviar/${p.token}`,
            validoAte: iso(p.validoAte),
            validoMinutos: Math.round(cofre.limites.envioValeMs / 60_000),
            aceita: EXTENSOES_ACEITAS,
            tamanhoMaxMB: maxMb,
            proximoPasso: 'Entregue o linkDeEnvio à pessoa. Quando ela disser que enviou, chame arquivo_ver_envio com este id.',
            aviso: 'O link é de uso único e expira; não o publique. O arquivo é apagado sozinho em poucas horas.',
          };
        }),
      ),
  );

  server.registerTool(
    'arquivo_ver_envio',
    {
      title: 'Ver se o arquivo já chegou',
      description:
        'PASSO 2 de 3. Diz se o arquivo do envio (id de arquivo_pedir_upload) já chegou: estado, nome, tamanho e tipo. Nunca devolve o conteúdo. ' +
        'estado "aguardando_envio" = a pessoa ainda não enviou (ou o link venceu); "recebido" = pode gerar o link com arquivo_link_temporario; "apagado" = venceu ou foi apagado, peça um novo envio.',
      inputSchema: { id: z.string().trim().min(8).max(64).describe('o id devolvido por arquivo_pedir_upload') },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) =>
      executar('arquivo_ver_envio', args, auditar, () =>
        comoEntrada(() => {
          const v = cofre.ver(quem.userId, args.id);
          const t = cofre.agora();
          return {
            id: v.id,
            estado: v.estado,
            finalidade: v.finalidade,
            ...(v.arquivo ? { arquivo: { nome: v.arquivo.nome, tipo: v.arquivo.tipo, tamanhoBytes: v.arquivo.tamanhoBytes, recebidoEm: iso(v.arquivo.recebidoEm) } } : {}),
            ...(v.envioValeAte ? { linkDeEnvioValeAte: iso(v.envioValeAte) } : {}),
            apagadoSozinhoAte: iso(v.apagaAte),
            links: v.links.map((l) => ({ expiraEm: iso(l.expiraEm), expiraEmMinutos: minutosAte(l.expiraEm, t), baixadas: l.baixadas, maximo: l.maximo, ativo: l.ativo })),
          };
        }),
      ),
  );

  server.registerTool(
    'arquivo_link_temporario',
    {
      title: 'Gerar o link de download do arquivo (para outro conector)',
      description:
        'PASSO 3 de 3. Devolve uma URL https de DOWNLOAD direto do arquivo recebido, com o nome e a extensão certos no caminho: ' +
        'cole-a onde o outro conector pede um link de arquivo (ex.: file_url do create_envelope_with_file_url do ClickSign). ' +
        `O link expira (padrão ${cofre.limites.linkPadraoMin} min, no máximo ${cofre.limites.linkMaxMin}) e abre no máximo ${cofre.limites.baixadasMax} vezes; ` +
        'quando o último link expira, o arquivo é APAGADO. Use logo, na mesma conversa. Não cole o link em lugar público nem o repita desnecessariamente. ' +
        'Se o outro conector falhar, dá para gerar outro link enquanto o arquivo existir.',
      inputSchema: {
        id: z.string().trim().min(8).max(64).describe('o id devolvido por arquivo_pedir_upload (o arquivo já tem que ter chegado)'),
        minutos: z.number().int().min(1).max(cofre.limites.linkMaxMin).optional().describe(`validade em minutos (padrão ${cofre.limites.linkPadraoMin}, máximo ${cofre.limites.linkMaxMin})`),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    (args) =>
      executar('arquivo_link_temporario', args, auditar, () =>
        comoEntrada(() => {
          const l = cofre.gerarLink(quem.userId, args.id, args.minutos);
          return {
            url: `${base()}/arquivos/baixar/${l.token}/${encodeURIComponent(l.nome)}`,
            nome: l.nome,
            expiraEm: iso(l.expiraEm),
            expiraEmMinutos: minutosAte(l.expiraEm, cofre.agora()),
            baixadasMaximas: l.baixadasMax,
            aviso: 'Use agora no outro conector. O link expira, abre poucas vezes e o arquivo é apagado depois; não o cole em lugar público.',
          };
        }),
      ),
  );

  server.registerTool(
    'arquivo_apagar',
    {
      title: 'Apagar o arquivo agora',
      description: 'Apaga já o arquivo do envio e invalida os links dele. Use assim que o outro conector terminar de usar o arquivo (ex.: o envelope do ClickSign foi criado). Só apaga arquivos que você mesmo enviou.',
      inputSchema: { id: z.string().trim().min(8).max(64).describe('o id devolvido por arquivo_pedir_upload') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    (args) => executar('arquivo_apagar', args, auditar, () => comoEntrada(() => ({ id: args.id, apagado: cofre.apagar(quem.userId, args.id) }))),
  );
}

/**
 * O portão de quem envia arquivos: só quem está na lista (já resolvida em ids de usuário) ganha as ferramentas. Fora dela elas
 * nem existem na sessão — não aparecem e não podem ser chamadas. Devolve se registrou.
 */
export function registrarArquivosSePermitido(
  server: McpServer,
  cofre: CofreDeArquivos,
  usuario: string,
  permitidos: ReadonlySet<string>,
  baseUrl: () => string,
  auditar: Auditar,
): boolean {
  if (!permitidos.has(usuario)) return false;
  registrarArquivos(server, cofre, { userId: usuario }, baseUrl, auditar);
  return true;
}
