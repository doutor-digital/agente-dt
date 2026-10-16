/**
 * Cofre das chaves de API de terceiros (Asaas, ClickSign): AES-256-GCM. A chave do Asaas também move
 * dinheiro, então nunca fica em texto puro no banco nem volta em resposta nenhuma.
 *
 * A chave-mestra sai de `INTEGRACOES_CHAVE_MESTRA` quando existe; senão é derivada do SESSION_JWT_SECRET
 * (trocar esse segredo invalida as chaves guardadas — aí é colar de novo no painel).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function mestra(segredo: string): Buffer {
  return createHash('sha256').update(`cofre-integracoes:${segredo}`).digest();
}

/** Texto cifrado no formato `v1.<iv>.<tag>.<dados>`, tudo em base64url. */
export function cifrar(texto: string, segredo: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', mestra(segredo), iv);
  const dados = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), dados.toString('base64url')].join('.');
}

export function decifrar(cifrado: string, segredo: string): string {
  const [v, iv, tag, dados] = cifrado.split('.');
  if (v !== 'v1' || !iv || !tag || !dados) throw new Error('chave guardada em formato desconhecido');
  const d = createDecipheriv('aes-256-gcm', mestra(segredo), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(dados, 'base64url')), d.final()]).toString('utf8');
}

/** Os 4 últimos caracteres, para a tela mostrar QUAL chave está salva sem mostrar a chave. */
export function finalDaChave(chave: string): string {
  return chave.length > 8 ? `…${chave.slice(-4)}` : '…';
}
