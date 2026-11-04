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
import { CofreDeArquivos, EXTENSOES_ACEITAS, ErroDeCofre, TIPOS_DE_MIDIA } from './cofre-arquivos.js';
import { DESTINO_TRANSCRICAO } from './transcricao-audio.js';

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
  /** o que esta pessoa pode enviar: documentos (ClickSign etc.) e/ou vídeo/áudio para transcrever (quem está em MCP_VIDEO_EMAILS) */
  pode: { documentos: boolean; midia: boolean } = { documentos: true, midia: false },
): void {
  const base = () => baseUrl().replace(/\/+$/, '');
  const maxMidiaMb = Math.floor(cofre.limites.tamanhoMaxMidiaBytes / 1024 / 1024);
  const maxMb = Math.floor(cofre.limites.tamanhoMaxBytes / 1024 / 1024);
  const aceita = EXTENSOES_ACEITAS.map((e) => `.${e}`).join(' ');

  const aceitaMidia = TIPOS_DE_MIDIA.map((e) => `.${e}`).join(' ');
  const finalidadeSchema = z.string().trim().min(3).max(200).describe('para que é, curto; aparece na página da pessoa (ex.: "contrato de admissão para assinar no ClickSign" ou "vídeo de câmera para transcrever"). Não fica no registro de auditoria');
  server.registerTool(
    'arquivo_pedir_upload',
    {
      title: 'Pedir um link para a pessoa enviar um arquivo',
      description:
        (pode.documentos
          ? 'PASSO 1 de 3 para entregar um ARQUIVO a outro conector que só aceita LINK (ex.: ClickSign, create_envelope_with_file_url). ' +
            'O claude.ai não consegue passar a outro conector um arquivo anexado na conversa; por isso a pessoa sobe o arquivo numa página nossa. ' +
            `Devolve o LINK DE ENVIO: mande-o à pessoa (abre no celular ou no computador). Vale ${Math.round(cofre.limites.envioValeMs / 60_000)} minutos e serve para UM envio só. ` +
            `Aceita ${aceita}, até ${maxMb} MB; o tipo é conferido pelo conteúdo, não pela extensão. ` +
            'O arquivo costuma ter dado pessoal sensível (CPF, endereço, salário): só peça quando a pessoa realmente vai usá-lo, e não cole o link de envio em lugar público. ' +
            'Depois que a pessoa disser que enviou, confira com arquivo_ver_envio. '
          : 'PASSO 1 de 3 para TRANSCREVER o áudio de um vídeo de câmera. Devolve o LINK DE ENVIO: mande-o à pessoa (abre no celular ou no computador). Depois que ela enviar, confira com arquivo_ver_envio e chame transcrever_audio com o id. ') +
        (pode.midia
          ? `VÍDEO OU ÁUDIO PARA TRANSCREVER: passe midia=true e finalidade "vídeo de câmera para transcrever"; aceita ${aceitaMidia}, até ${maxMidiaMb} MB (também conferido pelo conteúdo), e o arquivo só serve para transcrever_audio (não gera link de download). É imagem/áudio de funcionário: dado pessoal.`
          : ''),
      inputSchema: {
        finalidade: finalidadeSchema,
        ...(pode.midia
          ? { midia: z.boolean().optional().describe(`true = a pessoa vai enviar um vídeo/áudio (${aceitaMidia}, até ${maxMidiaMb} MB) para transcrever_audio${pode.documentos ? '; omita para documentos' : '; é o único uso permitido para você'}`) }
          : {}),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    ((args: { finalidade: string; midia?: boolean }) => {
      // quem só está na lista de vídeo NUNCA recebe o envio de documentos, mesmo passando midia=false
      const midia = pode.midia && (!pode.documentos || args.midia === true);
      // a finalidade costuma citar o nome da pessoa do contrato: na auditoria vai só o tamanho dela
      return executar('arquivo_pedir_upload', { finalidadeCaracteres: args.finalidade.length, ...(pode.midia ? { midia } : {}) }, auditar, () =>
        comoEntrada(() => {
          const p = cofre.pedirEnvio({
            userId: quem.userId,
            finalidade: args.finalidade,
            ...(midia ? { tipos: TIPOS_DE_MIDIA, destino: { tipo: DESTINO_TRANSCRICAO } } : {}),
          });
          return {
            id: p.id,
            linkDeEnvio: `${base()}/arquivos/enviar/${p.token}`,
            validoAte: iso(p.validoAte),
            validoMinutos: Math.round(cofre.limites.envioValeMs / 60_000),
            aceita: midia ? TIPOS_DE_MIDIA : EXTENSOES_ACEITAS,
            tamanhoMaxMB: Math.floor(p.tamanhoMaxBytes / 1024 / 1024),
            proximoPasso: midia
              ? 'Entregue o linkDeEnvio à pessoa. Quando ela disser que enviou, confira com arquivo_ver_envio e chame transcrever_audio com envio_id = este id.'
              : 'Entregue o linkDeEnvio à pessoa. Quando ela disser que enviou, chame arquivo_ver_envio com este id.',
            aviso: 'O link é de uso único e expira; não o publique. O arquivo é apagado sozinho em poucas horas.',
          };
        }),
      );
    }) as never,
  );

  server.registerTool(
    'arquivo_ver_envio',
    {
      title: 'Ver se o arquivo já chegou',
      description:
        'PASSO 2 de 3. Diz se o arquivo do envio (id de arquivo_pedir_upload) já chegou: estado, nome, tamanho e tipo. Nunca devolve o conteúdo. ' +
        'estado "aguardando_envio" = a pessoa ainda não enviou e o link de envio ainda vale; "recebido" = pode gerar o link com arquivo_link_temporario; ' +
        '"apagado" = acabou: o link de envio venceu sem arquivo, o último link de download expirou, passou o teto de 2 h ou foi apagado (peça um novo envio). ' +
        'Uma atualização do sistema também apaga os envios em andamento: se o id não for encontrado, peça um novo.',
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
            ...(v.arquivo ? { arquivo: { nome: v.arquivo.nome, tipo: v.arquivo.tipo, tamanhoBytes: v.arquivo.tamanhoBytes, sha256: v.arquivo.sha256, recebidoEm: iso(v.arquivo.recebidoEm) } } : {}),
            ...(v.envioValeAte ? { linkDeEnvioValeAte: iso(v.envioValeAte) } : {}),
            apagadoSozinhoAte: iso(v.apagaAte),
            links: v.links.map((l) => ({ expiraEm: iso(l.expiraEm), expiraEmMinutos: minutosAte(l.expiraEm, t), baixadas: l.baixadas, maximo: l.maximo, ativo: l.ativo })),
          };
        }),
      ),
  );

  if (pode.documentos) server.registerTool(
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
  /** quem está em MCP_VIDEO_EMAILS ganha também o envio de vídeo/áudio para transcrever (e, se só estiver nessa lista, SÓ isso) */
  midiaPermitidos: ReadonlySet<string> = new Set(),
): boolean {
  const documentos = permitidos.has(usuario);
  const midia = Boolean(usuario) && midiaPermitidos.has(usuario);
  if (!documentos && !midia) return false;
  registrarArquivos(server, cofre, { userId: usuario }, baseUrl, auditar, { documentos, midia });
  return true;
}
