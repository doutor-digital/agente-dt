/**
 * As rotas PÚBLICAS do cofre de envio (`cofre-arquivos.ts`). Quem as chama não tem login: o segredo é o token do endereço
 * (256 bits, uso único no envio; N baixadas e minutos no download). Não existe rota que liste nada.
 *
 *   GET  /arquivos/enviar/:token          a página (celular) onde a pessoa escolhe o arquivo; abrir NÃO gasta o link
 *   PUT  /arquivos/enviar/:token          o arquivo cru no corpo; o nome vai em X-Nome-Arquivo (URL-encoded)
 *   GET  /arquivos/baixar/:token/:nome    o download direto (o `:nome` é só para o conector deduzir o nome; quem manda é o token)
 *
 * O envio é `application/octet-stream`. Os parsers globais de JSON/urlencoded (server.ts) rodam antes e já teriam lido o corpo de um
 * PUT com esses tipos: por isso o PUT recusa esses dois tipos logo de cara (415) em vez de ficar esperando um corpo que não vem.
 */
import { randomBytes } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import { CofreDeArquivos, EXTENSOES_ACEITAS, ErroDeCofre } from './cofre-arquivos.js';
import { ipDoCliente, JanelaDeContagem } from './limites.js';
import { esc } from './pagina.js';

export const ROTA_ENVIO = '/arquivos/enviar/:token';
export const ROTA_BAIXA = '/arquivos/baixar/:token/:nome';

/** envios sendo recebidos ao mesmo tempo (cada um segura até o limite na memória; o container tem 1 GB) */
const ENVIOS_SIMULTANEOS = 2;
/** o corpo inteiro tem que chegar neste tempo (20 MB em 3G cabe) */
const TEMPO_MAX_DO_ENVIO_MS = 180_000;
/** downloads lendo o arquivo inteiro ao mesmo tempo (cada um segura o cifrado e o aberto: até 40 MB) */
const DOWNLOADS_SIMULTANEOS = 4;
const MENSAGEM_NAO_ACHADO = 'Arquivo não encontrado ou link vencido. Se o sistema foi atualizado há pouco, peça um novo link no Claude.';

function cabecalhosSeguros(res: Response): void {
  res.set({
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
}

export function paginaDeEnvio(o: { finalidade?: string; mensagem?: string; nonce?: string; limiteMb?: number }): string {
  const formulario = o.nonce
    ? `
  <p class="finalidade">${esc(o.finalidade ?? '')}</p>
  <label class="escolher">
    <span id="rotulo">Toque para escolher o arquivo</span>
    <input id="arquivo" type="file" accept="${EXTENSOES_ACEITAS.map((e) => `.${e}`).join(',')}">
  </label>
  <button id="enviar" type="button" disabled>Enviar</button>
  <progress id="barra" max="100" value="0" hidden></progress>
  <p id="aviso" role="status" class="aviso"></p>
  <p class="nota">Aceitamos PDF, Word (.doc/.docx), JPG, PNG e texto, até ${o.limiteMb ?? 20} MB.
  O arquivo fica guardado de forma temporária e cifrada e é apagado em até 2 horas. Este endereço serve para um envio só: não o compartilhe.</p>
  <script nonce="${o.nonce}">
  (function () {
    var LIMITE = ${(o.limiteMb ?? 20) * 1024 * 1024};
    var arq = document.getElementById('arquivo'), btn = document.getElementById('enviar'), aviso = document.getElementById('aviso');
    var barra = document.getElementById('barra'), rotulo = document.getElementById('rotulo');
    function msg(t, erro) { aviso.textContent = t; aviso.className = 'aviso' + (erro ? ' erro' : ' ok'); }
    arq.addEventListener('change', function () {
      var f = arq.files && arq.files[0];
      btn.disabled = !f;
      rotulo.textContent = f ? f.name : 'Toque para escolher o arquivo';
      msg(f && f.size > LIMITE ? 'Este arquivo passa de ${o.limiteMb ?? 20} MB.' : '', true);
      if (f && f.size > LIMITE) btn.disabled = true;
    });
    btn.addEventListener('click', function () {
      var f = arq.files && arq.files[0];
      if (!f) return;
      btn.disabled = true; arq.disabled = true; barra.hidden = false; msg('Enviando…', false);
      var x = new XMLHttpRequest();
      x.open('PUT', location.pathname);
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.setRequestHeader('X-Nome-Arquivo', encodeURIComponent(f.name));
      x.upload.onprogress = function (e) { if (e.lengthComputable) barra.value = Math.round(100 * e.loaded / e.total); };
      x.onload = function () {
        var r = {}; try { r = JSON.parse(x.responseText); } catch (e) {}
        barra.hidden = true;
        if (x.status === 200 && r.ok) { msg('Pronto! O arquivo chegou. Pode voltar ao Claude e fechar esta página.', false); btn.hidden = true; return; }
        msg(r.erro || 'Não consegui enviar. Tente de novo.', true);
        arq.disabled = false; btn.disabled = false;
      };
      x.onerror = function () { barra.hidden = true; msg('A conexão caiu. Tente de novo.', true); arq.disabled = false; btn.disabled = false; };
      x.send(f);
    });
  })();
  </script>`
    : '';
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Doutor Digital · Enviar arquivo</title>
<style>
  :root { color-scheme: light dark; --fundo:#f6f5f2; --cartao:#fff; --texto:#1d1d1b; --suave:#6b6a66; --borda:#dcdad4; --acento:#0f5c4d; --erro:#a3271b; }
  @media (prefers-color-scheme: dark) { :root { --fundo:#141413; --cartao:#1f1f1d; --texto:#ecebe7; --suave:#a3a19b; --borda:#3a3936; --acento:#5cc4a9; --erro:#f08a7e; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px 16px; background:var(--fundo); color:var(--texto); font:16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { width:100%; max-width:420px; background:var(--cartao); border:1px solid var(--borda); border-radius:12px; padding:28px 24px; }
  h1 { font-size:1.15rem; margin:0 0 12px; }
  .finalidade { margin:0 0 18px; color:var(--suave); overflow-wrap:anywhere; }
  .escolher { display:block; padding:22px 14px; border:2px dashed var(--borda); border-radius:10px; text-align:center; cursor:pointer; margin:0 0 14px; overflow-wrap:anywhere; }
  .escolher input { position:absolute; width:1px; height:1px; opacity:0; }
  button { width:100%; padding:13px; font:inherit; font-weight:600; color:#fff; background:var(--acento); border:0; border-radius:8px; cursor:pointer; }
  button:disabled { opacity:.45; cursor:default; }
  progress { width:100%; margin-top:12px; }
  .aviso { min-height:1.5em; margin:12px 0 0; font-size:.95rem; }
  .aviso.erro { color:var(--erro); } .aviso.ok { color:var(--acento); }
  .mensagem { margin:0; }
  .nota { margin:16px 0 0; color:var(--suave); font-size:.82rem; }
</style>
</head>
<body>
<main>
  <h1>Doutor Digital · Enviar arquivo</h1>
  ${o.mensagem ? `<p class="mensagem">${esc(o.mensagem)}</p>` : ''}${formulario}
</main>
</body>
</html>`;
}

export interface OpcoesDasRotas {
  /** só para os testes */
  tentativasPorIp?: JanelaDeContagem;
}

/** Liga as rotas públicas do cofre no app. Tem que vir ANTES de qualquer `app.use` que responda por tudo. */
export function montarRotasDoCofre(app: Express, cofre: CofreDeArquivos, o: OpcoesDasRotas = {}): void {
  // quem erra token demais é cortado: com 256 bits ninguém acerta, mas o log não deve encher de sondagem
  const erros = o.tentativasPorIp ?? new JanelaDeContagem(30, 10 * 60_000);
  let enviando = 0;
  let baixando = 0;
  // Um conector legítimo que insiste num link velho (de antes de um deploy, por exemplo) conta UMA vez por token, não uma por tentativa;
  // quem chuta tokens diferentes continua somando.
  const jaVistos = new JanelaDeContagem(1, 10 * 60_000);
  const sondagem = (req: Request, token: string) => {
    const ip = ipDoCliente(req);
    const t = Date.now();
    const chave = `${ip}|${token.slice(0, 64)}`;
    // com muitas chaves, a deduplicação (cuja varredura é O(n)) é largada e conta direto: quem chuta tokens não ganha CPU nossa
    if (jaVistos.tamanho < 2_000) {
      if (jaVistos.excedido(chave, t)) return;
      jaVistos.registrar(chave, t);
    }
    erros.registrar(ip, t);
  };

  const quem = (req: Request) => ({ ip: ipDoCliente(req), agente: String(req.headers['user-agent'] ?? '') });
  const bloqueado = (req: Request, res: Response): boolean => {
    if (!erros.excedido(ipDoCliente(req), Date.now())) return false;
    cabecalhosSeguros(res);
    res.status(429).set('Retry-After', '600').type('text/plain').send('Muitas tentativas. Aguarde alguns minutos.');
    return true;
  };

  app.get(ROTA_ENVIO, (req: Request, res: Response) => {
    cabecalhosSeguros(res);
    if (bloqueado(req, res)) return;
    const nonce = randomBytes(16).toString('base64');
    res.set(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    try {
      const { finalidade } = cofre.inspecionarEnvio(String(req.params.token));
      res.type('html').send(paginaDeEnvio({ finalidade, nonce, limiteMb: Math.floor(cofre.limites.tamanhoMaxBytes / 1024 / 1024) }));
    } catch (err) {
      if (!(err instanceof ErroDeCofre)) throw err;
      if (err.codigo === 'invalido') sondagem(req, String(req.params.token));
      res.status(err.status).type('html').send(paginaDeEnvio({ mensagem: err.message }));
    }
  });

  app.put(ROTA_ENVIO, async (req: Request, res: Response) => {
    cabecalhosSeguros(res);
    const falha = (status: number, erro: string) => res.status(status).set('Connection', 'close').json({ ok: false, erro });
    if (bloqueado(req, res)) return;
    if (req.is(['json', 'urlencoded'])) {
      falha(415, 'Envie o arquivo como application/octet-stream.');
      return;
    }
    const token = String(req.params.token);
    const limite = cofre.limites.tamanhoMaxBytes;
    const origem = quem(req);
    if (enviando >= ENVIOS_SIMULTANEOS) {
      res.set('Retry-After', '15');
      falha(503, 'Muitos envios ao mesmo tempo. Tente de novo em alguns segundos.');
      return;
    }
    let reserva;
    try {
      reserva = cofre.reservar(token);
    } catch (err) {
      if (!(err instanceof ErroDeCofre)) throw err;
      if (err.codigo === 'invalido') sondagem(req, token);
      falha(err.status, err.message);
      return;
    }
    enviando += 1;
    let nomeOriginal: string | undefined;
    try {
      nomeOriginal = decodeURIComponent(String(req.headers['x-nome-arquivo'] ?? '')).slice(0, 200);
    } catch {
      nomeOriginal = undefined;
    }
    let terminou = false;
    // a vaga só volta quando o corpo (que fica na memória) já foi guardado ou descartado, não quando acaba de chegar
    let vagaSolta = false;
    const soltarVaga = () => {
      if (vagaSolta) return;
      vagaSolta = true;
      enviando -= 1;
    };
    const sair = (soltar = true) => {
      if (terminou) return false;
      terminou = true;
      if (soltar) soltarVaga();
      clearTimeout(prazo);
      return true;
    };
    const prazo = setTimeout(() => {
      if (!sair()) return;
      cofre.liberar(reserva, 'demorou', origem);
      falha(408, 'O envio demorou demais. Tente de novo com uma conexão melhor.');
      pedacos.length = 0;
      res.once('finish', () => req.destroy());
    }, TEMPO_MAX_DO_ENVIO_MS);
    prazo.unref();

    const declarado = Number(req.headers['content-length']);
    if (Number.isFinite(declarado) && declarado > limite) {
      sair();
      cofre.liberar(reserva, 'grande', origem);
      falha(413, `O arquivo passa do limite de ${Math.floor(limite / 1024 / 1024)} MB.`);
      res.once('finish', () => req.destroy());
      return;
    }

    const pedacos: Buffer[] = [];
    let total = 0;
    let estourou = false;
    req.on('data', (c: Buffer) => {
      if (estourou || terminou) return; // depois do 408 (ou da queda) não guarda mais nada
      total += c.length;
      if (total > limite) {
        estourou = true;
        pedacos.length = 0;
        if (!sair()) return;
        cofre.liberar(reserva, 'grande', origem);
        falha(413, `O arquivo passa do limite de ${Math.floor(limite / 1024 / 1024)} MB.`);
        res.once('finish', () => req.destroy());
        return;
      }
      pedacos.push(c);
    });
    req.on('close', () => {
      // a conexão caiu antes do corpo inteiro chegar
      if (!req.complete && sair()) {
        pedacos.length = 0;
        cofre.liberar(reserva, 'cortou', origem);
      }
    });
    req.on('error', () => {
      if (sair()) {
        pedacos.length = 0;
        cofre.liberar(reserva, 'erro-de-rede', origem);
      }
    });
    req.on('end', () => {
      if (estourou || terminou) return;
      sair(false);
      const juntar = () => {
        const inteiro = Buffer.concat(pedacos, total);
        pedacos.length = 0; // os pedaços saem da memória; daqui em diante é uma cópia só (a cifra trabalha em fatias de 1 MB)
        return inteiro;
      };
      cofre
        .guardar(reserva, nomeOriginal, juntar(), origem)
        .then((r) => res.json({ ok: true, nome: r.nome, tamanho: r.tamanho }))
        .catch((err) => {
          if (err instanceof ErroDeCofre) falha(err.status, err.message);
          else falha(500, 'Erro ao guardar o arquivo. Tente de novo.');
        })
        .finally(soltarVaga);
    });
  });

  const baixar = async (req: Request, res: Response) => {
    cabecalhosSeguros(res);
    if (bloqueado(req, res)) return;
    const head = req.method === 'HEAD';
    if (!head && baixando >= DOWNLOADS_SIMULTANEOS) {
      res.status(503).set('Retry-After', '5').type('text/plain').send('Muitos downloads ao mesmo tempo. Tente de novo em alguns segundos.');
      return;
    }
    if (!head) baixando += 1;
    try {
      const a = await cofre.baixar(String(req.params.token), !head, quem(req));
      res.set({
        'Content-Type': a.mime,
        'Content-Length': String(a.tamanho),
        // o nome guardado só tem [A-Za-z0-9._-]: não precisa de escape
        'Content-Disposition': `attachment; filename="${a.nome}"`,
      });
      if (head) {
        res.status(200).end();
        return;
      }
      res.status(200).end(await a.ler());
    } catch (err) {
      if (!(err instanceof ErroDeCofre)) throw err;
      // só token que NÃO EXISTE conta como sondagem; link conhecido vencido/esgotado não bloqueia o IP de quem o usa
      if (err.codigo === 'invalido') sondagem(req, String(req.params.token));
      res.status(404).type('text/plain').send(MENSAGEM_NAO_ACHADO);
    } finally {
      if (!head) baixando -= 1;
    }
  };
  app.get(ROTA_BAIXA, (req, res, next) => void baixar(req, res).catch(next));
}
