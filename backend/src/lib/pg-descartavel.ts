import { spawn, spawnSync } from 'node:child_process';

/**
 * Garante que um contêiner de Postgres descartável de TESTE seja removido mesmo quando o processo morre no meio (Ctrl+C,
 * timeout da suíte, SIGKILL): `after()` não roda nesses casos e o contêiner ficava de pé na máquina.
 *
 *  - saída normal, SIGINT e SIGTERM: remove na hora;
 *  - SIGKILL (nada roda no processo): um vigia separado, desligado do processo, espera o PID sumir e remove o contêiner.
 *
 * Só para arquivos de teste. Chame logo depois do `docker run`.
 */
export function protegerContainer(nome: string): void {
  const remover = () => {
    spawnSync('docker', ['rm', '-f', nome], { stdio: 'ignore' });
  };
  process.once('exit', remover);
  for (const sinal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(sinal, () => {
      remover();
      process.exit(sinal === 'SIGINT' ? 130 : 143);
    });
  }
  const vigia = spawn('sh', ['-c', `while kill -0 ${process.pid} 2>/dev/null; do sleep 2; done; docker rm -f ${nome} >/dev/null 2>&1`], {
    detached: true,
    stdio: 'ignore',
  });
  vigia.unref();
}
