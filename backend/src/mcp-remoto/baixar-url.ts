/**
 * O SERVIDOR baixa um arquivo de um endereço que a Lia (ou qualquer pessoa no claude.ai) escolheu — é o risco clássico de SSRF
 * (OWASP A01/A10): quem escolhe a URL poderia apontar para a rede interna (a API do sistema novo, o banco, o endereço de metadados da nuvem).
 * O que segura:
 *  - LISTA BRANCA de domínios. Padrão: recibo.infinitepay.io, asaas.com e *.asaas.com. Outro domínio só entra pela variável de ambiente
 *    `ANEXO_URL_DOMINIOS` (decisão do João no servidor); nunca por argumento de ferramenta.
 *  - Só https, porta 443, sem usuário/senha na URL, nada de IP escrito no lugar do nome.
 *  - O nome é resolvido AQUI e a conexão vai para o IP que passou na checagem (a mesma resolução serve à checagem e à conexão:
 *    não há segunda consulta de DNS para um "rebind" trocar o destino). Todo IP devolvido tem que ser público: loopback, rede privada,
 *    link-local (169.254.x.x, onde mora o metadado da nuvem), CGNAT, multicast, IPv6 único-local e IPv4 embutido em IPv6 são recusados.
 *  - Redirecionamento: seguido à mão, no máximo 3, e CADA destino passa de novo por tudo acima (um redirect para fora da lista é recusado).
 *  - Limite de tamanho (lido aos pedaços; corta no limite, sem confiar em Content-Length) e de tempo (total, não por pedaço).
 *  - Sem cookie, sem Authorization, sem compressão (Accept-Encoding: identity: nada de bomba de descompressão).
 *  - Quem decide o que o arquivo é, é quem recebe (o servidor do sistema confere o CONTEÚDO); aqui só se recusa HTML com uma explicação.
 */
import dns from 'node:dns';
import { isIP } from 'node:net';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { ErroDeEntrada } from '../franquia-mcp/travas.js';

export const DOMINIOS_PADRAO = ['recibo.infinitepay.io', 'asaas.com', '*.asaas.com'] as const;
export const LIMITES_DOWNLOAD = { maxBytes: 15 * 1024 * 1024, tempoTotalMs: 25_000, redirecionamentos: 3 };

/** Os domínios aceitos: o padrão mais o que o João liberar na variável (separados por vírgula). Entradas fora do formato são ignoradas. */
export function dominiosPermitidos(amb: Record<string, string | undefined>): string[] {
  const extras = (amb.ANEXO_URL_DOMINIOS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d));
  return [...new Set([...DOMINIOS_PADRAO, ...extras])];
}

/** `*.asaas.com` casa www.asaas.com e a.b.asaas.com, mas não asaas.com (que tem entrada própria) nem evilasaas.com. */
export function hostPermitido(host: string, lista: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return lista.some((d) => (d.startsWith('*.') ? h.endsWith(d.slice(1)) && h.length > d.length - 1 : h === d));
}

// ---------------------------------------------------------------------------------------------- IP público?

function ipv4EmNumero(ip: string): number | null {
  const p = ip.split('.');
  if (p.length !== 4 || p.some((x) => !/^\d{1,3}$/.test(x) || Number(x) > 255)) return null;
  return ((Number(p[0]) << 24) | (Number(p[1]) << 16) | (Number(p[2]) << 8) | Number(p[3])) >>> 0;
}

const FAIXAS_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // "esta rede"
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, metadado da nuvem
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reservado + broadcast
];

/** true = não é um endereço público da internet (ou não consegui entender: na dúvida, recusa). */
export function ipPrivado(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const n = ipv4EmNumero(ip);
    if (n === null) return true;
    return FAIXAS_V4.some(([base, bits]) => {
      const b = ipv4EmNumero(base)!;
      const mascara = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (n & mascara) >>> 0 === (b & mascara) >>> 0;
    });
  }
  if (v === 6) {
    const baixo = ip.toLowerCase().split('%')[0]!;
    // IPv4 escrito dentro de IPv6 (::ffff:10.0.0.1, ::10.0.0.1, 64:ff9b::10.0.0.1): vale a regra do IPv4
    const embutido = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(baixo);
    if (embutido) return ipPrivado(embutido[1]!);
    if (baixo === '::' || baixo === '::1') return true;
    const grupos = expandirV6(baixo);
    if (!grupos) return true;
    const g0 = grupos[0]!;
    // ::ffff:a00:1 (o mesmo IPv4 em hexadecimal)
    if (grupos.slice(0, 5).every((x) => x === 0) && grupos[5] === 0xffff) return ipPrivado(`${grupos[6]! >> 8}.${grupos[6]! & 255}.${grupos[7]! >> 8}.${grupos[7]! & 255}`);
    if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 único-local
    if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((g0 & 0xff00) === 0xff00) return true; // multicast
    if (g0 === 0x2001 && grupos[1] === 0x0db8) return true; // documentação
    if (g0 === 0x64 && grupos[1] === 0xff9b) return true; // 64:ff9b::/96 (NAT64): o destino real é um IPv4 embutido
    if (g0 === 0x2002) return true; // 6to4 (idem)
    return false;
  }
  return true;
}

function expandirV6(ip: string): number[] | null {
  const partes = ip.split('::');
  if (partes.length > 2) return null;
  const lado = (t: string) => (t === '' ? [] : t.split(':'));
  const a = lado(partes[0]!);
  const b = partes.length === 2 ? lado(partes[1]!) : [];
  const falta = 8 - a.length - b.length;
  if ((partes.length === 1 && falta !== 0) || falta < 0) return null;
  const todos = [...a, ...Array(partes.length === 2 ? falta : 0).fill('0'), ...b];
  if (todos.length !== 8 || todos.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return null;
  return todos.map((x) => parseInt(x, 16));
}

// ---------------------------------------------------------------------------------------------- baixar

export interface Resolvedor {
  (host: string): Promise<string[]>;
}
const resolverDeVerdade: Resolvedor = async (host) => (await dns.promises.lookup(host, { all: true, verbatim: true })).map((r) => r.address);

/** Uma resposta crua (sem seguir redirect): quem chama decide. Separada para os testes trocarem a rede por um servidor de mentira. */
export interface Resposta {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** lê o corpo até `max` bytes; passou do limite → lança */
  corpo(max: number): Promise<Buffer>;
  descartar(): void;
}
export type Requisitar = (u: URL, ip: string, tempoMs: number) => Promise<Resposta>;

/** O pedido de verdade: conecta no IP já verificado e fala TLS com o NOME (certificado e SNI do domínio). */
const requisitarHttps: Requisitar = (u, ip, tempoMs) =>
  new Promise((ok, falha) => {
    const req = https.request(
      {
        host: u.hostname,
        port: 443,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        servername: u.hostname,
        // o ÚNICO lugar onde o nome vira IP: devolve o que já foi verificado
        lookup: ((_h: string, opcoes: { all?: boolean }, cb: (...a: unknown[]) => void) => (opcoes?.all ? cb(null, [{ address: ip, family: isIP(ip) }]) : cb(null, ip, isIP(ip)))) as never,
        headers: { 'User-Agent': 'DoutorDigital-Anexos/1.0', Accept: 'application/pdf,image/png,image/jpeg;q=0.9,*/*;q=0.1', 'Accept-Encoding': 'identity' },
        timeout: tempoMs,
      },
      (res: IncomingMessage) => {
        ok({
          status: res.statusCode ?? 0,
          headers: res.headers,
          corpo: (max) =>
            new Promise<Buffer>((resolve, reject) => {
              const partes: Buffer[] = [];
              let total = 0;
              res.on('data', (c: Buffer) => {
                total += c.length;
                if (total > max) {
                  res.destroy();
                  reject(new ErroDeEntrada(`o arquivo passa do limite de ${Math.floor(max / 1024 / 1024)} MB`));
                  return;
                }
                partes.push(c);
              });
              res.on('end', () => resolve(Buffer.concat(partes, total)));
              res.on('error', reject);
              res.on('aborted', () => reject(new Error('conexão cortada')));
            }),
          descartar: () => res.destroy(),
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('tempo esgotado')));
    req.on('error', falha);
    req.end();
  });

export interface OpcoesDeDownload {
  dominios: readonly string[];
  maxBytes?: number;
  tempoTotalMs?: number;
  redirecionamentos?: number;
  resolver?: Resolvedor;
  requisitar?: Requisitar;
  agora?: () => number;
}

export interface Baixado {
  bytes: Buffer;
  /** só o domínio, para o registro (o endereço inteiro pode ter o código do recibo) */
  host: string;
  contentType: string;
  /** nome sugerido pelo último trecho do caminho, sem pasta */
  nomeSugerido: string;
}

function validar(bruta: string, dominios: readonly string[]): URL {
  let u: URL;
  try {
    u = new URL(bruta);
  } catch {
    throw new ErroDeEntrada('url inválida');
  }
  if (u.protocol !== 'https:') throw new ErroDeEntrada('só aceito endereço https://');
  if (u.username || u.password) throw new ErroDeEntrada('o endereço não pode ter usuário e senha');
  if (u.port && u.port !== '443') throw new ErroDeEntrada('só a porta padrão (443)');
  const host = u.hostname.toLowerCase();
  if (isIP(host.replace(/^\[|\]$/g, '')) || /^[\d.]+$/.test(host)) throw new ErroDeEntrada('use o endereço com nome do site, não um número de IP');
  if (!hostPermitido(host, dominios)) {
    throw new ErroDeEntrada(`o domínio ${host.slice(0, 80)} não está na lista permitida (${dominios.join(', ')}). Para liberar outro, só o João, no servidor (ANEXO_URL_DOMINIOS).`);
  }
  return u;
}

export async function baixarUrl(bruta: string, o: OpcoesDeDownload): Promise<Baixado> {
  const maxBytes = o.maxBytes ?? LIMITES_DOWNLOAD.maxBytes;
  const total = o.tempoTotalMs ?? LIMITES_DOWNLOAD.tempoTotalMs;
  const maxSaltos = o.redirecionamentos ?? LIMITES_DOWNLOAD.redirecionamentos;
  const resolver = o.resolver ?? resolverDeVerdade;
  const requisitar = o.requisitar ?? requisitarHttps;
  const agora = o.agora ?? Date.now;
  const fim = agora() + total;
  const restante = () => {
    const r = fim - agora();
    if (r <= 0) throw new ErroDeEntrada('o site demorou demais para responder');
    return r;
  };

  let atual = validar(bruta, o.dominios);
  for (let salto = 0; ; salto++) {
    let ips: string[];
    try {
      ips = await resolver(atual.hostname);
    } catch {
      throw new ErroDeEntrada(`não consegui encontrar o site ${atual.hostname}`);
    }
    if (ips.length === 0) throw new ErroDeEntrada(`não consegui encontrar o site ${atual.hostname}`);
    // TODOS os endereços têm que ser públicos: um nome que também aponta para a rede interna é recusado inteiro
    if (ips.some(ipPrivado)) throw new ErroDeEntrada(`o site ${atual.hostname} aponta para um endereço interno: recusado`);
    let resp: Resposta;
    try {
      resp = await Promise.race([
        requisitar(atual, ips[0]!, restante()),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('tempo esgotado')), restante()).unref()),
      ]);
    } catch (e) {
      if (e instanceof ErroDeEntrada) throw e;
      throw new ErroDeEntrada(`não consegui baixar de ${atual.hostname} (${e instanceof Error ? e.message.slice(0, 60) : 'erro de rede'})`);
    }
    if ([301, 302, 303, 307, 308].includes(resp.status)) {
      resp.descartar();
      const destino = resp.headers.location;
      if (typeof destino !== 'string' || !destino) throw new ErroDeEntrada('o site mandou redirecionar sem dizer para onde');
      if (salto >= maxSaltos) throw new ErroDeEntrada('redirecionamentos demais');
      let proximo: string;
      try {
        proximo = new URL(destino, atual).toString();
      } catch {
        throw new ErroDeEntrada('o site mandou um redirecionamento inválido');
      }
      // o destino passa por TUDO de novo: um redirect para fora da lista (ou para IP interno) morre aqui
      atual = validar(proximo, o.dominios);
      continue;
    }
    if (resp.status !== 200) {
      resp.descartar();
      throw new ErroDeEntrada(`o site respondeu ${resp.status}: o link não abre o arquivo (venceu, é privado ou está errado)`);
    }
    const declarado = Number(resp.headers['content-length']);
    if (Number.isFinite(declarado) && declarado > maxBytes) {
      resp.descartar();
      throw new ErroDeEntrada(`o arquivo passa do limite de ${Math.floor(maxBytes / 1024 / 1024)} MB`);
    }
    let bytes: Buffer;
    try {
      bytes = await Promise.race([
        resp.corpo(maxBytes),
        new Promise<never>((_, rej) => setTimeout(() => { resp.descartar(); rej(new ErroDeEntrada('o site demorou demais para mandar o arquivo')); }, restante()).unref()),
      ]);
    } catch (e) {
      if (e instanceof ErroDeEntrada) throw e;
      throw new ErroDeEntrada('a conexão com o site caiu no meio do download');
    }
    const ct = String(resp.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    let ultimo = atual.pathname.split('/').filter(Boolean).pop() ?? '';
    try {
      ultimo = decodeURIComponent(ultimo);
    } catch {
      // fica como veio
    }
    ultimo = ultimo.slice(0, 100);
    return { bytes, host: atual.hostname, contentType: ct, nomeSugerido: ultimo };
  }
}
