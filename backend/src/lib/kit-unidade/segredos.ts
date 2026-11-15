/**
 * O cofre do kit: onde caem os segredos que o `--aplicar` gera (o token do usuário conector da clínica, o token do robô Sofia). Um arquivo
 * por segredo em `KIT_SEGREDOS_DIR` (modo 600, pasta 700); o João move para o arquivo de segredos da VPS e para o env do serviço. O valor NUNCA é
 * impresso. Conferir se um segredo existe olha o cofre e o ambiente do processo.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ErroDaPorta, type SegredosPorta } from './portas.js';

const NOME_OK = /^[A-Z][A-Z0-9_]{2,80}$/;

export function segredosEmArquivo(pasta: string | null, env: NodeJS.ProcessEnv = process.env): SegredosPorta {
  const arquivo = (nome: string) => {
    if (!NOME_OK.test(nome)) throw new ErroDaPorta(`nome de segredo inválido: ${nome}`);
    if (!pasta) throw new ErroDaPorta('KIT_SEGREDOS_DIR não está definida: sem o cofre o segredo gerado se perderia — defina a pasta (modo 700) e rode de novo');
    return join(pasta, nome);
  };
  const lerArquivo = (nome: string): string | null => {
    const f = arquivo(nome);
    return existsSync(f) ? readFileSync(f, 'utf8').trim() || null : null;
  };
  return {
    async pronto() {
      if (!pasta) throw new ErroDaPorta('KIT_SEGREDOS_DIR não está definida: sem o cofre o segredo gerado se perderia — defina a pasta (modo 700) e rode de novo');
      mkdirSync(pasta, { recursive: true, mode: 0o700 });
    },
    async tem(nome) {
      if (!NOME_OK.test(nome)) throw new ErroDaPorta(`nome de segredo inválido: ${nome}`);
      return !!env[nome]?.trim() || (!!pasta && !!lerArquivo(nome));
    },
    async ler(nome) {
      if (!NOME_OK.test(nome)) throw new ErroDaPorta(`nome de segredo inválido: ${nome}`);
      return env[nome]?.trim() || (pasta ? lerArquivo(nome) : null);
    },
    async guardar(nome, valor) {
      const f = arquivo(nome);
      const antes = lerArquivo(nome);
      if (antes !== null && antes !== valor) throw new ErroDaPorta(`o segredo ${nome} já existe no cofre com outro valor: não sobrescrevo`);
      if (antes === valor) return;
      mkdirSync(pasta!, { recursive: true, mode: 0o700 });
      writeFileSync(f, `${valor}\n`, { mode: 0o600 });
      chmodSync(f, 0o600);
    },
  };
}
